import { escapeIlike, SEARCH_TERM_MAX_LEN } from "@/lib/sanitize";

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

// The recognized PlayHistory.playMethod values. Exported so the export route's
// audit row can log the VALIDATED filter rather than the raw param.
export const PLAY_METHODS: readonly string[] = ["DirectPlay", "DirectStream", "Transcode"];

// Translate the query-string filters into a flat list of SQL fragments.
// Fragments reference the PlayHistory table as `h`, so every caller must alias
// it that way. Absent/unrecognized params contribute nothing.
export function parsePlayHistoryFilters(params: URLSearchParams): SqlFragment[] {
  const fragments: SqlFragment[] = [];

  const source = params.get("source");
  if (source === "plex" || source === "jellyfin") {
    fragments.push({ sql: `h."source" = ?`, binds: [source] });
  }

  const tmdbIdRaw = params.get("tmdbId");
  if (tmdbIdRaw) {
    const tmdbId = parseInt(tmdbIdRaw, 10);
    if (!isNaN(tmdbId)) {
      fragments.push({ sql: `h."tmdbId" = ?`, binds: [tmdbId] });
    }
  }

  const mediaType = params.get("mediaType");
  if (mediaType === "MOVIE" || mediaType === "TV") {
    fragments.push({ sql: `h."mediaType" = CAST(? AS "MediaType")`, binds: [mediaType] });
  }

  const watched = params.get("watched");
  if (watched === "true") fragments.push({ sql: `h."watched" = TRUE`, binds: [] });
  else if (watched === "false") fragments.push({ sql: `h."watched" = FALSE`, binds: [] });

  const userId = params.get("userId");
  if (userId) fragments.push({ sql: `h."mediaServerUserId" = ?`, binds: [userId] });

  const playMethod = params.get("playMethod");
  if (playMethod && PLAY_METHODS.includes(playMethod)) {
    fragments.push({ sql: `h."playMethod" = ?`, binds: [playMethod] });
  }

  const platform = params.get("platform");
  if (platform) fragments.push({ sql: `h."platform" = ?`, binds: [platform] });

  const startDate = params.get("startDate");
  if (startDate) fragments.push({ sql: `h."startedAt" >= ?`, binds: [new Date(startDate)] });
  const endDate = params.get("endDate");
  if (endDate) fragments.push({ sql: `h."startedAt" <= ?`, binds: [new Date(endDate)] });

  const search = params.get("search")?.trim().slice(0, SEARCH_TERM_MAX_LEN);
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
