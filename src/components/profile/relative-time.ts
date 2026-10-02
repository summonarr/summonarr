import type { Translator } from "@/lib/i18n/translate";

// The buckets of formatRelativeTime (src/lib/relative-time.ts) — "just now",
// "5m ago", "3h ago", "2d ago" — with the words from the active catalog.
// Reads Date.now(), so "use client" callers must gate it behind useHasMounted
// (CLAUDE.md guardrail 16).
export function translatedRelativeTime(date: string | number | Date, t: Translator): string {
  const minutes = Math.floor((Date.now() - new Date(date).getTime()) / 60_000);
  if (minutes < 1) return t("profile.time.justNow");
  if (minutes < 60) return t("profile.time.minutesAgo", { n: minutes });
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return t("profile.time.hoursAgo", { n: hours });
  return t("profile.time.daysAgo", { n: Math.floor(hours / 24) });
}
