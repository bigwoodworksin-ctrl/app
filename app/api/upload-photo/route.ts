import { NextRequest, NextResponse } from "next/server";
import { requireApiAuth } from "@/lib/auth";
import { buildOrderPhotoFileName, photoTimestamp, uploadImageToCloudinary } from "@/lib/cloudinary";
import { toClientError } from "@/lib/env";
import { getEmptyPhotoSlots, writePhotoSlots } from "@/lib/sheets";

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

    const emptySlots = await getEmptyPhotoSlots(rowNumber);

    if (photos.length > emptySlots.length) {
      throw new Error(`Only ${emptySlots.length} photo slot${emptySlots.length === 1 ? "" : "s"} available for this row.`);
    }

    const uploadedPhotos: Array<{ slot: 1 | 2 | 3; imageUrl: string }> = [];

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
      const slot = emptySlots[index];

      if (!slot) {
        throw new Error("No empty photo slot is available for this upload.");
      }

      const cloudinaryFileName = buildOrderPhotoFileName(personalization, fileName, index + 1, timestamp);
      const imageUrl = await uploadImageToCloudinary({ fileName: cloudinaryFileName, mimeType, base64Image });
      uploadedPhotos.push({ slot, imageUrl });
    }

    const photoLinks = await writePhotoSlots(rowNumber, uploadedPhotos);

    return NextResponse.json({ success: true, imageUrl: uploadedPhotos[0]?.imageUrl, photoLinks, rowNumber });
  } catch (error) {
    const message = toClientError(error);
    const status = message.toLowerCase().includes("unauthorized") ? 401 : 500;

    return NextResponse.json({ success: false, error: message }, { status });
  }
}
