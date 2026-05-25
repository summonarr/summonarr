import type { Metadata, Viewport } from "next";
import { Geist, Geist_Mono, Playfair_Display } from "next/font/google";
import { headers } from "next/headers";
import "./globals.css";
import { SessionProvider } from "next-auth/react";
import { auth } from "@/lib/auth";
import { readSummonarrSession } from "@/lib/session-server";
import { SummonarrSessionProvider } from "@/components/auth/summonarr-session-provider";
import { ThemeProvider } from "@/components/theme/theme-provider";

// Runs before first paint: applies the user's persisted theme/accent so there
// is no flash. Mirrors the storage keys + validation in theme-provider.tsx.
// Kept tiny and dependency-free; carries the CSP nonce so `strict-dynamic`
// allows it.
const THEME_INIT_SCRIPT = `(function(){try{var d=document.documentElement,t=localStorage.getItem("summonarr-theme"),a=localStorage.getItem("summonarr-accent");if(t==="light"||t==="dark"){d.setAttribute("data-theme",t);d.classList.toggle("dark",t==="dark");}if(a&&["indigo","amber","emerald","cyan","rose","mono"].indexOf(a)!==-1){d.setAttribute("data-accent",a);}}catch(e){}})();`;

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
  // Parallel to the next-auth session above. Reads the Summonarr session
  // cookie (set by /api/auth/me's backfill during the migration). Both
  // providers are mounted concurrently so consumers can move over one at a
  // time; the next-auth provider goes away in PR 5.
  const summonarrSessionClaims = await readSummonarrSession();
  const summonarrInitialSession = summonarrSessionClaims
    ? {
        user: {
          id: summonarrSessionClaims.id,
          role: summonarrSessionClaims.role,
          provider: summonarrSessionClaims.provider,
          mediaServer: summonarrSessionClaims.mediaServer ?? null,
        },
        sessionId: summonarrSessionClaims.sessionId,
        expiresAt: summonarrSessionClaims.expiresAt,
      }
    : null;
  // Reading headers() opts this layout into per-request rendering, which causes
  // Next.js 16 to read the `x-nonce` request header set by src/proxy.ts and stamp
  // the matching `nonce` attribute on its emitted inline scripts so they pass CSP.
  // We reuse it for the anti-FOUC theme script below (strict-dynamic requires it).
  const nonce = (await headers()).get("x-nonce") ?? undefined;
  return (
    <html
      lang="en"
      className={`${geist.variable} ${geistMono.variable} ${playfair.variable} h-full antialiased dark`}
      data-theme="dark"
      data-accent="indigo"
      suppressHydrationWarning
    >
      <head>
        <script
          nonce={nonce}
          // Sets data-theme / .dark / data-accent from localStorage before
          // paint. suppressHydrationWarning above absorbs the resulting
          // server/client attribute divergence on <html>.
          dangerouslySetInnerHTML={{ __html: THEME_INIT_SCRIPT }}
        />
      </head>
      <body
        className="min-h-full"
        style={{ background: "var(--ds-bg)", color: "var(--ds-fg)" }}
      >
        <SessionProvider session={session}>
          <SummonarrSessionProvider initialSession={summonarrInitialSession}>
            <ThemeProvider>{children}</ThemeProvider>
          </SummonarrSessionProvider>
        </SessionProvider>
      </body>
    </html>
  );
}
