// The database half of the activity pages' title-only tmdbId fallback. The
// keying rules are activity-title-resolve.ts (pure); this module runs the reads
// both admin activity pages share, so the overview and the per-user page can't
// answer the same unmapped title differently.
import { Prisma } from "@/generated/prisma";
import { prisma } from "./prisma";
import {
  addTitleResolutions,
  addUnambiguousTitleResolutions,
  titleWhereDisjuncts,
  unresolvedPairs,
  type TitleResolveMap,
  type UnmappedTitlePair,
} from "./activity-title-resolve";

// The newest resolved play per (title, mediaType) pair. DISTINCT ON keeps one
// row per pair in Postgres: Prisma's `distinct` (no native distinct here)
// fetched EVERY matching play and de-duplicated in memory, so a long-running
// series sent back each episode. One Prisma.sql value, never a tagged template
// with a fragment (guardrail 23a).
export async function latestResolvedByTitle(
  pairs: readonly UnmappedTitlePair[],
): Promise<{ title: string; tmdbId: number; mediaType: string | null }[]> {
  if (pairs.length === 0) return [];
  // The pair scoping comes from titleWhereDisjuncts, so this query and the map
  // keying (activity-title-resolve) can't drift apart.
  // A pair with a known year skips plays recorded under another year (a remake
  // resolved on someone's play); plays with no year still count.
  const disjuncts = titleWhereDisjuncts(pairs).map((d, i) => {
    const year = pairs[i].year;
    const byYear = year ? Prisma.sql` AND ("year" IS NULL OR "year" = ${year})` : Prisma.empty;
    return d.mediaType
      ? Prisma.sql`("title" = ${d.title} AND "mediaType" = CAST(${d.mediaType} AS "MediaType")${byYear})`
      : Prisma.sql`("title" = ${d.title}${byYear})`;
  });
  return prisma.$queryRaw<{ title: string; tmdbId: number; mediaType: string | null }[]>(Prisma.sql`
    SELECT DISTINCT ON ("title", "mediaType") "title", "tmdbId", "mediaType"::text AS "mediaType"
    FROM "PlayHistory"
    WHERE "tmdbId" IS NOT NULL AND (${Prisma.join(disjuncts, " OR ")})
    ORDER BY "title", "mediaType", "startedAt" DESC
  `);
}

// Every library row carrying one of the still-unresolved titles, on either
// server. Ordered so the read is deterministic; the ambiguity rule below never
// depends on which row came first.
async function libraryRowsByTitle(
  pairs: readonly UnmappedTitlePair[],
): Promise<{ title: string | null; tmdbId: number; mediaType: string | null; year: string | null }[]> {
  const where = { OR: titleWhereDisjuncts(pairs) };
  const select = { title: true, tmdbId: true, mediaType: true, year: true } as const;
  const orderBy = [{ tmdbId: "asc" as const }, { mediaType: "asc" as const }];
  const [plex, jellyfin] = await Promise.all([
    prisma.plexLibraryItem.findMany({ where, select, orderBy }),
    prisma.jellyfinLibraryItem.findMany({ where, select, orderBy }),
  ]);
  return [...plex, ...jellyfin];
}

/**
 * tmdbIds for unmapped (title, mediaType) pairs: the newest resolved play of
 * each pair first, then, with `libraryFallback`, the library tables for what
 * play history couldn't answer. A library title held under two different
 * tmdbIds (a remake, two shows sharing a name) is narrowed by the play's year
 * when it has one, and otherwise left unresolved rather than linked to
 * whichever row the read returned first.
 */
export async function resolveTitlesToTmdb(
  pairs: readonly UnmappedTitlePair[],
  opts: { libraryFallback: boolean },
): Promise<TitleResolveMap> {
  const map: TitleResolveMap = {};
  if (pairs.length === 0) return map;
  addTitleResolutions(map, await latestResolvedByTitle(pairs));
  if (!opts.libraryFallback) return map;
  const stillUnmapped = unresolvedPairs(map, pairs);
  if (stillUnmapped.length > 0) addUnambiguousTitleResolutions(map, await libraryRowsByTitle(stillUnmapped), stillUnmapped);
  return map;
}
