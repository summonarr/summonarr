import "server-only";

import { cache } from "react";
import { cookies, headers } from "next/headers";
import { LOCALE_COOKIE, resolveLocale, type Locale } from "./locales";
import { CATALOGS, FALLBACK_MESSAGES } from "./catalogs";
import { createTranslator, type Translator } from "./translate";
import { instanceDefaultLocale, localeForHeaders } from "./server-locale";

// The request's UI locale: the picker's cookie, else Accept-Language, else
// English. Memoized per request so a page and its layout agree.
export const getLocale = cache(async (): Promise<Locale> => {
  const [cookieStore, headerStore] = await Promise.all([cookies(), headers()]);
  return resolveLocale(
    cookieStore.get(LOCALE_COOKIE)?.value,
    headerStore.get("accept-language"),
    instanceDefaultLocale(),
  );
});

// Server-component translator: `const t = await getTranslator(); t("<key>")`.
export const getTranslator = cache(async (): Promise<Translator> => {
  const locale = await getLocale();
  return createTranslator(locale, CATALOGS[locale], FALLBACK_MESSAGES);
});

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
