import "server-only";

import { cache } from "react";
import { cookies, headers } from "next/headers";
import { LOCALE_COOKIE, isLocale, negotiateLocale, type Locale } from "./locales";
import type { Translator } from "./translate";
import { instanceDefaultLocale, localeForHeaders, translatorFor } from "./server-locale";

// The request's UI locale — localeForHeaders' rule (server-locale.ts), with
// the cookie read from the request's cookie store: the picker's cookie, else a
// native client's instance default, else Accept-Language, else the instance
// default. Memoized per request so a page and its layout agree.
export const getLocale = cache(async (): Promise<Locale> => {
  const [cookieStore, headerStore] = await Promise.all([cookies(), headers()]);
  const fromCookie = cookieStore.get(LOCALE_COOKIE)?.value;
  if (isLocale(fromCookie)) return fromCookie;
  const fallback = instanceDefaultLocale();
  if (headerStore.has("x-summonarr-client")) return fallback;
  return negotiateLocale(headerStore.get("accept-language"), fallback);
});

// Server-component translator: `const t = await getTranslator(); t("<key>")`.
// The process-wide translator for the locale, not a new one per request.
export const getTranslator = cache(async (): Promise<Translator> => translatorFor(await getLocale()));

// The language TMDB CONTENT (titles, overviews, genres) is shown in, for the
// current request — localeForRequest's precedence, so a native client gets the
// instance default rather than its phone's language. Outside a request scope
// (unit tests, library code run from a cron's own helpers) it is English, which
// makes the content overlay a no-op there.
export async function getContentLocale(): Promise<Locale> {
  try {
    return localeForHeaders(await headers());
  } catch {
    return "en";
  }
}
