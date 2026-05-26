import { NextRequest, NextResponse } from "next/server";
import { targetFromRequest } from "@/lib/apiTarget";
import { requireApiAuth } from "@/lib/auth";
import { toClientError } from "@/lib/env";
import { getAvailableTabs } from "@/lib/sheets";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: NextRequest) {
  try {
    requireApiAuth(request);
    const tabs = await getAvailableTabs(targetFromRequest(request));

    return NextResponse.json({ tabs });
  } catch (error) {
    const message = toClientError(error);
    const status = message.toLowerCase().includes("unauthorized") ? 401 : 500;

    return NextResponse.json({ error: message, tabs: [] }, { status });
  }
}
