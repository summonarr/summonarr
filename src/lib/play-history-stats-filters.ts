// The admin statistics filters (window, source, media type) as SQL: the one
// owner of the dynamic source/mediaType suffix and its $-index math.

export interface PlayHistoryStatsFilters {
  days?: number;
  source?: string;
  mediaType?: string;
}

// Parameters start at $1 here — callers that append further params must continue from params.length+1, not re-start at $1
/**
 * Single source of truth for the play-history `source` / `mediaType` filter
 * suffix and its parameter-index math.
 *
 * Three call sites used to hand-maintain copies of this clause + its `$N`
 * offset (buildStatsFilters, getActivityCalendarUncached, and the activity
 * page's raw queries). A divergence in the `$`-index between copies is the
 * exact 803cd11 bug class — keep this the only place it lives.
 *
 * `baseParams` are the params already bound *before* this suffix (e.g. a
 * startedAt cutoff); placeholder indices continue from `baseParams.length`,
 * so the returned `sql` is safe to append after `WHERE …$1 [AND …$2]`.
 * `tableAlias` namespaces the columns (e.g. "p" → `p."source"`) for JOINs.
 * `source` / `mediaType` are whitelist-validated; anything else is ignored.
 */
export function appendPlayHistoryFilter(
  baseParams: unknown[],
  opts: { source?: string; mediaType?: string; tableAlias?: string } = {},
): { sql: string; params: unknown[] } {
  const prefix = opts.tableAlias ? `${opts.tableAlias}.` : "";
  const clauses: string[] = [];
  const params: unknown[] = [...baseParams];

  if (opts.source === "plex" || opts.source === "jellyfin") {
    params.push(opts.source);
    clauses.push(`${prefix}"source" = $${params.length}`);
  }

  if (opts.mediaType === "MOVIE" || opts.mediaType === "TV") {
    params.push(opts.mediaType);
    clauses.push(`${prefix}"mediaType"::text = $${params.length}`);
  }

  return {
    sql: clauses.length > 0 ? ` AND ${clauses.join(" AND ")}` : "",
    params,
  };
}

// The window (`days`, default 30) plus the shared suffix: `startedAt >= $1`,
// then the filters from $2.
export function buildStatsFilters(filters: PlayHistoryStatsFilters, tableAlias = "") {
  const prefix = tableAlias ? `${tableAlias}.` : "";
  const cutoff = new Date(Date.now() - (filters.days ?? 30) * 24 * 60 * 60 * 1000);
  const { sql, params } = appendPlayHistoryFilter([cutoff], {
    source: filters.source,
    mediaType: filters.mediaType,
    tableAlias,
  });
  return { where: `${prefix}"startedAt" >= $1${sql}`, params, cutoff };
}
