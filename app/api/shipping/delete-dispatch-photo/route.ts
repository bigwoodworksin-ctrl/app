import { NextRequest, NextResponse } from "next/server";
import { targetFromBody } from "@/lib/apiTarget";
import { requireApiAuth } from "@/lib/auth";
import { deleteImageFromCloudinary } from "@/lib/cloudinary";
import { toClientError } from "@/lib/env";
import { clearDispatchPhoto } from "@/lib/sheets";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type DeleteDispatchPhotoBody = {
  rowNumber?: number;
  imageUrl?: string;
  sheetId?: string;
  tabName?: string;
};

export async function POST(request: NextRequest) {
  try {
    requireApiAuth(request);

    const body = (await request.json()) as DeleteDispatchPhotoBody;
    const rowNumber = Number(body.rowNumber);
    const imageUrl = body.imageUrl?.trim() ?? "";

    if (!Number.isInteger(rowNumber) || rowNumber < 2) {
      throw new Error("Invalid row number. Please refresh and try again.");
    }

    if (imageUrl) {
      await deleteImageFromCloudinary(imageUrl);
    }

    await clearDispatchPhoto(rowNumber, targetFromBody(body));

    return NextResponse.json({ success: true, rowNumber });
  } catch (error) {
    const message = toClientError(error);
    const status = message.toLowerCase().includes("unauthorized") ? 401 : 500;

    return NextResponse.json({ success: false, error: message }, { status });
  }
}
