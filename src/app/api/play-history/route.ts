import { NextResponse } from "next/server";
import { withPermission } from "@/lib/api-auth";
import { Permission } from "@/lib/permissions";
import { prisma } from "@/lib/prisma";
import { resolvePosterPathMap, posterPathKey } from "@/lib/poster-cache";
import { posterUrl } from "@/lib/tmdb-types";
import { checkRateLimit } from "@/lib/rate-limit";
import { composeWhere, parsePlayHistoryFilters } from "@/lib/play-history-filters";

export const dynamic = "force-dynamic";

export const GET = withPermission(Permission.ADMIN)(async (request, _ctx, session) => {
  // The grouped path runs two heavy window-function/aggregate raw queries over
  // the full PlayHistory table per request; throttle per admin to bound abuse.
  // Keyed on the session ALONE. getClientIp falls back to a hash of the User-Agent
  // whenever TRUST_PROXY is not "true" (the default docker deployment), so folding it in
  // let one admin session mint a fresh bucket per UA string and multiply its own
  // allowance against these heavy window-function queries. A caller-controlled component
  // can only ever widen a limit.
  if (!checkRateLimit(`play-history:${session.user.id}`, 120, 60_000)) {
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

  // Validate date params up front — both the grouped and ungrouped paths feed
  // `new Date(param)` straight into a query, and an unparseable value yields an
  // Invalid Date that throws mid-query (uncaught 500 instead of a 400).
  for (const name of ["startDate", "endDate"] as const) {
    const value = params.get(name);
    if (value && isNaN(new Date(value).getTime())) {
      return NextResponse.json({ error: `${name} must be a valid date` }, { status: 400 });
    }
  }

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

async function ungroupedQuery(
  params: URLSearchParams,
  page: number,
  limit: number,
  skip: number,
  sortBy: string,
  sortDir: "asc" | "desc",
) {
  // Raw SQL rather than a Prisma `where`, for the SAME reason as the grouped
  // path below: `search`. Prisma's `contains` emits an ILIKE with no ESCAPE
  // clause, so the only way to keep a `%`/`_` in the term from acting as a
  // wildcard there is to strip it — and a stripped term matches NOTHING for a
  // username or title that legitimately contains one (`john_doe` searched as
  // `johndoe`). Sharing parsePlayHistoryFilters with the grouped path and the
  // export also means one definition of what each filter param means, for the
  // three endpoints the admin table drives off one URLSearchParams.
  //
  // Same injection discipline as groupedQuery: filters are bound `$N`
  // parameters, and the ORDER BY column comes from the caller's safeSortBy
  // whitelist — no user data reaches SQL identifiers or structure.
  const fragments = parsePlayHistoryFilters(params);
  const { whereSql, binds, nextBindIndex } = composeWhere(fragments);

  const dir = sortDir.toUpperCase();
  // `id` is a stable secondary sort so OFFSET pagination can't duplicate or
  // skip rows when the primary column is non-unique (title/platform/source/
  // duration/playDuration all repeat) and data shifts between page fetches.
  // Mirrors the export path's (startedAt, id) tiebreaker.
  //
  // Deliberately NO `NULLS LAST` here, unlike the grouped query: Prisma emitted
  // plain `ORDER BY <col> <dir>` for this path, so adding the clause would
  // reshuffle nullable-column sorts (platform) for anyone with the grouping
  // toggle off. The two modes have always differed here; this keeps it that way
  // rather than smuggling an ordering change into a search fix.
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

  const [rows, totalRows] = await Promise.all([
    prisma.$queryRawUnsafe<RawUngroupedRow[]>(dataSql, ...binds, limit, skip),
    prisma.$queryRawUnsafe<{ total: number }[]>(countSql, ...binds),
  ]);

  const total = totalRows[0]?.total ?? 0;

  // Live TmdbMediaCore/TmdbCache paths. `posterUrl` (the web field) stays
  // live-only as it always was; `posterPath` — the row's finalize-time snapshot,
  // null for anything uncached at record time — falls back to the snapshot but
  // now prefers the live path, which is what native clients read.
  const livePaths = await resolvePosterPathMap(rows);
  const itemsWithPosters = rows.map((row) => {
    // Split the joined aliases back out so the response carries the same nested
    // `mediaServerUser` object Prisma's `include` produced — the relation is a
    // required FK, so it is always present. `user` keys off the joined id, not
    // the name: a linked account with a null `name` is `{ name: null }`, which
    // is what the relation returned, and NOT an absent link.
    const { msu_username, msu_source, msu_thumb_url, msu_user_id, msu_user_name, ...it } = row;
    const live =
      it.tmdbId != null ? livePaths[posterPathKey(it.tmdbId, it.mediaType)] ?? null : null;
    return {
      ...it,
      mediaServerUser: {
        username: msu_username,
        source: msu_source,
        thumbUrl: msu_thumb_url,
        user: msu_user_id != null ? { name: msu_user_name } : null,
      },
      posterPath: live ?? it.posterPath,
      posterUrl: posterUrl(live, "w342"),
      // In ungrouped mode every row is its own chain of one — surface segmentCount
      // so the client can render the badge consistently in either mode.
      segmentCount: 1,
      chainId: it.referenceId ?? it.id,
      totalPlayDuration: it.playDuration,
    };
  });

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
  const fragments = parsePlayHistoryFilters(params);
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
  // user-injected. Direction is also pre-validated to asc/desc. chain_id is
  // appended as a stable secondary sort so OFFSET pagination can't duplicate
  // or skip chains when the primary column is non-unique (source/platform/
  // duration/title all repeat) — mirrors the ungrouped path's `id` tiebreaker.
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
    ORDER BY b."${sortColumn}" ${sortDir.toUpperCase()} NULLS LAST, b.chain_id ${sortDir.toUpperCase()}
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

  // Resolve posters per (tmdbId, mediaType). Mirror the ungrouped path's
  // contract so the UI doesn't need a mode switch for posterUrl (or posterPath).
  const livePaths = await resolvePosterPathMap(
    rows as unknown as { tmdbId: number | null; mediaType: string | null }[],
  );

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
    const live =
      r.tmdbId != null ? livePaths[posterPathKey(r.tmdbId, r.mediaType)] ?? null : null;
    return {
      ...r,
      mediaServerUser,
      posterPath: live ?? r.posterPath,
      posterUrl: posterUrl(live, "w342"),
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

// PlayHistory's own columns as they arrive from a `SELECT h.*` / `SELECT b.*`
// (already camelCase — Prisma's column names are the field names). Shared by
// both raw paths; each extends it with its own aliases.
interface RawPlayHistoryRow {
  id: string;
  source: string;
  serverInstance: string;
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
}

// groupedQuery's row: the representative segment plus the window-function
// aliases (snake_case) and the joined MediaServerUser fields.
interface RawGroupedRow extends RawPlayHistoryRow {
  chain_id: string;
  rn: number;
  segment_count: number;
  total_play_duration: number;
  total_paused_duration: number;
  first_started_at: Date;
  last_stopped_at: Date | null;
  chain_watched: boolean;
  chain_completed: boolean;
  msu_username: string | null;
  msu_source: string | null;
  msu_thumb_url: string | null;
}

// ungroupedQuery's row: the segment itself plus the MediaServerUser join that
// stands in for Prisma's `include` (and the User join behind its `user`
// sub-select). The relation is a required FK, so the msu_* columns are only
// nullable in the type, never in practice; msu_user_* genuinely can be null
// (MediaServerUser.userId is optional).
interface RawUngroupedRow extends RawPlayHistoryRow {
  msu_username: string;
  msu_source: string;
  msu_thumb_url: string | null;
  msu_user_id: string | null;
  msu_user_name: string | null;
}

