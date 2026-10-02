import "server-only";

import { DEFAULT_LOCALE, isLocale, localeCookieFrom, negotiateLocale, type Locale } from "./locales";
import { CATALOGS, FALLBACK_MESSAGES } from "./catalogs";
import { createTranslator, type Translator } from "./translate";

// Server-side locale resolution for text that is NOT rendered by a page:
// API responses (per request) and notifications (per recipient — an email,
// push or Discord message has no browser and no cookie, so the recipient's
// stored User.locale decides).
//
// The instance default is an env var, not a Setting, on purpose: it is read on
// every API response, and a Setting would add a DB read to all of them (and to
// every route test's stubbed prisma).

export function instanceDefaultLocale(): Locale {
  const v = process.env.SUMMONARR_DEFAULT_LOCALE?.trim().toLowerCase();
  return isLocale(v) ? v : DEFAULT_LOCALE;
}

const translators = new Map<Locale, Translator>();

export function translatorFor(locale: Locale): Translator {
  let t = translators.get(locale);
  if (!t) {
    t = createTranslator(locale, CATALOGS[locale], FALLBACK_MESSAGES);
    translators.set(locale, t);
  }
  return t;
}

// The language an API response should be written in:
//   1. the picker's cookie (an explicit choice on this device);
//   2. a native client (X-Summonarr-Client) → the instance default — the iOS
//      apps' own UI is English, so following the phone's Accept-Language would
//      mix languages inside one screen;
//   3. the browser's Accept-Language;
//   4. the instance default.
// A request with none of these (every unit test) gets the instance default,
// which is English unless SUMMONARR_DEFAULT_LOCALE says otherwise.
export function localeForRequest(req: Request): Locale {
  return localeForHeaders(req.headers);
}

// The same rule over a bare header bag — next/headers' headers() in a server
// component or helper that has no Request in hand (getContentLocale).
export function localeForHeaders(h: { get(name: string): string | null; has(name: string): boolean }): Locale {
  const fromCookie = localeCookieFrom(h.get("cookie"));
  if (isLocale(fromCookie)) return fromCookie;
  const fallback = instanceDefaultLocale();
  if (h.has("x-summonarr-client")) return fallback;
  return negotiateLocale(h.get("accept-language"), fallback);
}

export function translatorForRequest(req: Request): Translator {
  return translatorFor(localeForRequest(req));
}

// The language a notification to this user should be written in.
export function localeForUser(user: { locale?: string | null } | null | undefined): Locale {
  const stored = user?.locale;
  return isLocale(stored) ? stored : instanceDefaultLocale();
}

export function translatorForUser(user: { locale?: string | null } | null | undefined): Translator {
  return translatorFor(localeForUser(user));
}
