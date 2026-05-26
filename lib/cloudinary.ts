import crypto from "crypto";
import { getAppEnv } from "./env";

const CLOUDINARY_FOLDER = "order-photos";

function safePublicId(fileName: string): string {
  const withoutExtension = fileName.replace(/\.[^.]+$/, "");
  const cleaned = withoutExtension.replace(/[^\w\-]+/g, "").trim();
  return cleaned || "order-photo";
}

export function photoTimestamp(date = new Date()): string {
  const day = String(date.getDate()).padStart(2, "0");
  const month = date.toLocaleString("en-US", { month: "short" });
  const year = String(date.getFullYear());
  const hours = String(date.getHours()).padStart(2, "0");
  const minutes = String(date.getMinutes()).padStart(2, "0");
  const seconds = String(date.getSeconds()).padStart(2, "0");

  return `${day}${month}${year}${hours}${minutes}${seconds}`;
}

function signParams(params: Record<string, string | number>, apiSecret: string): string {
  const payload = Object.entries(params)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, value]) => `${key}=${value}`)
    .join("&");

  return crypto.createHash("sha1").update(`${payload}${apiSecret}`).digest("hex");
}

export function buildOrderPhotoFileName(
  personalization: string,
  fallbackFileName: string,
  index = 1,
  timestamp = photoTimestamp()
): string {
  const prefix = personalization.replace(/[^a-z0-9]/gi, "").slice(0, 2).toUpperCase() || "OR";
  const extension = fallbackFileName.toLowerCase().endsWith(".png") ? ".png" : ".jpg";

  return `${prefix}${timestamp}-${index}${extension}`;
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
  const timestamp = Math.floor(Date.now() / 1000);
  const publicId = `cloudinary-check-${timestamp}`;
  const signatureParams = {
    folder: CLOUDINARY_FOLDER,
    overwrite: "true",
    public_id: publicId,
    timestamp
  };
  const signature = signParams(signatureParams, env.CLOUDINARY_API_SECRET);
  const formData = new FormData();

  formData.set(
    "file",
    "data:image/gif;base64,R0lGODlhAQABAAAAACw="
  );
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
  const data = (await response.json()) as {
    secure_url?: string;
    error?: { message?: string };
  };

  if (!response.ok) {
    throw new Error(`Cloudinary check failed: ${data.error?.message ?? "Check your Cloudinary credentials."}`);
  }

  return {
    cloudName: env.CLOUDINARY_CLOUD_NAME,
    plan: "upload access verified",
    creditsUsed: null,
    creditsLimit: null,
    testUrl: data.secure_url ?? null,
    canConnect: true
  };
}

function publicIdFromCloudinaryUrl(imageUrl: string): string {
  const url = new URL(imageUrl);
  const parts = url.pathname.split("/").filter(Boolean);
  const uploadIndex = parts.indexOf("upload");

  if (uploadIndex === -1) {
    throw new Error("This photo URL is not a Cloudinary upload URL.");
  }

  const publicIdParts = parts.slice(uploadIndex + 1).filter((part) => !/^v\d+$/.test(part));
  const publicIdWithExtension = publicIdParts.join("/");
  const publicId = publicIdWithExtension.replace(/\.[^.]+$/, "");

  if (!publicId) {
    throw new Error("Could not identify the Cloudinary photo to delete.");
  }

  return decodeURIComponent(publicId);
}

export async function deleteImageFromCloudinary(imageUrl: string): Promise<void> {
  const env = getAppEnv();
  const publicId = publicIdFromCloudinaryUrl(imageUrl);
  const timestamp = Math.floor(Date.now() / 1000);
  const signatureParams = {
    invalidate: "true",
    public_id: publicId,
    timestamp
  };
  const signature = signParams(signatureParams, env.CLOUDINARY_API_SECRET);
  const formData = new FormData();

  formData.set("api_key", env.CLOUDINARY_API_KEY);
  formData.set("timestamp", String(timestamp));
  formData.set("signature", signature);
  formData.set("public_id", publicId);
  formData.set("invalidate", "true");

  const response = await fetch(`https://api.cloudinary.com/v1_1/${env.CLOUDINARY_CLOUD_NAME}/image/destroy`, {
    method: "POST",
    body: formData
  });
  const data = (await response.json()) as { result?: string; error?: { message?: string } };

  if (!response.ok || (data.result !== "ok" && data.result !== "not found")) {
    throw new Error(`Cloudinary delete failed: ${data.error?.message ?? data.result ?? "Unknown delete error."}`);
  }
}
