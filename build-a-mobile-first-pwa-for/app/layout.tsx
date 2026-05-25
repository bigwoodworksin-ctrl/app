import type { Metadata, Viewport } from "next";
import type { ReactNode } from "react";
import "./globals.css";

export const metadata: Metadata = {
  title: "Order Photo Manager",
  description: "Search orders and attach Drive-backed photos to Google Sheet rows.",
  manifest: "/manifest.json",
  appleWebApp: {
    capable: true,
    title: "Order Photos",
    statusBarStyle: "default"
  }
};

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  themeColor: "#176b5b"
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
