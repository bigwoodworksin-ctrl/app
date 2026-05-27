import { NextRequest, NextResponse } from "next/server";
import { targetFromRequest } from "@/lib/apiTarget";
import { requireApiAuth } from "@/lib/auth";
import { toClientError } from "@/lib/env";
import { findShippingRowByTracking } from "@/lib/sheets";
import type { SheetTarget } from "@/lib/sheets";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: NextRequest) {
  try {
    requireApiAuth(request);

    const trackingId = request.nextUrl.searchParams.get("trackingId") ?? "";
    const rawTargets = request.nextUrl.searchParams.get("targets");
    const targets = rawTargets ? (JSON.parse(rawTargets) as Array<SheetTarget & { sheetName?: string }>) : [];
    const safeTargets = targets.filter((target) => target.sheetId || target.tabName);
    let row = null;

    if (safeTargets.length > 0) {
      for (const target of safeTargets) {
        const foundRow = await findShippingRowByTracking(trackingId, target);

        if (foundRow) {
          row = {
            ...foundRow,
            sheetId: target.sheetId,
            tabName: target.tabName,
            sheetName: target.sheetName
          };
          break;
        }
      }
    } else {
      row = await findShippingRowByTracking(trackingId, targetFromRequest(request));
    }

    return NextResponse.json({ row });
  } catch (error) {
    const message = toClientError(error);
    const status = message.toLowerCase().includes("unauthorized") ? 401 : 500;

    return NextResponse.json({ error: message, row: null }, { status });
  }
}
