import { getAppEnv } from "./env";
import { getSheetsClient } from "./google";

const REQUIRED_COLUMNS = ["Photo Link", "Carrier / Status", "Personalization"] as const;
const COLUMN_ALIASES: Record<(typeof REQUIRED_COLUMNS)[number], string[]> = {
  "Photo Link": ["Photo Link", "Photo", "Image Link"],
  "Carrier / Status": ["Carrier / Status", "Carrier", "Status", "Carrier Status"],
  Personalization: ["Personalization", "Personalisation", "Personalized", "Personalized Text"]
};
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
  headerRowNumber: number;
  rows: string[][];
};

let cache: SheetCache | null = null;

function quoteSheetName(name: string): string {
  return `'${name.replace(/'/g, "''")}'`;
}

function normalizeHeader(value: string): string {
  return value.trim().toLowerCase().replace(/\s+/g, " ");
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
  const aliases = COLUMN_ALIASES[name].map(normalizeHeader);
  const index = headers.findIndex((header) => aliases.includes(normalizeHeader(header)));

  if (index === -1) {
    throw new Error(
      `Missing required column: "${name}". Accepted headers: ${COLUMN_ALIASES[name].join(", ")}.`
    );
  }

  return index;
}

function findHeaderRow(values: string[][]): { headers: string[]; headerRowIndex: number } {
  const rowsToScan = values.slice(0, 10);

  for (let index = 0; index < rowsToScan.length; index += 1) {
    const headers = rowsToScan[index].map(String);
    const hasAllRequiredColumns = REQUIRED_COLUMNS.every((column) => {
      try {
        findColumn(headers, column);
        return true;
      } catch {
        return false;
      }
    });

    if (hasAllRequiredColumns) {
      return { headers, headerRowIndex: index };
    }
  }

  const previewHeaders = rowsToScan
    .map((row, index) => `row ${index + 1}: ${row.filter(Boolean).join(", ") || "blank"}`)
    .join(" | ");

  throw new Error(
    `Could not find the required header row in the first 10 rows. I saw: ${previewHeaders}. Required columns are Photo Link, Carrier/Status or Carrier, and Personalization.`
  );
}

function getPriority(status: string): 1 | 2 {
  const normalized = status.toLowerCase();
  return normalized.includes("delivered") || normalized.includes("dispatched") ? 2 : 1;
}

async function getAvailableTabNames(): Promise<string[]> {
  const env = getAppEnv();
  const sheets = getSheetsClient();
  const response = await sheets.spreadsheets.get({
    spreadsheetId: env.GOOGLE_SHEET_ID,
    fields: "sheets.properties.title"
  });

  return (
    response.data.sheets
      ?.map((sheet) => sheet.properties?.title)
      .filter((title): title is string => Boolean(title)) ?? []
  );
}

async function readSheetValues(): Promise<SheetCache> {
  if (cache && cache.expiresAt > Date.now()) {
    return cache;
  }

  const env = getAppEnv();
  const sheets = getSheetsClient();
  const availableTabs = await getAvailableTabNames();

  if (!availableTabs.includes(env.GOOGLE_SHEET_TAB_NAME)) {
    throw new Error(
      `Google Sheet tab "${env.GOOGLE_SHEET_TAB_NAME}" was not found. Available tabs: ${
        availableTabs.join(", ") || "none"
      }. Use the exact tab name shown at the bottom of the spreadsheet.`
    );
  }

  const response = await sheets.spreadsheets.values.get({
    spreadsheetId: env.GOOGLE_SHEET_ID,
    range: `${quoteSheetName(env.GOOGLE_SHEET_TAB_NAME)}!A:ZZ`
  });

  const values = (response.data.values ?? []).map((row) => row.map(String));

  if (values.length === 0) {
    throw new Error("The selected Google Sheet tab is empty.");
  }

  const { headers, headerRowIndex } = findHeaderRow(values);

  cache = {
    expiresAt: Date.now() + CACHE_TTL_MS,
    headers,
    headerRowNumber: headerRowIndex + 1,
    rows: values.slice(headerRowIndex + 1)
  };

  return cache;
}

export function clearSheetCache() {
  cache = null;
}

export async function searchSheetRows(query: string, limit = 100): Promise<SheetRow[]> {
  const { headers, headerRowNumber, rows } = await readSheetValues();
  const photoIndex = findColumn(headers, "Photo Link");
  const statusIndex = findColumn(headers, "Carrier / Status");
  const personalizationIndex = findColumn(headers, "Personalization");
  const normalizedQuery = query.trim().toLowerCase();

  return rows
    .map((row, index) => {
      const status = row[statusIndex] ?? "";

      return {
        rowNumber: headerRowNumber + index + 1,
        photoLink: row[photoIndex] ?? "",
        status,
        personalization: row[personalizationIndex] ?? "",
        priority: getPriority(status)
      };
    })
    .filter((row) => !normalizedQuery || row.personalization.toLowerCase().includes(normalizedQuery))
    .sort((a, b) => a.priority - b.priority || a.rowNumber - b.rowNumber)
    .slice(0, limit);
}

export async function getSheetDiagnostics() {
  const { headers, headerRowNumber, rows } = await readSheetValues();

  return {
    headers,
    headerRowNumber,
    dataRowCount: rows.length,
    requiredColumns: REQUIRED_COLUMNS.map((column) => ({
      name: column,
      found: COLUMN_ALIASES[column].some((alias) =>
        headers.some((header) => normalizeHeader(header) === normalizeHeader(alias))
      )
    })),
    sampleRows: rows.slice(0, 3).map((row, index) => ({
      rowNumber: headerRowNumber + index + 1,
      nonEmptyCellCount: row.filter((cell) => cell.trim()).length
    }))
  };
}

export async function updatePhotoLink(rowNumber: number, imageUrl: string): Promise<void> {
  if (!Number.isInteger(rowNumber) || rowNumber < 1) {
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
