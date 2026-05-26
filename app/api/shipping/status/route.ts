import { NextRequest, NextResponse } from "next/server";
import { targetFromBody } from "@/lib/apiTarget";
import { requireApiAuth } from "@/lib/auth";
import { toClientError } from "@/lib/env";
import { updateShippingStatus } from "@/lib/sheets";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type StatusBody = {
  rowNumber?: number;
  status?: string;
  sheetId?: string;
  tabName?: string;
};

export async function POST(request: NextRequest) {
  try {
    requireApiAuth(request);

    const body = (await request.json()) as StatusBody;
    const rowNumber = Number(body.rowNumber);

    if (!Number.isInteger(rowNumber) || rowNumber < 2) {
      throw new Error("Invalid row number. Please refresh and try again.");
    }

    await updateShippingStatus(rowNumber, body.status ?? "", targetFromBody(body));

    return NextResponse.json({ success: true, rowNumber, status: body.status });
  } catch (error) {
    const message = toClientError(error);
    const status = message.toLowerCase().includes("unauthorized") ? 401 : 500;

    return NextResponse.json({ success: false, error: message }, { status });
  }
}
