import { authActive } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { type RequestStatus, type MediaType, Prisma } from "@/generated/prisma";
import { posterUrl, getMovieDetails, getTVDetails } from "@/lib/tmdb";
import { getCacheStaleMany, tmdbDetailsKey } from "@/lib/tmdb-cache";
import type { TmdbMedia } from "@/lib/tmdb-types";
import { redirect } from "next/navigation";
import { hasPermission, Permission } from "@/lib/permissions";
import { getArrInstances } from "@/lib/arr-instance-registry";
import { isFeatureEnabled } from "@/lib/features";
import { SyncButton } from "@/components/admin/request-actions";
import { AdminRequestList, type GroupedRequestRow, type Requester, type MediaRatings } from "@/components/admin/admin-request-list";
import { AdminFilterBar } from "@/components/admin/admin-filter-bar";
import { EmptyState, PageHeader, StatCard } from "@/components/ui/design";
import { ClipboardList } from "@/components/icons";
import { getWatchGradeSummaries } from "@/lib/watch-grade-data";
import { getTranslator } from "@/lib/i18n/server";
import { commentLinkToLocate, queueCommentPage } from "@/lib/request-comment-deep-link";
import { parsePageNumber } from "@/lib/pagination";

export const dynamic = "force-dynamic";

const PAGE_SIZE = 20;

const VALID_STATUSES = ["PENDING", "APPROVED", "DECLINED", "AVAILABLE"] as const satisfies readonly RequestStatus[];

const VALID_SORTS = ["newest", "oldest", "title", "year-desc", "year-asc"] as const;
type QueueSort = (typeof VALID_SORTS)[number];

const isQueueStatus = (v: string | undefined): v is (typeof VALID_STATUSES)[number] =>
  (VALID_STATUSES as readonly string[]).includes(v ?? "");
const isQueueSort = (v: string | undefined): v is QueueSort =>
  (VALID_SORTS as readonly string[]).includes(v ?? "");

// How long a render waits for live TMDB details of a pending title missing from
// the cache. The fetch keeps going past it (coalesced, cached on success), so a
// slow or down TMDB costs this page a bounded wait instead of its full timeout on
// every load — the queue live-refreshes on every request:* event.
const LIVE_DETAILS_WAIT_MS = 2_500;

const STATUS_RANK: Record<string, number> = {
  PENDING: 0,
  APPROVED: 1,
  DECLINED: 2,
  AVAILABLE: 3,
};

export default async function AdminPage({
  searchParams,
}: {
  searchParams: Promise<{ page?: string; status?: string; sort?: string; type?: string; comments?: string | string[] }>;
}) {
  const session = await authActive();
  if (!session || !hasPermission(session.user.permissions, Permission.MANAGE_REQUESTS)) redirect("/");

  const { page: pageParam, status: statusParam, sort: sortParam, type: typeParam, comments: commentsRaw } = await searchParams;
  // ?comments=<requestId> (from a comment notification) opens that request's thread.
  const openCommentsId = Array.isArray(commentsRaw) ? commentsRaw[0] : commentsRaw;
  // The page the URL asks for, bounded so an oversized ?page= can't drive the
  // page query's `skip` past Prisma's limit. It is clamped to the last real page
  // once the group count is known (below) — approving the last items on page 2
  // fires an SSE-driven refresh that otherwise re-rendered a blank list with no pager.
  const requestedPage = parsePageNumber(pageParam);

  const statusFilter: RequestStatus | undefined = isQueueStatus(statusParam) ? statusParam : undefined;
  const typeFilter: MediaType | undefined = typeParam === "MOVIE" || typeParam === "TV" ? typeParam : undefined;
  const sort: QueueSort = isQueueSort(sortParam) ? sortParam : "newest";

  const where = {
    ...(statusFilter ? { status: statusFilter } : {}),
    ...(typeFilter ? { mediaType: typeFilter } : {}),
  };

  const primaryGroupOrder: Prisma.MediaRequestOrderByWithAggregationInput =
    sort === "oldest" ? { _min: { createdAt: "asc" } }
    : sort === "title" ? { _min: { title: "asc" } }
    : sort === "year-desc" ? { _max: { releaseYear: "desc" } }
    : sort === "year-asc" ? { _min: { releaseYear: "asc" } }
    : { _max: { createdAt: "desc" } };
  // The group key is the tiebreaker. Year and title sorts tie constantly, and
  // Postgres orders tied rows differently for different LIMIT/OFFSET bounds, so
  // without a total order a title could repeat across pages or never appear.
  const groupOrderBy: Prisma.MediaRequestOrderByWithAggregationInput[] = [
    primaryGroupOrder,
    { tmdbId: "asc" },
    { mediaType: "asc" },
  ];

  // A comment link names a request, not a page. On arrival from one (see
  // commentLinkToLocate), go to the page that holds its title under the current
  // filter, with an explicit page (even 1) so a live refresh of that URL never
  // relocates the admin. The param rides along to open the thread.
  const locateId = commentLinkToLocate(pageParam, commentsRaw);
  if (locateId) {
    const target = await queueCommentPage(where, groupOrderBy, locateId, PAGE_SIZE);
    if (target !== null) {
      const params = new URLSearchParams();
      params.set("page", String(target));
      if (statusFilter) params.set("status", statusFilter);
      if (typeFilter) params.set("type", typeFilter);
      if (sort !== "newest") params.set("sort", sort);
      params.set("comments", locateId);
      redirect(`/admin?${params.toString()}`);
    }
  }

  // Count the distinct (tmdbId, mediaType) groups in SQL. Doing it with a
  // groupBy would download every group row just to read how many there are.
  const statusCond = statusFilter
    ? Prisma.sql`AND "status" = ${statusFilter}::"RequestStatus"`
    : Prisma.empty;
  const typeCond = typeFilter
    ? Prisma.sql`AND "mediaType" = ${typeFilter}::"MediaType"`
    : Prisma.empty;

  const pageOfGroups = (p: number) =>
    prisma.mediaRequest.groupBy({
      by: ["tmdbId", "mediaType"],
      where,
      orderBy: groupOrderBy,
      skip: (p - 1) * PAGE_SIZE,
      take: PAGE_SIZE,
    });

  const [statusCounts, userCount, distinctGroups, requestedGroups] = await Promise.all([
    prisma.mediaRequest.groupBy({ by: ["status"], _count: { status: true } }),
    // Accounts that can sign in — the same figure /admin/stats reports.
    prisma.user.count({ where: { deactivatedAt: null } }),
    prisma.$queryRaw<[{ count: bigint }]>(Prisma.sql`
      SELECT COUNT(DISTINCT ("tmdbId", "mediaType")) AS count
      FROM "MediaRequest"
      WHERE TRUE ${statusCond} ${typeCond}
    `),
    pageOfGroups(requestedPage),
  ]);

  const total = Number(distinctGroups[0]?.count ?? 0);

  // Clamp to the last page that exists. A past-the-end page (the items on it
  // were just approved/deleted, or a stale ?page= link) shows the last page
  // instead of an empty area with no pager and a "page 3 of 2" label. Only this
  // rare case pays for a second page query; the common path reuses the one
  // already fetched above.
  const lastPage = Math.max(1, Math.ceil(total / PAGE_SIZE));
  const page = Math.min(requestedPage, lastPage);
  const pagedGroups = page === requestedPage ? requestedGroups : await pageOfGroups(page);

  const pairs = pagedGroups.map((g) => ({ tmdbId: g.tmdbId, mediaType: g.mediaType }));
  const cacheKey = (p: { tmdbId: number; mediaType: "MOVIE" | "TV" }) => tmdbDetailsKey(p.mediaType, p.tmdbId);

  // 1. Database first: read the cached TMDB details (which carry the ratings)
  //    from TmdbCache in one query for the whole page. No external calls, and
  //    stale rows are still used. It runs in the same Promise.all as the other
  //    page queries so it adds no extra wait. With no pairs we skip the queries
  //    and use empty results.
  const [requests, plexItems, jellyfinItems, cached] = pairs.length
    ? await Promise.all([
        prisma.mediaRequest.findMany({
          where: { OR: pairs, ...(statusFilter ? { status: statusFilter } : {}) },
          include: { user: { select: { name: true, email: true, discordId: true } }, _count: { select: { comments: true } } },
          orderBy: { createdAt: "desc" },
        }),
        // Only the membership sets below read these rows.
        prisma.plexLibraryItem.findMany({ where: { OR: pairs }, select: { tmdbId: true, mediaType: true } }),
        prisma.jellyfinLibraryItem.findMany({ where: { OR: pairs }, select: { tmdbId: true, mediaType: true } }),
        getCacheStaleMany<TmdbMedia>(pairs.map((p) => cacheKey(p))),
      ])
    : [[], [], [], new Map<string, { value: TmdbMedia; isStale: boolean }>()];

  const plexSet = new Set(plexItems.map((p) => `${p.tmdbId}:${p.mediaType}`));
  const jellyfinSet = new Set(jellyfinItems.map((p) => `${p.tmdbId}:${p.mediaType}`));

  const ratingsMap = new Map<string, MediaRatings>();
  const toRatings = (m: TmdbMedia): MediaRatings => ({
    certification: m.certification ?? null,
    imdbId: m.imdbId ?? null,
    imdbRating: m.imdbRating ?? null,
    imdbVotes: m.imdbVotes ?? null,
    rottenTomatoes: m.rottenTomatoes ?? null,
    rtAudienceScore: m.rtAudienceScore ?? null,
    metacritic: m.metacritic ?? null,
    traktRating: m.traktRating ?? null,
    letterboxdRating: m.letterboxdRating ?? null,
    mdblistScore: m.mdblistScore ?? null,
    malRating: m.malRating ?? null,
    rogerEbertRating: m.rogerEbertRating ?? null,
    voteAverage: m.voteAverage || null,
  });
  const inDb = new Set<string>();
  pairs.forEach((p) => {
    const v = cached.get(cacheKey(p))?.value;
    if (!v) return;
    const key = `${p.tmdbId}:${p.mediaType}`;
    inDb.add(key);
    ratingsMap.set(key, toRatings(v));
  });

  // 2. Missing from the cache AND the request is pending → fetch it live from
  //    TMDB. getMovieDetails/getTVDetails save the response to the cache, so the
  //    next page load is served from the database. The render waits at most
  //    LIVE_DETAILS_WAIT_MS: a title not back by then renders without ratings,
  //    and its fetch finishes (and caches) in the background. Without the bound a
  //    failing title — never cached — held every render for the fetch's timeout.
  const pendingKeys = new Set(
    requests.filter((r) => r.status === "PENDING").map((r) => `${r.tmdbId}:${r.mediaType}`),
  );
  const staleP = pairs.filter((p) => {
    const key = `${p.tmdbId}:${p.mediaType}`;
    return pendingKeys.has(key) && !inDb.has(key);
  });
  if (staleP.length) {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const deadline = new Promise<null>((resolve) => {
      timer = setTimeout(() => resolve(null), LIVE_DETAILS_WAIT_MS);
    });
    const detailResults = await Promise.all(
      staleP.map((p) =>
        Promise.race([
          (p.mediaType === "MOVIE" ? getMovieDetails(p.tmdbId) : getTVDetails(p.tmdbId)).catch(() => null),
          deadline,
        ]),
      ),
    );
    clearTimeout(timer);
    staleP.forEach((p, i) => {
      const details = detailResults[i];
      if (details) ratingsMap.set(`${p.tmdbId}:${p.mediaType}`, toRatings(details));
    });
  }

  const countFor = (status: string) =>
    statusCounts.find((s) => s.status === status)?._count.status ?? 0;

  const totalAll = statusCounts.reduce((sum, s) => sum + s._count.status, 0);
  const t = await getTranslator();

  const stats = [
    { key: "total",    label: t("adminQueue.page.statTotal"), value: totalAll },
    { key: "pending",  label: t("requests.status.pending"),   value: countFor("PENDING") },
    { key: "approved", label: t("requests.status.approved"),  value: countFor("APPROVED") },
    { key: "users",    label: t("adminQueue.page.statUsers"), value: userCount },
  ];

  const statusCountsMap: Record<string, number> = {};
  for (const s of statusCounts) statusCountsMap[s.status] = s._count.status;

  type RequestWithUser = (typeof requests)[number];
  const grouped = new Map<string, RequestWithUser[]>();
  for (const r of requests) {
    const key = `${r.tmdbId}:${r.mediaType}`;
    const bucket = grouped.get(key);
    if (bucket) bucket.push(r);
    else grouped.set(key, [r]);
  }

  const groupOrder = pagedGroups.map((g) => `${g.tmdbId}:${g.mediaType}`);

  // Slug → display name for the instance badges + approve picker labels. Union
  // of both services' registries; a slug defined on both keeps the Radarr name
  // (sonarr is applied first, radarr second, so radarr overwrites).
  const instanceNames: Record<string, string> = {};
  // Requesters on THIS page: their request totals (every status, all time) are
  // all the badges need, not a count for every user.
  const pageRequesters = [...new Set(requests.map((r) => r.requestedBy))];
  const [sonarrInstances, radarrInstances, userRequestCounts, watchGrades, radarrOn, sonarrOn] = await Promise.all([
    getArrInstances("sonarr"),
    getArrInstances("radarr"),
    pageRequesters.length
      ? prisma.mediaRequest.groupBy({ by: ["requestedBy"], where: { requestedBy: { in: pageRequesters } }, _count: { id: true } })
      : Promise.resolve([]),
    // Watch grade of every requester on this page, in one batch (null when the
    // feature or play history tracking is off).
    getWatchGradeSummaries(requests.map((r) => r.requestedBy)),
    // The Open in / Manage icons lead to routes that 404 while the integration
    // is switched off (arrGate).
    isFeatureEnabled("feature.integration.radarr").catch(() => false),
    isFeatureEnabled("feature.integration.sonarr").catch(() => false),
  ]);
  const userCountMap = new Map(userRequestCounts.map((u) => [u.requestedBy, u._count.id]));
  for (const instances of [sonarrInstances, radarrInstances]) {
    for (const inst of instances) {
      if (inst.slug !== "") instanceNames[inst.slug] = inst.name;
    }
  }

  const rows: GroupedRequestRow[] = groupOrder
    .map((key) => grouped.get(key))
    .filter((bucket): bucket is RequestWithUser[] => Array.isArray(bucket) && bucket.length > 0)
    .map((bucket) => {
      const primary = bucket[0];
      const requesters: Requester[] = bucket.map((r) => ({
        requestId: r.id,
        userId: r.requestedBy,
        userWatchGrade: watchGrades?.get(r.requestedBy) ?? null,
        status: r.status,
        arrInstance: r.arrInstance,
        note: r.note,
        adminNote: r.adminNote,
        commentCount: r._count.comments,
        createdAt: r.createdAt.toISOString(),
        userName: r.user.name,
        userEmail: r.user.email,
        userDiscordId: r.user.discordId,
        userRequestCount: userCountMap.get(r.requestedBy) ?? 1,
      }));

      const aggregateStatus = bucket
        .map((r) => r.status)
        .sort((a, b) => (STATUS_RANK[a] ?? 99) - (STATUS_RANK[b] ?? 99))[0];

      return {
        groupKey: `${primary.tmdbId}:${primary.mediaType}`,
        tmdbId: primary.tmdbId,
        title: primary.title,
        mediaType: primary.mediaType,
        posterUrl: posterUrl(primary.posterPath, "w342"),
        releaseYear: primary.releaseYear,
        ratings: ratingsMap.get(`${primary.tmdbId}:${primary.mediaType}`) ?? null,
        onPlex: plexSet.has(`${primary.tmdbId}:${primary.mediaType}`),
        onJellyfin: jellyfinSet.has(`${primary.tmdbId}:${primary.mediaType}`),
        aggregateStatus,
        requesters,
      };
    });

  return (
    <div className="ds-page-enter">
      <PageHeader
        title={t("adminQueue.page.title")}
        subtitle={t("adminQueue.page.subtitle")}
        // /api/sync admits the ADMIN role only (getCronActor), so a
        // MANAGE_REQUESTS delegate would get a 403 on every click.
        right={session.user.role === "ADMIN" ? <SyncButton /> : undefined}
      />

      <div className="ds-stat-row" style={{ marginBottom: 24 }}>
        {stats.map((s) => (
          <StatCard key={s.key} label={s.label} value={s.value} mono />
        ))}
      </div>

      <AdminFilterBar
        statusCounts={statusCountsMap}
        totalAll={totalAll}
        currentStatus={statusFilter ?? ""}
        currentType={typeFilter ?? ""}
        currentSort={sort}
      />

      {/* On the ROWS, not `total`: the count and the page query are separate
          reads, so a request landing or leaving between them can still hand
          this render a non-zero total with nothing to show. */}
      {rows.length === 0 ? (
        <EmptyState
          icon={ClipboardList}
          title={
            statusFilter
              ? t(`adminQueue.page.emptyStatus.${statusFilter.toLowerCase()}`)
              : t("adminQueue.page.empty")
          }
        />
      ) : (
        <AdminRequestList
          requests={rows}
          page={page}
          total={total}
          pageSize={PAGE_SIZE}
          statusFilter={statusFilter}
          typeFilter={typeFilter}
          sort={sort}
          instanceNames={instanceNames}
          // The viewer gate; `arrServices` then hides a movie's icons while
          // Radarr is off and a show's while Sonarr is.
          canOpenArr={hasPermission(session.user.permissions, Permission.ADMIN) && (radarrOn || sonarrOn)}
          arrServices={{ radarr: radarrOn, sonarr: sonarrOn }}
          initialOpenThread={openCommentsId}
        />
      )}
    </div>
  );
}
