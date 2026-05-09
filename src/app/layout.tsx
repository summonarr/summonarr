import type { Metadata, Viewport } from "next";
import { Geist, Geist_Mono, Playfair_Display } from "next/font/google";
import { headers } from "next/headers";
import "./globals.css";
import { SessionProvider } from "next-auth/react";
import { auth } from "@/lib/auth";

const geist = Geist({
  variable: "--font-geist-sans",
  subsets: ["latin"],
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

const playfair = Playfair_Display({
  variable: "--font-playfair",
  subsets: ["latin"],
});

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  viewportFit: "cover",
  themeColor: "#09090b",
};

export const metadata: Metadata = {
  title: "Summonarr",
  description: "Media request management",
  appleWebApp: {
    capable: true,
    title: "Summonarr",
    statusBarStyle: "black-translucent",
  },
};

export default async function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  const session = await auth();
  // Reading headers() opts this layout into per-request rendering, which causes
  // Next.js 16 to read the `x-nonce` request header set by src/proxy.ts and stamp
  // the matching `nonce` attribute on its emitted inline scripts so they pass CSP.
  const _nonce = (await headers()).get("x-nonce") ?? undefined;
  void _nonce;
  return (
    <html
      lang="en"
      className={`${geist.variable} ${geistMono.variable} ${playfair.variable} h-full antialiased dark`}
      data-theme="dark"
      data-accent="indigo"
    >
      <body className="min-h-full bg-zinc-950 text-zinc-100">
        <SessionProvider session={session}>{children}</SessionProvider>
      </body>
    </html>
  );
}
