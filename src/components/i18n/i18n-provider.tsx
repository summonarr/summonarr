"use client";

import { createContext, useCallback, useContext, useMemo } from "react";
import { useRouter } from "next/navigation";
import { LOCALE_COOKIE, type Locale } from "@/lib/i18n/locales";
import { createTranslator, type Messages, type Translator } from "@/lib/i18n/translate";

type I18nContextValue = { locale: Locale; t: Translator };

const I18nContext = createContext<I18nContextValue | null>(null);

// Receives the active catalog and the English fallback from the root layout,
// so client components translate synchronously with the same strings the
// server rendered — no hydration drift, no client-side catalog fetch.
export function I18nProvider({
  locale,
  messages,
  fallback,
  children,
}: {
  locale: Locale;
  messages: Messages;
  fallback: Messages;
  children: React.ReactNode;
}) {
  const value = useMemo(
    () => ({ locale, t: createTranslator(locale, messages, fallback) }),
    [locale, messages, fallback],
  );
  return <I18nContext.Provider value={value}>{children}</I18nContext.Provider>;
}

function useI18n(): I18nContextValue {
  const ctx = useContext(I18nContext);
  if (!ctx) throw new Error("useT/useLocale must be used inside <I18nProvider>");
  return ctx;
}

export function useT(): Translator {
  return useI18n().t;
}

export function useLocale(): Locale {
  return useI18n().locale;
}

// Persists the picked language for this device (one year) and re-renders the
// server tree so server components pick it up too.
export function useSetLocale(): (locale: Locale) => void {
  const router = useRouter();
  return useCallback(
    (locale: Locale) => {
      const secure = location.protocol === "https:" ? "; Secure" : "";
      document.cookie = `${LOCALE_COOKIE}=${locale}; Max-Age=${60 * 60 * 24 * 365}; Path=/; SameSite=Lax${secure}`;
      router.refresh();
    },
    [router],
  );
}
