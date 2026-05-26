import { NextRequest, NextResponse } from "next/server";
import { requireApiAuth } from "@/lib/auth";
import { buildOrderPhotoFileName, photoTimestamp, uploadImageToCloudinary } from "@/lib/cloudinary";
import { toClientError } from "@/lib/env";
import { appendPhotoLinks } from "@/lib/sheets";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type UploadBody = {
  rowNumber?: number;
  fileName?: string;
  mimeType?: string;
  base64Image?: string;
  personalization?: string;
  photos?: Array<{
    fileName?: string;
    mimeType?: string;
    base64Image?: string;
  }>;
};

export async function POST(request: NextRequest) {
  try {
    requireApiAuth(request);

    const body = (await request.json()) as UploadBody;
    const rowNumber = Number(body.rowNumber);
    const personalization = body.personalization ?? "";
    const photos =
      body.photos && body.photos.length > 0
        ? body.photos
        : [
            {
              fileName: body.fileName,
              mimeType: body.mimeType,
              base64Image: body.base64Image
            }
          ];

    if (!Number.isInteger(rowNumber) || rowNumber < 2) {
      throw new Error("Invalid row number. Please refresh and try again.");
    }

    if (photos.length > 3) {
      throw new Error("Please upload no more than 3 images at a time.");
    }

    const uploadedPhotos: Array<{ timestamp: string; imageUrl: string }> = [];

    for (const [index, photo] of photos.entries()) {
      const fileName = photo.fileName?.trim() || "order-photo.jpg";
      const mimeType = photo.mimeType?.trim() || "image/jpeg";
      const base64Image = photo.base64Image ?? "";

      if (!mimeType.startsWith("image/")) {
        throw new Error("Please upload image files only.");
      }

      if (!base64Image) {
        throw new Error("No image data was received.");
      }

      const timestamp = photoTimestamp();
      const cloudinaryFileName = buildOrderPhotoFileName(personalization, fileName, index + 1, timestamp);
      const imageUrl = await uploadImageToCloudinary({ fileName: cloudinaryFileName, mimeType, base64Image });
      uploadedPhotos.push({ timestamp, imageUrl });
    }

    const photoLink = await appendPhotoLinks(rowNumber, uploadedPhotos);

    return NextResponse.json({ success: true, imageUrl: uploadedPhotos[0]?.imageUrl, photoLink, rowNumber });
  } catch (error) {
    const message = toClientError(error);
    const status = message.toLowerCase().includes("unauthorized") ? 401 : 500;

    return NextResponse.json({ success: false, error: message }, { status });
  }
}
