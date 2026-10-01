// Supported UI locales + Accept-Language negotiation.
//
// Leaf module — ZERO imports — so the proxy, server components, client
// components and tests can all load it. The locale is a per-device preference
// held in a plain cookie (not a URL segment): Summonarr has no localized
// routes, and prefixing every path would break the native client's API paths,
// webhook URLs and every bookmarked link.

export const LOCALES = ["en", "es"] as const;
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
};

export function isLocale(value: unknown): value is Locale {
  return typeof value === "string" && (LOCALES as readonly string[]).includes(value);
}

// Picks the best supported locale from an Accept-Language header. Matches on
// the primary subtag only ("es-MX" → "es"), honours q-values, ignores q=0, and
// falls back to DEFAULT_LOCALE for an absent or unmatched header.
export function negotiateLocale(acceptLanguage: string | null | undefined): Locale {
  if (!acceptLanguage) return DEFAULT_LOCALE;
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
  return DEFAULT_LOCALE;
}

// Cookie value wins when valid; otherwise negotiate from the header.
export function resolveLocale(
  cookieValue: string | null | undefined,
  acceptLanguage: string | null | undefined,
): Locale {
  return isLocale(cookieValue) ? cookieValue : negotiateLocale(acceptLanguage);
}
