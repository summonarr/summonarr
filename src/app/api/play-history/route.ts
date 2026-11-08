import { NextResponse } from "next/server";
import { withPermission } from "@/lib/api-auth";
import { Permission } from "@/lib/permissions";
import { parsePageParam } from "@/lib/pagination";
import { prisma } from "@/lib/prisma";
import { resolvePosterPathMap } from "@/lib/poster-cache";
import { checkRateLimit } from "@/lib/rate-limit";
import {
  composeWhere,
  invalidDateParam,
  normalizePlayHistoryFilters,
  parsePlayHistoryFilters,
  playHistoryFilterFragments,
} from "@/lib/play-history-filters";
import { getPlayHistoryPlatforms } from "@/lib/play-history";
import { getStatsTimeZone } from "@/lib/stats-time-zone-data";
import { translatorForRequest } from "@/lib/i18n/server-locale";
import {
  groupedListSql,
  parsePlayHistorySort,
  shapeGroupedRow,
  shapeUngroupedRow,
  ungroupedListSql,
  type PlayHistorySort,
  type RawGroupedRow,
  type RawUngroupedRow,
  type SortDir,
} from "@/lib/play-history-list";

export const dynamic = "force-dynamic";

export const GET = withPermission(Permission.ADMIN)(async (request, _ctx, session) => {
  const t = translatorForRequest(request);
  // The grouped path runs two heavy window-function/aggregate raw queries over
  // the full PlayHistory table per request; throttle per admin to bound abuse.
  // Keyed on the session ALONE. getClientIp falls back to a hash of the User-Agent
  // whenever TRUST_PROXY is not "true" (the default docker deployment), so folding it in
  // let one admin session mint a fresh bucket per UA string and multiply its own
  // allowance against these heavy window-function queries. A caller-controlled component
  // can only ever widen a limit.
  if (!checkRateLimit(`play-history:${session.user.id}`, 120, 60_000)) {
    return NextResponse.json({ error: t("apiUser.common.tooManyRequestsShortly") }, { status: 429 });
  }

  const params = request.nextUrl.searchParams;

  const distinctMode = params.get("distinct");
  if (distinctMode === "platforms") {
    // A whole-table DISTINCT, memoized in the activity cache (a finalize clears it).
    return NextResponse.json(await getPlayHistoryPlatforms());
  }
  if (distinctMode === "users") {
    // Deliberately uncapped: it fills the filter dropdown, and a departed
    // identity (soft-deleted, guardrail 28) still owns history rows to filter by.
    // serverInstance is additive: the same username legitimately exists on two
    // same-type servers (the owner and every shared friend on two Plex instances,
    // guardrail 35), and the filter bar needs it to tell the two options apart.
    const rows = await prisma.mediaServerUser.findMany({
      select: { id: true, username: true, source: true, serverInstance: true },
      orderBy: { username: "asc" },
    });
    return NextResponse.json(rows);
  }

  const page = parsePageParam(params);
  const limit = Math.min(200, Math.max(1, parseInt(params.get("limit") ?? "20", 10) || 20));
  const skip = (page - 1) * limit;

  // Validate date params up front — both the grouped and ungrouped paths feed
  // `new Date(param)` straight into a query, and an unparseable value yields an
  // Invalid Date that throws mid-query (uncaught 500 instead of a 400).
  const badDate = invalidDateParam(params);
  if (badDate) {
    return NextResponse.json({ error: t("apiUser.playHistory.invalidDate", { name: badDate }) }, { status: 400 });
  }

  // Default: collapse continued watches (PlayHistory.referenceId chains) into
  // one logical viewing per chain. The chain's *latest* segment is the
  // representative row (for title/poster/codec/etc) and the response includes
  // aggregates over the whole chain (totalPlayDuration, segmentCount). Pass
  // ?ungrouped=true to see individual segments — used when the user toggles
  // the "Group continued watches" switch off in the filter bar.
  const ungrouped = params.get("ungrouped") === "true";

  const sortDir: SortDir = params.get("sortDir") === "asc" ? "asc" : "desc";
  const sortBy = parsePlayHistorySort(params.get("sortBy"));
  const timeZone = await getStatsTimeZone();
  const pageArgs = { page, limit, skip };

  if (ungrouped) {
    return ungroupedQuery(params, timeZone, pageArgs, sortBy, sortDir);
  }

  return groupedQuery(params, timeZone, pageArgs, sortBy, sortDir);
});

type PageArgs = { page: number; limit: number; skip: number };

// The answer both modes share: the page's items and the paging totals.
function listResponse(items: unknown[], total: number, { page, limit }: PageArgs, grouped: boolean): NextResponse {
  return NextResponse.json({
    items,
    total,
    page,
    limit,
    totalPages: Math.ceil(total / limit),
    grouped,
  });
}

// One row per segment (?ungrouped=true — the "Group continued watches" switch
// off). Raw SQL rather than a Prisma `where`, for the SAME reason as the grouped
// path: `search`. Prisma's `contains` emits an ILIKE with no ESCAPE clause, so
// the only way to keep a `%`/`_` in the term from acting as a wildcard there is
// to strip it — and a stripped term matches NOTHING for a username or title
// that legitimately contains one (`john_doe` searched as `johndoe`). Sharing
// parsePlayHistoryFilters with the grouped path and the export also means one
// definition of what each filter param means, for the three endpoints the admin
// table drives off one URLSearchParams.
async function ungroupedQuery(
  params: URLSearchParams,
  timeZone: string,
  pageArgs: PageArgs,
  sortBy: PlayHistorySort,
  sortDir: SortDir,
) {
  const { whereSql, binds, nextBindIndex } = composeWhere(parsePlayHistoryFilters(params, timeZone));
  const { dataSql, countSql } = ungroupedListSql(whereSql, nextBindIndex, sortBy, sortDir);
  const [rows, totalRows] = await Promise.all([
    prisma.$queryRawUnsafe<RawUngroupedRow[]>(dataSql, ...binds, pageArgs.limit, pageArgs.skip),
    prisma.$queryRawUnsafe<{ total: number }[]>(countSql, ...binds),
  ]);
  const livePaths = await resolvePosterPathMap(rows);
  return listResponse(rows.map((row) => shapeUngroupedRow(row, livePaths)), totalRows[0]?.total ?? 0, pageArgs, false);
}

// Default: continued watches (PlayHistory.referenceId chains) collapsed into
// one logical viewing per chain, its latest segment the representative row and
// the chain's aggregates beside it (play-history-list.ts). `watched` is decided
// per chain, so it is left out of the segment filters and applied to the chain.
async function groupedQuery(
  params: URLSearchParams,
  timeZone: string,
  pageArgs: PageArgs,
  sortBy: PlayHistorySort,
  sortDir: SortDir,
) {
  const filters = normalizePlayHistoryFilters(params, timeZone);
  const { whereSql, binds, nextBindIndex } = composeWhere(
    playHistoryFilterFragments({ ...filters, watched: null }),
  );
  const { dataSql, countSql } = groupedListSql(whereSql, nextBindIndex, sortBy, sortDir, filters.watched);
  // Data + count run concurrently on the same binds; only data takes limit/offset.
  const [rows, totalRows] = await Promise.all([
    prisma.$queryRawUnsafe<RawGroupedRow[]>(dataSql, ...binds, pageArgs.limit, pageArgs.skip),
    prisma.$queryRawUnsafe<{ total: number }[]>(countSql, ...binds),
  ]);
  // Posters per (tmdbId, mediaType), on the ungrouped path's contract so the
  // UI needs no mode switch for posterUrl (or posterPath).
  const livePaths = await resolvePosterPathMap(rows);
  return listResponse(rows.map((r) => shapeGroupedRow(r, livePaths)), totalRows[0]?.total ?? 0, pageArgs, true);
}
