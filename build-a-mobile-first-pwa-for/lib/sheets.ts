import { getAppEnv } from "./env";
import { getSheetsClient } from "./google";

const REQUIRED_COLUMNS = ["Photo Link", "Carrier / Status", "Personalization"] as const;
const CACHE_TTL_MS = 45_000;

export type SheetRow = {
  rowNumber: number;
  photoLink: string;
  status: string;
  personalization: string;
  priority: 1 | 2;
};

type SheetCache = {
  expiresAt: number;
  headers: string[];
  rows: string[][];
};

let cache: SheetCache | null = null;

function quoteSheetName(name: string): string {
  return `'${name.replace(/'/g, "''")}'`;
}

function normalizeHeader(value: string): string {
  return value.trim().toLowerCase();
}

function columnLetter(index: number): string {
  let dividend = index + 1;
  let column = "";

  while (dividend > 0) {
    const modulo = (dividend - 1) % 26;
    column = String.fromCharCode(65 + modulo) + column;
    dividend = Math.floor((dividend - modulo) / 26);
  }

  return column;
}

function findColumn(headers: string[], name: (typeof REQUIRED_COLUMNS)[number]): number {
  const index = headers.findIndex((header) => normalizeHeader(header) === normalizeHeader(name));

  if (index === -1) {
    throw new Error(`Missing required column: "${name}". Check row 1 of the Google Sheet.`);
  }

  return index;
}

function getPriority(status: string): 1 | 2 {
  const normalized = status.toLowerCase();
  return normalized.includes("delivered") || normalized.includes("dispatched") ? 2 : 1;
}

async function readSheetValues(): Promise<SheetCache> {
  if (cache && cache.expiresAt > Date.now()) {
    return cache;
  }

  const env = getAppEnv();
  const sheets = getSheetsClient();
  const response = await sheets.spreadsheets.values.get({
    spreadsheetId: env.GOOGLE_SHEET_ID,
    range: `${quoteSheetName(env.GOOGLE_SHEET_TAB_NAME)}!A:ZZ`
  });

  const values = response.data.values ?? [];
  const headers = (values[0] ?? []).map(String);

  if (headers.length === 0) {
    throw new Error("The selected Google Sheet tab has no header row.");
  }

  for (const column of REQUIRED_COLUMNS) {
    findColumn(headers, column);
  }

  cache = {
    expiresAt: Date.now() + CACHE_TTL_MS,
    headers,
    rows: values.slice(1).map((row) => row.map(String))
  };

  return cache;
}

export function clearSheetCache() {
  cache = null;
}

export async function searchSheetRows(query: string, limit = 100): Promise<SheetRow[]> {
  const { headers, rows } = await readSheetValues();
  const photoIndex = findColumn(headers, "Photo Link");
  const statusIndex = findColumn(headers, "Carrier / Status");
  const personalizationIndex = findColumn(headers, "Personalization");
  const normalizedQuery = query.trim().toLowerCase();

  if (!normalizedQuery) {
    return [];
  }

  return rows
    .map((row, index) => {
      const status = row[statusIndex] ?? "";

      return {
        rowNumber: index + 2,
        photoLink: row[photoIndex] ?? "",
        status,
        personalization: row[personalizationIndex] ?? "",
        priority: getPriority(status)
      };
    })
    .filter((row) => row.personalization.toLowerCase().includes(normalizedQuery))
    .sort((a, b) => a.priority - b.priority || a.rowNumber - b.rowNumber)
    .slice(0, limit);
}

export async function updatePhotoLink(rowNumber: number, imageUrl: string): Promise<void> {
  if (!Number.isInteger(rowNumber) || rowNumber < 2) {
    throw new Error("Invalid row number. Expected a data row from the Google Sheet.");
  }

  const env = getAppEnv();
  const { headers } = await readSheetValues();
  const photoIndex = findColumn(headers, "Photo Link");
  const sheets = getSheetsClient();
  const targetCell = `${columnLetter(photoIndex)}${rowNumber}`;

  await sheets.spreadsheets.values.update({
    spreadsheetId: env.GOOGLE_SHEET_ID,
    range: `${quoteSheetName(env.GOOGLE_SHEET_TAB_NAME)}!${targetCell}`,
    valueInputOption: "RAW",
    requestBody: {
      values: [[imageUrl]]
    }
  });

  clearSheetCache();
}
