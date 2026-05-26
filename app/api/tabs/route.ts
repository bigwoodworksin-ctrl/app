import { NextRequest, NextResponse } from "next/server";
import { targetFromRequest } from "@/lib/apiTarget";
import { requireApiAuth } from "@/lib/auth";
import { toClientError } from "@/lib/env";
import { getSheetMetadata } from "@/lib/sheets";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: NextRequest) {
  try {
    requireApiAuth(request);
    const metadata = await getSheetMetadata(targetFromRequest(request));

    return NextResponse.json(metadata);
  } catch (error) {
    const message = toClientError(error);
    const status = message.toLowerCase().includes("unauthorized") ? 401 : 500;

    return NextResponse.json({ error: message, spreadsheetTitle: "", tabs: [] }, { status });
  }
}
