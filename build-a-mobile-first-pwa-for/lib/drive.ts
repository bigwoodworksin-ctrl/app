import { Readable } from "stream";
import { getAppEnv } from "./env";
import { getDriveClient } from "./google";

function safeFileName(fileName: string): string {
  const cleaned = fileName.replace(/[^\w.\- ]+/g, "-").trim();
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  return cleaned ? `${stamp}-${cleaned}` : `${stamp}-order-photo.jpg`;
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
