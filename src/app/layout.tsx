import type { Metadata, Viewport } from "next";
import { Geist, Playfair_Display } from "next/font/google";
import "./globals.css";
import { SessionProvider } from "next-auth/react";
import { auth } from "@/lib/auth";

const geist = Geist({
  variable: "--font-geist-sans",
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
  return (
    <html lang="en" className={`${geist.variable} ${playfair.variable} h-full antialiased dark`}>
      <body className="min-h-full bg-zinc-950 text-zinc-100">
        <SessionProvider session={session}>{children}</SessionProvider>
      </body>
    </html>
  );
}
