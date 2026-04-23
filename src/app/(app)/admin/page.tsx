import { auth } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { type RequestStatus } from "@/generated/prisma";
import { posterUrl } from "@/lib/tmdb";
import { redirect } from "next/navigation";
import { SyncButton } from "@/components/admin/request-actions";
import { AdminRequestList, type RequestRow } from "@/components/admin/admin-request-list";
import { AdminFilterBar } from "@/components/admin/admin-filter-bar";
import { PageHeader, StatCard } from "@/components/ui/design";

export const dynamic = "force-dynamic";

const PAGE_SIZE = 20;

const VALID_STATUSES = ["PENDING", "APPROVED", "DECLINED", "AVAILABLE"];

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

  const orderBy =
    sort === "oldest" ? { createdAt: "asc" as const }
    : sort === "title" ? { title: "asc" as const }
    : { createdAt: "desc" as const };

  const where = statusFilter ? { status: statusFilter } : {};

  const [statusCounts, userCount, requests, total, userRequestCounts] = await Promise.all([
    prisma.mediaRequest.groupBy({ by: ["status"], _count: { status: true } }),
    prisma.user.count(),
    prisma.mediaRequest.findMany({
      where,
      include: { user: { select: { name: true, email: true, discordId: true } } },
      orderBy,
      skip,
      take: PAGE_SIZE,
    }),
    prisma.mediaRequest.count({ where }),
    prisma.mediaRequest.groupBy({ by: ["requestedBy"], _count: { id: true } }),
  ]);

  const pairs = requests.map((r) => ({ tmdbId: r.tmdbId, mediaType: r.mediaType }));
  const [plexItems, jellyfinItems] = pairs.length
    ? await Promise.all([
        prisma.plexLibraryItem.findMany({ where: { OR: pairs } }),
        prisma.jellyfinLibraryItem.findMany({ where: { OR: pairs } }),
      ])
    : [[], []];

  const plexSet = new Set(plexItems.map((p) => `${p.tmdbId}:${p.mediaType}`));
  const jellyfinSet = new Set(jellyfinItems.map((p) => `${p.tmdbId}:${p.mediaType}`));
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

  const rows: RequestRow[] = requests.map((r) => ({
    id: r.id,
    tmdbId: r.tmdbId,
    title: r.title,
    mediaType: r.mediaType,
    status: r.status,
    posterUrl: posterUrl(r.posterPath, "w342"),
    releaseYear: r.releaseYear,
    createdAt: r.createdAt.toISOString(),
    note: r.note,
    adminNote: r.adminNote,
    userName: r.user.name,
    userEmail: r.user.email,
    userDiscordId: r.user.discordId,
    onPlex: plexSet.has(`${r.tmdbId}:${r.mediaType}`),
    onJellyfin: jellyfinSet.has(`${r.tmdbId}:${r.mediaType}`),
    userRequestCount: userCountMap.get(r.requestedBy) ?? 1,
  }));

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
