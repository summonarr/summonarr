"use client";

import { useEffect } from "react";
import "./globals.css";
import { withBasePath } from "@/lib/base-path";

// Replaces the entire document on unrecoverable errors; must render its own <html>/<body> shell.
// globals.css is imported here directly because global-error.tsx bypasses the root layout,
// which is where globals.css is normally loaded — without this import, the --ds-* tokens
// below would be undefined and the page would render unstyled.
//
// The --ds-* palette is scoped to `[data-theme]` (globals.css), so <html> must carry the
// same data-theme / .dark / data-accent defaults the root layout stamps, or every var
// resolves to nothing. The root layout then corrects those from localStorage in a
// nonce'd inline script before first paint. That script cannot be reproduced here: this
// is a Client Component with no access to headers(), so it cannot obtain the CSP nonce,
// and src/proxy.ts's `strict-dynamic` policy blocks an un-nonced inline script outright.
// The persisted theme is applied from an effect instead — one frame in the dark default
// for a light-theme user, on a page that only appears when everything else has failed.
//
// Mirrors src/components/layout/state-page.tsx's shell inline: this file cannot import
// the app fonts (the next/font variables live on the root layout's <html>), and the
// router that next/link needs is exactly what just crashed. Keep the two in step.
const ACCENTS = ["indigo", "amber", "emerald", "cyan", "rose", "mono"];

const CTA_BASE: React.CSSProperties = {
  display: "inline-flex",
  alignItems: "center",
  justifyContent: "center",
  gap: 8,
  fontWeight: 500,
  fontSize: 14,
  minHeight: 44,
  borderRadius: 10,
  textDecoration: "none",
  width: "100%",
};

export default function GlobalError({
  error,
  retry,
}: {
  error: Error & { digest?: string };
  retry: () => void;
}) {
  useEffect(() => {
    console.error("[global/error]", error);
  }, [error]);

  // Same storage keys + validation as the root layout's THEME_INIT_SCRIPT and
  // theme-provider.tsx. Post-hydration, so it never disagrees with SSR (guardrail 16).
  useEffect(() => {
    try {
      const d = document.documentElement;
      const t = localStorage.getItem("summonarr-theme");
      const a = localStorage.getItem("summonarr-accent");
      if (t === "light" || t === "dark") {
        d.setAttribute("data-theme", t);
        d.classList.toggle("dark", t === "dark");
      }
      if (a && ACCENTS.includes(a)) d.setAttribute("data-accent", a);
    } catch {
      // storage unavailable — keep the dark default
    }
  }, []);

  return (
    <html lang="en" className="dark" data-theme="dark" data-accent="indigo">
      <body
        style={{
          margin: 0,
          background: "var(--ds-bg)",
          color: "var(--ds-fg)",
          fontFamily: "var(--font-geist-sans, ui-sans-serif, system-ui, sans-serif)",
          WebkitFontSmoothing: "antialiased",
        }}
      >
        <div
          className="ds-page-enter"
          style={{
            display: "flex",
            flexDirection: "column",
            alignItems: "center",
            justifyContent: "center",
            minHeight: "100dvh",
            padding: "48px 24px",
          }}
        >
          <div
            className="ds-mono"
            aria-hidden
            style={{
              fontSize: 64,
              fontWeight: 700,
              color: "var(--ds-fg-muted)",
              letterSpacing: "-0.02em",
              lineHeight: 1,
            }}
          >
            500
          </div>
          <h1
            style={{
              margin: "12px 0 0",
              fontSize: 22,
              fontWeight: 600,
              color: "var(--ds-fg)",
              textAlign: "center",
            }}
          >
            Something went wrong
          </h1>
          <p
            style={{
              margin: "8px 0 0",
              fontSize: 14,
              color: "var(--ds-fg-muted)",
              maxWidth: 320,
              lineHeight: 1.5,
              textAlign: "center",
            }}
          >
            A critical error occurred and the page could not be drawn. Try again, or reload from
            the home page.
          </p>
          <div
            style={{
              display: "flex",
              flexDirection: "column",
              alignItems: "stretch",
              gap: 8,
              marginTop: 28,
              width: "100%",
              maxWidth: 280,
            }}
          >
            <button
              type="button"
              onClick={() => retry()}
              className="ds-tap ds-hover-tint"
              style={{
                ...CTA_BASE,
                background: "var(--ds-accent)",
                color: "var(--ds-accent-fg)",
                border: 0,
              }}
            >
              Try again
            </button>
            <a
              href={withBasePath("/")}
              className="ds-tap ds-hover-tint"
              style={{
                ...CTA_BASE,
                background: "var(--ds-bg-2)",
                color: "var(--ds-fg)",
                border: "1px solid var(--ds-border)",
              }}
            >
              Go home
            </a>
          </div>
        </div>
      </body>
    </html>
  );
}
