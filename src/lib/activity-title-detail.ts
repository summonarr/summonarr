// Pure helpers behind the admin per-title Activity page
// (src/app/(app)/admin/activity/media/[tmdbId]/page.tsx). Zero-import, so the
// unit suite loads it directly (tests/activity-title-detail.test.mts).

export type TitleMediaType = "MOVIE" | "TV";

/** `?type=`, in either case the linking surfaces send it; anything else is untyped. */
export function parseTitleMediaType(raw: string | undefined): TitleMediaType | undefined {
  if (raw === "TV" || raw === "tv") return "TV";
  if (raw === "MOVIE" || raw === "movie") return "MOVIE";
  return undefined;
}

/**
 * TMDB numbers movies and shows separately, so one id can name a film AND a
 * series, and an untyped page would add both titles' plays together. When the
 * id has typed plays under BOTH types this names the one with more plays (MOVIE
 * on a tie), for a redirect to its typed URL; one type or none needs no choice.
 */
export function dominantMediaType(
  groups: readonly { mediaType: string | null; count: number }[],
): TitleMediaType | null {
  const movie = groups.find((g) => g.mediaType === "MOVIE")?.count ?? 0;
  const tv = groups.find((g) => g.mediaType === "TV")?.count ?? 0;
  if (movie === 0 || tv === 0) return null;
  return tv > movie ? "TV" : "MOVIE";
}

export const COMPLETION_BUCKETS = ["0-25%", "25-50%", "50-75%", "75-95%", "95-100%"] as const;

function completionBucket(playDuration: number, duration: number): number {
  const pct = duration > 0 ? (playDuration / duration) * 100 : 0;
  return pct >= 95 ? 4 : pct >= 75 ? 3 : pct >= 50 ? 2 : pct >= 25 ? 1 : 0;
}

/**
 * The per-play distributions the stats query doesn't aggregate, from the
 * recent-plays sample: watched count, completion histogram and platforms (most
 * used first).
 */
export function sampleDistributions(
  plays: readonly { watched: boolean; platform: string | null; playDuration: number; duration: number }[],
): {
  watchedCount: number;
  completionHist: { label: string; count: number }[];
  platforms: { label: string; count: number }[];
} {
  const completion = COMPLETION_BUCKETS.map(() => 0);
  const platformMap = new Map<string, number>();
  let watchedCount = 0;
  for (const p of plays) {
    if (p.watched) watchedCount += 1;
    if (p.platform) platformMap.set(p.platform, (platformMap.get(p.platform) ?? 0) + 1);
    completion[completionBucket(p.playDuration, p.duration)] += 1;
  }
  return {
    watchedCount,
    completionHist: COMPLETION_BUCKETS.map((label, i) => ({ label, count: completion[i] })),
    platforms: [...platformMap.entries()]
      .map(([label, count]) => ({ label, count }))
      .sort((a, b) => b.count - a.count),
  };
}
