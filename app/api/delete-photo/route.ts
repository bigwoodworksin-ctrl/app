import { NextRequest, NextResponse } from "next/server";
import { requireApiAuth } from "@/lib/auth";
import { deleteImageFromCloudinary } from "@/lib/cloudinary";
import { toClientError } from "@/lib/env";
import { clearPhotoSlot } from "@/lib/sheets";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type DeleteBody = {
  rowNumber?: number;
  slot?: number;
  imageUrl?: string;
};

export async function POST(request: NextRequest) {
  try {
    requireApiAuth(request);

    const body = (await request.json()) as DeleteBody;
    const rowNumber = Number(body.rowNumber);
    const slot = Number(body.slot);
    const imageUrl = body.imageUrl?.trim() ?? "";

    if (!Number.isInteger(rowNumber) || rowNumber < 2) {
      throw new Error("Invalid row number. Please refresh and try again.");
    }

    if (![1, 2, 3].includes(slot)) {
      throw new Error("Invalid photo slot.");
    }

    if (imageUrl) {
      await deleteImageFromCloudinary(imageUrl);
    }

    await clearPhotoSlot(rowNumber, slot as 1 | 2 | 3);

    return NextResponse.json({ success: true, rowNumber, slot });
  } catch (error) {
    const message = toClientError(error);
    const status = message.toLowerCase().includes("unauthorized") ? 401 : 500;

    return NextResponse.json({ success: false, error: message }, { status });
  }
}
