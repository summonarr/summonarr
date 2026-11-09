// The admin "Recently added" grid's read rules. Zero-import (the page passes
// the library reads in), so tests/activity-recent-added.test.mts loads it directly.

export const RECENT_ADDED_LIMIT = 60;
// Rows per library read, and how many reads one source may take before the
// grid settles for what it has.
export const RECENT_ADDED_PAGE = 120;
export const RECENT_ADDED_MAX_PAGES = 10;

export interface RecentLibraryRow {
  tmdbId: number;
  mediaType: "MOVIE" | "TV";
  title: string | null;
  year: string | null;
  addedAt: Date;
}

const keyOf = (r: { tmdbId: number; mediaType: string }) => `${r.mediaType}:${r.tmdbId}`;

/**
 * The newest `limit` DISTINCT titles of one library, newest first. Library rows
 * are per server, so a title on two servers is two rows; cutting the read at
 * `limit` rows before de-duplicating let those copies use up the slots and the
 * grid showed far fewer titles than it promised. Reads `page` rows at a time
 * (newest first) until enough distinct titles are in, the library runs out, or
 * `maxPages` reads were spent.
 */
export async function newestDistinctTitles<R extends RecentLibraryRow>(
  read: (skip: number, take: number) => Promise<R[]>,
  opts: { limit?: number; page?: number; maxPages?: number } = {},
): Promise<R[]> {
  const limit = opts.limit ?? RECENT_ADDED_LIMIT;
  const page = opts.page ?? RECENT_ADDED_PAGE;
  const maxPages = opts.maxPages ?? RECENT_ADDED_MAX_PAGES;
  const seen = new Set<string>();
  const out: R[] = [];
  for (let i = 0; i < maxPages; i++) {
    const rows = await read(i * page, page);
    for (const r of rows) {
      const k = keyOf(r);
      if (seen.has(k)) continue;
      seen.add(k);
      out.push(r);
      if (out.length >= limit) return out;
    }
    if (rows.length < page) break;
  }
  return out;
}

export interface RecentItem {
  tmdbId: number;
  title: string;
  mediaType: "MOVIE" | "TV";
  year: string | null;
  addedAt: Date;
  // A title present in both libraries carries both tags.
  sources: { plex: boolean; jellyfin: boolean };
}

/**
 * One list over both libraries, newest first, at most `limit` titles. A title
 * held by Plex and Jellyfin keeps its newest addedAt (with that row's title and
 * year) and carries both source tags rather than the second overwriting the first.
 */
export function mergeRecentlyAdded(
  plex: readonly RecentLibraryRow[],
  jellyfin: readonly RecentLibraryRow[],
  unknownTitle: string,
  limit = RECENT_ADDED_LIMIT,
): RecentItem[] {
  const rows = [
    ...plex.map((i) => ({ ...i, src: "plex" as const })),
    ...jellyfin.map((i) => ({ ...i, src: "jellyfin" as const })),
  ];
  const merged = new Map<string, RecentItem>();
  // Keys whose stored title is still the placeholder: a titled row fills it
  // whatever its addedAt.
  const untitled = new Set<string>();
  for (const item of rows) {
    const key = keyOf(item);
    const existing = merged.get(key);
    if (existing) {
      existing.sources[item.src] = true;
      if (item.addedAt.getTime() > existing.addedAt.getTime()) {
        existing.addedAt = item.addedAt;
        existing.title = item.title ?? existing.title;
        existing.year = item.year ?? existing.year;
        if (item.title != null) untitled.delete(key);
      } else if (item.title != null && untitled.has(key)) {
        existing.title = item.title;
        existing.year = item.year ?? existing.year;
        untitled.delete(key);
      }
      continue;
    }
    if (item.title == null) untitled.add(key);
    merged.set(key, {
      tmdbId: item.tmdbId,
      title: item.title ?? unknownTitle,
      mediaType: item.mediaType,
      year: item.year ?? null,
      addedAt: item.addedAt,
      sources: { plex: item.src === "plex", jellyfin: item.src === "jellyfin" },
    });
  }
  return Array.from(merged.values())
    .sort((a, b) => b.addedAt.getTime() - a.addedAt.getTime())
    .slice(0, limit);
}
