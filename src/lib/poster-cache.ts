import { prisma } from "@/lib/prisma";
import { posterUrl } from "@/lib/tmdb-types";

// Resolve TMDB poster URLs for activity views from the `TmdbCache` `:details`
// rows the sync layer already populates — the same source the overview's Now
// Playing cards use. Returns a tmdbId→url map; url is absent when the title
// is uncached/unmapped so callers fall back to the letter placeholder.
//
// Both `movie:` and `tv:` keys are queried for every id because `mediaType`
// can be null or mismatched on unmapped rows; the first poster found per id
// wins.
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

  const keys = ids.flatMap((id) => [
    `movie:${id}:details`,
    `tv:${id}:details`,
  ]);
  const rows = await prisma.tmdbCache.findMany({
    where: { key: { in: keys } },
    select: { key: true, data: true },
  });

  const map: Record<number, string> = {};
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
