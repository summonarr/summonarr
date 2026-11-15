import "server-only";
import { prisma } from "./prisma";
import { Prisma } from "@/generated/prisma";

export const LIBRARY_PAGE_SIZE = 500;

export type LibraryItem = { tmdbId: number; mediaType: "MOVIE" | "TV" };

// Paged reads avoid loading the entire library into memory; callers should not assume
// a consistent snapshot — a concurrent full sync may repopulate rows mid-iteration.
//
// Rows are keyed (tmdbId, mediaType, serverInstance), so two servers can hold
// rows with the same tmdbId, and a page can end between them. The bound
// therefore carries serverInstance too, or the next page could skip or repeat
// one of them. collectAllLibraryItems dedups on tmdbId:mediaType, so the
// per-server duplicates collapse there.
//
// Each page is bounded strictly AFTER the last key read, never positioned on
// that row (Prisma `cursor` + `skip: 1`): a walk spans minutes, and a sync or
// fix-match that removes the row the walk stopped on must not end it early.
export async function* iterateLibrary(
  source: "plex" | "jellyfin",
  mediaType: "MOVIE" | "TV",
): AsyncGenerator<LibraryItem> {
  let after: { tmdbId: number; serverInstance: string } | undefined;
  for (;;) {
    // One query shape for both tables; only the model differs.
    const args = {
      where: after === undefined
        ? { mediaType }
        : {
            mediaType,
            OR: [
              { tmdbId: { gt: after.tmdbId } },
              { tmdbId: after.tmdbId, serverInstance: { gt: after.serverInstance } },
            ],
          },
      take: LIBRARY_PAGE_SIZE,
      orderBy: [{ tmdbId: "asc" as const }, { serverInstance: "asc" as const }],
      select: { tmdbId: true, mediaType: true, serverInstance: true },
    };
    const page = source === "plex"
      ? await prisma.plexLibraryItem.findMany(args)
      : await prisma.jellyfinLibraryItem.findMany(args);
    if (page.length === 0) break;
    for (const item of page) {
      yield { tmdbId: item.tmdbId, mediaType: item.mediaType as "MOVIE" | "TV" };
    }
    if (page.length < LIBRARY_PAGE_SIZE) break;
    const last = page[page.length - 1];
    after = { tmdbId: last.tmdbId, serverInstance: last.serverInstance };
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
