import { prisma } from "@/lib/prisma";
import { Prisma } from "@/generated/prisma";

// The settings System tab's database counts, each named beside its query. They
// run as ONE statement (readDbCounts) — one pooled connection, not ~35 queries
// queued on the pool's five — and the names come back as columns, so adding a
// count can't shift the label of the ones after it. Enum values are literals:
// a text parameter has no equality with a Postgres enum column.
export function dbCountQueries(now: Date) {
  return {
    totalRequests: Prisma.sql`SELECT COUNT(*) FROM "MediaRequest"`,
    pendingRequests: Prisma.sql`SELECT COUNT(*) FROM "MediaRequest" WHERE "status" = 'PENDING'`,
    approvedRequests: Prisma.sql`SELECT COUNT(*) FROM "MediaRequest" WHERE "status" = 'APPROVED'`,
    availableRequests: Prisma.sql`SELECT COUNT(*) FROM "MediaRequest" WHERE "status" = 'AVAILABLE'`,
    declinedRequests: Prisma.sql`SELECT COUNT(*) FROM "MediaRequest" WHERE "status" = 'DECLINED'`,
    movieRequests: Prisma.sql`SELECT COUNT(*) FROM "MediaRequest" WHERE "mediaType" = 'MOVIE'`,
    tvRequests: Prisma.sql`SELECT COUNT(*) FROM "MediaRequest" WHERE "mediaType" = 'TV'`,
    totalUsers: Prisma.sql`SELECT COUNT(*) FROM "User"`,
    adminUsers: Prisma.sql`SELECT COUNT(*) FROM "User" WHERE "role" = 'ADMIN'`,
    issueAdminUsers: Prisma.sql`SELECT COUNT(*) FROM "User" WHERE "role" = 'ISSUE_ADMIN'`,
    discordLinkedUsers: Prisma.sql`SELECT COUNT(*) FROM "User" WHERE "discordId" IS NOT NULL`,
    totalIssues: Prisma.sql`SELECT COUNT(*) FROM "Issue"`,
    openIssues: Prisma.sql`SELECT COUNT(*) FROM "Issue" WHERE "status" = 'OPEN'`,
    inProgressIssues: Prisma.sql`SELECT COUNT(*) FROM "Issue" WHERE "status" = 'IN_PROGRESS'`,
    resolvedIssues: Prisma.sql`SELECT COUNT(*) FROM "Issue" WHERE "status" = 'RESOLVED'`,
    plexItems: Prisma.sql`SELECT COUNT(*) FROM "PlexLibraryItem"`,
    jellyfinItems: Prisma.sql`SELECT COUNT(*) FROM "JellyfinLibraryItem"`,

    // TV COVERAGE: both halves must come from the SAME population or the
    // ratio is meaningless — this pair used to read 1,798 / 1,796 because the
    // numerator counted DISTINCT tmdbId in TVEpisodeCache while the
    // denominator was a raw row count on the library table. Two ways they
    // drifted: the library tables are keyed [tmdbId, mediaType,
    // serverInstance] so a title on two servers counted twice, and
    // TVEpisodeCache has no serverInstance column and is only rewritten when
    // every configured instance's fetch succeeds (guardrail 35), so it lags
    // and retains rows for titles the library no longer holds.
    //
    // Denominator: DISTINCT shows in the library. Numerator: those of them
    // that actually have episode rows. The EXISTS makes covered ≤ total by
    // construction, so a stale episode-cache row can never push it over 100%.
    plexTvShows: Prisma.sql`SELECT COUNT(DISTINCT "tmdbId") FROM "PlexLibraryItem" WHERE "mediaType" = 'TV'`,
    jellyfinTvShows: Prisma.sql`SELECT COUNT(DISTINCT "tmdbId") FROM "JellyfinLibraryItem" WHERE "mediaType" = 'TV'`,
    plexShowsWithEps: Prisma.sql`
      SELECT COUNT(DISTINCT p."tmdbId")
      FROM "PlexLibraryItem" p
      WHERE p."mediaType" = 'TV'
        AND EXISTS (SELECT 1 FROM "TVEpisodeCache" e WHERE e."tmdbId" = p."tmdbId" AND e.source = 'plex')
    `,
    jellyfinShowsWithEps: Prisma.sql`
      SELECT COUNT(DISTINCT j."tmdbId")
      FROM "JellyfinLibraryItem" j
      WHERE j."mediaType" = 'TV'
        AND EXISTS (SELECT 1 FROM "TVEpisodeCache" e WHERE e."tmdbId" = j."tmdbId" AND e.source = 'jellyfin')
    `,

    tmdbCacheEntries: Prisma.sql`SELECT COUNT(*) FROM "TmdbCache" WHERE "key" NOT LIKE 'omdb:%'`,
    omdbCacheEntries: Prisma.sql`SELECT COUNT(*) FROM "TmdbCache" WHERE "key" LIKE 'omdb:%'`,
    upcomingItems: Prisma.sql`SELECT COUNT(*) FROM "UpcomingCacheItem"`,
    episodeCacheEntries: Prisma.sql`SELECT COUNT(*) FROM "TVEpisodeCache"`,
    radarrWanted: Prisma.sql`SELECT COUNT(*) FROM "RadarrWantedItem"`,
    radarrAvailable: Prisma.sql`SELECT COUNT(*) FROM "RadarrAvailableItem"`,
    sonarrWanted: Prisma.sql`SELECT COUNT(*) FROM "SonarrWantedItem"`,
    sonarrAvailable: Prisma.sql`SELECT COUNT(*) FROM "SonarrAvailableItem"`,
    deletionVotes: Prisma.sql`SELECT COUNT(*) FROM "DeletionVote"`,
    tmdbCoreEntries: Prisma.sql`SELECT COUNT(*) FROM "TmdbMediaCore"`,
    tmdbCoreMovies: Prisma.sql`SELECT COUNT(*) FROM "TmdbMediaCore" WHERE "mediaType" = 'MOVIE'`,
    tmdbCoreTv: Prisma.sql`SELECT COUNT(*) FROM "TmdbMediaCore" WHERE "mediaType" = 'TV'`,
    playHistoryEntries: Prisma.sql`SELECT COUNT(*) FROM "PlayHistory"`,
    mediaServerUsers: Prisma.sql`SELECT COUNT(*) FROM "MediaServerUser"`,
    discordCacheEntries: Prisma.sql`SELECT COUNT(*) FROM "DiscordSearchCache" WHERE "expiresAt" > ${now}`,
  };
}

export type DbCounts = { [K in keyof ReturnType<typeof dbCountQueries>]: number };

export async function readDbCounts(now: Date): Promise<DbCounts> {
  const queries = dbCountQueries(now);
  const names = Object.keys(queries) as Array<keyof DbCounts>;
  // One Prisma.sql value (guardrail 23a). The aliases are the constant keys
  // above, never input.
  const rows = await prisma.$queryRaw<Array<Record<string, bigint | number | null>>>(
    Prisma.sql`SELECT ${Prisma.join(names.map((name) => Prisma.sql`(${queries[name]}) AS ${Prisma.raw(`"${name}"`)}`))}`,
  );
  const row = rows[0] ?? {};
  return Object.fromEntries(names.map((name) => [name, Number(row[name] ?? 0)])) as DbCounts;
}
