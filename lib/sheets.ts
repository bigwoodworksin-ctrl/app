import { extractGoogleId, getAppEnv } from "./env";
import { getSheetsClient } from "./google";

const REQUIRED_COLUMNS = ["Photo Link", "Carrier / Status", "Personalization"] as const;
const PHOTO_COLUMNS = ["Photo Link", "Photo Link 2", "Photo Link 3"] as const;
const COLUMN_ALIASES: Record<(typeof REQUIRED_COLUMNS)[number], string[]> = {
  "Photo Link": ["Photo Link", "Photo", "Image Link"],
  "Carrier / Status": ["Carrier / Status", "Carrier", "Status", "Carrier Status"],
  Personalization: ["Personalization", "Personalisation", "Personalized", "Personalized Text"]
};
const CACHE_TTL_MS = 45_000;
const TRACKING_COLUMNS = ["Tracking ID", "Carrier / Status", "Dispatch Photo Link"] as const;
const TRACKING_ALIASES: Record<(typeof TRACKING_COLUMNS)[number], string[]> = {
  "Tracking ID": [
    "Tracking ID",
    "Tracking Id",
    "Tracking",
    "Tracking #",
    "Tracking#",
    "Tracking Number",
    "Tracking No",
    "Tracking No.",
    "Tracking Code",
    "Barcode",
    "AWB",
    "AWB No",
    "AWB Number",
    "Consignment No",
    "Consignment Number"
  ],
  "Carrier / Status": COLUMN_ALIASES["Carrier / Status"],
  "Dispatch Photo Link": ["Dispatch Photo Link", "Dispatch Photo", "Package Photo", "Shipping Photo"]
};

export type SheetTarget = {
  sheetId?: string;
  tabName?: string;
};

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

export type ShippingRow = {
  rowNumber: number;
  trackingId: string;
  status: string;
  personalization: string;
  dispatchPhotoLink: string;
};

type SheetCache = {
  expiresAt: number;
  headers: string[];
  headerRowNumber: number;
  sheetId: number;
  rows: string[][];
};

const cache = new Map<string, SheetCache>();
type SheetMode = "orders" | "shipping";

function resolveTarget(target?: SheetTarget) {
  const env = getAppEnv();

  return {
    spreadsheetId: extractGoogleId(target?.sheetId?.trim() || env.GOOGLE_SHEET_ID),
    tabName: target?.tabName?.trim() || env.GOOGLE_SHEET_TAB_NAME,
    serviceAccountEmail: env.GOOGLE_SERVICE_ACCOUNT_EMAIL
  };
}

function cacheKey(target?: SheetTarget, mode: SheetMode = "orders"): string {
  const resolved = resolveTarget(target);
  return `${resolved.spreadsheetId}:${resolved.tabName}:${mode}`;
}

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

function normalizeTrackingValue(value: string): string {
  return value.trim().toLowerCase().replace(/\s+/g, "");
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

function findAliasedColumn(headers: string[], aliases: string[]): number {
  const normalizedAliases = aliases.map(normalizeHeader);
  return headers.findIndex((header) => normalizedAliases.includes(normalizeHeader(header)));
}

function getPhotoColumnIndexes(headers: string[]): number[] {
  return PHOTO_COLUMNS.map((_, index) => findPhotoColumn(headers, (index + 1) as 1 | 2 | 3));
}

async function ensurePhotoColumns(headers: string[], headerRowNumber: number, target?: SheetTarget): Promise<string[]> {
  const resolved = resolveTarget(target);
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
      range: `${quoteSheetName(resolved.tabName)}!${columnLetter(targetIndex)}${headerRowNumber}`,
      values: [[header]]
    });
  }

  try {
    await sheets.spreadsheets.values.batchUpdate({
      spreadsheetId: resolved.spreadsheetId,
      requestBody: {
        valueInputOption: "RAW",
        data: updates
      }
    });
  } catch (error) {
    throw new Error(
      `Google Sheets header update failed: ${googleApiMessage(error)}. Share the spreadsheet with ${resolved.serviceAccountEmail} as Editor.`
    );
  }

  return nextHeaders;
}

async function ensureColumn(headers: string[], headerRowNumber: number, header: string, aliases: string[], target?: SheetTarget): Promise<string[]> {
  if (findAliasedColumn(headers, aliases) !== -1) {
    return headers;
  }

  const resolved = resolveTarget(target);
  const nextHeaders = [...headers];
  const targetIndex = nextHeaders.length;
  nextHeaders[targetIndex] = header;

  try {
    await getSheetsClient().spreadsheets.values.update({
      spreadsheetId: resolved.spreadsheetId,
      range: `${quoteSheetName(resolved.tabName)}!${columnLetter(targetIndex)}${headerRowNumber}`,
      valueInputOption: "RAW",
      requestBody: {
        values: [[header]]
      }
    });
  } catch (error) {
    throw new Error(
      `Google Sheets header update failed: ${googleApiMessage(error)}. Share the spreadsheet with ${resolved.serviceAccountEmail} as Editor.`
    );
  }

  return nextHeaders;
}

function findOrderHeaderRow(values: string[][]): { headers: string[]; headerRowIndex: number } {
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

function findShippingHeaderRow(values: string[][]): { headers: string[]; headerRowIndex: number } {
  const rowsToScan = values.slice(0, 10);

  for (let index = 0; index < rowsToScan.length; index += 1) {
    const headers = rowsToScan[index].map(String);
    const hasTracking = findAliasedColumn(headers, TRACKING_ALIASES["Tracking ID"]) !== -1;
    const hasStatus = findAliasedColumn(headers, TRACKING_ALIASES["Carrier / Status"]) !== -1;

    if (hasTracking && hasStatus) {
      return { headers, headerRowIndex: index };
    }
  }

  const previewHeaders = rowsToScan
    .map((row, index) => `row ${index + 1}: ${row.filter(Boolean).join(", ") || "blank"}`)
    .join(" | ");

  throw new Error(
    `Could not find the shipping header row in the first 10 rows. I saw: ${previewHeaders}. Required columns are Tracking ID/Tracking Number and Carrier/Status or Carrier.`
  );
}

function getPriority(status: string): 1 | 2 {
  const normalized = status.toLowerCase();
  return normalized.includes("delivered") || normalized.includes("dispatched") ? 2 : 1;
}

export async function getSheetMetadata(target?: SheetTarget): Promise<{
  spreadsheetTitle: string;
  tabs: Array<{ title: string; sheetId: number }>;
}> {
  const resolved = resolveTarget(target);
  const sheets = getSheetsClient();
  let response;

  try {
    response = await sheets.spreadsheets.get({
      spreadsheetId: resolved.spreadsheetId,
      fields: "properties.title,sheets.properties(sheetId,title)"
    });
  } catch (error) {
    throw new Error(
      `Google Sheets access failed: ${googleApiMessage(error)}. Share the spreadsheet with ${resolved.serviceAccountEmail} as Editor.`
    );
  }

  return {
    spreadsheetTitle: response.data.properties?.title ?? "Google Sheet",
    tabs:
      response.data.sheets
      ?.map((sheet) => ({
        title: sheet.properties?.title ?? "",
        sheetId: sheet.properties?.sheetId ?? 0
      }))
      .filter((sheet) => Boolean(sheet.title)) ?? []
  };
}

export async function getAvailableTabs(target?: SheetTarget): Promise<Array<{ title: string; sheetId: number }>> {
  const metadata = await getSheetMetadata(target);
  return metadata.tabs;
}

async function readSheetValues(target?: SheetTarget, mode: SheetMode = "orders"): Promise<SheetCache> {
  const key = cacheKey(target, mode);
  const cached = cache.get(key);

  if (cached && cached.expiresAt > Date.now()) {
    return cached;
  }

  const resolved = resolveTarget(target);
  const sheets = getSheetsClient();
  const availableTabs = await getAvailableTabs(target);
  const activeTab = availableTabs.find((tab) => tab.title === resolved.tabName);

  if (!activeTab) {
    throw new Error(
      `Google Sheet tab "${resolved.tabName}" was not found. Available tabs: ${
        availableTabs.map((tab) => tab.title).join(", ") || "none"
      }. Use the exact tab name shown at the bottom of the spreadsheet.`
    );
  }

  let response;

  try {
    response = await sheets.spreadsheets.values.get({
      spreadsheetId: resolved.spreadsheetId,
      range: `${quoteSheetName(resolved.tabName)}!A:ZZ`,
      valueRenderOption: "FORMULA"
    });
  } catch (error) {
    throw new Error(
      `Google Sheets read failed: ${googleApiMessage(error)}. Share the spreadsheet with ${resolved.serviceAccountEmail} as Viewer or Editor.`
    );
  }

  const values = (response.data.values ?? []).map((row) => row.map(String));

  if (values.length === 0) {
    throw new Error("The selected Google Sheet tab is empty.");
  }

  const { headers, headerRowIndex } =
    mode === "shipping" ? findShippingHeaderRow(values) : findOrderHeaderRow(values);
  const finalHeaders = mode === "orders" ? await ensurePhotoColumns(headers, headerRowIndex + 1, target) : headers;

  const nextCache = {
    expiresAt: Date.now() + CACHE_TTL_MS,
    headers: finalHeaders,
    headerRowNumber: headerRowIndex + 1,
    sheetId: activeTab.sheetId,
    rows: values.slice(headerRowIndex + 1)
  };

  cache.set(key, nextCache);
  return nextCache;
}

export function clearSheetCache(target?: SheetTarget) {
  if (target) {
    cache.delete(cacheKey(target, "orders"));
    cache.delete(cacheKey(target, "shipping"));
    return;
  }

  cache.clear();
}

export async function searchSheetRows(query: string, limit = 100, target?: SheetTarget): Promise<SheetRow[]> {
  const { headers, headerRowNumber, rows } = await readSheetValues(target);
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

export async function getSheetDiagnostics(target?: SheetTarget) {
  const { headers, headerRowNumber, rows } = await readSheetValues(target);

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

async function readRowValues(rowNumber: number, target?: SheetTarget): Promise<string[]> {
  const resolved = resolveTarget(target);
  const sheets = getSheetsClient();

  try {
    const response = await sheets.spreadsheets.values.get({
      spreadsheetId: resolved.spreadsheetId,
      range: `${quoteSheetName(resolved.tabName)}!A${rowNumber}:ZZ${rowNumber}`,
      valueRenderOption: "FORMULA"
    });

    return (response.data.values?.[0] ?? []).map(String);
  } catch (error) {
    throw new Error(
      `Google Sheets row read failed: ${googleApiMessage(error)}. Share the spreadsheet with ${resolved.serviceAccountEmail} as Editor.`
    );
  }
}

export async function getEmptyPhotoSlots(rowNumber: number, target?: SheetTarget): Promise<Array<1 | 2 | 3>> {
  if (!Number.isInteger(rowNumber) || rowNumber < 1) {
    throw new Error("Invalid row number. Expected a data row from the Google Sheet.");
  }

  const { headers } = await readSheetValues(target);
  const photoIndexes = getPhotoColumnIndexes(headers);
  const row = await readRowValues(rowNumber, target);

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
  photos: Array<{ slot: 1 | 2 | 3; imageUrl: string }>,
  target?: SheetTarget
): Promise<PhotoSlot[]> {
  if (!Number.isInteger(rowNumber) || rowNumber < 1) {
    throw new Error("Invalid row number. Expected a data row from the Google Sheet.");
  }

  if (photos.length === 0) {
    throw new Error("No photo links were provided for the Sheet update.");
  }

  const resolved = resolveTarget(target);
  const { headers, sheetId } = await readSheetValues(target);
  const photoIndexes = getPhotoColumnIndexes(headers);
  const sheets = getSheetsClient();
  const data = photos.map((photo) => {
    const columnIndex = photoIndexes[photo.slot - 1];

    if (columnIndex === -1) {
      throw new Error(`Missing column for Photo Link ${photo.slot}.`);
    }

    return {
      range: `${quoteSheetName(resolved.tabName)}!${columnLetter(columnIndex)}${rowNumber}`,
      values: [[photo.imageUrl]]
    };
  });

  try {
    await sheets.spreadsheets.values.batchUpdate({
      spreadsheetId: resolved.spreadsheetId,
      requestBody: {
        valueInputOption: "USER_ENTERED",
        data
      }
    });

    await sheets.spreadsheets.batchUpdate({
      spreadsheetId: resolved.spreadsheetId,
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
      `Google Sheets update failed: ${googleApiMessage(error)}. Share the spreadsheet with ${resolved.serviceAccountEmail} as Editor.`
    );
  }

  clearSheetCache(target);

  return photos.map((photo) => ({
    slot: photo.slot,
    header: PHOTO_COLUMNS[photo.slot - 1],
    label: `Photo ${photo.slot}`,
    url: photo.imageUrl
  }));
}

export async function clearPhotoSlot(rowNumber: number, slot: 1 | 2 | 3, target?: SheetTarget): Promise<void> {
  if (!Number.isInteger(rowNumber) || rowNumber < 1) {
    throw new Error("Invalid row number. Expected a data row from the Google Sheet.");
  }

  if (![1, 2, 3].includes(slot)) {
    throw new Error("Invalid photo slot.");
  }

  const resolved = resolveTarget(target);
  const { headers } = await readSheetValues(target);
  const photoIndex = getPhotoColumnIndexes(headers)[slot - 1];

  if (photoIndex === -1) {
    throw new Error(`Missing column for Photo Link ${slot}.`);
  }

  try {
    await getSheetsClient().spreadsheets.values.clear({
      spreadsheetId: resolved.spreadsheetId,
      range: `${quoteSheetName(resolved.tabName)}!${columnLetter(photoIndex)}${rowNumber}`
    });
  } catch (error) {
    throw new Error(
      `Google Sheets photo delete failed: ${googleApiMessage(error)}. Share the spreadsheet with ${resolved.serviceAccountEmail} as Editor.`
    );
  }

  clearSheetCache(target);
}

export async function findShippingRowByTracking(trackingId: string, target?: SheetTarget): Promise<ShippingRow | null> {
  const normalizedTracking = normalizeTrackingValue(trackingId);

  if (!normalizedTracking) {
    return null;
  }

  let { headers, headerRowNumber, rows } = await readSheetValues(target, "shipping");
  headers = await ensureColumn(headers, headerRowNumber, "Dispatch Photo Link", TRACKING_ALIASES["Dispatch Photo Link"], target);
  clearSheetCache(target);

  const trackingIndex = findAliasedColumn(headers, TRACKING_ALIASES["Tracking ID"]);
  const statusIndex = findAliasedColumn(headers, TRACKING_ALIASES["Carrier / Status"]);
  const personalizationIndex = findAliasedColumn(headers, COLUMN_ALIASES.Personalization);
  const dispatchPhotoIndex = findAliasedColumn(headers, TRACKING_ALIASES["Dispatch Photo Link"]);

  if (trackingIndex === -1) {
    throw new Error(`Missing required tracking column. Accepted headers: ${TRACKING_ALIASES["Tracking ID"].join(", ")}.`);
  }

  if (statusIndex === -1) {
    throw new Error(`Missing required status column. Accepted headers: ${TRACKING_ALIASES["Carrier / Status"].join(", ")}.`);
  }

  const rowIndex = rows.findIndex((row) => normalizeTrackingValue(String(row[trackingIndex] ?? "")) === normalizedTracking);

  if (rowIndex === -1) {
    return null;
  }

  const row = rows[rowIndex];

  return {
    rowNumber: headerRowNumber + rowIndex + 1,
    trackingId: row[trackingIndex] ?? "",
    status: row[statusIndex] ?? "",
    personalization: personalizationIndex >= 0 ? row[personalizationIndex] ?? "" : "",
    dispatchPhotoLink: dispatchPhotoIndex >= 0 ? extractPhotoUrls(row[dispatchPhotoIndex] ?? "")[0] ?? row[dispatchPhotoIndex] ?? "" : ""
  };
}

export async function updateShippingStatus(rowNumber: number, status: string, target?: SheetTarget): Promise<void> {
  if (!Number.isInteger(rowNumber) || rowNumber < 1) {
    throw new Error("Invalid row number. Expected a data row from the Google Sheet.");
  }

  const nextStatus = status.trim();

  if (!nextStatus) {
    throw new Error("Shipping status cannot be blank.");
  }

  const resolved = resolveTarget(target);
  const { headers } = await readSheetValues(target, "shipping");
  const statusIndex = findAliasedColumn(headers, TRACKING_ALIASES["Carrier / Status"]);

  if (statusIndex === -1) {
    throw new Error(`Missing required status column. Accepted headers: ${TRACKING_ALIASES["Carrier / Status"].join(", ")}.`);
  }

  try {
    await getSheetsClient().spreadsheets.values.update({
      spreadsheetId: resolved.spreadsheetId,
      range: `${quoteSheetName(resolved.tabName)}!${columnLetter(statusIndex)}${rowNumber}`,
      valueInputOption: "USER_ENTERED",
      requestBody: {
        values: [[nextStatus]]
      }
    });
  } catch (error) {
    throw new Error(
      `Google Sheets status update failed: ${googleApiMessage(error)}. Share the spreadsheet with ${resolved.serviceAccountEmail} as Editor.`
    );
  }

  clearSheetCache(target);
}

export async function updateDispatchPhoto(rowNumber: number, imageUrl: string, target?: SheetTarget): Promise<void> {
  if (!Number.isInteger(rowNumber) || rowNumber < 1) {
    throw new Error("Invalid row number. Expected a data row from the Google Sheet.");
  }

  const resolved = resolveTarget(target);
  let { headers, headerRowNumber } = await readSheetValues(target, "shipping");
  headers = await ensureColumn(headers, headerRowNumber, "Dispatch Photo Link", TRACKING_ALIASES["Dispatch Photo Link"], target);
  const dispatchPhotoIndex = findAliasedColumn(headers, TRACKING_ALIASES["Dispatch Photo Link"]);

  try {
    await getSheetsClient().spreadsheets.values.update({
      spreadsheetId: resolved.spreadsheetId,
      range: `${quoteSheetName(resolved.tabName)}!${columnLetter(dispatchPhotoIndex)}${rowNumber}`,
      valueInputOption: "USER_ENTERED",
      requestBody: {
        values: [[imageUrl]]
      }
    });
  } catch (error) {
    throw new Error(
      `Google Sheets dispatch photo update failed: ${googleApiMessage(error)}. Share the spreadsheet with ${resolved.serviceAccountEmail} as Editor.`
    );
  }

  clearSheetCache(target);
}
