import { prisma } from "@/lib/prisma";
import { posterUrl } from "@/lib/tmdb-types";

// Resolve TMDB poster URLs for activity views. Returns a tmdbId→url map; url
// is absent when the title is uncached/unmapped so callers fall back to the
// letter placeholder.
//
// TmdbMediaCore first: it carries `posterPath` as a plain column, so the
// lookup avoids transferring and parsing the full `:details` JSON blob per id.
// Core rows expire and get purged, so ids missing from core fall back to the
// `TmdbCache` `:details` rows the sync layer already populates — the same
// source the overview's Now Playing cards use.
//
// Both MOVIE and TV rows (and both `movie:`/`tv:` fallback keys) are queried
// for every id because `mediaType` can be null or mismatched on unmapped rows;
// the first poster found per id wins.
export async function resolvePosterMap(
  items: { tmdbId: number | null }[],
): Promise<Record<number, string>> {
  const ids = [
    ...new Set(
      items
        .map((i) => i.tmdbId)
        .filter((id): id is number => id != null),
    ),
  ];
  if (ids.length === 0) return {};

  const map: Record<number, string> = {};

  const coreRows = await prisma.tmdbMediaCore.findMany({
    where: { tmdbId: { in: ids } },
    select: { tmdbId: true, posterPath: true },
  });
  for (const row of coreRows) {
    if (map[row.tmdbId]) continue;
    const url = row.posterPath ? posterUrl(row.posterPath, "w342") : null;
    if (url) map[row.tmdbId] = url;
  }

  const missing = ids.filter((id) => !map[id]);
  if (missing.length === 0) return map;

  const keys = missing.flatMap((id) => [
    `movie:${id}:details`,
    `tv:${id}:details`,
  ]);
  const rows = await prisma.tmdbCache.findMany({
    where: { key: { in: keys } },
    select: { key: true, data: true },
  });

  for (const row of rows) {
    const id = parseInt(row.key.split(":")[1] ?? "", 10);
    if (!Number.isFinite(id) || map[id]) continue;
    try {
      const parsed = JSON.parse(row.data) as { posterPath?: string | null };
      const url = parsed.posterPath
        ? posterUrl(parsed.posterPath, "w342")
        : null;
      if (url) map[id] = url;
    } catch {
      // ignore unparseable cache rows
    }
  }
  return map;
}
