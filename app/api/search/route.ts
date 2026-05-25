import { NextRequest, NextResponse } from "next/server";
import { requireApiAuth } from "@/lib/auth";
import { toClientError } from "@/lib/env";
import { searchSheetRows } from "@/lib/sheets";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: NextRequest) {
  try {
    requireApiAuth(request);

    const query = request.nextUrl.searchParams.get("q") ?? "";
    const rows = await searchSheetRows(query, 100);

    return NextResponse.json({ rows });
  } catch (error) {
    const message = toClientError(error);
    const status = message.toLowerCase().includes("unauthorized") ? 401 : 500;

    return NextResponse.json({ error: message, rows: [] }, { status });
  }
}
