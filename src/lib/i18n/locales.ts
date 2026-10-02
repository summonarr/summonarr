// Supported UI locales + Accept-Language negotiation.
//
// Leaf module — ZERO imports — so the proxy, server components, client
// components and tests can all load it. The locale is a per-device preference
// held in a plain cookie (not a URL segment): Summonarr has no localized
// routes, and prefixing every path would break the native client's API paths,
// webhook URLs and every bookmarked link.

// "pt" is Brazilian Portuguese and "zh" Simplified Chinese — the defaults Intl
// picks for those bare tags, so dates and numbers format to match the copy.
// Every catalog must carry exactly English's keys, plural variants included,
// so a language whose plurals need categories English lacks (few/many: ru, pl…)
// can't be added without first widening that rule.
export const LOCALES = ["en", "es", "fr", "de", "pt", "it", "zh"] as const;
export type Locale = (typeof LOCALES)[number];

export const DEFAULT_LOCALE: Locale = "en";

// Not HttpOnly on purpose: the language picker writes it from the client,
// and it carries nothing sensitive.
export const LOCALE_COOKIE = "summonarr-locale";

// Each language's name in ITSELF, so a user who can't read the current UI
// language can still find their own.
export const LOCALE_LABELS: Record<Locale, string> = {
  en: "English",
  es: "Español",
  fr: "Français",
  de: "Deutsch",
  pt: "Português (Brasil)",
  it: "Italiano",
  zh: "简体中文",
};

export function isLocale(value: unknown): value is Locale {
  return typeof value === "string" && (LOCALES as readonly string[]).includes(value);
}

// Picks the best supported locale from an Accept-Language header. Matches on
// the primary subtag only ("es-MX" → "es"), honours q-values, ignores q=0, and
// falls back to `fallback` (the instance default on the server) for an absent
// or unmatched header.
export function negotiateLocale(
  acceptLanguage: string | null | undefined,
  fallback: Locale = DEFAULT_LOCALE,
): Locale {
  if (!acceptLanguage) return fallback;
  const ranked = acceptLanguage
    .split(",")
    .map((part, index) => {
      const [tag, ...params] = part.trim().split(";");
      let q = 1;
      for (const p of params) {
        const [k, v] = p.trim().split("=");
        if (k === "q") {
          const n = Number(v);
          q = Number.isFinite(n) ? n : 0;
        }
      }
      return { primary: tag.trim().toLowerCase().split("-")[0], q, index };
    })
    .filter((r) => r.primary && r.q > 0)
    // Stable on equal q: earlier entries win, as the header lists them in
    // preference order.
    .sort((a, b) => b.q - a.q || a.index - b.index);
  for (const r of ranked) {
    if (isLocale(r.primary)) return r.primary;
  }
  return fallback;
}

// Cookie value wins when valid; otherwise negotiate from the header.
export function resolveLocale(
  cookieValue: string | null | undefined,
  acceptLanguage: string | null | undefined,
  fallback: Locale = DEFAULT_LOCALE,
): Locale {
  return isLocale(cookieValue) ? cookieValue : negotiateLocale(acceptLanguage, fallback);
}

// Reads the locale cookie out of a raw Cookie header (route handlers get a
// Request, not the next/headers cookie store).
export function localeCookieFrom(cookieHeader: string | null | undefined): string | undefined {
  if (!cookieHeader) return undefined;
  for (const part of cookieHeader.split(";")) {
    const eq = part.indexOf("=");
    if (eq > 0 && part.slice(0, eq).trim() === LOCALE_COOKIE) return part.slice(eq + 1).trim();
  }
  return undefined;
}
