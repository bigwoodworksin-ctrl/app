import { NextRequest, NextResponse } from "next/server";
import { requireApiAuth } from "@/lib/auth";
import { uploadImageToDrive } from "@/lib/drive";
import { toClientError } from "@/lib/env";
import { updatePhotoLink } from "@/lib/sheets";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type UploadBody = {
  rowNumber?: number;
  fileName?: string;
  mimeType?: string;
  base64Image?: string;
};

export async function POST(request: NextRequest) {
  try {
    requireApiAuth(request);

    const body = (await request.json()) as UploadBody;
    const rowNumber = Number(body.rowNumber);
    const fileName = body.fileName?.trim() || "order-photo.jpg";
    const mimeType = body.mimeType?.trim() || "image/jpeg";
    const base64Image = body.base64Image ?? "";

    if (!Number.isInteger(rowNumber) || rowNumber < 2) {
      throw new Error("Invalid row number. Please refresh and try again.");
    }

    if (!mimeType.startsWith("image/")) {
      throw new Error("Please upload an image file.");
    }

    if (!base64Image) {
      throw new Error("No image data was received.");
    }

    const imageUrl = await uploadImageToDrive({ fileName, mimeType, base64Image });
    await updatePhotoLink(rowNumber, imageUrl);

    return NextResponse.json({ success: true, imageUrl, rowNumber });
  } catch (error) {
    const message = toClientError(error);
    const status = message.toLowerCase().includes("unauthorized") ? 401 : 500;

    return NextResponse.json({ success: false, error: message }, { status });
  }
}
