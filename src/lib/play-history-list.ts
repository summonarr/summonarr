// The admin play-history table's two raw queries (GET /api/play-history): the
// SQL and the shaping of its rows. Pure, so the route only fetches and answers.
//
// Injection discipline (keep it): every user-influenced filter (source,
// tmdbId, mediaType, dates, search, …) reaches the SQL as a bound `$N`
// parameter through composeWhere (play-history-filters.ts). The ORDER BY
// column comes only from the PlayHistorySort union below, mapped to a column
// here, and the direction is "asc" | "desc" — no user data reaches an SQL
// identifier or the query's structure.
import type { PlayHistory } from "@/generated/prisma";
import { posterPathKey } from "./poster-cache";
import { posterUrl } from "./tmdb-types";

/** The columns the table sorts by. Each is a PlayHistory column of the same name. */
export type PlayHistorySort = "startedAt" | "title" | "playDuration" | "duration" | "source" | "platform";
export type SortDir = "asc" | "desc";

const SORTS: ReadonlySet<string> = new Set<PlayHistorySort>(["startedAt", "title", "playDuration", "duration", "source", "platform"]);

/** `?sortBy=`, defaulting to startedAt for anything else. */
export function parsePlayHistorySort(raw: string | null): PlayHistorySort {
  return raw !== null && SORTS.has(raw) ? (raw as PlayHistorySort) : "startedAt";
}

/**
 * The ungrouped (one row per segment) page and count queries. `whereSql` is
 * composeWhere's fragment; the page query binds LIMIT and OFFSET after it, at
 * `nextBindIndex` and the one after.
 */
export function ungroupedListSql(whereSql: string, nextBindIndex: number, sortBy: PlayHistorySort, sortDir: SortDir): { dataSql: string; countSql: string } {
  const dir = sortDir.toUpperCase();
  // `id` is a stable secondary sort so OFFSET pagination can't duplicate or
  // skip rows when the primary column is non-unique (title/platform/source/
  // duration/playDuration all repeat) and data shifts between page fetches.
  // Mirrors the export path's (startedAt, id) tiebreaker.
  //
  // Deliberately NO `NULLS LAST` here, unlike the grouped query: Prisma emitted
  // plain `ORDER BY <col> <dir>` for this path, so adding the clause would
  // reshuffle nullable-column sorts (platform) for anyone with the grouping
  // toggle off. The two modes have always differed here; this keeps it that way.
  const dataSql = `
    SELECT h.*,
      msu."username" AS msu_username,
      msu."source" AS msu_source,
      msu."thumbUrl" AS msu_thumb_url,
      u."id" AS msu_user_id,
      u."name" AS msu_user_name
    FROM "PlayHistory" h
    LEFT JOIN "MediaServerUser" msu ON msu.id = h."mediaServerUserId"
    LEFT JOIN "User" u ON u.id = msu."userId"
    WHERE 1=1 ${whereSql}
    ORDER BY h."${sortBy}" ${dir}, h."id" ${dir}
    LIMIT $${nextBindIndex} OFFSET $${nextBindIndex + 1}
  `;
  const countSql = `
    SELECT COUNT(*)::int AS total
    FROM "PlayHistory" h
    WHERE 1=1 ${whereSql}
  `;
  return { dataSql, countSql };
}

/**
 * The grouped (one row per continued-watch chain) page and count queries.
 *
 * The filters pick CHAINS; the aggregates then cover every segment of a picked
 * chain. Filtering segments before the window functions cut a chain at a
 * date-range edge and under-counted its segments and totals, and
 * `watched=false` showed a chain finished in another segment as unwatched.
 * `watched` is decided per chain (chain_watched), not per segment — so
 * `whereSql` must be built WITHOUT the watched filter, which comes in as
 * `watched` here.
 */
export function groupedListSql(
  whereSql: string,
  nextBindIndex: number,
  sortBy: PlayHistorySort,
  sortDir: SortDir,
  watched: "true" | "false" | null,
): { dataSql: string; countSql: string } {
  const dir = sortDir.toUpperCase();
  const chainWatchedSql = watched === null ? "" : ` AND b.chain_watched = ${watched === "true" ? "TRUE" : "FALSE"}`;
  // With any segment filter, `matched` holds the chosen chain ids and `chainRows`
  // pulls every segment of them: the OR lets Postgres serve it from the primary
  // key and the referenceId index, and the COALESCE re-check keeps it exact.
  // With none, every chain is chosen in full and the scan stays a plain one.
  const matchedCte = `matched AS (
      SELECT DISTINCT COALESCE(h."referenceId", h.id) AS chain_id
      FROM "PlayHistory" h
      WHERE 1=1 ${whereSql}
    )`;
  const withMatched = whereSql ? `${matchedCte},\n    ` : "";
  const chainRows = whereSql
    ? `(h.id IN (SELECT chain_id FROM matched) OR h."referenceId" IN (SELECT chain_id FROM matched))
        AND COALESCE(h."referenceId", h.id) IN (SELECT chain_id FROM matched)`
    : "1=1";

  // chain_id = COALESCE("referenceId", id) groups a continued-watch chain
  // (the finalize logic in src/lib/play-history.ts sets PlayHistory.referenceId
  // on resume so all segments of a chain share one value). Window functions
  // aggregate over the chain partition; ROW_NUMBER picks the latest segment
  // as the representative row whose fields the UI displays.
  //
  // sortBy mapping when grouped:
  //   startedAt    → latest segment's startedAt (most recent activity)
  //   playDuration → SUM over chain (total watch time)
  //   duration / title / source / platform → latest segment value
  // chain_id is appended as a stable secondary sort so OFFSET pagination can't
  // duplicate or skip chains when the primary column is non-unique — mirrors
  // the ungrouped path's `id` tiebreaker.
  const sortColumn = sortBy === "playDuration" ? "total_play_duration" : sortBy;
  const dataSql = `
    WITH ${withMatched}base AS (
      SELECT h.*,
        COALESCE(h."referenceId", h.id) AS chain_id,
        ROW_NUMBER() OVER (
          PARTITION BY COALESCE(h."referenceId", h.id)
          ORDER BY h."startedAt" DESC
        )::int AS rn,
        COUNT(*) OVER (
          PARTITION BY COALESCE(h."referenceId", h.id)
        )::int AS segment_count,
        SUM(h."playDuration") OVER (
          PARTITION BY COALESCE(h."referenceId", h.id)
        )::int AS total_play_duration,
        SUM(COALESCE(h."pausedDuration", 0)) OVER (
          PARTITION BY COALESCE(h."referenceId", h.id)
        )::int AS total_paused_duration,
        MIN(h."startedAt") OVER (
          PARTITION BY COALESCE(h."referenceId", h.id)
        ) AS first_started_at,
        MAX(h."stoppedAt") OVER (
          PARTITION BY COALESCE(h."referenceId", h.id)
        ) AS last_stopped_at,
        bool_or(h."watched") OVER (
          PARTITION BY COALESCE(h."referenceId", h.id)
        ) AS chain_watched,
        bool_or(h."completed") OVER (
          PARTITION BY COALESCE(h."referenceId", h.id)
        ) AS chain_completed
      FROM "PlayHistory" h
      WHERE ${chainRows}
    )
    SELECT b.*,
      msu.username AS msu_username,
      msu.source AS msu_source,
      msu."thumbUrl" AS msu_thumb_url
    FROM base b
    LEFT JOIN "MediaServerUser" msu ON msu.id = b."mediaServerUserId"
    WHERE b.rn = 1${chainWatchedSql}
    ORDER BY b."${sortColumn}" ${dir} NULLS LAST, b.chain_id ${dir}
    LIMIT $${nextBindIndex} OFFSET $${nextBindIndex + 1}
  `;

  // The same chains the data query pages through: the chosen ones, narrowed by
  // the chain-level `watched` when it is set.
  const countSql =
    watched === null
      ? `
    SELECT COUNT(DISTINCT COALESCE(h."referenceId", h.id))::int AS total
    FROM "PlayHistory" h
    WHERE 1=1 ${whereSql}
  `
      : `
    WITH ${withMatched}chains AS (
      SELECT bool_or(h."watched") AS chain_watched
      FROM "PlayHistory" h
      WHERE ${chainRows}
      GROUP BY COALESCE(h."referenceId", h.id)
    )
    SELECT COUNT(*)::int AS total
    FROM chains b
    WHERE 1=1${chainWatchedSql}
  `;
  return { dataSql, countSql };
}

// The joined MediaServerUser columns. The join is a LEFT JOIN, so they are
// nullable in the row even though PlayHistory.mediaServerUserId is a required FK.
interface JoinedServerUser {
  msu_username: string | null;
  msu_source: string | null;
  msu_thumb_url: string | null;
}

/** The ungrouped query's row: the segment plus the MediaServerUser join and the User behind it. */
export interface RawUngroupedRow extends PlayHistory, JoinedServerUser {
  msu_user_id: string | null;
  msu_user_name: string | null;
}

/** The grouped query's row: the representative segment plus the window aggregates and the join. */
export interface RawGroupedRow extends PlayHistory, JoinedServerUser {
  chain_id: string;
  rn: number;
  segment_count: number;
  total_play_duration: number;
  total_paused_duration: number;
  first_started_at: Date;
  last_stopped_at: Date;
  chain_watched: boolean;
  chain_completed: boolean;
}

// The nested `mediaServerUser` both modes answer, null when the join found no
// row (never in practice: the FK is required).
function serverUserOf(r: JoinedServerUser) {
  return r.msu_username != null
    ? { username: r.msu_username, source: r.msu_source, thumbUrl: r.msu_thumb_url }
    : null;
}

// The live TmdbMediaCore/TmdbCache path for a row, from resolvePosterPathMap's answer.
function livePosterPath(r: Pick<PlayHistory, "tmdbId" | "mediaType">, livePaths: Record<string, string>): string | null {
  return r.tmdbId != null ? livePaths[posterPathKey(r.tmdbId, r.mediaType)] ?? null : null;
}

/**
 * One ungrouped row as the table reads it: the segment, its server user (with
 * the linked account — `user` keys off the joined id, so a linked account with
 * no name is `{ name: null }`, never an absent link), the posters, and the
 * chain fields as a chain of one, so the client needs no mode switch.
 * `posterUrl` (the web field) stays live-only; `posterPath` — the row's
 * finalize-time snapshot — prefers the live path, which native clients read.
 */
export function shapeUngroupedRow(row: RawUngroupedRow, livePaths: Record<string, string>) {
  const { msu_username, msu_source, msu_thumb_url, msu_user_id, msu_user_name, ...it } = row;
  const serverUser = serverUserOf({ msu_username, msu_source, msu_thumb_url });
  const live = livePosterPath(it, livePaths);
  return {
    ...it,
    mediaServerUser: serverUser ? { ...serverUser, user: msu_user_id != null ? { name: msu_user_name } : null } : null,
    posterPath: live ?? it.posterPath,
    posterUrl: posterUrl(live, "w342"),
    segmentCount: 1,
    chainId: it.referenceId ?? it.id,
    totalPlayDuration: it.playDuration,
    totalPausedDuration: it.pausedDuration,
    firstStartedAt: it.startedAt,
    lastStoppedAt: it.stoppedAt,
  };
}

/**
 * One grouped row: the representative segment with the window aliases mapped
 * to camelCase (each value once — the aliases are destructured OUT before the
 * spread), and the chain-wide watched/completed in place of the segment's own,
 * so a chain finished in an earlier segment still reads as watched.
 */
export function shapeGroupedRow(r: RawGroupedRow, livePaths: Record<string, string>) {
  const {
    rn: _rn, chain_id: _chainId, segment_count: _segmentCount,
    total_play_duration: _totalPlay, total_paused_duration: _totalPaused,
    first_started_at: _firstStarted, last_stopped_at: _lastStopped,
    chain_watched: _chainWatched, chain_completed: _chainCompleted,
    msu_username: _msuUsername, msu_source: _msuSource, msu_thumb_url: _msuThumb,
    ...base
  } = r;
  const live = livePosterPath(r, livePaths);
  return {
    ...base,
    mediaServerUser: serverUserOf(r),
    posterPath: live ?? r.posterPath,
    posterUrl: posterUrl(live, "w342"),
    segmentCount: r.segment_count,
    chainId: r.chain_id,
    totalPlayDuration: r.total_play_duration,
    totalPausedDuration: r.total_paused_duration,
    firstStartedAt: r.first_started_at,
    lastStoppedAt: r.last_stopped_at,
    watched: r.chain_watched,
    completed: r.chain_completed,
  };
}
