import "server-only";
import { prisma } from "./prisma";
import { Prisma } from "@/generated/prisma";

export const LIBRARY_PAGE_SIZE = 500;

export type LibraryItem = { tmdbId: number; mediaType: "MOVIE" | "TV" };

// Cursor-based pagination avoids loading the entire library into memory; callers should not assume
// a consistent snapshot — a concurrent full sync may repopulate rows mid-iteration.
export async function* iterateLibrary(
  source: "plex" | "jellyfin",
  mediaType: "MOVIE" | "TV",
): AsyncGenerator<LibraryItem> {
  let cursor: number | undefined;
  for (;;) {
    const page = source === "plex"
      ? await prisma.plexLibraryItem.findMany({
          where: { mediaType },
          take: LIBRARY_PAGE_SIZE,
          ...(cursor !== undefined
            ? { skip: 1, cursor: { tmdbId_mediaType: { tmdbId: cursor, mediaType } } }
            : {}),
          orderBy: { tmdbId: "asc" },
          select: { tmdbId: true, mediaType: true },
        })
      : await prisma.jellyfinLibraryItem.findMany({
          where: { mediaType },
          take: LIBRARY_PAGE_SIZE,
          ...(cursor !== undefined
            ? { skip: 1, cursor: { tmdbId_mediaType: { tmdbId: cursor, mediaType } } }
            : {}),
          orderBy: { tmdbId: "asc" },
          select: { tmdbId: true, mediaType: true },
        });
    if (page.length === 0) break;
    for (const item of page) {
      yield { tmdbId: item.tmdbId, mediaType: item.mediaType as "MOVIE" | "TV" };
    }
    if (page.length < LIBRARY_PAGE_SIZE) break;
    cursor = page[page.length - 1].tmdbId;
  }
}

// UNION (not UNION ALL) deduplicates items that exist in both Plex and Jellyfin
export async function countUniqueLibraryItems(): Promise<number> {
  const result = await prisma.$queryRaw<[{ count: bigint }]>(
    Prisma.sql`
      SELECT COUNT(*) AS count FROM (
        SELECT "tmdbId", "mediaType" FROM "PlexLibraryItem"
        UNION
        SELECT "tmdbId", "mediaType" FROM "JellyfinLibraryItem"
      ) combined
    `
  );
  return Number(result[0].count);
}

export async function collectAllLibraryItems(maxItems: number): Promise<LibraryItem[]> {
  const seen = new Set<string>();
  const items: LibraryItem[] = [];
  const sources: Array<"plex" | "jellyfin"> = ["plex", "jellyfin"];
  const mediaTypes: Array<"MOVIE" | "TV"> = ["MOVIE", "TV"];
  outer: for (const source of sources) {
    for (const mediaType of mediaTypes) {
      for await (const item of iterateLibrary(source, mediaType)) {
        const k = `${item.tmdbId}:${item.mediaType}`;
        if (seen.has(k)) continue;
        seen.add(k);
        items.push(item);
        if (items.length >= maxItems) break outer;
      }
    }
  }
  return items;
}
