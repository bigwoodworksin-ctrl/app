import { getAppEnv } from "./env";
import { getSheetsClient } from "./google";

const REQUIRED_COLUMNS = ["Photo Link", "Carrier / Status", "Personalization"] as const;
const PHOTO_COLUMNS = ["Photo Link", "Photo Link 2", "Photo Link 3"] as const;
const COLUMN_ALIASES: Record<(typeof REQUIRED_COLUMNS)[number], string[]> = {
  "Photo Link": ["Photo Link", "Photo", "Image Link"],
  "Carrier / Status": ["Carrier / Status", "Carrier", "Status", "Carrier Status"],
  Personalization: ["Personalization", "Personalisation", "Personalized", "Personalized Text"]
};
const CACHE_TTL_MS = 45_000;

export type SheetRow = {
  rowNumber: number;
  photoLink: string;
  photoLinks: PhotoSlot[];
  status: string;
  personalization: string;
  priority: 1 | 2;
};

export type PhotoSlot = {
  slot: 1 | 2 | 3;
  header: string;
  label: string;
  url: string;
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

function extractPhotoUrls(value: string): string[] {
  const formulaMatches = Array.from(value.matchAll(/HYPERLINK\("([^"]+)","([^"]+)"\)/g));

  if (formulaMatches.length > 0) {
    return formulaMatches.map((match) => match[1]);
  }

  return Array.from(value.matchAll(/https?:\/\/\S+/g)).map((match) => match[0]);
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

function findPhotoColumn(headers: string[], slot: 1 | 2 | 3): number {
  const header = PHOTO_COLUMNS[slot - 1];
  const aliases = slot === 1 ? COLUMN_ALIASES["Photo Link"] : [header];
  const normalizedAliases = aliases.map(normalizeHeader);

  return headers.findIndex((value) => normalizedAliases.includes(normalizeHeader(value)));
}

function getPhotoColumnIndexes(headers: string[]): number[] {
  return PHOTO_COLUMNS.map((_, index) => findPhotoColumn(headers, (index + 1) as 1 | 2 | 3));
}

async function ensurePhotoColumns(headers: string[], headerRowNumber: number): Promise<string[]> {
  const env = getAppEnv();
  const missingHeaders = PHOTO_COLUMNS.filter((_, index) => findPhotoColumn(headers, (index + 1) as 1 | 2 | 3) === -1);

  if (missingHeaders.length === 0) {
    return headers;
  }

  const sheets = getSheetsClient();
  const nextHeaders = [...headers];
  const updates = [];

  for (const header of missingHeaders) {
    const targetIndex = nextHeaders.length;
    nextHeaders[targetIndex] = header;
    updates.push({
      range: `${quoteSheetName(env.GOOGLE_SHEET_TAB_NAME)}!${columnLetter(targetIndex)}${headerRowNumber}`,
      values: [[header]]
    });
  }

  try {
    await sheets.spreadsheets.values.batchUpdate({
      spreadsheetId: env.GOOGLE_SHEET_ID,
      requestBody: {
        valueInputOption: "RAW",
        data: updates
      }
    });
  } catch (error) {
    throw new Error(
      `Google Sheets header update failed: ${googleApiMessage(error)}. Share the spreadsheet with ${env.GOOGLE_SERVICE_ACCOUNT_EMAIL} as Editor.`
    );
  }

  return nextHeaders;
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
  const finalHeaders = await ensurePhotoColumns(headers, headerRowIndex + 1);

  cache = {
    expiresAt: Date.now() + CACHE_TTL_MS,
    headers: finalHeaders,
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
  const photoIndexes = getPhotoColumnIndexes(headers);
  const statusIndex = findColumn(headers, "Carrier / Status");
  const personalizationIndex = findColumn(headers, "Personalization");
  const normalizedQuery = query.trim().toLowerCase();

  return rows
    .map((row, index) => {
      const status = row[statusIndex] ?? "";

      const photoLinks = photoIndexes
        .map((photoIndex, photoIndexPosition) => {
          const url = photoIndex >= 0 ? extractPhotoUrls(row[photoIndex] ?? "")[0] ?? "" : "";

          return {
            slot: (photoIndexPosition + 1) as 1 | 2 | 3,
            header: PHOTO_COLUMNS[photoIndexPosition],
            label: `Photo ${photoIndexPosition + 1}`,
            url
          };
        })
        .filter((photo) => photo.url);

      return {
        rowNumber: headerRowNumber + index + 1,
        photoLink: photoLinks.map((photo) => photo.url).join("\n"),
        photoLinks,
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

async function readRowValues(rowNumber: number): Promise<string[]> {
  const env = getAppEnv();
  const sheets = getSheetsClient();

  try {
    const response = await sheets.spreadsheets.values.get({
      spreadsheetId: env.GOOGLE_SHEET_ID,
      range: `${quoteSheetName(env.GOOGLE_SHEET_TAB_NAME)}!A${rowNumber}:ZZ${rowNumber}`,
      valueRenderOption: "FORMULA"
    });

    return (response.data.values?.[0] ?? []).map(String);
  } catch (error) {
    throw new Error(
      `Google Sheets row read failed: ${googleApiMessage(error)}. Share the spreadsheet with ${env.GOOGLE_SERVICE_ACCOUNT_EMAIL} as Editor.`
    );
  }
}

export async function getEmptyPhotoSlots(rowNumber: number): Promise<Array<1 | 2 | 3>> {
  if (!Number.isInteger(rowNumber) || rowNumber < 1) {
    throw new Error("Invalid row number. Expected a data row from the Google Sheet.");
  }

  const { headers } = await readSheetValues();
  const photoIndexes = getPhotoColumnIndexes(headers);
  const row = await readRowValues(rowNumber);

  return photoIndexes
    .map((photoIndex, index) => ({
      slot: (index + 1) as 1 | 2 | 3,
      value: photoIndex >= 0 ? row[photoIndex] ?? "" : ""
    }))
    .filter((photo) => extractPhotoUrls(photo.value).length === 0 && !photo.value.trim())
    .map((photo) => photo.slot);
}

export async function writePhotoSlots(
  rowNumber: number,
  photos: Array<{ slot: 1 | 2 | 3; imageUrl: string }>
): Promise<PhotoSlot[]> {
  if (!Number.isInteger(rowNumber) || rowNumber < 1) {
    throw new Error("Invalid row number. Expected a data row from the Google Sheet.");
  }

  if (photos.length === 0) {
    throw new Error("No photo links were provided for the Sheet update.");
  }

  const env = getAppEnv();
  const { headers, sheetId } = await readSheetValues();
  const photoIndexes = getPhotoColumnIndexes(headers);
  const sheets = getSheetsClient();
  const data = photos.map((photo) => {
    const columnIndex = photoIndexes[photo.slot - 1];

    if (columnIndex === -1) {
      throw new Error(`Missing column for Photo Link ${photo.slot}.`);
    }

    return {
      range: `${quoteSheetName(env.GOOGLE_SHEET_TAB_NAME)}!${columnLetter(columnIndex)}${rowNumber}`,
      values: [[photo.imageUrl]]
    };
  });

  try {
    await sheets.spreadsheets.values.batchUpdate({
      spreadsheetId: env.GOOGLE_SHEET_ID,
      requestBody: {
        valueInputOption: "USER_ENTERED",
        data
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
                startColumnIndex: Math.min(...photos.map((photo) => photoIndexes[photo.slot - 1])),
                endColumnIndex: Math.max(...photos.map((photo) => photoIndexes[photo.slot - 1])) + 1
              },
              cell: {
                userEnteredFormat: {
                  wrapStrategy: "CLIP"
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

  return photos.map((photo) => ({
    slot: photo.slot,
    header: PHOTO_COLUMNS[photo.slot - 1],
    label: `Photo ${photo.slot}`,
    url: photo.imageUrl
  }));
}

export async function clearPhotoSlot(rowNumber: number, slot: 1 | 2 | 3): Promise<void> {
  if (!Number.isInteger(rowNumber) || rowNumber < 1) {
    throw new Error("Invalid row number. Expected a data row from the Google Sheet.");
  }

  if (![1, 2, 3].includes(slot)) {
    throw new Error("Invalid photo slot.");
  }

  const env = getAppEnv();
  const { headers } = await readSheetValues();
  const photoIndex = getPhotoColumnIndexes(headers)[slot - 1];

  if (photoIndex === -1) {
    throw new Error(`Missing column for Photo Link ${slot}.`);
  }

  try {
    await getSheetsClient().spreadsheets.values.clear({
      spreadsheetId: env.GOOGLE_SHEET_ID,
      range: `${quoteSheetName(env.GOOGLE_SHEET_TAB_NAME)}!${columnLetter(photoIndex)}${rowNumber}`
    });
  } catch (error) {
    throw new Error(
      `Google Sheets photo delete failed: ${googleApiMessage(error)}. Share the spreadsheet with ${env.GOOGLE_SERVICE_ACCOUNT_EMAIL} as Editor.`
    );
  }

  clearSheetCache();
}
