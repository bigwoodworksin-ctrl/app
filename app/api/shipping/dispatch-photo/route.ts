import { NextRequest, NextResponse } from "next/server";
import { targetFromBody } from "@/lib/apiTarget";
import { requireApiAuth } from "@/lib/auth";
import { buildOrderPhotoFileName, photoTimestamp, uploadImageToCloudinary } from "@/lib/cloudinary";
import { toClientError } from "@/lib/env";
import { updateDispatchPhoto } from "@/lib/sheets";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type DispatchPhotoBody = {
  rowNumber?: number;
  trackingId?: string;
  fileName?: string;
  mimeType?: string;
  base64Image?: string;
  sheetId?: string;
  tabName?: string;
};

export async function POST(request: NextRequest) {
  try {
    requireApiAuth(request);

    const body = (await request.json()) as DispatchPhotoBody;
    const rowNumber = Number(body.rowNumber);
    const fileName = body.fileName?.trim() || "dispatch-photo.jpg";
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

    const timestamp = photoTimestamp();
    const cloudinaryFileName = buildOrderPhotoFileName(body.trackingId || "dispatch", fileName, 1, timestamp);
    const imageUrl = await uploadImageToCloudinary({ fileName: cloudinaryFileName, mimeType, base64Image });
    await updateDispatchPhoto(rowNumber, imageUrl, targetFromBody(body));

    return NextResponse.json({ success: true, imageUrl, rowNumber });
  } catch (error) {
    const message = toClientError(error);
    const status = message.toLowerCase().includes("unauthorized") ? 401 : 500;

    return NextResponse.json({ success: false, error: message }, { status });
  }
}
