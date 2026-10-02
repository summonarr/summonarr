"use client";

import { useEffect, useState } from "react";
import "./globals.css";
import { withBasePath } from "@/lib/base-path";
import { LOCALE_COOKIE, isLocale, negotiateLocale, type Locale } from "@/lib/i18n/locales";
import { createTranslator } from "@/lib/i18n/translate";
// Only the shared area, not the full CATALOGS: this boundary renders without
// the root layout (so without I18nProvider), and bundling every catalog into
// the crash page would cost far more than these few strings.
import enShared from "@/lib/i18n/messages/en/shared.json";
import esShared from "@/lib/i18n/messages/es/shared.json";

const SHARED_MESSAGES: Record<Locale, Record<string, string>> = { en: enShared, es: esShared };

// The picker's cookie, else the browser language — the same precedence the
// server applies (resolveLocale), read client-side because there is no
// request scope here.
function readClientLocale(): Locale {
  try {
    const match = document.cookie.split("; ").find((c) => c.startsWith(`${LOCALE_COOKIE}=`));
    const value = match?.slice(LOCALE_COOKIE.length + 1);
    if (isLocale(value)) return value;
  } catch {
    // cookies unavailable — fall through to the browser language
  }
  return negotiateLocale(navigator.languages?.join(",") || navigator.language);
}

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
  // English on the first render (matches any server render), then the
  // viewer's language from an effect, like the theme below (guardrail 16).
  const [locale, setLocale] = useState<Locale>("en");
  const t = createTranslator(locale, SHARED_MESSAGES[locale], SHARED_MESSAGES.en);

  useEffect(() => {
    console.error("[global/error]", error);
  }, [error]);

  useEffect(() => {
    setLocale(readClientLocale());
  }, []);

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
    <html lang={locale} className="dark" data-theme="dark" data-accent="indigo">
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
            {t("shared.error.title")}
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
            {t("shared.error.criticalDescription")}
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
              {t("shared.error.tryAgain")}
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
              {t("shared.error.goHome")}
            </a>
          </div>
        </div>
      </body>
    </html>
  );
}
