import { getAppEnv } from "./env";
import { getSheetsClient } from "./google";

const REQUIRED_COLUMNS = ["Photo Link", "Carrier / Status", "Personalization"] as const;
const COLUMN_ALIASES: Record<(typeof REQUIRED_COLUMNS)[number], string[]> = {
  "Photo Link": ["Photo Link", "Photo", "Image Link"],
  "Carrier / Status": ["Carrier / Status", "Carrier", "Status", "Carrier Status"],
  Personalization: ["Personalization", "Personalisation", "Personalized", "Personalized Text"]
};
const CACHE_TTL_MS = 45_000;
const PHOTO_ENTRY_SEPARATOR = "\n\n";

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
  sheetId: number;
  rows: string[][];
};

let cache: SheetCache | null = null;

function googleApiMessage(error: unknown): string {
  if (typeof error === "object" && error !== null && "response" in error) {
    const response = (error as { response?: { data?: { error?: { message?: string } } } }).response;
    const message = response?.data?.error?.message;

    if (message) {
      return message;
    }
  }

  if (error instanceof Error && error.message) {
    return error.message;
  }

  return "Unknown Google Sheets error.";
}

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

function extractPhotoEntries(value: string): string[] {
  const formulaMatches = Array.from(value.matchAll(/HYPERLINK\("([^"]+)","([^"]+)"\)/g));

  if (formulaMatches.length > 0) {
    return formulaMatches.map((match) => `${match[2]}: ${match[1]}`);
  }

  const urlMatches = Array.from(value.matchAll(/https?:\/\/\S+/g));

  if (urlMatches.length > 0) {
    return urlMatches.map((match, index) => {
      const url = match[0];
      const beforeUrl = value.slice(0, match.index).split(/\r?\n|\s+\|\s+/).pop()?.trim();
      const label = beforeUrl && !beforeUrl.startsWith("http") ? beforeUrl.replace(/[:|-]\s*$/, "") : `Photo ${index + 1}`;

      return `${label}: ${url}`;
    });
  }

  return value.split(/\r?\n|\s+\|\s+/).map((entry) => entry.trim()).filter(Boolean);
}

function formatPhotoEntriesForCell(entries: string[]): string {
  return entries
    .map((entry, index) => {
      const match = entry.match(/^(.*?)(?:\s+-\s+|:\s*)(https?:\/\/\S+)$/);

      if (!match) {
        return entry;
      }

      const label = match[1].trim() || `Photo ${index + 1}`;
      const url = match[2];

      return `${label}\n${url}`;
    })
    .join(PHOTO_ENTRY_SEPARATOR);
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

async function getAvailableTabs(): Promise<Array<{ title: string; sheetId: number }>> {
  const env = getAppEnv();
  const sheets = getSheetsClient();
  let response;

  try {
    response = await sheets.spreadsheets.get({
      spreadsheetId: env.GOOGLE_SHEET_ID,
      fields: "sheets.properties(sheetId,title)"
    });
  } catch (error) {
    throw new Error(
      `Google Sheets access failed: ${googleApiMessage(error)}. Share the spreadsheet with ${env.GOOGLE_SERVICE_ACCOUNT_EMAIL} as Editor.`
    );
  }

  return (
    response.data.sheets
      ?.map((sheet) => ({
        title: sheet.properties?.title ?? "",
        sheetId: sheet.properties?.sheetId ?? 0
      }))
      .filter((sheet) => Boolean(sheet.title)) ?? []
  );
}

async function readSheetValues(): Promise<SheetCache> {
  if (cache && cache.expiresAt > Date.now()) {
    return cache;
  }

  const env = getAppEnv();
  const sheets = getSheetsClient();
  const availableTabs = await getAvailableTabs();
  const activeTab = availableTabs.find((tab) => tab.title === env.GOOGLE_SHEET_TAB_NAME);

  if (!activeTab) {
    throw new Error(
      `Google Sheet tab "${env.GOOGLE_SHEET_TAB_NAME}" was not found. Available tabs: ${
        availableTabs.map((tab) => tab.title).join(", ") || "none"
      }. Use the exact tab name shown at the bottom of the spreadsheet.`
    );
  }

  let response;

  try {
    response = await sheets.spreadsheets.values.get({
      spreadsheetId: env.GOOGLE_SHEET_ID,
      range: `${quoteSheetName(env.GOOGLE_SHEET_TAB_NAME)}!A:ZZ`,
      valueRenderOption: "FORMULA"
    });
  } catch (error) {
    throw new Error(
      `Google Sheets read failed: ${googleApiMessage(error)}. Share the spreadsheet with ${env.GOOGLE_SERVICE_ACCOUNT_EMAIL} as Viewer or Editor.`
    );
  }

  const values = (response.data.values ?? []).map((row) => row.map(String));

  if (values.length === 0) {
    throw new Error("The selected Google Sheet tab is empty.");
  }

  const { headers, headerRowIndex } = findHeaderRow(values);

  cache = {
    expiresAt: Date.now() + CACHE_TTL_MS,
    headers,
    headerRowNumber: headerRowIndex + 1,
    sheetId: activeTab.sheetId,
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

export async function appendPhotoLinks(
  rowNumber: number,
  photos: Array<{ timestamp: string; imageUrl: string }>
): Promise<string> {
  if (!Number.isInteger(rowNumber) || rowNumber < 1) {
    throw new Error("Invalid row number. Expected a data row from the Google Sheet.");
  }

  if (photos.length === 0) {
    throw new Error("No photo links were provided for the Sheet update.");
  }

  const env = getAppEnv();
  const { headers, sheetId } = await readSheetValues();
  const photoIndex = findColumn(headers, "Photo Link");
  const sheets = getSheetsClient();
  const targetCell = `${columnLetter(photoIndex)}${rowNumber}`;
  let existingValue = "";

  try {
    const existing = await sheets.spreadsheets.values.get({
      spreadsheetId: env.GOOGLE_SHEET_ID,
      range: `${quoteSheetName(env.GOOGLE_SHEET_TAB_NAME)}!${targetCell}`,
      valueRenderOption: "FORMULA"
    });
    existingValue = String(existing.data.values?.[0]?.[0] ?? "").trim();
  } catch (error) {
    throw new Error(
      `Google Sheets read failed before photo update: ${googleApiMessage(error)}. Share the spreadsheet with ${env.GOOGLE_SERVICE_ACCOUNT_EMAIL} as Editor.`
    );
  }

  const newEntries = photos.map((photo, index) => `Photo ${index + 1} ${photo.timestamp}: ${photo.imageUrl}`);
  const existingEntries = extractPhotoEntries(existingValue);
  const updatedEntries = [...existingEntries, ...newEntries];
  const updatedValue = formatPhotoEntriesForCell(updatedEntries);

  try {
    await sheets.spreadsheets.values.update({
      spreadsheetId: env.GOOGLE_SHEET_ID,
      range: `${quoteSheetName(env.GOOGLE_SHEET_TAB_NAME)}!${targetCell}`,
      valueInputOption: "USER_ENTERED",
      requestBody: {
        values: [[updatedValue]]
      }
    });

    await sheets.spreadsheets.batchUpdate({
      spreadsheetId: env.GOOGLE_SHEET_ID,
      requestBody: {
        requests: [
          {
            repeatCell: {
              range: {
                sheetId,
                startRowIndex: rowNumber - 1,
                endRowIndex: rowNumber,
                startColumnIndex: photoIndex,
                endColumnIndex: photoIndex + 1
              },
              cell: {
                userEnteredFormat: {
                  wrapStrategy: "WRAP"
                }
              },
              fields: "userEnteredFormat.wrapStrategy"
            }
          }
        ]
      }
    });
  } catch (error) {
    throw new Error(
      `Google Sheets update failed: ${googleApiMessage(error)}. Share the spreadsheet with ${env.GOOGLE_SERVICE_ACCOUNT_EMAIL} as Editor.`
    );
  }

  clearSheetCache();
  return updatedValue;
}
