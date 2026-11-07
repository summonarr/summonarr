import { escapeIlike, SEARCH_TERM_MAX_LEN } from "@/lib/sanitize";
import { zonedMidnightSql } from "@/lib/stats-time-zone";

// Shared query-string → SQL translation for the admin play-history surfaces:
// the list route's grouped and ungrouped paths (src/app/api/play-history/
// route.ts) and the CSV/JSON export (…/export/route.ts). All three read the
// SAME filter params — the admin table builds one URLSearchParams and hands it
// to both endpoints (src/components/admin/activity-history/helpers.ts) — so
// they must agree on what each param means.
//
// Why raw fragments instead of a Prisma `where`: the `search` filter. Prisma's
// `contains` emits an ILIKE with no ESCAPE clause, so the only way to make a
// term containing `%`/`_` match literally there is to STRIP those characters —
// which silently drops rows (a search for `john_doe` becomes `johndoe`). An
// escaped bind paired with an explicit `ESCAPE '\'` matches the term the user
// actually typed, and that pairing requires SQL we control. See escapeIlike in
// src/lib/sanitize.ts for the full escape-vs-strip rule.
//
// Injection discipline (unchanged from the grouped path this was extracted
// from): every user-influenced value is either whitelisted to a literal, run
// through parseInt, or appended to `binds` and referenced by position. No user
// data reaches SQL identifiers or structure. Preserve that in any new fragment.

// A filter expression plus its binds. Each entry contributes one "AND <sql>"
// term; `?` placeholders are renumbered to `$N` at composition time.
export type SqlFragment = { sql: string; binds: unknown[] };

// The recognized PlayHistory.playMethod values; anything else narrows nothing.
export const PLAY_METHODS: readonly string[] = ["DirectPlay", "DirectStream", "Transcode"];

// The filters as they actually narrow the query: each is the recognised value,
// or null when the param is absent or not one this module understands. The
// export's audit row records THESE, so it never claims a scope the export did
// not have (`source=plexx` exports every row, so it must log source: null).
export interface PlayHistoryFilterValues {
  source: "plex" | "jellyfin" | null;
  tmdbId: number | null;
  mediaType: "MOVIE" | "TV" | null;
  watched: "true" | "false" | null;
  userId: string | null;
  playMethod: string | null;
  platform: string | null;
  startAt: Date | null;
  endAt: Date | null;
  // Whole days (YYYY-MM-DD) in the statistics zone, as the activity calendar
  // buckets them: a calendar cell's "view these plays" link lists exactly the
  // plays it counted. `timeZone` is the zone they are read in.
  fromDay: string | null;
  toDay: string | null;
  timeZone: string;
  search: string | null;
}

// An unparseable date is ignored like any other unrecognized param — binding an
// Invalid Date makes the driver throw (a 500 for a malformed query string).
function parseDateParam(raw: string | null): Date | null {
  const at = raw ? new Date(raw) : null;
  return at && !isNaN(at.getTime()) ? at : null;
}

// A real calendar day as YYYY-MM-DD, or null. 2026-02-30 is refused here:
// Postgres would reject it mid-query (a 500), where the route answers a 400.
function parseDayParam(raw: string | null): string | null {
  const m = raw ? /^(\d{4})-(\d{2})-(\d{2})$/.exec(raw) : null;
  if (!m) return null;
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  const at = new Date(Date.UTC(y, mo - 1, d));
  return at.getUTCFullYear() === y && at.getUTCMonth() === mo - 1 && at.getUTCDate() === d ? raw : null;
}

// `timeZone` is the statistics zone (getStatsTimeZone): the fromDay/toDay
// filters are whole days there.
export function normalizePlayHistoryFilters(params: URLSearchParams, timeZone: string): PlayHistoryFilterValues {
  const source = params.get("source");
  const tmdbIdRaw = params.get("tmdbId");
  const tmdbId = tmdbIdRaw ? parseInt(tmdbIdRaw, 10) : NaN;
  const mediaType = params.get("mediaType");
  const watched = params.get("watched");
  const playMethod = params.get("playMethod");
  return {
    source: source === "plex" || source === "jellyfin" ? source : null,
    tmdbId: isNaN(tmdbId) ? null : tmdbId,
    mediaType: mediaType === "MOVIE" || mediaType === "TV" ? mediaType : null,
    watched: watched === "true" || watched === "false" ? watched : null,
    userId: params.get("userId") || null,
    playMethod: playMethod && PLAY_METHODS.includes(playMethod) ? playMethod : null,
    platform: params.get("platform") || null,
    startAt: parseDateParam(params.get("startDate")),
    endAt: parseDateParam(params.get("endDate")),
    fromDay: parseDayParam(params.get("fromDay")),
    toDay: parseDayParam(params.get("toDay")),
    timeZone,
    search: params.get("search")?.trim().slice(0, SEARCH_TERM_MAX_LEN) || null,
  };
}

// The first date param that is present but unparseable, or null. The list and
// export routes answer it with a 400 before any query or audit write.
export function invalidDateParam(params: URLSearchParams): "startDate" | "endDate" | "fromDay" | "toDay" | null {
  for (const name of ["startDate", "endDate"] as const) {
    const value = params.get(name);
    if (value && isNaN(new Date(value).getTime())) return name;
  }
  for (const name of ["fromDay", "toDay"] as const) {
    const value = params.get(name);
    if (value && parseDayParam(value) === null) return name;
  }
  return null;
}

// Translate the query-string filters into a flat list of SQL fragments.
// Fragments reference the PlayHistory table as `h`, so every caller must alias
// it that way. Absent/unrecognized params contribute nothing.
export function parsePlayHistoryFilters(params: URLSearchParams, timeZone: string): SqlFragment[] {
  return playHistoryFilterFragments(normalizePlayHistoryFilters(params, timeZone));
}

// The fragments for already-normalized values. A caller that decides one filter
// itself (the grouped list applies `watched` per CHAIN) passes it as null here.
export function playHistoryFilterFragments(v: PlayHistoryFilterValues): SqlFragment[] {
  const fragments: SqlFragment[] = [];

  if (v.source) fragments.push({ sql: `h."source" = ?`, binds: [v.source] });
  if (v.tmdbId !== null) fragments.push({ sql: `h."tmdbId" = ?`, binds: [v.tmdbId] });
  if (v.mediaType) fragments.push({ sql: `h."mediaType" = CAST(? AS "MediaType")`, binds: [v.mediaType] });
  if (v.watched === "true") fragments.push({ sql: `h."watched" = TRUE`, binds: [] });
  else if (v.watched === "false") fragments.push({ sql: `h."watched" = FALSE`, binds: [] });
  if (v.userId) fragments.push({ sql: `h."mediaServerUserId" = ?`, binds: [v.userId] });
  if (v.playMethod) fragments.push({ sql: `h."playMethod" = ?`, binds: [v.playMethod] });
  if (v.platform) fragments.push({ sql: `h."platform" = ?`, binds: [v.platform] });
  if (v.startAt) fragments.push({ sql: `h."startedAt" >= ?`, binds: [v.startAt] });
  if (v.endAt) fragments.push({ sql: `h."startedAt" <= ?`, binds: [v.endAt] });
  // A day runs from its midnight to the next one in the zone (23 or 25 hours
  // across a DST change), compared on the bare column so its indexes serve it.
  // Placeholders in order: the day, then the zone.
  if (v.fromDay) {
    fragments.push({ sql: `h."startedAt" >= ${zonedMidnightSql("CAST(? AS date)", "?")}`, binds: [v.fromDay, v.timeZone] });
  }
  if (v.toDay) {
    fragments.push({ sql: `h."startedAt" < ${zonedMidnightSql("CAST(? AS date) + 1", "?")}`, binds: [v.toDay, v.timeZone] });
  }

  const search = v.search;
  if (search) {
    // Username search needs the MediaServerUser table, which is a JOIN on some
    // of these paths and not on others; keep this filter self-contained by
    // emitting an EXISTS subquery test instead, so it composes cleanly with the
    // other fragments and with any caller's FROM clause.
    // Escape `%`/`_`/`\` in the search term so it matches literally, and append
    // `ESCAPE '\'` to every ILIKE clause so Postgres honors those escapes. Both
    // halves are load-bearing: the escape without the clause matches nothing,
    // the clause without the escape lets a wildcard-laden search string force an
    // expensive, unindexable scan across title / ipAddress / username.
    const like = `%${escapeIlike(search)}%`;
    fragments.push({
      sql: `(h."title" ILIKE ? ESCAPE '\\' OR h."ipAddress" ILIKE ? ESCAPE '\\' OR EXISTS (
              SELECT 1 FROM "MediaServerUser" msu2
              WHERE msu2.id = h."mediaServerUserId" AND msu2."username" ILIKE ? ESCAPE '\\'
            ))`,
      binds: [like, like, like],
    });
  }

  return fragments;
}

// Renumber `?` placeholders in a SQL string to `$1, $2, ...` starting at
// `startIndex`. Postgres needs positional binds, not the `?` placeholder.
function renumber(sql: string, startIndex: number): { sql: string; nextIndex: number } {
  let i = startIndex;
  const out = sql.replace(/\?/g, () => `$${i++}`);
  return { sql: out, nextIndex: i };
}

// Join fragments into a `WHERE 1=1 ${whereSql}` suffix. `nextBindIndex` is the
// first free `$N` for whatever the caller appends afterwards (LIMIT/OFFSET, a
// keyset cursor); keep binds and indices in lockstep or the query reads the
// wrong parameter — see tests/play-history-sql.test.mts for that failure class.
export function composeWhere(fragments: SqlFragment[]): {
  whereSql: string;
  binds: unknown[];
  nextBindIndex: number;
} {
  const binds: unknown[] = [];
  const parts: string[] = [];
  let next = 1;
  for (const f of fragments) {
    const { sql, nextIndex } = renumber(f.sql, next);
    parts.push(sql);
    binds.push(...f.binds);
    next = nextIndex;
  }
  return {
    whereSql: parts.length > 0 ? `AND ${parts.join(" AND ")}` : "",
    binds,
    nextBindIndex: next,
  };
}
