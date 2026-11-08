// The per-title stats bundle behind the admin activity media page.
import { prisma } from "./prisma";
import { getStatsTimeZone } from "./stats-time-zone-data";
import type { MediaType } from "@/generated/prisma";
import { count, padDailySeries, round1, runCapped } from "./play-history-aggregate";
import { hoursOf, localStartedAt, RESOLUTION_BUCKET_SQL } from "./play-history-sql-fragments";

// The recent-plays sample the media page lists and derives its per-play
// distributions from (completion histogram, platforms).
const MEDIA_RECENT_PLAYS = 50;

// The columns the media page reads from each recent play — not the IP,
// codecs-by-stream or marker columns a whole row carries.
const MEDIA_RECENT_PLAY_SELECT = {
  id: true,
  mediaServerUserId: true,
  startedAt: true,
  duration: true,
  playDuration: true,
  watched: true,
  seasonNumber: true,
  episodeNumber: true,
  platform: true,
  playMethod: true,
  resolution: true,
  videoCodec: true,
  videoDecision: true,
  audioDecision: true,
  mediaServerUser: { select: { username: true, source: true } },
} as const;

// Aggregate the per-title stats bundle (totals, unique/top viewers, completion,
// recent plays, daily series, transcode/resolution breakdowns) for one tmdbId.
// The daily series is bucketed in the statistics zone and padded like the
// other bundles' (padDailySeries), so the chart gets one entry per day.
export async function getMediaPlayStats(tmdbId: number, mediaType?: MediaType) {
  const timeZone = await getStatsTimeZone();
  const ninetyDaysAgo = new Date(Date.now() - 90 * 24 * 60 * 60 * 1000);

  // TMDB namespaces movie and TV IDs separately, so the same numeric id can be
  // both a film and a series. When the caller knows which one it wants, scope
  // every aggregate to that mediaType so a movie+show id collision can't blend
  // two unrelated titles' stats. The "$2 mediaType" predicate is a no-op clause
  // when mediaType is undefined.
  const mt = mediaType ?? null;
  // The comparison side MUST cast $2 to the "MediaType" enum: the `$2::text IS
  // NULL` null-check types the parameter as text, and Postgres has no
  // enum = text operator (42883 on every call, even with a valid value). A NULL
  // param casts to NULL::"MediaType" harmlessly; non-null values are always
  // 'MOVIE'/'TV' (typed MediaType upstream), so the cast can't throw.
  const mtClause = `($2::text IS NULL OR "mediaType" = $2::"MediaType")`;
  const mtClauseP = `($2::text IS NULL OR p."mediaType" = $2::"MediaType")`;
  const where = mediaType ? { tmdbId, mediaType } : { tmdbId };
  const whereWatched = mediaType ? { tmdbId, mediaType, watched: true } : { tmdbId, watched: true };

  // At most STATS_STATEMENT_CONCURRENCY in flight, like every aggregate fan-out (guardrail 31).
  const r = await runCapped({
    totalPlays: () => prisma.playHistory.count({ where: whereWatched }),
    uniqueViewers: () => prisma.$queryRawUnsafe<{ count: bigint }[]>(
      `SELECT COUNT(DISTINCT "mediaServerUserId")::bigint AS count FROM "PlayHistory" WHERE "tmdbId" = $1 AND ${mtClause} AND "watched" = true`,
      tmdbId,
      mt,
    ),
    avgCompletion: () => prisma.$queryRawUnsafe<{ avg_pct: number | null }[]>(
      // playDuration is wall-clock playing seconds and is NOT capped at the
      // runtime (a looped/rewound sitting stores playDuration > duration), so
      // each row's completion is clamped at 100% before it enters the mean —
      // otherwise one looped session reads as 300% and drags the title's
      // average past 100%.
      `SELECT AVG(
         CASE WHEN "duration" > 0 THEN LEAST("playDuration"::float / "duration", 1.0) * 100 ELSE NULL END
       )::float8 AS avg_pct
       FROM "PlayHistory" WHERE "tmdbId" = $1 AND ${mtClause}`,
      tmdbId,
      mt,
    ),
    topViewers: () => prisma.$queryRawUnsafe<{ id: string; username: string; source: string; count: bigint; hours: number }[]>(
      `SELECT m."id", m."username", m."source", COUNT(*)::bigint AS count,
              ${hoursOf(`SUM(p."playDuration")`)} AS hours
       FROM "PlayHistory" p JOIN "MediaServerUser" m ON m."id" = p."mediaServerUserId"
       WHERE p."tmdbId" = $1 AND ${mtClauseP} AND p."watched" = true
       GROUP BY m."id", m."username", m."source"
       ORDER BY count DESC LIMIT 20`,
      tmdbId,
      mt,
    ),
    recentPlays: () => prisma.playHistory.findMany({
      where,
      orderBy: { startedAt: "desc" },
      take: MEDIA_RECENT_PLAYS,
      select: MEDIA_RECENT_PLAY_SELECT,
    }),
    mediaInfo: () => prisma.playHistory.findFirst({
      where,
      orderBy: { startedAt: "desc" },
      select: { title: true, mediaType: true, year: true },
    }),
    playsByDay: () => prisma.$queryRawUnsafe<{ day: string; count: bigint }[]>(
      `SELECT to_char(date_trunc('day', ${localStartedAt("$4")}), 'YYYY-MM-DD') AS day,
              COUNT(*)::bigint AS count
       FROM "PlayHistory"
       WHERE "tmdbId" = $1 AND ${mtClause} AND "watched" = true AND "startedAt" >= $3
       GROUP BY day ORDER BY day`,
      tmdbId,
      mt,
      ninetyDaysAgo,
      timeZone,
    ),
    transcodeRatio: () => prisma.$queryRawUnsafe<{ method: string | null; count: bigint }[]>(
      `SELECT "playMethod" AS method, COUNT(*)::bigint AS count
       FROM "PlayHistory" WHERE "tmdbId" = $1 AND ${mtClause}
       GROUP BY "playMethod" ORDER BY count DESC`,
      tmdbId,
      mt,
    ),
    // RESOLUTION_BUCKET_SQL names a bucket for every row, so `resolution` is never null.
    resolutionBreakdown: () => prisma.$queryRawUnsafe<{ resolution: string; count: bigint }[]>(
      `SELECT ${RESOLUTION_BUCKET_SQL} AS resolution, COUNT(*)::bigint AS count
       FROM "PlayHistory"
       WHERE "tmdbId" = $1 AND ${mtClause} AND "resolution" IS NOT NULL
       GROUP BY 1 ORDER BY count DESC`,
      tmdbId,
      mt,
    ),
  });

  const resolvedMedia = r.mediaInfo ?? (await libraryTitle(tmdbId, mediaType));

  return {
    totalPlays: r.totalPlays,
    uniqueViewers: count(r.uniqueViewers[0]?.count),
    avgCompletion: Math.round(Number(r.avgCompletion[0]?.avg_pct ?? 0)),
    topViewers: r.topViewers.map((v) => ({
      id: v.id,
      username: v.username,
      source: v.source,
      count: count(v.count),
      hours: round1(Number(v.hours)),
    })),
    recentPlays: r.recentPlays,
    title: resolvedMedia?.title ?? `TMDB ${tmdbId}`,
    mediaType: resolvedMedia?.mediaType ?? null,
    year: resolvedMedia?.year ?? null,
    timeZone,
    playsByDay: padDailySeries(
      r.playsByDay.map((d) => ({ day: d.day, count: count(d.count) })),
      ninetyDaysAgo,
      timeZone,
      (day) => ({ day, count: 0 }),
    ),
    transcodeRatio: r.transcodeRatio.map((t) => ({ method: t.method ?? "Unknown", count: count(t.count) })),
    resolutionBreakdown: r.resolutionBreakdown.map((x) => ({ resolution: x.resolution, count: count(x.count) })),
  };
}

// A title nobody has played yet (its plays were all deleted, say): name it from
// the library cache instead of "TMDB <id>". Plex first, then Jellyfin.
async function libraryTitle(
  tmdbId: number,
  mediaType: MediaType | undefined,
): Promise<{ title: string | null; mediaType: MediaType | null; year: string | null } | null> {
  const libWhere = mediaType ? { tmdbId, mediaType } : { tmdbId };
  const [plexFallback, jellyfinFallback] = await Promise.all([
    prisma.plexLibraryItem.findFirst({ where: libWhere, select: { title: true, mediaType: true, year: true } }),
    prisma.jellyfinLibraryItem.findFirst({ where: libWhere, select: { title: true, mediaType: true, year: true } }),
  ]);
  return plexFallback ?? jellyfinFallback;
}
