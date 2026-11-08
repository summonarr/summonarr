// The For You page's subtitle: one sentence about where the picks came from.
// Pure (the translator is passed in), so tests/for-you-subtitle.test.mts runs it.
import type { Translator } from "./i18n/translate";

export interface ForYouSeedCounts {
  watchHistorySeeds: number;
  watchlistSeeds: number;
  requestSeeds: number;
}

// "updated 5m ago", localized. Same buckets as formatRelativeTime
// (src/lib/relative-time.ts), which is English-only. Server-rendered, so the
// browser receives finished text (guardrail 16 does not apply here).
export function updatedLabel(t: Translator, date: Date, now = Date.now()): string {
  const minutes = Math.floor((now - date.getTime()) / 60_000);
  if (minutes < 1) return t("browse.forYou.updated.justNow");
  if (minutes < 60) return t("browse.forYou.updated.minutes", { count: minutes });
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return t("browse.forYou.updated.hours", { count: hours });
  return t("browse.forYou.updated.days", { count: Math.floor(hours / 24) });
}

// "3 watched, 2 on your watchlist and 1 requested", or null with no seeds.
function seedList(t: Translator, seeds: ForYouSeedCounts): string | null {
  const parts: string[] = [];
  if (seeds.watchHistorySeeds > 0) parts.push(t("browse.forYou.seeds.watched", { count: seeds.watchHistorySeeds }));
  if (seeds.watchlistSeeds > 0) parts.push(t("browse.forYou.seeds.watchlist", { count: seeds.watchlistSeeds }));
  if (seeds.requestSeeds > 0) parts.push(t("browse.forYou.seeds.requested", { count: seeds.requestSeeds }));
  if (parts.length === 0) return null;
  if (parts.length === 1) return parts[0];
  return t("browse.forYou.seeds.join", { rest: parts.slice(0, -1).join(", "), last: parts[parts.length - 1] });
}

const joinParts = (parts: (string | null)[]) => parts.filter((p): p is string => !!p).join(" · ");

/**
 * The subtitle. `total` is the whole enriched shelf, `shown` what the filters
 * leave; the seed counts describe the WHOLE shelf (the same population as the
 * "of N picks" denominator), so a pill click doesn't re-count them. An
 * all-fallback shelf (cold start) says so instead of implying a taste profile.
 */
export function buildForYouSubtitle(
  t: Translator,
  view: { total: number; shown: number; allFallback: boolean; seeds: ForYouSeedCounts; computedAt: Date | null },
  now = Date.now(),
): string {
  if (view.total === 0) return t("browse.forYou.subtitle");
  const updated = view.computedAt ? updatedLabel(t, view.computedAt, now) : null;
  if (view.allFallback) {
    return joinParts([t("browse.forYou.fallbackPicks", { count: view.shown }), t("browse.forYou.fallbackHint"), updated]);
  }
  const seeds = seedList(t, view.seeds);
  return joinParts([
    // "200 of 200 picks" says nothing the plain count doesn't.
    view.shown === view.total
      ? t("browse.forYou.picks", { count: view.total })
      : t("browse.forYou.picksOf", { count: view.shown, total: view.total }),
    seeds ? t("browse.forYou.builtFrom", { seeds }) : null,
    updated,
  ]);
}
