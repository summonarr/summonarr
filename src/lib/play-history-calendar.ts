// The activity heatmaps: the 365-day calendar and the drill-down behind a click
// on one of its cells (or on an hour × day-of-week cell). Every bucket is in
// the statistics zone (guardrail 19g).
import { prisma } from "./prisma";
import { DELIVERED_KBPS_SQL } from "./bitrate";
import { getStatsTimeZone } from "./stats-time-zone-data";
import { zonedMidnightSql } from "./stats-time-zone";
import { CALENDAR_TTL, getCacheKey, memoizeActivity, STATS_TTL } from "./play-history-cache";
import { count, round1 } from "./play-history-aggregate";
import {
  DIRECT_PLAY_SQL,
  DIRECT_STREAM_SQL,
  localStartedAt,
  PLAY_HOURS_SQL,
  RESOLUTION_BUCKET_SQL,
  sqlParams,
  TITLE_GROUP_BY_SQL,
  TRANSCODE_REASON_SQL,
  TRANSCODE_SQL,
} from "./play-history-sql-fragments";
import { appendPlayHistoryFilter } from "./play-history-stats-filters";

export async function getActivityCalendar(
  source?: string,
  mediaType?: string,
): Promise<{ day: string; count: number }[]> {
  const timeZone = await getStatsTimeZone();
  return memoizeActivity(
    getCacheKey("calendar", { source, mediaType, zone: timeZone }),
    CALENDAR_TTL,
    () => getActivityCalendarUncached(source, mediaType, timeZone),
  );
}

async function getActivityCalendarUncached(
  source: string | undefined,
  mediaType: string | undefined,
  timeZone: string,
): Promise<{ day: string; count: number }[]> {
  // The zone is $1, so the filter params start at $2 — see appendPlayHistoryFilter.
  const { sql: filterSql, params: filterParams } = appendPlayHistoryFilter([timeZone], {
    source,
    mediaType,
  });

  const result = await prisma.$queryRawUnsafe<{ day: string; count: bigint }[]>(
    // Days are the statistics zone's, and so is the window: today there, back 364
    // days (365 calendar days inclusive of today), as the zone's midnight in
    // stored UTC so the bare column keeps its index. CURRENT_DATE would be the
    // Postgres session's day, which need not be the zone's; the page hands the
    // client (activity-calendar.tsx) the same zone's today.
    `SELECT to_char(${localStartedAt("$1")}, 'YYYY-MM-DD') AS day, COUNT(*)::bigint AS count
     FROM "PlayHistory"
     WHERE "startedAt" >= ${zonedMidnightSql("(now() AT TIME ZONE $1::text)::date - 364", "$1")} AND "watched" = true${filterSql}
     GROUP BY day
     ORDER BY day ASC`,
    ...filterParams,
  );

  return result.map((r) => ({ day: r.day, count: count(r.count) }));
}

// Per-cell drill-down behind the click popover on the activity heatmaps
// (activity-calendar.tsx day cells + HourHeatmap dow/hour cells). All counts
// filter watched=true so the popover's "total plays" matches the count the
// cell was coloured by (both heatmaps colour from watched=true aggregates).
export interface HeatmapCellQuery {
  mode: "day" | "hour";
  day?: string; // YYYY-MM-DD in the statistics zone — mode="day"
  dow?: number; // Postgres DOW 0=Sun..6=Sat, statistics zone — mode="hour"
  hour?: number; // 0-23, statistics zone — mode="hour"
  userId?: string; // mediaServerUserId — user-scoped pages
  source?: string; // "plex" | "jellyfin"
  mediaType?: string; // "MOVIE" | "TV"
  days?: number; // time window for mode="hour" on the admin (non-user) page
}

export interface HeatmapCellDetail {
  totalPlays: number;
  watchHours: number;
  avgSessionMinutes: number;
  completedCount: number;
  completedPct: number;
  methods: { directPlay: number; directStream: number; transcode: number; other: number };
  topTranscodeReasons: { reason: string; count: number }[];
  source: { plex: number; jellyfin: number };
  mediaType: { movie: number; tv: number; other: number };
  avgBitrateMbps: number;
  dataTransferredGb: number;
  topResolutions: { resolution: string; count: number }[];
  network: { lan: number; wan: number; relay: number };
  // mediaType rides along because the query groups by (tmdbId, mediaType):
  // TMDB movie and TV id spaces overlap, so a movie and a series sharing an
  // integer are two rows and the popover needs the type to key + link them.
  topTitles: { title: string; tmdbId: number | null; mediaType: string | null; count: number }[];
  // Top viewers for the bucket (up to 3). Empty on user-scoped pages (they would
  // always be the page's own user — redundant).
  topUsers: { id: string; username: string; count: number }[];
}

// Through memoizeActivity, so the overview page and the native heatmap-cell
// route asking for one cell at once share ONE five-statement computation. The
// cell is a bucket in the statistics zone, so the zone is part of the key.
export async function getHeatmapCellDetail(q: HeatmapCellQuery): Promise<HeatmapCellDetail> {
  const timeZone = await getStatsTimeZone();
  return memoizeActivity(
    `heatmap-cell:z=${timeZone}:${JSON.stringify(q)}`,
    STATS_TTL,
    () => getHeatmapCellDetailUncached(q, timeZone),
  );
}

// The cell's WHERE and its binds: one predicate every drill-down statement
// shares, so a condition can never reach some of them and not the others.
export function heatmapCellWhere(q: HeatmapCellQuery, timeZone: string): { where: string; params: unknown[] } {
  const conditions: string[] = [`"watched" = true`];
  const { bind, values } = sqlParams();

  if (q.mode === "day") {
    // Half-open range on the BARE column, not DATE("startedAt") = $n. Wrapping
    // the column made the predicate non-sargable, so none of the startedAt
    // indexes could serve it and all five queries below fell back to a
    // sequential scan of the whole table on every popover click.
    //
    // The boundaries are computed in SQL from the bound date string rather than
    // from a JS Date: the day's midnight and the next one IN THE STATISTICS ZONE,
    // as stored-UTC instants, so the range holds exactly the rows the calendar's
    // day bucket counted (a DST day is 23 or 25 hours long, never a fixed 24).
    // It also keeps the loud failure on an impossible-but-well-shaped day like
    // 2026-02-30 — the route's regex admits it, Postgres rejects it, whereas
    // new Date("2026-02-30") silently rolls over to March 2 and would quietly
    // return the wrong day's rows.
    const day = bind(q.day);
    const zone = bind(timeZone);
    conditions.push(
      `"startedAt" >= ${zonedMidnightSql(`${day}::date`, zone)} AND "startedAt" < ${zonedMidnightSql(`${day}::date + 1`, zone)}`,
    );
  } else {
    // Match the source heatmaps' scoping: admin grid is bounded by the `days`
    // window (getPlayHistoryStats); the per-user grid is all-history. Only apply
    // the window when not user-scoped so the popover total matches the cell.
    if (!q.userId && q.days) {
      conditions.push(
        `"startedAt" >= ${bind(new Date(Date.now() - q.days * 24 * 60 * 60 * 1000))}`,
      );
    }
    const local = localStartedAt(bind(timeZone));
    conditions.push(`EXTRACT(DOW FROM ${local})::int = ${bind(q.dow)}`);
    conditions.push(`EXTRACT(HOUR FROM ${local})::int = ${bind(q.hour)}`);
  }
  if (q.userId) conditions.push(`"mediaServerUserId" = ${bind(q.userId)}`);
  if (q.source === "plex" || q.source === "jellyfin") {
    conditions.push(`"source" = ${bind(q.source)}`);
  }
  if (q.mediaType === "MOVIE" || q.mediaType === "TV") {
    conditions.push(`"mediaType"::text = ${bind(q.mediaType)}`);
  }
  return { where: conditions.join(" AND "), params: values };
}

export type HeatmapAggRow = {
  total: bigint;
  watch_hours: number;
  avg_minutes: number;
  completed: bigint;
  direct_play: bigint;
  direct_stream: bigint;
  transcode: bigint;
  method_other: bigint;
  src_plex: bigint;
  src_jellyfin: bigint;
  mt_movie: bigint;
  mt_tv: bigint;
  mt_other: bigint;
  net_lan: bigint;
  net_wan: bigint;
  net_relay: bigint;
  avg_mbps: number | null;
  total_gb: number | null;
};

async function getHeatmapCellDetailUncached(q: HeatmapCellQuery, timeZone: string): Promise<HeatmapCellDetail> {
  const { where, params } = heatmapCellWhere(q, timeZone);

  // Same delivered-bytes expression as the rest of the stats layer (lib/bitrate.ts)
  // so this popover's Mbps/GB agree with the panel behind it — mirrors the
  // total_gb query in the Statistics summary.
  const normBitrate = DELIVERED_KBPS_SQL;

  const [agg, reasons, resolutions, titles, topUserRows] = await Promise.all([
    prisma.$queryRawUnsafe<HeatmapAggRow[]>(
      `SELECT
         COUNT(*)::bigint AS total,
         ${PLAY_HOURS_SQL} AS watch_hours,
         (COALESCE(AVG("playDuration"), 0) / 60.0)::float8 AS avg_minutes,
         COUNT(*) FILTER (WHERE "completed" = true)::bigint AS completed,
         COUNT(*) FILTER (WHERE "playMethod" = ${DIRECT_PLAY_SQL})::bigint AS direct_play,
         COUNT(*) FILTER (WHERE "playMethod" = ${DIRECT_STREAM_SQL})::bigint AS direct_stream,
         COUNT(*) FILTER (WHERE "playMethod" = ${TRANSCODE_SQL})::bigint AS transcode,
         COUNT(*) FILTER (WHERE "playMethod" IS NULL OR "playMethod" NOT IN (${DIRECT_PLAY_SQL},${DIRECT_STREAM_SQL},${TRANSCODE_SQL}))::bigint AS method_other,
         COUNT(*) FILTER (WHERE "source" = 'plex')::bigint AS src_plex,
         COUNT(*) FILTER (WHERE "source" = 'jellyfin')::bigint AS src_jellyfin,
         COUNT(*) FILTER (WHERE "mediaType"::text = 'MOVIE')::bigint AS mt_movie,
         COUNT(*) FILTER (WHERE "mediaType"::text = 'TV')::bigint AS mt_tv,
         COUNT(*) FILTER (WHERE "mediaType" IS NULL)::bigint AS mt_other,
         COUNT(*) FILTER (WHERE "location" = 'lan')::bigint AS net_lan,
         COUNT(*) FILTER (WHERE "location" = 'wan')::bigint AS net_wan,
         COUNT(*) FILTER (WHERE "location" = 'relay' OR "relayed" = true)::bigint AS net_relay,
         (AVG(${normBitrate} / 1000.0) FILTER (WHERE "bitrate" > 0))::float8 AS avg_mbps,
         (COALESCE(SUM((${normBitrate})::float8 * "playDuration"::float8) FILTER (WHERE "bitrate" > 0), 0) / 8.0 / 1000.0 / 1000.0)::float8 AS total_gb
       FROM "PlayHistory" WHERE ${where}`,
      ...params,
    ),
    // Same reason read as the Statistics page (legacy Plex labels normalized), so a
    // cell's reasons and the page's chart name one cause the same way.
    prisma.$queryRawUnsafe<{ reason: string; count: bigint }[]>(
      `SELECT ${TRANSCODE_REASON_SQL} AS reason, COUNT(*)::bigint AS count
       FROM "PlayHistory" WHERE ${where} AND "transcodeReason" IS NOT NULL AND "transcodeReason" <> ''
       GROUP BY 1 ORDER BY count DESC LIMIT 4`,
      ...params,
    ),
    // Bucket via the canonical CASE so "720"/"720p" and "1080"/"1080p" collapse
    // into one row each (raw GROUP BY split them — the formatting bug). Exclude
    // the 'Unknown' bucket so an absent resolution doesn't show as a fake row.
    prisma.$queryRawUnsafe<{ resolution: string; count: bigint }[]>(
      `SELECT ${RESOLUTION_BUCKET_SQL} AS resolution, COUNT(*)::bigint AS count
       FROM "PlayHistory" WHERE ${where} AND "resolution" IS NOT NULL AND "resolution" <> ''
       GROUP BY 1 ORDER BY count DESC LIMIT 4`,
      ...params,
    ),
    // Most-played titles in the bucket — same tmdbId/title dedup as the stats
    // topMedia query (null tmdbId falls back to lowercased title).
    prisma.$queryRawUnsafe<{ title: string; tmdbId: number | null; mediaType: string | null; count: bigint }[]>(
      `SELECT MAX("title") AS title, "tmdbId", "mediaType"::text AS "mediaType", COUNT(*)::bigint AS count
       FROM "PlayHistory" WHERE ${where} AND "title" IS NOT NULL AND "title" <> ''
       ${TITLE_GROUP_BY_SQL}
       ORDER BY count DESC LIMIT 4`,
      ...params,
    ),
    // Top viewer — skipped on user-scoped pages (always the page's own user).
    // Filter inside a CTE (bare column names, no alias collisions) then join
    // MediaServerUser outside; PlayHistory and MediaServerUser both have a
    // "source" column so a direct join on the filtered set would be ambiguous.
    q.userId
      ? Promise.resolve([] as { id: string; username: string; count: bigint }[])
      : prisma.$queryRawUnsafe<{ id: string; username: string; count: bigint }[]>(
          `WITH f AS (
             SELECT "mediaServerUserId", COUNT(*)::bigint AS count
             FROM "PlayHistory" WHERE ${where}
             GROUP BY "mediaServerUserId"
           )
           SELECT m."id" AS id, m."username" AS username, f."count" AS count
           FROM f JOIN "MediaServerUser" m ON m."id" = f."mediaServerUserId"
           ORDER BY f."count" DESC LIMIT 3`,
          ...params,
        ),
  ]);

  return toHeatmapCellDetail(agg[0], { reasons, resolutions, titles, topUserRows });
}

// The popover's shape from the five statements' rows.
export function toHeatmapCellDetail(
  r: HeatmapAggRow | undefined,
  lists: {
    reasons: { reason: string; count: bigint }[];
    resolutions: { resolution: string; count: bigint }[];
    titles: { title: string; tmdbId: number | null; mediaType: string | null; count: bigint }[];
    topUserRows: { id: string; username: string; count: bigint }[];
  },
): HeatmapCellDetail {
  const { reasons, resolutions, titles, topUserRows } = lists;
  const total = count(r?.total);
  const completedCount = count(r?.completed);
  return {
    totalPlays: total,
    watchHours: round1(Number(r?.watch_hours ?? 0)),
    avgSessionMinutes: Math.round(Number(r?.avg_minutes ?? 0)),
    completedCount,
    completedPct: total > 0 ? Math.round((completedCount / total) * 100) : 0,
    methods: {
      directPlay: count(r?.direct_play),
      directStream: count(r?.direct_stream),
      transcode: count(r?.transcode),
      other: count(r?.method_other),
    },
    topTranscodeReasons: reasons.map((x) => ({ reason: x.reason, count: count(x.count) })),
    source: {
      plex: count(r?.src_plex),
      jellyfin: count(r?.src_jellyfin),
    },
    mediaType: {
      movie: count(r?.mt_movie),
      tv: count(r?.mt_tv),
      other: count(r?.mt_other),
    },
    avgBitrateMbps: round1(Number(r?.avg_mbps ?? 0)),
    dataTransferredGb: Math.round(Number(r?.total_gb ?? 0) * 100) / 100,
    topResolutions: resolutions.map((x) => ({ resolution: x.resolution, count: count(x.count) })),
    network: {
      lan: count(r?.net_lan),
      wan: count(r?.net_wan),
      relay: count(r?.net_relay),
    },
    topTitles: titles.map((x) => ({
      title: x.title,
      tmdbId: x.tmdbId,
      mediaType: x.mediaType,
      count: count(x.count),
    })),
    topUsers: topUserRows.map((u) => ({
      id: u.id,
      username: u.username,
      count: count(u.count),
    })),
  };
}
