// Can Sonarr run an interactive release search for this issue scope? Pure and
// zero-import, so the issue Replace panel ("use client") and the server share
// one rule.
//
// Sonarr searches a SEASON or an EPISODE only: `/api/v3/release` with nothing
// but a `seriesId` answers with the indexers' RSS FEED — other shows'
// episodes, some of them grabbable — not a search for this series. So a
// whole-series (FULL) scope has no release search, and neither has a season or
// episode scope missing its numbers.
export function seriesReleaseScopeSearchable(
  scope: string,
  seasonNumber: number | null | undefined,
  episodeNumber: number | null | undefined,
): boolean {
  if (scope === "EPISODE") return seasonNumber != null && episodeNumber != null;
  if (scope === "SEASON") return seasonNumber != null;
  return false;
}
