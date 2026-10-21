// ADMIN-only "never watched" chip for the movie/TV detail pages (guardrail
// 14d). A server component with no hooks: the page passes its own translator
// and locale, and the verdict was read server-side through the same narrowed
// evidence read the cleanup delete re-check uses. Renders nothing unless the
// title (or, for a watched show, some season) is in a "never" state.
import Link from "next/link";
import { Chip } from "@/components/ui/design";
import type { Translator } from "@/lib/i18n/translate";
import type { TitleNeverWatched } from "@/lib/never-watched-report";

// [1,2,3,5,7,8] → "1–3, 5, 7–8"
export function seasonRanges(seasons: readonly number[]): string {
  const sorted = [...new Set(seasons)].sort((a, b) => a - b);
  const parts: string[] = [];
  for (let i = 0; i < sorted.length; i++) {
    let j = i;
    while (j + 1 < sorted.length && sorted[j + 1] === sorted[j] + 1) j++;
    parts.push(j > i ? `${sorted[i]}–${sorted[j]}` : String(sorted[i]));
    i = j;
  }
  return parts.join(", ");
}

export function NeverWatchedChip({ info, t, locale }: { info: TitleNeverWatched | null; t: Translator; locale: string }) {
  if (!info) return null;
  const never = info.state === "neverWatched" || info.state === "noPlaysSince";
  if (!never && info.neverWatchedSeasons.length === 0) return null;
  const date = info.windowStart
    ? new Intl.DateTimeFormat(locale, { dateStyle: "medium", timeZone: "UTC" }).format(new Date(info.windowStart))
    : null;
  const label = never
    ? date
      ? t("detail.neverWatched.since", { date })
      : t("detail.neverWatched.title")
    : t("detail.neverWatched.seasons", { count: info.neverWatchedSeasons.length, list: seasonRanges(info.neverWatchedSeasons) });
  return (
    <Link href={never ? "/admin/never-watched" : "/admin/never-watched?level=season"} title={t("detail.neverWatched.hint")}>
      <Chip tone="pending">{label}</Chip>
    </Link>
  );
}
