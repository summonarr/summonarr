import { NextResponse } from "next/server";
import { withAdmin } from "@/lib/api-auth";
import { prisma } from "@/lib/prisma";
import { resolvePosterMap } from "@/lib/poster-cache";
import { checkRateLimit, getClientIp } from "@/lib/rate-limit";

export const dynamic = "force-dynamic";

// Escape LIKE/ILIKE wildcard metacharacters (`%`, `_`, and the escape char `\`
// itself) so user-supplied search text is matched LITERALLY rather than as a
// pattern. Without this, a query containing many `%`/`_` wildcards expands into an
// unindexable full-table scan with pathological pattern matching — letting a search
// box trigger an expensive query (a wildcard-scan denial-of-service). Each escaped
// value must be paired with `ESCAPE '\'` on its ILIKE clause so Postgres treats the
// backslash we inserted as the escape character and matches the metacharacters as
// literal text.
function escapeIlike(s: string): string {
  return s.replace(/\\/g, "\\\\").replace(/%/g, "\\%").replace(/_/g, "\\_");
}

// The Prisma `contains` filter (used on the ungrouped path) emits an ILIKE with
// NO `ESCAPE` clause, so any `%`/`_` in the search term remain wildcards and a
// wildcard-laden string forces an unindexable pattern scan (a search-box DoS).
// Unlike the grouped raw-SQL path we cannot attach an ESCAPE clause here, so we
// strip the metacharacters (and the escape char) and bound the length, leaving a
// literal substring match for normal text.
const MAX_SEARCH_LEN = 100;
function sanitizeContainsSearch(s: string): string {
  return s.replace(/[%_\\]/g, "").slice(0, MAX_SEARCH_LEN);
}

export const GET = withAdmin(async (request, _ctx, session) => {
  // The grouped path runs two heavy window-function/aggregate raw queries over
  // the full PlayHistory table per request; throttle per admin to bound abuse.
  if (!checkRateLimit(`play-history:${session.user.id}:${getClientIp(request.headers)}`, 120, 60_000)) {
    return NextResponse.json({ error: "Too many requests — try again shortly" }, { status: 429 });
  }

  const params = request.nextUrl.searchParams;

  const distinctMode = params.get("distinct");
  if (distinctMode === "platforms") {
    const rows = await prisma.$queryRawUnsafe<{ platform: string }[]>(
      `SELECT DISTINCT "platform" FROM "PlayHistory" WHERE "platform" IS NOT NULL ORDER BY "platform"`,
    );
    return NextResponse.json(rows.map((r) => r.platform));
  }
  if (distinctMode === "users") {
    const rows = await prisma.mediaServerUser.findMany({
      select: { id: true, username: true, source: true },
      orderBy: { username: "asc" },
    });
    return NextResponse.json(rows);
  }

  const page = Math.min(Math.max(1, parseInt(params.get("page") ?? "1", 10) || 1), 10_000);
  const limit = Math.min(200, Math.max(1, parseInt(params.get("limit") ?? "20", 10) || 20));
  const skip = (page - 1) * limit;

  // Default: collapse continued watches (PlayHistory.referenceId chains) into
  // one logical viewing per chain. The chain's *latest* segment is the
  // representative row (for title/poster/codec/etc) and the response includes
  // aggregates over the whole chain (totalPlayDuration, segmentCount). Pass
  // ?ungrouped=true to see individual segments — used when the user toggles
  // the "Group continued watches" switch off in the filter bar.
  const ungrouped = params.get("ungrouped") === "true";

  const sortDir = params.get("sortDir") === "asc" ? "asc" : "desc";
  const sortByRaw = params.get("sortBy");
  type SortField = "startedAt" | "title" | "playDuration" | "duration" | "source" | "platform";
  const safeSortBy: SortField = ((): SortField => {
    switch (sortByRaw) {
      case "startedAt": return "startedAt";
      case "title": return "title";
      case "playDuration": return "playDuration";
      case "duration": return "duration";
      case "source": return "source";
      case "platform": return "platform";
      default: return "startedAt";
    }
  })();

  if (ungrouped) {
    return ungroupedQuery(params, page, limit, skip, safeSortBy, sortDir);
  }

  return groupedQuery(params, page, limit, skip, safeSortBy, sortDir);
});

// Shape of a filter expression for raw-SQL composition. Each entry adds an
// "AND <sql>" fragment with its binds appended to the parameter list.
type SqlFragment = { sql: string; binds: unknown[] };

// Translate the query-string filters into a flat list of SQL fragments. Same
// semantics as the original Prisma `where` object, but emitted as `$N`-bound
// fragments so they can be composed into a window-function query.
function parseFilters(params: URLSearchParams): SqlFragment[] {
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
  if (playMethod && ["DirectPlay", "DirectStream", "Transcode"].includes(playMethod)) {
    fragments.push({ sql: `h."playMethod" = ?`, binds: [playMethod] });
  }

  const platform = params.get("platform");
  if (platform) fragments.push({ sql: `h."platform" = ?`, binds: [platform] });

  const startDate = params.get("startDate");
  if (startDate) fragments.push({ sql: `h."startedAt" >= ?`, binds: [new Date(startDate)] });
  const endDate = params.get("endDate");
  if (endDate) fragments.push({ sql: `h."startedAt" <= ?`, binds: [new Date(endDate)] });

  const search = params.get("search")?.trim();
  if (search) {
    // Username search needs the MediaServerUser table, which is a JOIN in the
    // grouped path; keep this filter self-contained by emitting an EXISTS subquery
    // test instead, so it composes cleanly with the other fragments.
    // Escape `%`/`_`/`\` in the search term so it matches literally, and append
    // `ESCAPE '\'` to every ILIKE clause so Postgres honors those escapes. This is
    // what prevents a wildcard-laden search string from forcing an expensive,
    // unindexable scan across title / ipAddress / username (a search-box DoS).
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

function composeWhere(fragments: SqlFragment[]): { whereSql: string; binds: unknown[]; nextBindIndex: number } {
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

async function ungroupedQuery(
  params: URLSearchParams,
  page: number,
  limit: number,
  skip: number,
  sortBy: string,
  sortDir: "asc" | "desc",
) {
  const where: Record<string, unknown> = {};
  const source = params.get("source");
  if (source === "plex" || source === "jellyfin") where.source = source;

  const tmdbIdRaw = params.get("tmdbId");
  if (tmdbIdRaw) {
    const tmdbId = parseInt(tmdbIdRaw, 10);
    if (!isNaN(tmdbId)) where.tmdbId = tmdbId;
  }

  const mediaType = params.get("mediaType");
  if (mediaType === "MOVIE" || mediaType === "TV") where.mediaType = mediaType;

  const watched = params.get("watched");
  if (watched === "true") where.watched = true;
  else if (watched === "false") where.watched = false;

  const userId = params.get("userId");
  if (userId) where.mediaServerUserId = userId;

  const playMethod = params.get("playMethod");
  if (playMethod && ["DirectPlay", "DirectStream", "Transcode"].includes(playMethod)) {
    where.playMethod = playMethod;
  }

  const platform = params.get("platform");
  if (platform) where.platform = platform;

  const startDate = params.get("startDate");
  const endDate = params.get("endDate");
  if (startDate || endDate) {
    where.startedAt = {
      ...(startDate ? { gte: new Date(startDate) } : {}),
      ...(endDate ? { lte: new Date(endDate) } : {}),
    };
  }

  const search = sanitizeContainsSearch(params.get("search")?.trim() ?? "");
  if (search) {
    where.OR = [
      { title: { contains: search, mode: "insensitive" } },
      { ipAddress: { contains: search, mode: "insensitive" } },
      { mediaServerUser: { username: { contains: search, mode: "insensitive" } } },
    ];
  }

  const orderBy: Record<string, string> = { [sortBy]: sortDir };

  const [items, total] = await Promise.all([
    prisma.playHistory.findMany({
      where,
      orderBy,
      skip,
      take: limit,
      include: {
        mediaServerUser: {
          select: { username: true, source: true, thumbUrl: true, user: { select: { name: true } } },
        },
      },
    }),
    prisma.playHistory.count({ where }),
  ]);

  const posters = await resolvePosterMap(items);
  const itemsWithPosters = items.map((it) => ({
    ...it,
    posterUrl: it.tmdbId != null ? posters[it.tmdbId] ?? null : null,
    // In ungrouped mode every row is its own chain of one — surface segmentCount
    // so the client can render the badge consistently in either mode.
    segmentCount: 1,
    chainId: it.referenceId ?? it.id,
    totalPlayDuration: it.playDuration,
  }));

  return NextResponse.json({
    items: itemsWithPosters,
    total,
    page,
    limit,
    totalPages: Math.ceil(total / limit),
    grouped: false,
  });
}

async function groupedQuery(
  params: URLSearchParams,
  page: number,
  limit: number,
  skip: number,
  sortBy: string,
  sortDir: "asc" | "desc",
) {
  // NOTE on raw SQL here (and in lib/play-history.ts stats paths):
  // All user-influenced filters (source, tmdbId, mediaType, dates, search, etc.)
  // come from a strict whitelist or parseInt + bound parameters (via ? -> $N
  // renumbering in composeWhere). ORDER BY column is taken from a server-side
  // safeSortBy whitelist only. No user data is interpolated into SQL identifiers
  // or structure. This is the complex dynamic-stats area; changes must preserve
  // the whitelist + parameterization discipline to avoid injection.
  const fragments = parseFilters(params);
  const { whereSql, binds, nextBindIndex } = composeWhere(fragments);

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
  //
  // Sort column comes from a static whitelist (safeSortBy) so it cannot be
  // user-injected. Direction is also pre-validated to asc/desc.
  const sortColumn = sortBy === "playDuration" ? "total_play_duration" : sortBy;

  const dataLimitBind = nextBindIndex;
  const dataOffsetBind = nextBindIndex + 1;
  const dataSql = `
    WITH base AS (
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
      WHERE 1=1 ${whereSql}
    )
    SELECT b.*,
      msu.username AS msu_username,
      msu.source AS msu_source,
      msu."thumbUrl" AS msu_thumb_url
    FROM base b
    LEFT JOIN "MediaServerUser" msu ON msu.id = b."mediaServerUserId"
    WHERE b.rn = 1
    ORDER BY b."${sortColumn}" ${sortDir.toUpperCase()} NULLS LAST
    LIMIT $${dataLimitBind} OFFSET $${dataOffsetBind}
  `;

  const countSql = `
    SELECT COUNT(DISTINCT COALESCE(h."referenceId", h.id))::int AS total
    FROM "PlayHistory" h
    WHERE 1=1 ${whereSql}
  `;

  // Run data + count concurrently. They share the same bind list except
  // for limit/offset which only data uses.
  const [rows, totalRows] = await Promise.all([
    prisma.$queryRawUnsafe<RawGroupedRow[]>(dataSql, ...binds, limit, skip),
    prisma.$queryRawUnsafe<{ total: number }[]>(countSql, ...binds),
  ]);

  const total = totalRows[0]?.total ?? 0;

  // Resolve posters by tmdbId. Mirror the ungrouped path's contract so the
  // UI doesn't need a mode switch for posterUrl.
  const tmdbIds = [...new Set(rows.map((r) => r.tmdbId).filter((v): v is number => v != null))];
  const posters = tmdbIds.length > 0
    ? await resolvePosterMap(rows as unknown as { tmdbId: number | null; mediaType: "MOVIE" | "TV" | null }[])
    : {};

  const items = rows.map((r) => {
    // Map snake_case raw columns to the camelCase shape the rest of the app
    // consumes. The base PlayHistory columns already arrive camelCase via the
    // SELECT b.* — only the window-function aliases need translation.
    const mediaServerUser = r.msu_username != null
      ? {
          username: r.msu_username,
          source: r.msu_source,
          thumbUrl: r.msu_thumb_url,
        }
      : null;
    return {
      ...r,
      mediaServerUser,
      posterUrl: r.tmdbId != null ? posters[r.tmdbId] ?? null : null,
      segmentCount: r.segment_count,
      chainId: r.chain_id,
      totalPlayDuration: r.total_play_duration,
      totalPausedDuration: r.total_paused_duration,
      firstStartedAt: r.first_started_at,
      lastStoppedAt: r.last_stopped_at,
      // Override the row's own watched/completed flags with the chain-wide
      // booleans so the UI's "Watched" pill reflects whether *any* segment of
      // this chain reached the threshold (a chain that finishes watched should
      // still show watched even if the final segment was a 2-minute coda).
      watched: r.chain_watched,
      completed: r.chain_completed,
    };
  });

  return NextResponse.json({
    items,
    total,
    page,
    limit,
    totalPages: Math.ceil(total / limit),
    grouped: true,
  });
}

// Shape of the raw row returned by groupedQuery's $queryRawUnsafe. Mirrors
// PlayHistory's columns (already camelCase via SELECT b.*) plus the window
// function aliases (snake_case) and the joined MediaServerUser fields.
interface RawGroupedRow {
  id: string;
  source: string;
  startedAt: Date;
  stoppedAt: Date | null;
  duration: number;
  playDuration: number;
  pausedDuration: number | null;
  watched: boolean;
  completed: boolean;
  mediaServerUserId: string;
  tmdbId: number | null;
  mediaType: "MOVIE" | "TV" | null;
  title: string;
  year: string | null;
  posterPath: string | null;
  seasonNumber: number | null;
  episodeNumber: number | null;
  episodeTitle: string | null;
  sourceSessionId: string | null;
  sourceItemId: string | null;
  platform: string | null;
  player: string | null;
  device: string | null;
  ipAddress: string | null;
  playMethod: string | null;
  videoCodec: string | null;
  audioCodec: string | null;
  resolution: string | null;
  bitrate: number | null;
  videoDecision: string | null;
  audioDecision: string | null;
  container: string | null;
  transcodeReason: string | null;
  location: string | null;
  bandwidth: number | null;
  secure: boolean | null;
  relayed: boolean | null;
  introStartMs: number | null;
  introEndMs: number | null;
  creditsStartMs: number | null;
  creditsEndMs: number | null;
  referenceId: string | null;
  createdAt: Date;
  // Window aliases
  chain_id: string;
  rn: number;
  segment_count: number;
  total_play_duration: number;
  total_paused_duration: number;
  first_started_at: Date;
  last_stopped_at: Date | null;
  chain_watched: boolean;
  chain_completed: boolean;
  // Joined columns
  msu_username: string | null;
  msu_source: string | null;
  msu_thumb_url: string | null;
}

