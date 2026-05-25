import crypto from "crypto";
import { NextRequest } from "next/server";
import { getAppEnv } from "./env";

function tokenForPassword(password: string): string {
  return crypto.createHash("sha256").update(password).digest("hex");
}

function safeEqual(left: string, right: string): boolean {
  const leftBuffer = Buffer.from(left);
  const rightBuffer = Buffer.from(right);

  if (leftBuffer.length !== rightBuffer.length) {
    return false;
  }

  return crypto.timingSafeEqual(leftBuffer, rightBuffer);
}

export function createSessionToken(password: string): string {
  const { APP_PASSWORD } = getAppEnv();

  if (!safeEqual(password, APP_PASSWORD)) {
    throw new Error("Wrong password. Please try again.");
  }

  return tokenForPassword(APP_PASSWORD);
}

export function requireApiAuth(request: NextRequest): void {
  const { APP_PASSWORD } = getAppEnv();
  const expectedToken = tokenForPassword(APP_PASSWORD);
  const token = request.headers.get("x-app-token") ?? "";

  if (!token || !safeEqual(token, expectedToken)) {
    throw new Error("Unauthorized. Please sign in again.");
  }
}
