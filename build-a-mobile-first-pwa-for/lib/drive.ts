import { Readable } from "stream";
import { getAppEnv } from "./env";
import { getDriveClient } from "./google";

function safeFileName(fileName: string): string {
  const cleaned = fileName.replace(/[^\w.\-]+/g, "").trim();
  return cleaned || "order-photo.jpg";
}

function dateStamp(date: Date): string {
  const day = String(date.getDate()).padStart(2, "0");
  const month = date.toLocaleString("en-US", { month: "short" });
  const year = String(date.getFullYear());

  return `${day}${month}${year}`;
}

export function buildOrderPhotoFileName(personalization: string, fallbackFileName: string): string {
  const prefix = personalization.replace(/[^a-z0-9]/gi, "").slice(0, 2).toUpperCase() || "OR";
  const extension = fallbackFileName.toLowerCase().endsWith(".png") ? ".png" : ".jpg";

  return safeFileName(`${prefix}${dateStamp(new Date())}${extension}`);
}

export async function uploadImageToDrive(params: {
  fileName: string;
  mimeType: string;
  base64Image: string;
}): Promise<string> {
  const env = getAppEnv();
  const drive = getDriveClient();
  const buffer = Buffer.from(params.base64Image, "base64");

  if (buffer.length === 0) {
    throw new Error("Upload failed because the image was empty.");
  }

  const created = await drive.files.create({
    requestBody: {
      name: safeFileName(params.fileName),
      parents: [env.GOOGLE_DRIVE_FOLDER_ID]
    },
    media: {
      mimeType: params.mimeType,
      body: Readable.from(buffer)
    },
    fields: "id"
  });

  const fileId = created.data.id;

  if (!fileId) {
    throw new Error("Google Drive did not return an uploaded file ID.");
  }

  await drive.permissions.create({
    fileId,
    requestBody: {
      role: "reader",
      type: "anyone"
    }
  });

  return `https://drive.google.com/uc?export=view&id=${fileId}`;
}
