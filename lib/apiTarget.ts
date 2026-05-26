import { NextRequest } from "next/server";
import type { SheetTarget } from "./sheets";

export function targetFromRequest(request: NextRequest): SheetTarget {
  return {
    sheetId: request.nextUrl.searchParams.get("sheetId") ?? undefined,
    tabName: request.nextUrl.searchParams.get("tabName") ?? undefined
  };
}

export function targetFromBody(body: { sheetId?: string; tabName?: string }): SheetTarget {
  return {
    sheetId: body.sheetId,
    tabName: body.tabName
  };
}
