import "server-only";

import { cache } from "react";
import { headers } from "next/headers";
import type { Locale } from "./locales";
import type { Translator } from "./translate";
import { localeForHeaders, translatorFor } from "./server-locale";

// The request's UI locale — localeForHeaders' rule (server-locale.ts): the
// picker's cookie (read from the Cookie header), else a native client's
// instance default, else Accept-Language, else the instance default. Memoized
// per request so a page and its layout agree.
export const getLocale = cache(async (): Promise<Locale> => localeForHeaders(await headers()));

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
