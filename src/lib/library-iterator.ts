import "server-only";
import { prisma } from "./prisma";
import { Prisma } from "@/generated/prisma";

export const LIBRARY_PAGE_SIZE = 500;

export type LibraryItem = { tmdbId: number; mediaType: "MOVIE" | "TV" };

// Cursor-based pagination avoids loading the entire library into memory; callers should not assume
// a consistent snapshot — a concurrent full sync may repopulate rows mid-iteration.
//
// Rows are keyed (tmdbId, mediaType, serverInstance), so two servers can hold
// rows with the same tmdbId, and a page can end between them. The cursor
// therefore carries serverInstance too, or the next page could skip or repeat
// one of them. collectAllLibraryItems dedups on tmdbId:mediaType, so the
// per-server duplicates collapse there.
export async function* iterateLibrary(
  source: "plex" | "jellyfin",
  mediaType: "MOVIE" | "TV",
): AsyncGenerator<LibraryItem> {
  let cursor: { tmdbId: number; serverInstance: string } | undefined;
  for (;;) {
    const page = source === "plex"
      ? await prisma.plexLibraryItem.findMany({
          where: { mediaType },
          take: LIBRARY_PAGE_SIZE,
          ...(cursor !== undefined
            ? { skip: 1, cursor: { tmdbId_mediaType_serverInstance: { tmdbId: cursor.tmdbId, mediaType, serverInstance: cursor.serverInstance } } }
            : {}),
          orderBy: [{ tmdbId: "asc" }, { serverInstance: "asc" }],
          select: { tmdbId: true, mediaType: true, serverInstance: true },
        })
      : await prisma.jellyfinLibraryItem.findMany({
          where: { mediaType },
          take: LIBRARY_PAGE_SIZE,
          ...(cursor !== undefined
            ? { skip: 1, cursor: { tmdbId_mediaType_serverInstance: { tmdbId: cursor.tmdbId, mediaType, serverInstance: cursor.serverInstance } } }
            : {}),
          orderBy: [{ tmdbId: "asc" }, { serverInstance: "asc" }],
          select: { tmdbId: true, mediaType: true, serverInstance: true },
        });
    if (page.length === 0) break;
    for (const item of page) {
      yield { tmdbId: item.tmdbId, mediaType: item.mediaType as "MOVIE" | "TV" };
    }
    if (page.length < LIBRARY_PAGE_SIZE) break;
    const last = page[page.length - 1];
    cursor = { tmdbId: last.tmdbId, serverInstance: last.serverInstance };
  }
}

// UNION (not UNION ALL) removes duplicates, so a title on both Plex and
// Jellyfin (or on two servers) counts once.
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
