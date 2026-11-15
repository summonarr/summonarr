// The admin Statistics page's aggregate: one memoized bundle per (window,
// source, media type, zone), built from ~25 named statements run under the pool
// cap, plus the previous-period comparison and whether history covers it
// (guardrail 19d).
import { prisma } from "./prisma";
import { DELIVERED_KBPS_SQL } from "./bitrate";
import { getStatsTimeZone } from "./stats-time-zone-data";
import { TRACKING_STAMP_KEYS, parseStampDate } from "./never-watched";
import { getCacheKey, memoizeActivity, STATS_TTL } from "./play-history-cache";
import { count, padDailySeries, round1, runCapped } from "./play-history-aggregate";
import { getArcGapDays, getCompletionThreshold, loadSettings, retentionDaysFrom, type PlayHistorySettings } from "./play-history-settings";
import {
  arcCtes,
  localStartedAt,
  OTHER_REASONS_SQL,
  PLAY_HOURS_SQL,
  RESOLUTION_BUCKET_SQL,
  TITLE_GROUP_BY_SQL,
  TRANSCODE_REASON_SQL,
  TRANSCODE_SQL,
} from "./play-history-sql-fragments";
import { appendPlayHistoryFilter, buildStatsFilters, type PlayHistoryStatsFilters } from "./play-history-stats-filters";
import { getMostRewatchedUncached, getTopWatchedUncached } from "./play-history-leaderboards";

export type PlayHistoryStatsResult = {
  // The statistics zone every day, day-of-week and hour bucket below is in.
  timeZone: string;
  totalPlays: number;
  totalWatchTimeHours: number;
  playsByDay: { day: string; count: number }[];
  topUsers: { id: string; username: string; source: string; count: number }[];
  topMedia: { title: string; tmdbId: number | null; mediaType: string | null; count: number }[];
  transcodeRatio: { method: string; count: number }[];
  playsByPlatform: { platform: string; count: number }[];
  playsByHour: { hour: number; count: number }[];
  mediaTypeBreakdown: { type: string; count: number }[];
  watchTimeByDay: { day: string; hours: number }[];
  heatmap: { dow: number; hour: number; count: number }[];
  completionRate: number;
  completionBuckets: { bucket: string; count: number }[];
  avgBitrateMbps: number;
  totalBandwidthGB: number;
  bandwidthByDay: { day: string; gb: number }[];

  uniqueViewers: number;
  // Distinct (tmdbId, mediaType) pairs — TMDB movie and TV ids overlap.
  uniqueTitles: number;
  // Watched plays in the window whose viewer had ALREADY watched the same item
  // (same movie, or same episode) before — see the rewatch query below — and
  // that count as a share (0–100, one decimal) of the window's watched plays.
  rewatchPlays: number;
  rewatchRate: number;
  avgSessionMinutes: number;
  longestSessionMinutes: number;
  pauseRatio: number;
  peakConcurrent: number;

  uniqueViewersByDay: { day: string; count: number }[];
  playsByDow: { dow: number; count: number }[];

  resolutionBreakdown: { bucket: string; count: number }[];
  videoCodecBreakdown: { codec: string; count: number }[];
  audioCodecBreakdown: { codec: string; count: number }[];
  containerBreakdown: { container: string; count: number }[];
  bitrateBuckets: { bucket: string; count: number }[];
  transcodeReasons: { reason: string; count: number }[];

  topDevices: { device: string; count: number }[];
  topPlayers: { player: string; count: number }[];
  sourceSplit: { source: string; count: number }[];

  decadeBreakdown: { decade: string; count: number }[];
  topRewatched: { tmdbId: number; mediaType: string; title: string; posterPath: string | null; plays: number; viewers: number }[];
  topWatched: { tmdbId: number; mediaType: string; title: string; posterPath: string | null; plays: number; viewers: number }[];
  topEpisodes: { tmdbId: number | null; title: string; season: number | null; episode: number | null; episodeTitle: string | null; count: number }[];

  // `complete` is false when play history does not reach back across the whole
  // previous window — tracking started inside it, or retention purged part of
  // it — so a comparison would measure the gap, not a change. Callers show no
  // period-over-period delta then.
  prevPeriod: { totalPlays: number; totalWatchTimeHours: number; uniqueViewers: number; complete: boolean };
};

export async function getPlayHistoryStats(
  filters: PlayHistoryStatsFilters = {},
): Promise<PlayHistoryStatsResult> {
  // NOTE: The many $queryRawUnsafe calls in the play-history modules (and the route handler)
  // for activity stats/heatmaps use either fully static SQL + bound $1 params,
  // or dynamic fragments built only from whitelisted enum values + parseInt +
  // bound parameters. No user-controlled strings reach SQL structure or identifiers.
  // Keep this discipline on any future edits. See also the route's groupedQuery.
  // The zone is part of the key: a changed zone re-buckets everything, so the
  // old zone's answer must not be served under the new one (19b).
  const timeZone = await getStatsTimeZone();
  return memoizeActivity(
    getCacheKey("stats", { ...filters, zone: timeZone }),
    STATS_TTL,
    () => getPlayHistoryStatsUncached(filters, timeZone),
  );
}

const DAY_MS = 24 * 60 * 60 * 1000;

// The window every current-period statement reads, in its spellings.
interface StatsScope {
  filters: PlayHistoryStatsFilters;
  timeZone: string;
  // The window's start (the series pad from its day).
  cutoff: Date;
  // `where` + `params`: the window and filters ($1, then the filters).
  where: string;
  params: unknown[];
  // `where` limited to watched plays.
  wwhere: string;
  // The same predicates on alias `p`, for the statements that join.
  joinParams: unknown[];
  joinWWhere: string;
  // "startedAt" in the statistics zone, the zone bound right after `params`.
  local: string;
}

function statsScope(filters: PlayHistoryStatsFilters, timeZone: string, now: number): StatsScope {
  const { where, params, cutoff } = buildStatsFilters(filters, "", now);
  const { where: joinWhere, params: joinParams } = buildStatsFilters(filters, "p", now);
  // "plays" surfaces use wwhere (filter watched=true); analytics surfaces (completion rate, codecs,
  // bitrate, bandwidth, peak concurrent, stream method, source split, client apps) use the raw
  // `where` so the denominator stays complete. The Statistics page groups its cards the same way,
  // so no card mixes the two.
  return {
    filters,
    timeZone,
    cutoff,
    where,
    params,
    wwhere: `${where} AND "watched" = true`,
    joinParams,
    joinWWhere: `${joinWhere} AND p."watched" = true`,
    // The two bucketed statements (daily series, day × hour heatmap) bind the
    // zone right after `where`'s params.
    local: localStartedAt(`$${params.length + 1}`),
  };
}

// The previous window of the same length, right before the current one.
function previousWindow(filters: PlayHistoryStatsFilters, now: number) {
  const days = filters.days ?? 30;
  const prevStart = new Date(now - days * 2 * DAY_MS);
  const prevEnd = new Date(now - days * DAY_MS);
  // The previous-period window binds $1/$2 itself; the source/mediaType suffix
  // comes from appendPlayHistoryFilter (the single owner of that clause and its
  // $-index math) rather than a hand copy that could drift from it.
  const { sql, params } = appendPlayHistoryFilter([prevStart, prevEnd], {
    source: filters.source,
    mediaType: filters.mediaType,
  });
  return { days, prevStart, where: `"startedAt" >= $1 AND "startedAt" < $2${sql}`, params };
}

// Was the whole previous window recorded? (guardrail 19d) A play older than its
// start proves tracking (of this source) was already running then. Nothing older
// means it began inside the window, or retention purged it, and a delta would
// measure that gap ("+400%", or "new" on every tile) instead of a change.
// mediaType is deliberately left out: a media type nobody watched is not an
// untracked one. The answer has three parts: the probe statement (`observed`,
// run with the others), the retention setting and the tracking stamps.
function previousWindowCoverage(
  filters: PlayHistoryStatsFilters,
  days: number,
  prevStart: Date,
  settings: PlayHistorySettings,
) {
  const sourceFiltered = filters.source === "plex" || filters.source === "jellyfin";
  // Retention shorter than both windows together means the purge has cut into
  // the previous one even if a few not-yet-purged rows survive past its start.
  const retentionDays = retentionDaysFrom(settings.playHistoryRetentionDays);
  const retentionCutsPrevious = retentionDays > 0 && retentionDays < days * 2;
  // The probe's bound. With retention ≥ both windows the purge deletes exactly
  // the rows older than now − retention — at retention = 2 × days, every row
  // before the previous window's start, i.e. the evidence. A row within a day of
  // the purge cutoff then shows history was clipped by the purge, not by
  // tracking starting, so the bound moves to cutoff + 1 day. Accepted: up to one
  // day of the previous window may be uncovered.
  const probeBound =
    retentionDays > 0 && retentionDays >= days * 2
      ? new Date(Math.max(prevStart.getTime(), Date.now() - retentionDays * DAY_MS + DAY_MS))
      : prevStart;
  const { sql: observedFilterSql, params: observedParams } = appendPlayHistoryFilter([probeBound], {
    source: filters.source,
  });
  // Unfiltered: EVERY source with plays since the bound must also have one
  // before it — old Plex rows say nothing about a Jellyfin server added last
  // week (one with tracking on by default never wrote a stamp). Index-shaped
  // on (source, startedAt). Filtered, the probe above is already per source.
  const perSourceObservedSql = sourceFiltered
    ? ""
    : ` AND NOT EXISTS (
         SELECT 1 FROM (VALUES ('plex'), ('jellyfin')) AS s(src)
         WHERE EXISTS (SELECT 1 FROM "PlayHistory" n WHERE n."source" = s.src AND n."startedAt" >= $1)
           AND NOT EXISTS (SELECT 1 FROM "PlayHistory" o WHERE o."source" = s.src AND o."startedAt" < $1)
       )`;
  // Tracking stamps: a switch turned back on after the previous window began
  // means a gap inside it, whatever older rows exist. The global switch always
  // counts; the filtered source's, or both with no filter. No stamp keeps the
  // old behaviour (installs from before the stamps existed).
  const stampKeys = [
    TRACKING_STAMP_KEYS.playHistoryEnabled,
    ...(filters.source === "plex"
      ? [TRACKING_STAMP_KEYS.playHistoryPlexEnabled]
      : filters.source === "jellyfin"
        ? [TRACKING_STAMP_KEYS.playHistoryJellyfinEnabled]
        : [TRACKING_STAMP_KEYS.playHistoryPlexEnabled, TRACKING_STAMP_KEYS.playHistoryJellyfinEnabled]),
  ];
  const stampsCoverPrevious = stampKeys.every((key) => {
    const stamp = parseStampDate(settings[key]);
    return stamp === null || stamp.getTime() <= prevStart.getTime();
  });
  return {
    retentionCutsPrevious,
    stampsCoverPrevious,
    observedSql: `SELECT (EXISTS (
         SELECT 1 FROM "PlayHistory" WHERE "startedAt" < $1${observedFilterSql}
       )${perSourceObservedSql}) AS observed`,
    observedParams,
  };
}

// Arc-grouped completion: three sittings of one movie should count as one completion, not
// "one watched + two incomplete". Same arc chain as getMostPopularOnServer (arcCtes) —
// consecutive sessions on the same (user, title, season, episode) split by
// playHistoryArcGapDays or by a prior `completed=true` row (rewatch boundary). The arc
// CTE needs one extra param (arcGap) on top of `where`'s params, and the ONE statement
// that reads it binds a second (completionRatio) for the rate; the histogram buckets in
// the same statement use fixed thresholds. Every bound param must be referenced —
// Postgres rejects a prepared statement with an unused bind.
function arcStatement(s: StatsScope, arcGapDays: number, completionPct: number) {
  const arcGapIdx = s.params.length + 1;
  const completionIdx = s.params.length + 2;
  // Identity for the arc partition. tmdbId and mediaType are BOTH NULL on an unmatched
  // play, and SQL PARTITION BY treats NULLs as equal — so every unmatched play by a user
  // collapsed into ONE arc spanning unrelated titles, and the completion rate was
  // computed across them. Fall back to the title, matching how the sibling topMedia
  // query identifies an unmatched item.
  const arcs = arcCtes(s.where, arcGapIdx, {
    key: "arc_key",
    keyExpr: `COALESCE("tmdbId"::text, 'title:' || LOWER(COALESCE("title", '')))`,
    arcSelect: `SUM("playDuration") AS arc_play,
              MAX("duration") AS arc_dur`,
    arcGroupBy: `"mediaServerUserId", arc_key, "mediaType",
                COALESCE("seasonNumber", -1), COALESCE("episodeNumber", -1), arc_id`,
  });
  // An arc's watched share. NULLIF so no evaluation order can divide by a zero
  // runtime: every FILTER below also requires arc_dur > 0.
  const arcRatio = `(arc_play::float / NULLIF(arc_dur, 0))`;
  // Completion rate and its histogram from ONE pass over the arc chain. The
  // buckets keep the old CASE's boundaries: [0, .25), [.25, .5), [.5, .75), [.75, ∞).
  return {
    sql: `WITH ${arcs}
       SELECT COUNT(*) FILTER (WHERE arc_dur > 0 AND ${arcRatio} >= $${completionIdx})::bigint AS watched,
              COUNT(*) FILTER (WHERE arc_dur > 0)::bigint AS total,
              COUNT(*) FILTER (WHERE arc_dur > 0 AND ${arcRatio} < 0.25)::bigint AS b0,
              COUNT(*) FILTER (WHERE arc_dur > 0 AND ${arcRatio} >= 0.25 AND ${arcRatio} < 0.50)::bigint AS b25,
              COUNT(*) FILTER (WHERE arc_dur > 0 AND ${arcRatio} >= 0.50 AND ${arcRatio} < 0.75)::bigint AS b50,
              COUNT(*) FILTER (WHERE arc_dur > 0 AND ${arcRatio} >= 0.75)::bigint AS b75
       FROM arcs`,
    params: [...s.params, arcGapDays * 24 * 60 * 60, completionPct / 100],
  };
}

// A bitrate the delivered-bytes figures can use (see DELIVERED_KBPS_SQL).
const HAS_BITRATE_SQL = `"bitrate" IS NOT NULL AND "bitrate" > 0`;
// Seconds of delivered bitrate (kbps) as decimal gigabytes.
const deliveredGb = (sum: string) => `${sum} / 8.0 / 1000.0 / 1000.0`;

// The window's totals, per-day series, heatmap and peak concurrency.
function windowStatements(s: StatsScope) {
  const { where, params, local, timeZone } = s;
  return {
    // The window's totals: plays and viewers/titles are plays-semantic (watched);
    // hours, session length, pause and bitrate are session analytics over every
    // row, so "how long do people sit through this" stays honest. unique_titles
    // counts (tmdbId, mediaType) PAIRS: TMDB movie and TV ids are separate
    // namespaces that overlap numerically, so a bare DISTINCT "tmdbId" merged a
    // movie and a show sharing an integer into one title.
    //
    // DELIVERED_KBPS_SQL, not the raw column: these figures answer "how many
    // bytes left the server", so a transcoded Plex session must not be measured
    // at its source bitrate. See lib/bitrate.ts — it also carries the unit
    // normalization, which is by SOURCE and never by magnitude (the two servers'
    // ranges overlap, and both possible thresholds have already shipped as bugs:
    // one erased Plex UHD sessions, the other inflated sub-1-Mbps Jellyfin
    // sessions 1000x).
    //
    // Byte conversion is DECIMAL throughout (/1000/1000), matching the kbps input and
    // the avg_mbps figure beside it. It previously divided by 1024 twice, mixing a
    // decimal-k numerator with binary denominators: the result was 2.4% above true GiB
    // and 4.6% below true GB — neither convention, and inconsistent with the Mbps
    // number on the same panel.
    summary: () => prisma.$queryRawUnsafe<{
      plays: bigint;
      hours: number | null;
      unique_viewers: bigint;
      unique_titles: bigint;
      avg_session_s: number | null;
      longest_session_s: number | null;
      pause_ratio: number | null;
      avg_mbps: number | null;
      total_gb: number | null;
    }[]>(
      `SELECT COUNT(*) FILTER (WHERE "watched" = true)::bigint AS plays,
              ${PLAY_HOURS_SQL} AS hours,
              COUNT(DISTINCT "mediaServerUserId") FILTER (WHERE "watched" = true)::bigint AS unique_viewers,
              COUNT(DISTINCT ("tmdbId", "mediaType")) FILTER (WHERE "tmdbId" IS NOT NULL AND "watched" = true)::bigint AS unique_titles,
              COALESCE(AVG(NULLIF("playDuration", 0)), 0)::float8 AS avg_session_s,
              COALESCE(MAX("playDuration"), 0)::int AS longest_session_s,
              (COALESCE(SUM("pausedDuration"), 0)::float8
                / NULLIF(SUM("playDuration"), 0)::float8)::float8 AS pause_ratio,
              (AVG(${DELIVERED_KBPS_SQL} / 1000.0) FILTER (WHERE ${HAS_BITRATE_SQL}))::float8 AS avg_mbps,
              (${deliveredGb(`(SUM(
                ${DELIVERED_KBPS_SQL}
                * "playDuration"::float8
              ) FILTER (WHERE ${HAS_BITRATE_SQL}))`)})::float8 AS total_gb
       FROM "PlayHistory" WHERE ${where}`,
      ...params,
    ),
    // The four per-day series in one pass, with the same semantics per column as
    // the totals above. A day with rows but no watched play reads 0, exactly what
    // padDailySeries fills in for a day with no rows at all.
    daily: () => prisma.$queryRawUnsafe<{ day: string; plays: bigint; hours: number; viewers: bigint; gb: number }[]>(
      `SELECT to_char(date_trunc('day', ${local}), 'YYYY-MM-DD') AS day,
              COUNT(*) FILTER (WHERE "watched" = true)::bigint AS plays,
              ${PLAY_HOURS_SQL} AS hours,
              COUNT(DISTINCT "mediaServerUserId") FILTER (WHERE "watched" = true)::bigint AS viewers,
              (${deliveredGb(`COALESCE(SUM(
                ${DELIVERED_KBPS_SQL}
                * "playDuration"::float8
              ) FILTER (WHERE ${HAS_BITRATE_SQL}), 0)`)})::float8 AS gb
       FROM "PlayHistory" WHERE ${where}
       GROUP BY day ORDER BY day`,
      ...params,
      timeZone,
    ),
    heatmap: () => prisma.$queryRawUnsafe<{ dow: number; hour: number; count: bigint }[]>(
      `SELECT EXTRACT(DOW FROM ${local})::int AS dow,
              EXTRACT(HOUR FROM ${local})::int AS hour,
              COUNT(*)::bigint AS count
       FROM "PlayHistory" WHERE ${s.wwhere}
       GROUP BY dow, hour ORDER BY dow, hour`,
      ...params,
      timeZone,
    ),
    // Sessions are half-open [startedAt, stoppedAt): at a tie the stop (-1) is applied
    // before the start (+1). Both pollers finalize an autoplayed episode and create the
    // next one with the SAME `now`, so ordering starts first counted every autoplay
    // hand-off as two simultaneous streams — one viewer binge-watching read as a peak of 2.
    peakConcurrent: () => prisma.$queryRawUnsafe<{ peak: number | null }[]>(
      `SELECT COALESCE(MAX(concurrent), 0)::int AS peak FROM (
         SELECT SUM(delta) OVER (ORDER BY t, delta ASC) AS concurrent
         FROM (
           SELECT "startedAt" AS t, 1 AS delta FROM "PlayHistory" WHERE ${where}
           UNION ALL
           SELECT "stoppedAt" AS t, -1 AS delta FROM "PlayHistory" WHERE ${where}
         ) events
       ) sweeps`,
      ...params,
    ),
  };
}

// Who watched what: the top viewers, titles and episodes, and the two
// poster-carrying leaderboards.
function titleStatements(s: StatsScope) {
  const { params, wwhere, filters } = s;
  return {
    topUsers: () => prisma.$queryRawUnsafe<{ id: string; username: string; source: string; count: bigint }[]>(
      `WITH user_counts AS (
         SELECT m."id", m."username", m."source", COUNT(*)::bigint AS count
         FROM "PlayHistory" p JOIN "MediaServerUser" m ON m."id" = p."mediaServerUserId"
         WHERE ${s.joinWWhere}
         GROUP BY m."id", m."username", m."source"
       ), ranked AS (
         SELECT *, ROW_NUMBER() OVER (PARTITION BY "source" ORDER BY "count" DESC) AS rn
         FROM user_counts
       )
       SELECT "id", "username", "source", "count"
       FROM ranked
       WHERE rn <= 10
       ORDER BY "count" DESC`,
      ...s.joinParams,
    ),
    // The same title identity as the per-user bundle (TITLE_GROUP_BY_SQL).
    topMedia: () => prisma.$queryRawUnsafe<{ title: string; tmdbId: number | null; mediaType: string | null; count: bigint }[]>(
      `SELECT MAX("title") AS title, "tmdbId", "mediaType"::text AS "mediaType", COUNT(*)::bigint AS count
       FROM "PlayHistory" WHERE ${wwhere}
       ${TITLE_GROUP_BY_SQL}
       ORDER BY count DESC LIMIT 10`,
      ...params,
    ),
    topEpisodes: () => prisma.$queryRawUnsafe<{
      tmdbId: number | null;
      title: string;
      season: number | null;
      episode: number | null;
      episodeTitle: string | null;
      count: bigint;
    }[]>(
      `SELECT "tmdbId", "title",
              "seasonNumber" AS season, "episodeNumber" AS episode,
              "episodeTitle", COUNT(*)::bigint AS count
       FROM "PlayHistory"
       WHERE ${wwhere} AND "mediaType"::text = 'TV'
         AND "seasonNumber" IS NOT NULL AND "episodeNumber" IS NOT NULL
       GROUP BY "tmdbId", "title", "seasonNumber", "episodeNumber", "episodeTitle"
       ORDER BY count DESC LIMIT 10`,
      ...params,
    ),
    topRewatched: () => getMostRewatchedUncached(filters, 10),
    topWatched: () => getTopWatchedUncached(filters, 8),
  };
}

// The session analytics: how plays were delivered and on what (raw `where`,
// every session), plus the watched-play platform/device/media-type splits.
function breakdownStatements(s: StatsScope) {
  const { where, params, wwhere, filters } = s;
  return {
    transcodeRatio: () => prisma.$queryRawUnsafe<{ method: string | null; count: bigint }[]>(
      `SELECT "playMethod" AS method, COUNT(*)::bigint AS count
       FROM "PlayHistory" WHERE ${where}
       GROUP BY "playMethod" ORDER BY count DESC`,
      ...params,
    ),
    playsByPlatform: () => prisma.$queryRawUnsafe<{ platform: string | null; count: bigint }[]>(
      `SELECT "platform", COUNT(*)::bigint AS count
       FROM "PlayHistory" WHERE ${wwhere}
       GROUP BY "platform" ORDER BY count DESC LIMIT 10`,
      ...params,
    ),
    mediaTypeBreakdown: () => prisma.$queryRawUnsafe<{ type: string; count: bigint }[]>(
      `SELECT "mediaType"::text AS type, COUNT(*)::bigint AS count
       FROM "PlayHistory" WHERE ${wwhere} AND "mediaType" IS NOT NULL
       GROUP BY "mediaType" ORDER BY count DESC`,
      ...params,
    ),
    resolutionBreakdown: () => prisma.$queryRawUnsafe<{ bucket: string; count: bigint }[]>(
      `SELECT ${RESOLUTION_BUCKET_SQL} AS bucket, COUNT(*)::bigint AS count
       FROM "PlayHistory" WHERE ${where}
       GROUP BY bucket ORDER BY count DESC`,
      ...params,
    ),
    videoCodecBreakdown: () => prisma.$queryRawUnsafe<{ codec: string; count: bigint }[]>(
      `SELECT COALESCE(NULLIF(UPPER("videoCodec"), ''), 'Unknown') AS codec,
              COUNT(*)::bigint AS count
       FROM "PlayHistory" WHERE ${where}
       GROUP BY codec ORDER BY count DESC LIMIT 8`,
      ...params,
    ),
    audioCodecBreakdown: () => prisma.$queryRawUnsafe<{ codec: string; count: bigint }[]>(
      `SELECT COALESCE(NULLIF(UPPER("audioCodec"), ''), 'Unknown') AS codec,
              COUNT(*)::bigint AS count
       FROM "PlayHistory" WHERE ${where}
       GROUP BY codec ORDER BY count DESC LIMIT 8`,
      ...params,
    ),
    containerBreakdown: () => prisma.$queryRawUnsafe<{ container: string; count: bigint }[]>(
      `SELECT COALESCE(NULLIF(LOWER("container"), ''), 'unknown') AS container,
              COUNT(*)::bigint AS count
       FROM "PlayHistory" WHERE ${where}
       GROUP BY 1 ORDER BY count DESC LIMIT 8`,
      ...params,
    ),
    bitrateBuckets: () => prisma.$queryRawUnsafe<{ bucket: string; count: bigint }[]>(
      `SELECT CASE
         WHEN "bitrate" IS NULL OR "bitrate" <= 0 THEN 'Unknown'
         WHEN (${DELIVERED_KBPS_SQL} / 1000.0) < 2 THEN '<2 Mbps'
         WHEN (${DELIVERED_KBPS_SQL} / 1000.0) < 5 THEN '2-5 Mbps'
         WHEN (${DELIVERED_KBPS_SQL} / 1000.0) < 10 THEN '5-10 Mbps'
         WHEN (${DELIVERED_KBPS_SQL} / 1000.0) < 20 THEN '10-20 Mbps'
         WHEN (${DELIVERED_KBPS_SQL} / 1000.0) < 50 THEN '20-50 Mbps'
         ELSE '50+ Mbps'
       END AS bucket, COUNT(*)::bigint AS count
       FROM "PlayHistory" WHERE ${where}
       GROUP BY bucket ORDER BY count DESC`,
      ...params,
    ),
    transcodeReasons: () => prisma.$queryRawUnsafe<{ reason: string; count: bigint }[]>(
      // Group by the captured transcodeReason (Plex-derived / Jellyfin
      // TranscodeReasons). Multi-reason sessions keep their comma-joined
      // label as one bucket, and pre-capture rows have a null reason and fall
      // into 'Unknown'.
      //
      // The tail is ROLLED UP, not dropped. A plain `LIMIT 8` here returned the
      // top eight buckets while the comment above it claimed the counts "sum to
      // exactly the transcode session total" — they didn't, and the UI prints
      // that sum as "N transcoded sessions" beside a percentage derived from
      // the real total (2,035 vs 2,206 on a live instance, a 171-session gap).
      // Everything past the eighth bucket now lands in one 'Other reasons' row,
      // so the buckets sum to exactly the transcode total again and the claim
      // holds. The row is omitted entirely when there is no tail.
      `WITH reasons AS (
         SELECT ${TRANSCODE_REASON_SQL} AS reason,
                COUNT(*)::bigint AS count
         FROM "PlayHistory"
         WHERE ${where} AND "playMethod" = ${TRANSCODE_SQL}
         GROUP BY 1
       ), ranked AS (
         SELECT reason, count, ROW_NUMBER() OVER (ORDER BY count DESC, reason) AS rn
         FROM reasons
       ), rolled AS (
         SELECT reason, count, rn FROM ranked WHERE rn <= 8
         UNION ALL
         SELECT ${OTHER_REASONS_SQL}, SUM(count)::bigint, 9 FROM ranked WHERE rn > 8
         HAVING SUM(count) > 0
       )
       SELECT reason, count FROM rolled ORDER BY rn`,
      ...params,
    ),
    topDevices: () => prisma.$queryRawUnsafe<{ device: string; count: bigint }[]>(
      `SELECT COALESCE(NULLIF("device", ''), 'Unknown') AS device,
              COUNT(*)::bigint AS count
       FROM "PlayHistory" WHERE ${wwhere}
       GROUP BY 1 ORDER BY count DESC LIMIT 10`,
      ...params,
    ),
    // Client apps and the source split are SESSION analytics (raw `where`), like the codec,
    // resolution and stream-method breakdowns they sit beside on the Statistics page. They
    // used to count watched plays only, so "Source split" summed to fewer sessions than the
    // stream-method bar directly above it in the same card.
    topPlayers: () => prisma.$queryRawUnsafe<{ player: string; count: bigint }[]>(
      `SELECT COALESCE(NULLIF("player", ''), 'Unknown') AS player,
              COUNT(*)::bigint AS count
       FROM "PlayHistory" WHERE ${where}
       GROUP BY 1 ORDER BY count DESC LIMIT 10`,
      ...params,
    ),
    sourceSplit: () => prisma.$queryRawUnsafe<{ source: string; count: bigint }[]>(
      `SELECT "source", COUNT(*)::bigint AS count
       FROM "PlayHistory" WHERE ${where}
       GROUP BY "source" ORDER BY count DESC`,
      ...params,
    ),
    // Movies only, as the card says. An episode's "year" is its own air year and every
    // episode is a play, so without the filter a few binged shows outweighed every film.
    // Under a TV filter the two predicates contradict — the answer is [] by construction,
    // so it is not asked (one statement fewer on the five-connection pool; the wire
    // shape is the same []).
    decadeBreakdown: () => filters.mediaType === "TV"
      ? Promise.resolve([] as { decade: string; count: bigint }[])
      : prisma.$queryRawUnsafe<{ decade: string; count: bigint }[]>(
          `SELECT CASE
             WHEN "year" IS NULL OR "year" = '' THEN 'Unknown'
             WHEN "year" ~ '^[0-9]{4}' THEN (SUBSTRING("year", 1, 3) || '0s')
             ELSE 'Unknown'
           END AS decade, COUNT(*)::bigint AS count
           FROM "PlayHistory" WHERE ${wwhere} AND "mediaType"::text = 'MOVIE'
           GROUP BY decade ORDER BY decade`,
          ...params,
        ),
  };
}

// Rewatch rate. A watched play is a REWATCH when the same viewer (server identity, like
// every viewer count on this page) had already watched the same item before it started:
// the same movie, or the same EPISODE. Matching per episode is the point — episode 2
// after episode 1 is a new play, not a repeat; the old "plays per title" figure counted
// it as one (the trap getMostRewatchedUncached documents). The earlier play may predate
// the window; plays retention has purged are not seen. The server's own item id is a
// SECOND match for every play, not only for unmatched ones: PlayHistory.tmdbId is
// write-once, so an earlier play recorded unmatched (watched before the next library
// sync) never meets a later matched rewatch through the tmdb branch — same item, same
// viewer, earlier, watched is a rewatch whatever tmdbId either row carries. The
// show-level tmdb match is MOVIES only: a TV play missing its season/episode numbers
// matched every other numberless episode of the show (IS NOT DISTINCT FROM NULL), so
// it is judged by its per-episode item id alone, and with none counts as a first
// watch. A play with no match at all can't be judged and counts as a first watch.
// Each branch is shaped for an index:
// (mediaServerUserId, tmdbId, mediaType, seasonNumber, episodeNumber, startedAt) and
// (source, sourceItemId, mediaServerUserId, startedAt). `plays` is counted here, over the
// same rows, so the rate's two halves can't drift apart.
function rewatchStatement(s: StatsScope) {
  return () => prisma.$queryRawUnsafe<{ plays: bigint; rewatches: bigint }[]>(
    `SELECT COUNT(*)::bigint AS plays,
              COUNT(*) FILTER (WHERE (CASE
                WHEN p."tmdbId" IS NOT NULL AND p."mediaType" IS NOT NULL
                     AND p."seasonNumber" IS NOT NULL AND p."episodeNumber" IS NOT NULL THEN EXISTS (
                  SELECT 1 FROM "PlayHistory" q
                  WHERE q."mediaServerUserId" = p."mediaServerUserId"
                    AND q."tmdbId" = p."tmdbId" AND q."mediaType" = p."mediaType"
                    AND q."seasonNumber" = p."seasonNumber" AND q."episodeNumber" = p."episodeNumber"
                    AND q."startedAt" < p."startedAt" AND q."watched" = true)
                WHEN p."tmdbId" IS NOT NULL AND p."mediaType"::text = 'MOVIE' THEN EXISTS (
                  SELECT 1 FROM "PlayHistory" q
                  WHERE q."mediaServerUserId" = p."mediaServerUserId"
                    AND q."tmdbId" = p."tmdbId"
                    AND q."mediaType" IS NOT DISTINCT FROM p."mediaType"
                    AND q."seasonNumber" IS NOT DISTINCT FROM p."seasonNumber"
                    AND q."episodeNumber" IS NOT DISTINCT FROM p."episodeNumber"
                    AND q."startedAt" < p."startedAt" AND q."watched" = true)
                ELSE false
              END) OR (p."sourceItemId" IS NOT NULL AND EXISTS (
                  SELECT 1 FROM "PlayHistory" q
                  WHERE q."source" = p."source" AND q."serverInstance" = p."serverInstance"
                    AND q."sourceItemId" = p."sourceItemId"
                    AND q."mediaServerUserId" = p."mediaServerUserId"
                    AND q."startedAt" < p."startedAt" AND q."watched" = true)))::bigint AS rewatches
       FROM "PlayHistory" p WHERE ${s.joinWWhere}`,
    ...s.joinParams,
  );
}

async function getPlayHistoryStatsUncached(filters: PlayHistoryStatsFilters, timeZone: string): Promise<PlayHistoryStatsResult> {
  // One instant for the current and previous windows, so they meet exactly.
  const now = Date.now();
  const scope = statsScope(filters, timeZone, now);
  const prev = previousWindow(filters, now);
  const [completionPct, arcGapDays, settings] = await Promise.all([
    getCompletionThreshold(),
    getArcGapDays(),
    loadSettings(),
  ]);
  const coverage = previousWindowCoverage(filters, prev.days, prev.prevStart, settings);
  const arc = arcStatement(scope, arcGapDays, completionPct);

  // At most STATS_STATEMENT_CONCURRENCY statements in flight (guardrail 31): an
  // uncached load used to issue all of them at once and hold every pooled
  // connection until the batch drained. Statements reading the same rows with
  // the same grouping are folded into one (summary, daily, heatmap, arcs).
  const r = await runCapped({
    ...windowStatements(scope),
    arcStats: () => prisma.$queryRawUnsafe<{ watched: bigint; total: bigint; b0: bigint; b25: bigint; b50: bigint; b75: bigint }[]>(
      arc.sql,
      ...arc.params,
    ),
    rewatch: rewatchStatement(scope),
    ...titleStatements(scope),
    ...breakdownStatements(scope),
    // Mirror current-period stance: plays/viewers filter watched, hours stays raw.
    prevPeriod: () => prisma.$queryRawUnsafe<{ plays: bigint; hours: number | null; viewers: bigint }[]>(
      `SELECT COUNT(*) FILTER (WHERE "watched" = true)::bigint AS plays,
              ${PLAY_HOURS_SQL} AS hours,
              COUNT(DISTINCT "mediaServerUserId") FILTER (WHERE "watched" = true)::bigint AS viewers
       FROM "PlayHistory" WHERE ${prev.where}`,
      ...prev.params,
    ),
    observed: () => prisma.$queryRawUnsafe<{ observed: boolean }[]>(coverage.observedSql, ...coverage.observedParams),
  });

  const { cutoff } = scope;
  const summary = r.summary[0];
  const prevRow = r.prevPeriod[0];
  const rewatchBase = count(r.rewatch[0]?.plays);
  const rewatchPlays = count(r.rewatch[0]?.rewatches);
  const margins = heatmapMargins(r.heatmap);
  const completion = arcCompletion(r.arcStats[0]);

  // The series run from the rolling cutoff's day (padDailySeries): padding to
  // `days` would drop the oldest edge's rows while totalPlays above counts them.
  const series = <T extends { day: string }>(pick: (d: (typeof r.daily)[number]) => T, fill: (day: string) => T) =>
    padDailySeries(r.daily.map(pick), cutoff, timeZone, fill);

  return {
    timeZone,
    totalPlays: count(summary?.plays),
    totalWatchTimeHours: round1(Number(summary?.hours ?? 0)),
    playsByDay: series((d) => ({ day: d.day, count: count(d.plays) }), (day) => ({ day, count: 0 })),
    topUsers: r.topUsers.map((u) => ({ id: u.id, username: u.username, source: u.source, count: count(u.count) })),
    topMedia: r.topMedia.map((m) => ({ title: m.title, tmdbId: m.tmdbId, mediaType: m.mediaType, count: count(m.count) })),
    transcodeRatio: r.transcodeRatio.map((t) => ({ method: t.method ?? "Unknown", count: count(t.count) })),
    playsByPlatform: r.playsByPlatform.map((p) => ({ platform: p.platform ?? "Unknown", count: count(p.count) })),
    playsByHour: margins.playsByHour,
    mediaTypeBreakdown: r.mediaTypeBreakdown.map((m) => ({ type: m.type, count: count(m.count) })),
    watchTimeByDay: series((d) => ({ day: d.day, hours: Math.round(d.hours * 100) / 100 }), (day) => ({ day, hours: 0 })),
    heatmap: r.heatmap.map((h) => ({ dow: h.dow, hour: h.hour, count: count(h.count) })),
    completionRate: completion.rate,
    completionBuckets: completion.buckets,
    avgBitrateMbps: round1(Number(summary?.avg_mbps ?? 0)),
    totalBandwidthGB: round1(Number(summary?.total_gb ?? 0)),
    bandwidthByDay: series((d) => ({ day: d.day, gb: Math.round(d.gb * 100) / 100 }), (day) => ({ day, gb: 0 })),
    uniqueViewers: count(summary?.unique_viewers),
    uniqueTitles: count(summary?.unique_titles),
    rewatchPlays,
    rewatchRate: rewatchBase > 0 ? Math.round((rewatchPlays / rewatchBase) * 1000) / 10 : 0,
    avgSessionMinutes: summary ? round1(Number(summary.avg_session_s ?? 0) / 60) : 0,
    longestSessionMinutes: summary ? Math.round(Number(summary.longest_session_s ?? 0) / 60) : 0,
    pauseRatio: summary ? Math.round(Number(summary.pause_ratio ?? 0) * 1000) / 1000 : 0,
    peakConcurrent: count(r.peakConcurrent[0]?.peak),
    uniqueViewersByDay: series((d) => ({ day: d.day, count: count(d.viewers) }), (day) => ({ day, count: 0 })),
    playsByDow: margins.playsByDow,
    resolutionBreakdown: r.resolutionBreakdown.map((b) => ({ bucket: b.bucket, count: count(b.count) })),
    videoCodecBreakdown: r.videoCodecBreakdown.map((c) => ({ codec: c.codec, count: count(c.count) })),
    audioCodecBreakdown: r.audioCodecBreakdown.map((c) => ({ codec: c.codec, count: count(c.count) })),
    containerBreakdown: r.containerBreakdown.map((c) => ({ container: c.container, count: count(c.count) })),
    bitrateBuckets: r.bitrateBuckets.map((b) => ({ bucket: b.bucket, count: count(b.count) })),
    transcodeReasons: r.transcodeReasons.map((t) => ({ reason: t.reason, count: count(t.count) })),
    topDevices: r.topDevices.map((d) => ({ device: d.device, count: count(d.count) })),
    topPlayers: r.topPlayers.map((p) => ({ player: p.player, count: count(p.count) })),
    sourceSplit: r.sourceSplit.map((s) => ({ source: s.source, count: count(s.count) })),
    decadeBreakdown: r.decadeBreakdown.map((d) => ({ decade: d.decade, count: count(d.count) })),
    topRewatched: r.topRewatched,
    topWatched: r.topWatched,
    topEpisodes: r.topEpisodes.map((e) => ({
      tmdbId: e.tmdbId,
      title: e.title,
      season: e.season,
      episode: e.episode,
      episodeTitle: e.episodeTitle,
      count: count(e.count),
    })),
    prevPeriod: {
      totalPlays: count(prevRow?.plays),
      totalWatchTimeHours: round1(Number(prevRow?.hours ?? 0)),
      uniqueViewers: count(prevRow?.viewers),
      complete: r.observed[0]?.observed === true && !coverage.retentionCutsPrevious && coverage.stampsCoverPrevious,
    },
  };
}

// playsByHour and playsByDow are the heatmap's margins (same watched rows, same
// zone buckets), in bucket order with empty buckets omitted, like their GROUP BYs.
export function heatmapMargins(heatmap: readonly { dow: number; hour: number; count: bigint | number }[]) {
  const hourTotals = new Map<number, number>();
  const dowTotals = new Map<number, number>();
  for (const cell of heatmap) {
    const n = Number(cell.count);
    hourTotals.set(cell.hour, (hourTotals.get(cell.hour) ?? 0) + n);
    dowTotals.set(cell.dow, (dowTotals.get(cell.dow) ?? 0) + n);
  }
  return {
    playsByHour: [...hourTotals].sort((a, b) => a[0] - b[0]).map(([hour, n]) => ({ hour, count: n })),
    playsByDow: [...dowTotals].sort((a, b) => a[0] - b[0]).map(([dow, n]) => ({ dow, count: n })),
  };
}

// The completion rate (watched arcs over arcs with a runtime) and its histogram:
// the same rows, order and labels the per-bucket GROUP BY returned — empty
// buckets omitted, sorted by label.
export function arcCompletion(
  arc: { watched: bigint; total: bigint; b0: bigint; b25: bigint; b50: bigint; b75: bigint } | undefined,
): { rate: number; buckets: { bucket: string; count: number }[] } {
  const watched = count(arc?.watched);
  const total = count(arc?.total);
  const buckets = (
    [["0-25%", arc?.b0], ["25-50%", arc?.b25], ["50-75%", arc?.b50], ["75-100%", arc?.b75]] as const
  )
    .map(([bucket, n]) => ({ bucket, count: count(n) }))
    .filter((b) => b.count > 0);
  return { rate: total > 0 ? Math.round((watched / total) * 100) : 0, buckets };
}
