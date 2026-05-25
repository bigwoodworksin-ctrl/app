const REQUIRED_ENV = [
  "GOOGLE_SHEET_ID",
  "GOOGLE_SHEET_TAB_NAME",
  "GOOGLE_DRIVE_FOLDER_ID",
  "GOOGLE_SERVICE_ACCOUNT_EMAIL",
  "GOOGLE_PRIVATE_KEY",
  "APP_PASSWORD"
] as const;

export type AppEnv = Record<(typeof REQUIRED_ENV)[number], string>;

export function extractGoogleId(value: string, kind: "sheet" | "driveFolder"): string {
  const trimmed = value.trim();

  if (!trimmed.includes("http")) {
    return trimmed;
  }

  const patterns =
    kind === "sheet"
      ? [/\/spreadsheets\/d\/([a-zA-Z0-9-_]+)/, /[?&]id=([a-zA-Z0-9-_]+)/]
      : [/\/folders\/([a-zA-Z0-9-_]+)/, /[?&]id=([a-zA-Z0-9-_]+)/];

  for (const pattern of patterns) {
    const match = trimmed.match(pattern);
    if (match?.[1]) {
      return match[1];
    }
  }

  return trimmed;
}

export function getAppEnv(): AppEnv {
  const missing = REQUIRED_ENV.filter((key) => !process.env[key]?.trim());

  if (missing.length > 0) {
    throw new Error(`Missing required environment variables: ${missing.join(", ")}`);
  }

  return {
    GOOGLE_SHEET_ID: extractGoogleId(process.env.GOOGLE_SHEET_ID!, "sheet"),
    GOOGLE_SHEET_TAB_NAME: process.env.GOOGLE_SHEET_TAB_NAME!.trim(),
    GOOGLE_DRIVE_FOLDER_ID: extractGoogleId(process.env.GOOGLE_DRIVE_FOLDER_ID!, "driveFolder"),
    GOOGLE_SERVICE_ACCOUNT_EMAIL: process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL!.trim(),
    GOOGLE_PRIVATE_KEY: process.env.GOOGLE_PRIVATE_KEY!.replace(/\\n/g, "\n"),
    APP_PASSWORD: process.env.APP_PASSWORD!
  };
}

export function toClientError(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }

  return "Something went wrong. Please try again.";
}
