import { NextRequest, NextResponse } from "next/server";
import { createSessionToken } from "@/lib/auth";
import { toClientError } from "@/lib/env";

export const runtime = "nodejs";

export async function POST(request: NextRequest) {
  try {
    const body = (await request.json()) as { password?: string };
    const token = createSessionToken(body.password ?? "");

    return NextResponse.json({ success: true, token });
  } catch (error) {
    return NextResponse.json({ success: false, error: toClientError(error) }, { status: 401 });
  }
}
