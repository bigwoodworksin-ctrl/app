import { NextRequest, NextResponse } from "next/server";
import { requireApiAuth } from "@/lib/auth";
import { targetFromRequest } from "@/lib/apiTarget";
import { toClientError } from "@/lib/env";
import { searchSheetRows } from "@/lib/sheets";
import type { SheetTarget } from "@/lib/sheets";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: NextRequest) {
  try {
    requireApiAuth(request);

    const query = request.nextUrl.searchParams.get("q") ?? "";
    const rawTargets = request.nextUrl.searchParams.get("targets");
    const targets = rawTargets ? (JSON.parse(rawTargets) as Array<SheetTarget & { sheetName?: string }>) : [];
    const safeTargets = targets.filter((target) => target.sheetId || target.tabName);
    const rows =
      safeTargets.length > 0
        ? (
            await Promise.all(
              safeTargets.map(async (target) => {
                const targetRows = await searchSheetRows(query, 100, target);

                return targetRows.map((row) => ({
                  ...row,
                  sheetId: target.sheetId,
                  tabName: target.tabName,
                  sheetName: target.sheetName
                }));
              })
            )
          )
            .flat()
            .sort((left, right) => left.priority - right.priority || left.rowNumber - right.rowNumber)
            .slice(0, 100)
        : await searchSheetRows(query, 100, targetFromRequest(request));

    return NextResponse.json({ rows });
  } catch (error) {
    const message = toClientError(error);
    const status = message.toLowerCase().includes("unauthorized") ? 401 : 500;

    return NextResponse.json({ error: message, rows: [] }, { status });
  }
}
