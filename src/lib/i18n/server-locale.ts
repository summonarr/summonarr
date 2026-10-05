import "server-only";

import { DEFAULT_LOCALE, LOCALES, isLocale, localeCookieFrom, negotiateLocale, type Locale } from "./locales";
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

// SUMMONARR_DEFAULT_LOCALE is read on its PRIMARY SUBTAG — the rule
// negotiateLocale already applies to Accept-Language. The README describes the
// languages as "pt (Brazilian)" and "zh (Simplified)", which invites exactly
// the spellings an exact match rejected: "pt-BR", "zh-CN", "zh-Hans-CN", the
// POSIX "pt_BR.UTF-8". Null for a value that names no supported language (and
// for an unset or blank variable).
export function parseInstanceDefaultLocale(raw: string | undefined): Locale | null {
  const primary = raw?.trim().toLowerCase().split(/[-_.]/)[0];
  return isLocale(primary) ? primary : null;
}

export function instanceDefaultLocale(): Locale {
  return parseInstanceDefaultLocale(process.env.SUMMONARR_DEFAULT_LOCALE) ?? DEFAULT_LOCALE;
}

// Boot-time check for instrumentation.ts: the ONE warning to log when the
// variable is set but resolves to nothing. Without it every notification and
// API message to a user with no stored language quietly came out in English
// with nothing in the logs saying why. Null when unset, blank or valid — a
// valid value logs nothing (guardrail 7).
export function instanceDefaultLocaleWarning(): string | null {
  const raw = process.env.SUMMONARR_DEFAULT_LOCALE;
  if (raw === undefined || raw.trim() === "") return null;
  if (parseInstanceDefaultLocale(raw)) return null;
  return (
    `[i18n] SUMMONARR_DEFAULT_LOCALE="${raw}" is not a supported locale ` +
    `(${LOCALES.join(", ")}; a region tag such as pt-BR is read on its language part); using "${DEFAULT_LOCALE}"`
  );
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
