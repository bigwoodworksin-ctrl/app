import crypto from "crypto";
import { getAppEnv } from "./env";

const CLOUDINARY_FOLDER = "order-photos";

function safePublicId(fileName: string): string {
  const withoutExtension = fileName.replace(/\.[^.]+$/, "");
  const cleaned = withoutExtension.replace(/[^\w\-]+/g, "").trim();
  return cleaned || "order-photo";
}

function dateStamp(date: Date): string {
  const day = String(date.getDate()).padStart(2, "0");
  const month = date.toLocaleString("en-US", { month: "short" });
  const year = String(date.getFullYear());

  return `${day}${month}${year}`;
}

function signParams(params: Record<string, string | number>, apiSecret: string): string {
  const payload = Object.entries(params)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, value]) => `${key}=${value}`)
    .join("&");

  return crypto.createHash("sha1").update(`${payload}${apiSecret}`).digest("hex");
}

export function buildOrderPhotoFileName(personalization: string, fallbackFileName: string): string {
  const prefix = personalization.replace(/[^a-z0-9]/gi, "").slice(0, 2).toUpperCase() || "OR";
  const extension = fallbackFileName.toLowerCase().endsWith(".png") ? ".png" : ".jpg";

  return `${prefix}${dateStamp(new Date())}${extension}`;
}

export async function uploadImageToCloudinary(params: {
  fileName: string;
  mimeType: string;
  base64Image: string;
}): Promise<string> {
  const env = getAppEnv();
  const timestamp = Math.floor(Date.now() / 1000);
  const publicId = safePublicId(params.fileName);
  const signatureParams = {
    folder: CLOUDINARY_FOLDER,
    overwrite: "true",
    public_id: publicId,
    timestamp
  };
  const signature = signParams(signatureParams, env.CLOUDINARY_API_SECRET);
  const formData = new FormData();

  formData.set("file", `data:${params.mimeType};base64,${params.base64Image}`);
  formData.set("api_key", env.CLOUDINARY_API_KEY);
  formData.set("timestamp", String(timestamp));
  formData.set("signature", signature);
  formData.set("folder", CLOUDINARY_FOLDER);
  formData.set("public_id", publicId);
  formData.set("overwrite", "true");

  const response = await fetch(`https://api.cloudinary.com/v1_1/${env.CLOUDINARY_CLOUD_NAME}/image/upload`, {
    method: "POST",
    body: formData
  });
  const data = (await response.json()) as { secure_url?: string; error?: { message?: string } };

  if (!response.ok || !data.secure_url) {
    throw new Error(`Cloudinary upload failed: ${data.error?.message ?? "Unknown upload error."}`);
  }

  return data.secure_url;
}

export async function checkCloudinaryAccess() {
  const env = getAppEnv();
  const url = new URL(`https://api.cloudinary.com/v1_1/${env.CLOUDINARY_CLOUD_NAME}/usage`);
  const auth = Buffer.from(`${env.CLOUDINARY_API_KEY}:${env.CLOUDINARY_API_SECRET}`).toString("base64");

  const response = await fetch(url, {
    headers: {
      authorization: `Basic ${auth}`
    }
  });
  const data = (await response.json()) as {
    plan?: string;
    credits?: { usage?: number; limit?: number };
    error?: { message?: string };
  };

  if (!response.ok) {
    throw new Error(`Cloudinary check failed: ${data.error?.message ?? "Check your Cloudinary credentials."}`);
  }

  return {
    cloudName: env.CLOUDINARY_CLOUD_NAME,
    plan: data.plan ?? "unknown",
    creditsUsed: data.credits?.usage ?? null,
    creditsLimit: data.credits?.limit ?? null,
    canConnect: true
  };
}
