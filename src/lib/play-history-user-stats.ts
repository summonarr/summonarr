// The per-person stats bundle: the admin per-user page and the self-service
// /my-stats surfaces, over a SET of MediaServerUser ids (one person can have
// several server identities).
import { prisma } from "./prisma";
import { getStatsTimeZone } from "./stats-time-zone-data";
import { count, padDailySeries, round1, runCapped } from "./play-history-aggregate";
import { localStartedAt, PLAY_HOURS_SQL, RESOLUTION_BUCKET_SQL, sqlParams, TITLE_GROUP_BY_SQL } from "./play-history-sql-fragments";

// How many recent plays the per-user stats bundle carries (the admin per-user
// page's list length).
export const RECENT_PLAYS_SHOWN = 12;

// One statement's binds for the id set: the ids first (one $N each, IN (NULL)
// for none — "IN ()" is a syntax error), then `extra` in order. `refs` are the
// extras' placeholders. Same IN-list discipline as my-watch-history.
export function idScope(ids: readonly string[], ...extra: unknown[]): { idIn: string; refs: string[]; params: unknown[] } {
  const p = sqlParams();
  const idIn = p.bindList(ids);
  const refs = extra.map((v) => p.bind(v));
  return { idIn, refs, params: p.values };
}

// Aggregate the full per-user stats bundle (totals, recent plays, top media,
// daily/heatmap series, codec/resolution/device breakdowns) across a SET of
// MediaServerUser ids (one person can have several server identities). The day
// and day × hour buckets are in the statistics zone, which the bundle names.
export async function getPlayStatsForServerUsers(ids: string[], timeZone?: string) {
  const zone = timeZone ?? (await getStatsTimeZone());
  const ninetyDaysAgo = new Date(Date.now() - 90 * 24 * 60 * 60 * 1000);
  const oneYearAgo = new Date(Date.now() - 365 * 24 * 60 * 60 * 1000);
  // An empty id list renders IN (NULL), which matches no row. Callers today
  // short-circuit on empty, so this is a landmine guard, not a live path
  // (getPlayYearsForServerUsers early-returns for the same reason).
  const all = idScope(ids);
  const recent = idScope(ids, ninetyDaysAgo, zone);
  const year = idScope(ids, oneYearAgo, zone);
  const zoned = idScope(ids, zone);
  const idIn = all.idIn;
  const byIds = `"mediaServerUserId" IN (${idIn})`;

  // A user-facing page, so at most STATS_STATEMENT_CONCURRENCY statements in
  // flight like the admin fan-out (guardrail 31): a dozen at once held every
  // pooled connection.
  const r = await runCapped({
    // "plays" surfaces filter watched=true (sessions that crossed the configured threshold).
    // Raw counts are reserved for technical/resource analytics (codec, transcode, bitrate, avg session).
    totalPlays: () => prisma.playHistory.count({ where: { mediaServerUserId: { in: ids }, watched: true } }),
    totalWatchTime: () => prisma.$queryRawUnsafe<{ hours: number | null }[]>(
      `SELECT ${PLAY_HOURS_SQL} AS hours FROM "PlayHistory" WHERE ${byIds}`,
      ...all.params,
    ),
    // Only what the readers use: the admin per-user page lists RECENT_PLAYS_SHOWN
    // rows with these fields, the self-service surfaces read the newest startedAt.
    recentPlays: () => prisma.playHistory.findMany({
      where: { mediaServerUserId: { in: ids } },
      orderBy: { startedAt: "desc" },
      take: RECENT_PLAYS_SHOWN,
      select: {
        id: true,
        title: true,
        tmdbId: true,
        mediaType: true,
        year: true,
        seasonNumber: true,
        episodeNumber: true,
        resolution: true,
        videoCodec: true,
        startedAt: true,
      },
    }),
    // Group by tmdbId (cross-source dedupe — Plex + Jellyfin entries for the
    // same show collapse) with title fallback for unmapped rows. Previously
    // the GROUP BY also keyed on title, so the same show
    // appeared twice when one source resolved tmdbId and the other didn't.
    // `year` is set only when the group's plays agree on one, so the per-user
    // page's title fallback can tell two same-named films apart.
    topMedia: () => prisma.$queryRawUnsafe<{ title: string; tmdbId: number | null; mediaType: string | null; posterPath: string | null; year: string | null; count: bigint }[]>(
      `SELECT MAX("title") AS title, "tmdbId", "mediaType"::text AS "mediaType", MAX("posterPath") AS "posterPath",
              CASE WHEN COUNT(DISTINCT "year") = 1 THEN MAX("year") END AS year, COUNT(*)::bigint AS count
       FROM "PlayHistory" WHERE ${byIds} AND "watched" = true
       ${TITLE_GROUP_BY_SQL}
       ORDER BY count DESC LIMIT 10`,
      ...all.params,
    ),
    playsByDay: () => prisma.$queryRawUnsafe<{ day: string; count: bigint; hours: number }[]>(
      `SELECT to_char(date_trunc('day', ${localStartedAt(recent.refs[1])}), 'YYYY-MM-DD') AS day,
              COUNT(*) FILTER (WHERE "watched" = true)::bigint AS count,
              ${PLAY_HOURS_SQL} AS hours
       FROM "PlayHistory"
       WHERE ${byIds} AND "startedAt" >= ${recent.refs[0]}
       GROUP BY day ORDER BY day`,
      ...recent.params,
    ),
    platformBreakdown: () => prisma.$queryRawUnsafe<{ platform: string | null; count: bigint }[]>(
      `SELECT "platform", COUNT(*)::bigint AS count
       FROM "PlayHistory" WHERE ${byIds} AND "watched" = true
       GROUP BY "platform" ORDER BY count DESC`,
      ...all.params,
    ),
    activityCalendar: () => prisma.$queryRawUnsafe<{ day: string; count: bigint }[]>(
      `SELECT to_char(date_trunc('day', ${localStartedAt(year.refs[1])}), 'YYYY-MM-DD') AS day,
              COUNT(*)::bigint AS count
       FROM "PlayHistory"
       WHERE ${byIds} AND "watched" = true AND "startedAt" >= ${year.refs[0]}
       GROUP BY day ORDER BY day`,
      ...year.params,
    ),
    avgSessionDuration: () => prisma.$queryRawUnsafe<{ avg_secs: number | null }[]>(
      // Zero-length rows are left out, as in the global summary, so the two figures agree.
      `SELECT AVG(NULLIF("playDuration", 0))::float8 AS avg_secs FROM "PlayHistory" WHERE ${byIds}`,
      ...all.params,
    ),
    transcodeRatio: () => prisma.$queryRawUnsafe<{ method: string | null; count: bigint }[]>(
      `SELECT "playMethod" AS method, COUNT(*)::bigint AS count
       FROM "PlayHistory" WHERE ${byIds}
       GROUP BY "playMethod" ORDER BY count DESC`,
      ...all.params,
    ),
    // RESOLUTION_BUCKET_SQL names a bucket for every row, so `resolution` is never null.
    resolutionBreakdown: () => prisma.$queryRawUnsafe<{ resolution: string; count: bigint }[]>(
      `SELECT ${RESOLUTION_BUCKET_SQL} AS resolution, COUNT(*)::bigint AS count
       FROM "PlayHistory"
       WHERE ${byIds} AND "resolution" IS NOT NULL
       GROUP BY 1 ORDER BY count DESC LIMIT 8`,
      ...all.params,
    ),
    // The all-history heatmap: the zone right after the ids.
    userHeatmap: () => prisma.$queryRawUnsafe<{ dow: number; hour: number; count: bigint }[]>(
      `SELECT EXTRACT(DOW FROM ${localStartedAt(zoned.refs[0])})::int AS dow,
              EXTRACT(HOUR FROM ${localStartedAt(zoned.refs[0])})::int AS hour,
              COUNT(*)::bigint AS count
       FROM "PlayHistory" WHERE ${byIds} AND "watched" = true
       GROUP BY dow, hour ORDER BY dow, hour`,
      ...zoned.params,
    ),
    // `"device" IS NOT NULL` in the WHERE, so `device` is never null.
    deviceList: () => prisma.$queryRawUnsafe<{ device: string; count: bigint }[]>(
      `SELECT "device", COUNT(*)::bigint AS count
       FROM "PlayHistory"
       WHERE ${byIds} AND "watched" = true AND "device" IS NOT NULL
       GROUP BY "device" ORDER BY count DESC LIMIT 6`,
      ...all.params,
    ),
  });

  return {
    timeZone: zone,
    totalPlays: r.totalPlays,
    totalWatchTimeHours: round1(Number(r.totalWatchTime[0]?.hours ?? 0)),
    recentPlays: r.recentPlays,
    topMedia: r.topMedia.map((m) => ({ title: m.title, tmdbId: m.tmdbId, mediaType: m.mediaType, posterPath: m.posterPath, year: m.year, count: count(m.count) })),
    // Padded from the rolling cutoff's day (padDailySeries), so the oldest
    // partial day's rows are charted, not dropped.
    playsByDay: padDailySeries(
      r.playsByDay.map((d) => ({ day: d.day, count: count(d.count), hours: Math.round(d.hours * 100) / 100 })),
      ninetyDaysAgo,
      zone,
      (day) => ({ day, count: 0, hours: 0 }),
    ),
    platformBreakdown: r.platformBreakdown.map((p) => ({ platform: p.platform ?? "Unknown", count: count(p.count) })),
    activityCalendar: r.activityCalendar.map((d) => ({ day: d.day, count: count(d.count) })),
    avgSessionDuration: Math.round(Number(r.avgSessionDuration[0]?.avg_secs ?? 0)),
    transcodeRatio: r.transcodeRatio.map((t) => ({ method: t.method ?? "Unknown", count: count(t.count) })),
    resolutionBreakdown: r.resolutionBreakdown.map((x) => ({ resolution: x.resolution, count: count(x.count) })),
    userHeatmap: r.userHeatmap.map((h) => ({ dow: h.dow, hour: h.hour, count: count(h.count) })),
    deviceList: r.deviceList.map((d) => ({ device: d.device, count: count(d.count) })),
  };
}

// Back-compat single-identity wrapper for the admin per-user activity page; the
// bundle shape is unchanged from when this function held the query body.
export async function getUserPlayStats(mediaServerUserId: string) {
  return getPlayStatsForServerUsers([mediaServerUserId]);
}
