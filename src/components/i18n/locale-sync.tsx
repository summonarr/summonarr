"use client";

import { useEffect } from "react";
import { useLocale } from "@/components/i18n/i18n-provider";
import { LOCALE_COOKIE } from "@/lib/i18n/locales";
import { withBasePath } from "@/lib/base-path";

// Keeps User.locale (the language emails/push/Discord DMs are written in) in
// step with the web UI, without a DB write on every render:
//   - an EXPLICIT choice on this device (the picker's cookie) that differs from
//     the stored value is saved;
//   - an account that has never stored one is seeded with the language it is
//     browsing in (cookie or Accept-Language);
//   - otherwise nothing happens — a second device browsing in another language
//     without choosing one must not silently flip where this user's mail goes.
// Best-effort: a failed save simply retries on the next page load.
export function LocaleSync({ stored }: { stored: string | null }) {
  const locale = useLocale();
  useEffect(() => {
    const explicit = document.cookie.split(";").some((c) => c.trim().startsWith(`${LOCALE_COOKIE}=`));
    if (stored === locale || (stored !== null && !explicit)) return;
    void fetch(withBasePath("/api/profile/locale"), {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      credentials: "include",
      body: JSON.stringify({ locale }),
    }).catch(() => {});
  }, [locale, stored]);
  return null;
}
