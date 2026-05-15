import { auth } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { type RequestStatus, Prisma } from "@/generated/prisma";
import { posterUrl, getMovieDetails, getTVDetails } from "@/lib/tmdb";
import { redirect } from "next/navigation";
import { SyncButton } from "@/components/admin/request-actions";
import { AdminRequestList, type GroupedRequestRow, type Requester, type MediaRatings } from "@/components/admin/admin-request-list";
import { AdminFilterBar } from "@/components/admin/admin-filter-bar";
import { PageHeader, StatCard } from "@/components/ui/design";

export const dynamic = "force-dynamic";

const PAGE_SIZE = 20;

const VALID_STATUSES = ["PENDING", "APPROVED", "DECLINED", "AVAILABLE"];

const STATUS_RANK: Record<string, number> = {
  PENDING: 0,
  APPROVED: 1,
  DECLINED: 2,
  AVAILABLE: 3,
};

export default async function AdminPage({
  searchParams,
}: {
  searchParams: Promise<{ page?: string; status?: string; sort?: string }>;
}) {
  const session = await auth();
  if (!session || session.user.role !== "ADMIN") redirect("/");

  const { page: pageParam, status: statusParam, sort: sortParam } = await searchParams;
  const page = Math.max(1, parseInt(pageParam ?? "1", 10) || 1);
  const skip = (page - 1) * PAGE_SIZE;

  const statusFilter = VALID_STATUSES.includes(statusParam ?? "") ? (statusParam as RequestStatus) : undefined;
  const sort = sortParam === "oldest" ? "oldest" : sortParam === "title" ? "title" : "newest";

  const where = statusFilter ? { status: statusFilter } : {};

  const groupOrderBy: Prisma.MediaRequestOrderByWithAggregationInput =
    sort === "oldest" ? { _min: { createdAt: "asc" } }
    : sort === "title" ? { _min: { title: "asc" } }
    : { _max: { createdAt: "desc" } };

  const [statusCounts, userCount, allGroups, pagedGroups, userRequestCounts] = await Promise.all([
    prisma.mediaRequest.groupBy({ by: ["status"], _count: { status: true } }),
    prisma.user.count(),
    prisma.mediaRequest.groupBy({ by: ["tmdbId", "mediaType"], where }),
    prisma.mediaRequest.groupBy({
      by: ["tmdbId", "mediaType"],
      where,
      orderBy: groupOrderBy,
      skip,
      take: PAGE_SIZE,
    }),
    prisma.mediaRequest.groupBy({ by: ["requestedBy"], _count: { id: true } }),
  ]);

  const total = allGroups.length;

  const pairs = pagedGroups.map((g) => ({ tmdbId: g.tmdbId, mediaType: g.mediaType }));
  const [requests, plexItems, jellyfinItems, coreItems] = pairs.length
    ? await Promise.all([
        prisma.mediaRequest.findMany({
          where: { OR: pairs, ...(statusFilter ? { status: statusFilter } : {}) },
          include: { user: { select: { name: true, email: true, discordId: true } } },
          orderBy: { createdAt: "desc" },
        }),
        prisma.plexLibraryItem.findMany({ where: { OR: pairs } }),
        prisma.jellyfinLibraryItem.findMany({ where: { OR: pairs } }),
        prisma.tmdbMediaCore.findMany({ where: { OR: pairs } }),
      ])
    : [[], [], [], []];

  const plexSet = new Set(plexItems.map((p) => `${p.tmdbId}:${p.mediaType}`));
  const jellyfinSet = new Set(jellyfinItems.map((p) => `${p.tmdbId}:${p.mediaType}`));

  const ratingsMap = new Map<string, MediaRatings>();

  // 1. Serve what the database already knows (TmdbMediaCore) — no external calls.
  const inDb = new Set<string>();
  for (const c of coreItems) {
    const key = `${c.tmdbId}:${c.mediaType}`;
    inDb.add(key);
    ratingsMap.set(key, {
      certification: c.certification ?? null,
      imdbId: null,
      imdbRating: null,
      imdbVotes: null,
      rottenTomatoes: null,
      rtAudienceScore: null,
      metacritic: null,
      traktRating: null,
      letterboxdRating: null,
      mdblistScore: null,
      malRating: null,
      rogerEbertRating: null,
      voteAverage: c.voteAverage || null,
    });
  }

  // 2. Not in the database and the request is pending → fetch live from TMDB
  //    to keep the information fresh. getMovie/TVDetails caches the response
  //    and upserts TmdbMediaCore, so the next load is served from the database.
  const pendingKeys = new Set(
    requests.filter((r) => r.status === "PENDING").map((r) => `${r.tmdbId}:${r.mediaType}`),
  );
  const staleP = pairs.filter((p) => {
    const key = `${p.tmdbId}:${p.mediaType}`;
    return pendingKeys.has(key) && !inDb.has(key);
  });
  if (staleP.length) {
    const detailResults = await Promise.allSettled(
      staleP.map((p) =>
        p.mediaType === "MOVIE" ? getMovieDetails(p.tmdbId) : getTVDetails(p.tmdbId),
      ),
    );
    staleP.forEach((p, i) => {
      const res = detailResults[i];
      if (res?.status !== "fulfilled") return;
      const m = res.value;
      ratingsMap.set(`${p.tmdbId}:${p.mediaType}`, {
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
        voteAverage: m.voteAverage ?? null,
      });
    });
  }
  const userCountMap = new Map(userRequestCounts.map((u) => [u.requestedBy, u._count.id]));

  const countFor = (status: string) =>
    statusCounts.find((s) => s.status === status)?._count.status ?? 0;

  const totalAll = statusCounts.reduce((sum, s) => sum + s._count.status, 0);

  const stats = [
    { label: "Total Requests", value: totalAll },
    { label: "Pending",        value: countFor("PENDING") },
    { label: "Approved",       value: countFor("APPROVED") },
    { label: "Users",          value: userCount },
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

  const rows: GroupedRequestRow[] = groupOrder
    .map((key) => grouped.get(key))
    .filter((bucket): bucket is RequestWithUser[] => Array.isArray(bucket) && bucket.length > 0)
    .map((bucket) => {
      const primary = bucket[0];
      const requesters: Requester[] = bucket.map((r) => ({
        requestId: r.id,
        status: r.status,
        note: r.note,
        adminNote: r.adminNote,
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
        title="Requested"
        subtitle="Approve, decline, or manage every incoming request"
        right={<SyncButton />}
      />

      <div className="ds-stat-row" style={{ marginBottom: 24 }}>
        {stats.map((s) => (
          <StatCard key={s.label} label={s.label} value={s.value} mono />
        ))}
      </div>

      <AdminFilterBar
        statusCounts={statusCountsMap}
        totalAll={totalAll}
        currentStatus={statusFilter ?? ""}
        currentSort={sort}
      />

      {total === 0 ? (
        <div
          className="text-center ds-mono"
          style={{
            padding: "40px 20px",
            background: "var(--ds-bg-1)",
            border: "1px dashed var(--ds-border)",
            borderRadius: 8,
            fontSize: 12,
            color: "var(--ds-fg-subtle)",
          }}
        >
          {statusFilter
            ? `No ${statusFilter.toLowerCase()} requests.`
            : "No requests yet."}
        </div>
      ) : (
        <AdminRequestList
          requests={rows}
          page={page}
          total={total}
          pageSize={PAGE_SIZE}
          statusFilter={statusFilter}
          sort={sort}
        />
      )}
    </div>
  );
}
