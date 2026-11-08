// SQL fragments every play-history aggregate shares. One definition each, so a
// change in how a resolution, a reason, a title or an hour is read lands in
// every query that reads it.
//
// Injection discipline: every fragment here is built from constants in this
// repo, never from request data. Values a caller supplies are BOUND through
// sqlParams() and referenced by placeholder.
import { LEGACY_PLEX_REASON_LABELS, OTHER_REASONS, UNKNOWN_REASON } from "./transcode-reasons";
import { zonedTimestampSql } from "./stats-time-zone";
import { PLAY_METHOD } from "./play-history-filters";

// A string constant as a SQL string literal. Quotes are doubled, so a label
// that ever gains an apostrophe still yields valid SQL (standard_conforming_strings
// is on, so a backslash is an ordinary character). Constants only: request
// data is bound, never inlined.
export function sqlStringLiteral(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

// Collects a statement's bound values in order and hands back their $N
// placeholders, so the SQL and its params can't drift apart (the 803cd11
// placeholder-offset class). Bind in the order the params should be passed.
export function sqlParams(): {
  bind(value: unknown): string;
  // A list for `IN (…)`. An empty list renders NULL — "IN ()" is a syntax
  // error, "IN (NULL)" matches no row — and binds nothing.
  bindList(values: readonly unknown[]): string;
  values: unknown[];
} {
  const values: unknown[] = [];
  const bind = (value: unknown): string => {
    values.push(value);
    return `$${values.length}`;
  };
  return {
    bind,
    bindList: (list) => (list.length > 0 ? list.map(bind).join(", ") : "NULL"),
    values,
  };
}

// The play's start on the statistics zone's wall clock (stats-time-zone.ts).
// Every hour, day-of-week, day, month and year bucket groups on it (guardrail 19g).
export const localStartedAt = (zoneRef: string) => zonedTimestampSql(`"startedAt"`, zoneRef);

// Seconds of `sum` as fractional hours. `sum` is the whole aggregate, FILTER
// included, so the variants (a table alias, a FILTER) share one conversion.
export const hoursOf = (sum: string) => `(COALESCE(${sum}, 0) / 3600.0)::float8`;
// Hours played across the rows in scope — the common case.
export const PLAY_HOURS_SQL = hoursOf(`SUM("playDuration")`);

// One title per row: the tmdbId (cross-source — Plex and Jellyfin plays of one
// show collapse), with the lower-cased title standing in for an unmatched play.
export const TITLE_GROUP_BY_SQL = `GROUP BY "tmdbId", "mediaType", CASE WHEN "tmdbId" IS NULL THEN LOWER("title") ELSE NULL END`;

// The recognized PlayHistory.playMethod values as SQL literals.
export const DIRECT_PLAY_SQL = sqlStringLiteral(PLAY_METHOD.directPlay);
export const DIRECT_STREAM_SQL = sqlStringLiteral(PLAY_METHOD.directStream);
export const TRANSCODE_SQL = sqlStringLiteral(PLAY_METHOD.transcode);

// Canonical resolution bucketing. Plex/Jellyfin report the same resolution in
// inconsistent forms ("720" vs "720p", "1080" vs "1080p", "4k" vs "2160"), so a
// raw GROUP BY on "resolution" splits one resolution across several rows. Reuse
// this CASE everywhere we surface resolution so the buckets always collapse.
// Never NULL: every branch, the ELSE included, names a bucket.
export const RESOLUTION_BUCKET_SQL = `CASE
  WHEN "resolution" IS NULL OR "resolution" = '' THEN 'Unknown'
  WHEN LOWER("resolution") LIKE '4k%' OR LOWER("resolution") LIKE '2160%' THEN '4K'
  WHEN LOWER("resolution") LIKE '1080%' THEN '1080p'
  WHEN LOWER("resolution") LIKE '720%' THEN '720p'
  WHEN LOWER("resolution") LIKE '576%'
    OR LOWER("resolution") LIKE '540%'
    OR LOWER("resolution") LIKE '480%'
    OR LOWER("resolution") = 'sd' THEN 'SD'
  ELSE 'Other'
END`;

// Canonical transcode-reason read for every surface that groups by reason
// (guardrail 19c). Rows with no reason (recorded before capture began) bucket
// as 'Unknown'. Plex rows written before plex.ts stopped guessing carry a cause
// Plex never reported ("Video codec not supported" for a bandwidth step-down
// too); they are read back as what Plex did report — which stream it
// transcoded — so old and new rows share one bucket. Jellyfin rows keep their
// reasons: those come from Jellyfin's own TranscodeReasons. The replacements
// are fixed literals from transcode-reasons.ts.
const PLEX_REASON_SQL = Object.entries(LEGACY_PLEX_REASON_LABELS).reduce(
  (expr, [from, to]) => `REPLACE(${expr}, ${sqlStringLiteral(from)}, ${sqlStringLiteral(to)})`,
  `"transcodeReason"`,
);
export const TRANSCODE_REASON_SQL = `CASE
  WHEN "transcodeReason" IS NULL OR "transcodeReason" = '' THEN ${sqlStringLiteral(UNKNOWN_REASON)}
  WHEN "source" = 'plex' THEN ${PLEX_REASON_SQL}
  ELSE "transcodeReason"
END`;
// The rolled-up tail row of the Statistics reason chart.
export const OTHER_REASONS_SQL = sqlStringLiteral(OTHER_REASONS);

// The arc chain shared by /popular and the Statistics completion figures. An arc
// is a run of consecutive sessions by one viewer on one item (`key`, mediaType,
// season, episode), broken by a gap of at least the arc-gap param ($arcGapIdx,
// seconds) or by a prior `completed=true` row (a rewatch boundary). Returns the
// CTE list WITHOUT the leading WITH, ending in `arcs`, so a caller appends its
// own CTEs. `keyExpr`, when given, is projected in `base` AS `key`; `arcSelect`
// and `arcGroupBy` shape the `arcs` rows. One definition, so the two callers
// can't drift apart.
export function arcCtes(
  where: string,
  arcGapIdx: number,
  opts: { key: string; keyExpr?: string; arcSelect: string; arcGroupBy: string },
): string {
  const keyColumn = opts.keyExpr ? `${opts.keyExpr} AS ${opts.key}, ` : "";
  const partition = `"mediaServerUserId", ${opts.key}, "mediaType",
                     COALESCE("seasonNumber", -1), COALESCE("episodeNumber", -1)`;
  return `base AS (
      SELECT "mediaServerUserId", "tmdbId", "mediaType",
             "seasonNumber", "episodeNumber", ${keyColumn}
             "startedAt", "playDuration", "duration", "completed"
      FROM "PlayHistory"
      WHERE ${where}
    ),
    arc_flags AS (
      SELECT *,
        CASE
          WHEN LAG("startedAt") OVER w IS NULL
            OR EXTRACT(EPOCH FROM ("startedAt" - LAG("startedAt") OVER w)) >= $${arcGapIdx}
            OR LAG("completed") OVER w = true
          THEN 1 ELSE 0
        END AS arc_start
      FROM base
      WINDOW w AS (
        PARTITION BY ${partition}
        ORDER BY "startedAt"
      )
    ),
    arc_ids AS (
      SELECT *,
        SUM(arc_start) OVER (
          PARTITION BY ${partition}
          ORDER BY "startedAt"
          ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW
        ) AS arc_id
      FROM arc_flags
    ),
    arcs AS (
      SELECT ${opts.arcSelect}
      FROM arc_ids
      GROUP BY ${opts.arcGroupBy}
    )`;
}
