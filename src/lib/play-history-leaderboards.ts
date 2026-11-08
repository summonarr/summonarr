// The ranked lists and small lookups the activity overview and Statistics page
// show beside the main aggregate: rewatched/top-watched titles, the users list,
// transcode offenders, the watch-time leaderboard, the busiest day and the
// platform filter list. Every one is memoized through memoizeActivity (19b).
import { prisma } from "./prisma";
import { resolvePosterPathMap, posterPathKey } from "./poster-cache";
import { getStatsTimeZone } from "./stats-time-zone-data";
import { getCacheKey, memoizeActivity, REWATCHED_TTL, STATS_TTL } from "./play-history-cache";
import { count, round1 } from "./play-history-aggregate";
import { hoursOf, localStartedAt, TITLE_GROUP_BY_SQL, TRANSCODE_SQL } from "./play-history-sql-fragments";
import { buildStatsFilters, type PlayHistoryStatsFilters } from "./play-history-stats-filters";

type TitleLeaderboardRow = { tmdbId: number; mediaType: string; title: string; posterPath: string | null; plays: bigint; viewers: bigint };

// Shared tail of the two leaderboard queries: swap the row's stored
// `PlayHistory.posterPath` for the LIVE TmdbMediaCore/TmdbCache path.
//
// The stored value is a snapshot taken at finalize time from the title's
// `:details` cache row, so it's null for anything nobody had opened in the app
// before watching it — which left the admin Statistics page and the iOS Admin
// Activity leaderboards on placeholder tiles. It stays as the fallback for
// titles the caches no longer hold. Two extra indexed reads per leaderboard,
// and `getMostRewatched` memoizes its result anyway.
async function withLivePosterPaths(rows: TitleLeaderboardRow[]) {
  const livePaths = await resolvePosterPathMap(rows);
  return rows.map((r) => ({
    tmdbId: r.tmdbId,
    mediaType: r.mediaType,
    title: r.title,
    // Namespaced key: these two leaderboards partition by mediaType, so a movie
    // row and a TV row with the same tmdbId can both rank — a bare-id lookup
    // would hand them the same (one of them wrong) poster.
    posterPath: livePaths[posterPathKey(r.tmdbId, r.mediaType)] ?? r.posterPath,
    plays: Number(r.plays),
    viewers: Number(r.viewers),
  }));
}

export async function getMostRewatched(filters: PlayHistoryStatsFilters = {}, limit = 10) {
  return memoizeActivity(
    getCacheKey("rewatched", { ...filters, limit }),
    REWATCHED_TTL,
    () => getMostRewatchedUncached(filters, limit),
  );
}

export async function getMostRewatchedUncached(filters: PlayHistoryStatsFilters = {}, limit = 10) {
  const { where, params } = buildStatsFilters(filters);
  // Push then read length so a future param insertion in buildStatsFilters can't shift the limit's $-index
  // (the "803cd11" placeholder-offset bug class the tests pin).
  params.push(limit);
  const limitIdx = params.length;

  const rows = await prisma.$queryRawUnsafe<TitleLeaderboardRow[]>(
    // Carry the stored posterPath (like getTopWatchedUncached) as the fallback
    // beneath the live lookup below.
    //
    // "Rewatched" is decided PER EPISODE, not per title. A TV show's tmdbId
    // aggregates every episode (one PlayHistory row per episode, keyed by
    // seasonNumber/episodeNumber — the same COALESCE(…, -1) key the arc CTEs
    // use), so a show-level `HAVING COUNT(*) > 1` ranked any show with two
    // distinct episodes watched once each as a rewatch and pushed genuinely
    // rewatched movies below every multi-episode show (f1d609a diagnosed this
    // and sidestepped it only for the Top Watched cards). Rows whose episode
    // was played more than once survive the filter; the title then rolls up
    // plays/viewers over those rows only. Movies have NULL season/episode, so
    // they form one -1/-1 partition and keep exactly the old semantics.
    `WITH rewatched_rows AS (
       SELECT "tmdbId", "mediaType"::text AS "mediaType", "title", "posterPath", "mediaServerUserId",
              COUNT(*) OVER (
                PARTITION BY "tmdbId", "mediaType", COALESCE("seasonNumber", -1), COALESCE("episodeNumber", -1)
              ) AS episode_plays
       FROM "PlayHistory"
       WHERE ${where} AND "tmdbId" IS NOT NULL AND "watched" = true
     )
     SELECT "tmdbId", "mediaType", MAX("title") AS title,
            MAX("posterPath") AS "posterPath",
            COUNT(*)::bigint AS plays,
            COUNT(DISTINCT "mediaServerUserId")::bigint AS viewers
     FROM rewatched_rows
     WHERE episode_plays > 1
     GROUP BY "tmdbId", "mediaType"
     ORDER BY plays DESC
     LIMIT $${limitIdx}`,
    ...params,
  );

  return withLivePosterPaths(rows);
}

// Top-watched titles split per media type. Unlike getMostRewatchedUncached
// this has NO rewatch filter — a movie watched once
// still ranks — and partitions by mediaType so movies can't be starved out
// of a global top-N by TV shows (whose tmdbId aggregates every episode).
// Posters resolve the same way (withLivePosterPaths).
export async function getTopWatchedUncached(filters: PlayHistoryStatsFilters = {}, limitPerType = 8) {
  const { where, params } = buildStatsFilters(filters);
  // Push then read length so a future param insertion can't shift the $-index (cf. 803cd11).
  params.push(limitPerType);
  const limitIdx = params.length;

  const rows = await prisma.$queryRawUnsafe<TitleLeaderboardRow[]>(
    `WITH agg AS (
       SELECT "tmdbId", "mediaType"::text AS "mediaType", MAX("title") AS title,
              MAX("posterPath") AS "posterPath",
              COUNT(*)::bigint AS plays,
              COUNT(DISTINCT "mediaServerUserId")::bigint AS viewers
       FROM "PlayHistory"
       WHERE ${where} AND "tmdbId" IS NOT NULL AND "watched" = true
       GROUP BY "tmdbId", "mediaType"
     ), ranked AS (
       SELECT *, ROW_NUMBER() OVER (PARTITION BY "mediaType" ORDER BY plays DESC, viewers DESC) AS rn
       FROM agg
     )
     SELECT "tmdbId", "mediaType", title, "posterPath", plays, viewers
     FROM ranked WHERE rn <= $${limitIdx}
     ORDER BY plays DESC`,
    ...params,
  );

  return withLivePosterPaths(rows);
}

// One-row-per-MediaServerUser leaderboard for the admin users list: plays, watch
// hours, last-active, favourite platform, and direct-play vs transcode split.
// Memoized like the other aggregates (guardrail 19b): the users page re-renders
// on every search, sort and status click, and each render used to rescan the
// whole PlayHistory table. A finalize still clears it.
export async function getAllUsersStats() {
  return memoizeActivity(getCacheKey("all-users", {}), STATS_TTL, getAllUsersStatsUncached);
}

async function getAllUsersStatsUncached() {
  // Fully static SQL, so the tagged form (no fragment is interpolated — 23a).
  const rows = await prisma.$queryRaw<
    {
      id: string;
      username: string;
      source: string;
      thumbUrl: string | null;
      active: boolean;
      sourceUserId: string;
      serverInstance: string;
      isServerAdmin: boolean;
      createdAt: Date;
      plays: bigint;
      hours: number | null;
      lastActive: Date | null;
      favPlatform: string | null;
      direct: bigint;
      transcodes: bigint;
    }[]
  >`
    SELECT
      m."id",
      m."username",
      m."source",
      m."thumbUrl",
      m."active",
      m."sourceUserId",
      m."serverInstance",
      m."isServerAdmin",
      m."createdAt",
      COUNT(p."id") FILTER (WHERE p."watched" = true)::bigint AS plays,
      (COALESCE(SUM(p."playDuration"), 0) / 3600.0)::float8 AS hours,
      MAX(p."startedAt") AS "lastActive",
      (SELECT p2."platform"
       FROM "PlayHistory" p2
       WHERE p2."mediaServerUserId" = m."id" AND p2."platform" IS NOT NULL AND p2."watched" = true
       GROUP BY p2."platform"
       ORDER BY COUNT(*) DESC
       LIMIT 1) AS "favPlatform",
      COUNT(p."id") FILTER (WHERE p."playMethod" = 'DirectPlay')::bigint AS direct,
      COUNT(p."id") FILTER (WHERE p."playMethod" = 'Transcode')::bigint AS transcodes
    FROM "MediaServerUser" m
    LEFT JOIN "PlayHistory" p ON p."mediaServerUserId" = m."id"
    GROUP BY m."id", m."username", m."source", m."thumbUrl", m."active", m."sourceUserId", m."serverInstance", m."isServerAdmin", m."createdAt"
    ORDER BY plays DESC
  `;

  return rows.map((r) => {
    const plays = Number(r.plays);
    const direct = Number(r.direct);
    const transcodes = Number(r.transcodes);
    const totalWithMethod = direct + transcodes;
    return {
      id: r.id,
      username: r.username,
      source: r.source,
      thumbUrl: r.thumbUrl,
      active: r.active,
      sourceUserId: r.sourceUserId,
      serverInstance: r.serverInstance,
      isServerAdmin: r.isServerAdmin,
      createdAt: r.createdAt,
      plays,
      hours: round1(Number(r.hours ?? 0)),
      lastActive: r.lastActive,
      favPlatform: r.favPlatform,
      directPct: totalWithMethod > 0 ? Math.round((direct / totalWithMethod) * 100) : null,
      transcodePct: totalWithMethod > 0 ? Math.round((transcodes / totalWithMethod) * 100) : null,
    };
  });
}

// Transcode-pressure leaderboard for the activity overview: who/what forces the
// most server-side transcodes in the period. Transcodes are the expensive path
// (CPU + bandwidth), so a ranked list helps an admin spot the heavy hitters.
export interface TranscodeOffenders {
  // `id` is the MediaServerUser primary key — the only stable per-row key.
  // username is NOT unique (@@unique is [source, serverInstance, sourceUserId]):
  // the same person on two same-type servers (guardrail 35) or a departed row
  // plus a re-created account (guardrail 28) legitimately share (source, username).
  topUsers: { id: string; username: string; source: string; count: number }[];
  topTitles: { title: string; tmdbId: number | null; mediaType: string | null; count: number }[];
}

// Memoized like the heatmap cell: the overview page and the native
// transcode-offenders route share one computation per key.
export async function getTranscodeOffenders(
  filters: PlayHistoryStatsFilters = {},
  limit = 6,
): Promise<TranscodeOffenders> {
  return memoizeActivity(
    `transcode-offenders:${JSON.stringify({ ...filters, limit })}`,
    STATS_TTL,
    () => getTranscodeOffendersUncached(filters, limit),
  );
}

async function getTranscodeOffendersUncached(
  filters: PlayHistoryStatsFilters,
  limit: number,
): Promise<TranscodeOffenders> {
  const { where, params } = buildStatsFilters(filters);
  const twhere = `${where} AND "playMethod" = ${TRANSCODE_SQL}`;
  const limitIdx = params.length + 1;

  const [users, titles] = await Promise.all([
    // Filter in a CTE (bare names) then join MediaServerUser — PlayHistory and
    // MediaServerUser both expose "source", so a direct join would be ambiguous.
    prisma.$queryRawUnsafe<{ id: string; username: string; source: string; count: bigint }[]>(
      `WITH f AS (
         SELECT "mediaServerUserId", COUNT(*)::bigint AS count
         FROM "PlayHistory" WHERE ${twhere}
         GROUP BY "mediaServerUserId"
       )
       SELECT m."id" AS id, m."username" AS username, m."source" AS source, f."count" AS count
       FROM f JOIN "MediaServerUser" m ON m."id" = f."mediaServerUserId"
       ORDER BY f."count" DESC LIMIT $${limitIdx}`,
      ...params,
      limit,
    ),
    prisma.$queryRawUnsafe<{ title: string; tmdbId: number | null; mediaType: string | null; count: bigint }[]>(
      `SELECT MAX("title") AS title, "tmdbId", "mediaType"::text AS "mediaType", COUNT(*)::bigint AS count
       FROM "PlayHistory" WHERE ${twhere} AND "title" IS NOT NULL AND "title" <> ''
       ${TITLE_GROUP_BY_SQL}
       ORDER BY count DESC LIMIT $${limitIdx}`,
      ...params,
      limit,
    ),
  ]);

  return {
    topUsers: users.map((u) => ({
      id: u.id,
      username: u.username,
      source: u.source,
      count: count(u.count),
    })),
    topTitles: titles.map((t) => ({
      title: t.title,
      tmdbId: t.tmdbId,
      mediaType: t.mediaType,
      count: count(t.count),
    })),
  };
}

// The overview's watch-time leaderboard: the top viewers by hours in the window.
// `plays` is computed HERE, per row, with the same `watched = true` rule as
// getPlayHistoryStats' topUsers. Looking it up from topUsers instead read 0 for
// anyone outside the per-source top 10 by PLAY COUNT — exactly the
// few-long-plays viewer a watch-time leaderboard surfaces ("42h · 0 plays").
// One overall ranking (the page shows a single list), with `id` breaking ties so
// equal-hours viewers keep their order across refreshes.
export const WATCH_TIME_LEADERBOARD_SIZE = 8;

export async function getWatchTimeLeaderboard(
  filters: PlayHistoryStatsFilters = {},
): Promise<{ id: string; username: string; source: string; hours: number; plays: number }[]> {
  return memoizeActivity(getCacheKey("watch-leaderboard", { ...filters }), STATS_TTL, async () => {
    const { where, params } = buildStatsFilters(filters, "p");
    params.push(WATCH_TIME_LEADERBOARD_SIZE);
    const limitIdx = params.length;
    const rows = await prisma.$queryRawUnsafe<
      { id: string; username: string; source: string; hours: number | null; plays: bigint }[]
    >(
      `SELECT m."id", m."username", m."source",
              ${hoursOf(`SUM(p."playDuration")`)} AS hours,
              COUNT(*) FILTER (WHERE p."watched" = true)::bigint AS plays
       FROM "PlayHistory" p JOIN "MediaServerUser" m ON m."id" = p."mediaServerUserId"
       WHERE ${where}
       GROUP BY m."id", m."username", m."source"
       ORDER BY hours DESC, m."id" ASC
       LIMIT $${limitIdx}`,
      ...params,
    );
    return rows.map((r) => ({
      id: r.id,
      username: r.username,
      source: r.source,
      hours: r.hours ?? 0,
      plays: count(r.plays),
    }));
  });
}

// The window's busiest day (in the statistics zone) by watched plays.
// `watched = true` is NOT optional: the "Plays per day" chart this sits beside
// is built from watched plays, and counting every row named a day of many
// abandoned starts the busiest while the chart showed it as a trough.
export async function getBusiestDay(
  filters: PlayHistoryStatsFilters = {},
): Promise<{ day: string; count: number } | null> {
  const timeZone = await getStatsTimeZone();
  const cached = await memoizeActivity(getCacheKey("busiest-day", { ...filters, zone: timeZone }), STATS_TTL, async () => {
    const { where, params } = buildStatsFilters(filters);
    const rows = await prisma.$queryRawUnsafe<{ day: string; count: bigint }[]>(
      `SELECT to_char(date_trunc('day', ${localStartedAt(`$${params.length + 1}`)}), 'YYYY-MM-DD') AS day, COUNT(*)::bigint AS count
       FROM "PlayHistory" WHERE ${where} AND "watched" = true
       GROUP BY day ORDER BY count DESC, day DESC LIMIT 1`,
      ...params,
      timeZone,
    );
    // Wrapped so "no plays" is a cacheable value (memoizeActivity skips a null).
    return { day: rows[0] ? { day: rows[0].day, count: count(rows[0].count) } : null };
  });
  return cached.day;
}

// Every platform name in play history, for the history table's filter. A
// DISTINCT over the whole table (no index serves it), so memoized: the table
// fetches it on every mount, and a finalize that adds a new platform clears it.
export async function getPlayHistoryPlatforms(): Promise<string[]> {
  return memoizeActivity(getCacheKey("platforms", {}), STATS_TTL, async () => {
    const rows = await prisma.$queryRawUnsafe<{ platform: string }[]>(
      `SELECT DISTINCT "platform" FROM "PlayHistory" WHERE "platform" IS NOT NULL ORDER BY "platform"`,
    );
    return rows.map((r) => r.platform);
  });
}
