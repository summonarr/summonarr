import "server-only";

import { cache } from "react";
import { cookies, headers } from "next/headers";
import { LOCALE_COOKIE, resolveLocale, type Locale } from "./locales";
import { CATALOGS, FALLBACK_MESSAGES } from "./catalogs";
import { createTranslator, type Translator } from "./translate";

// The request's UI locale: the picker's cookie, else Accept-Language, else
// English. Memoized per request so a page and its layout agree.
export const getLocale = cache(async (): Promise<Locale> => {
  const [cookieStore, headerStore] = await Promise.all([cookies(), headers()]);
  return resolveLocale(
    cookieStore.get(LOCALE_COOKIE)?.value,
    headerStore.get("accept-language"),
  );
});

// Server-component translator: `const t = await getTranslator(); t("<key>")`.
export const getTranslator = cache(async (): Promise<Translator> => {
  const locale = await getLocale();
  return createTranslator(locale, CATALOGS[locale], FALLBACK_MESSAGES);
});
