import { auth } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { posterUrl } from "@/lib/tmdb";
import { Film, Tv2 } from "lucide-react";
import Image from "next/image";
import Link from "next/link";
import { LiveRefresh } from "@/components/live-refresh";
import { FilterPills, SearchBox } from "@/components/user-list-filters";
import type { Prisma } from "@/generated/prisma";
import { attachAllAvailability } from "@/lib/attach-all";
import { getBadgeVisibility } from "@/lib/badge-visibility";
import { AvailabilityBadges } from "@/components/media/availability-badges";
import type { TmdbMedia } from "@/lib/tmdb-types";
import { Chip, PageHeader } from "@/components/ui/design";
import type { ChipTone } from "@/components/ui/design";

export const dynamic = "force-dynamic";

const STATUS_TONE: Record<string, ChipTone> = {
  PENDING: "pending",
  APPROVED: "approved",
  DECLINED: "declined",
  AVAILABLE: "accent",
};

const STATUS_LABEL: Record<string, string> = {
  PENDING:   "Pending",
  APPROVED:  "Approved",
  DECLINED:  "Declined",
  AVAILABLE: "Available",
};

const VALID_STATUSES = ["PENDING", "APPROVED", "DECLINED", "AVAILABLE"] as const;
const VALID_SORTS = ["newest", "oldest"] as const;

const PAGE_SIZE = 20;

export default async function RequestsPage({
  searchParams,
}: {
  searchParams: Promise<{ page?: string; status?: string; sort?: string; q?: string }>;
}) {
  const session = await auth();
  if (!session) return null;

  const { page: pageParam, status: statusParam, sort: sortParam, q: qParam } = await searchParams;
  const page = Math.max(1, parseInt(pageParam ?? "1", 10) || 1);
  const skip = (page - 1) * PAGE_SIZE;

  const status = VALID_STATUSES.includes(statusParam as typeof VALID_STATUSES[number])
    ? (statusParam as typeof VALID_STATUSES[number])
    : null;
  const sort = VALID_SORTS.includes(sortParam as typeof VALID_SORTS[number])
    ? (sortParam as typeof VALID_SORTS[number])
    : "newest";
  const q = (qParam ?? "").trim();

  const where: Prisma.MediaRequestWhereInput = {
    requestedBy: session.user.id,
    ...(status ? { status } : {}),
    ...(q ? { title: { contains: q, mode: "insensitive" } } : {}),
  };

  const [requests, total, statusCountsRaw] = await Promise.all([
    prisma.mediaRequest.findMany({
      where,

      select: {
        id: true, mediaType: true, tmdbId: true, title: true,
        posterPath: true, releaseYear: true, status: true, note: true,
        createdAt: true, updatedAt: true,
      },
      orderBy: { createdAt: sort === "oldest" ? "asc" : "desc" },
      skip,
      take: PAGE_SIZE,
    }),
    prisma.mediaRequest.count({ where }),
    prisma.mediaRequest.groupBy({
      by: ["status"],
      where: {
        requestedBy: session.user.id,
        ...(q ? { title: { contains: q, mode: "insensitive" } } : {}),
      },
      _count: { status: true },
    }),
  ]);

  const statusCounts = Object.fromEntries(
    statusCountsRaw.map((r) => [r.status, r._count.status]),
  );
  const totalAllStatuses = statusCountsRaw.reduce((s, r) => s + r._count.status, 0);

  const totalPages = Math.ceil(total / PAGE_SIZE);

  const { showPlex, showJellyfin } = getBadgeVisibility(session);
  const availabilityStubs: TmdbMedia[] = requests.map((r) => ({
    id: r.tmdbId,
    mediaType: r.mediaType === "MOVIE" ? "movie" : "tv",
    title: r.title,
    overview: "",
    posterPath: r.posterPath,
    backdropPath: null,
    releaseDate: null,
    releaseYear: r.releaseYear ?? "",
    voteAverage: 0,
  }));
  const enriched = await attachAllAvailability(
    availabilityStubs,
    session.user.id,
    { skipRatings: true },
  );
  const availabilityByKey = new Map(
    enriched.map((e) => [`${e.id}:${e.mediaType}`, e]),
  );

  function pageHref(p: number): string {
    const params = new URLSearchParams();
    if (p > 1) params.set("page", String(p));
    if (status) params.set("status", status);
    if (sort !== "newest") params.set("sort", sort);
    if (q) params.set("q", q);
    return `/requests${params.toString() ? `?${params.toString()}` : ""}`;
  }

  const hasFilters = status !== null || sort !== "newest" || q !== "";

  const subtitle =
    `${total} request${total !== 1 ? "s" : ""}` +
    (hasFilters && totalAllStatuses !== total
      ? ` (of ${totalAllStatuses} total)`
      : "");

  return (
    <div className="ds-page-enter">
      <LiveRefresh on={["request:updated", "request:deleted"]} />
      <PageHeader title="My Requests" subtitle={subtitle} />

      <div className="flex flex-col gap-3 mb-5 sm:flex-row sm:items-center sm:justify-between">
        <FilterPills
          param="status"
          active={status ?? ""}
          options={[
            { value: "", label: "All", count: totalAllStatuses },
            { value: "PENDING", label: "Pending", count: statusCounts.PENDING ?? 0 },
            { value: "APPROVED", label: "Approved", count: statusCounts.APPROVED ?? 0 },
            { value: "AVAILABLE", label: "Available", count: statusCounts.AVAILABLE ?? 0 },
            { value: "DECLINED", label: "Declined", count: statusCounts.DECLINED ?? 0 },
          ]}
          preserve={["sort", "q"]}
        />
        <div className="flex items-center gap-3">
          <FilterPills
            param="sort"
            active={sort === "newest" ? "" : sort}
            options={[
              { value: "", label: "Newest" },
              { value: "oldest", label: "Oldest" },
            ]}
            preserve={["status", "q"]}
          />
          <SearchBox
            param="q"
            initial={q}
            placeholder="Search titles…"
            preserve={["status", "sort"]}
          />
        </div>
      </div>

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
          {hasFilters
            ? "No requests match these filters."
            : "No requests yet. Find something on Discover, Movies, or TV and hit Request."}
        </div>
      ) : (
        <>
          <div className="flex flex-col" style={{ gap: 8 }}>
            {requests.map((r) => {
              const poster = posterUrl(r.posterPath, "w342");
              const availability = availabilityByKey.get(
                `${r.tmdbId}:${r.mediaType === "MOVIE" ? "movie" : "tv"}`,
              );
              return (
                <div
                  key={r.id}
                  className="flex items-start"
                  style={{
                    gap: 14,
                    padding: 14,
                    background: "var(--ds-bg-2)",
                    border: "1px solid var(--ds-border)",
                    borderRadius: 8,
                  }}
                >
                  <Link
                    href={
                      r.mediaType === "MOVIE"
                        ? `/movie/${r.tmdbId}`
                        : `/tv/${r.tmdbId}`
                    }
                    className="flex items-start flex-1 min-w-0 group"
                    style={{ gap: 14 }}
                  >
                    <div
                      className="relative shrink-0 overflow-hidden"
                      style={{
                        width: 44,
                        aspectRatio: "2 / 3",
                        borderRadius: 4,
                        background: "var(--ds-bg-3)",
                      }}
                    >
                      {poster ? (
                        <Image
                          src={poster}
                          alt={r.title}
                          fill
                          className="object-cover"
                          sizes="44px"
                        />
                      ) : (
                        <div
                          className="absolute inset-0 flex items-center justify-center"
                          style={{ color: "var(--ds-fg-subtle)" }}
                        >
                          {r.mediaType === "MOVIE" ? (
                            <Film style={{ width: 16, height: 16 }} />
                          ) : (
                            <Tv2 style={{ width: 16, height: 16 }} />
                          )}
                        </div>
                      )}
                    </div>

                    <div className="flex-1 min-w-0">
                      <p
                        className="font-medium truncate transition-colors group-hover:text-[var(--ds-accent)]"
                        style={{ fontSize: 14, color: "var(--ds-fg)" }}
                      >
                        {r.title}
                      </p>
                      <div
                        className="ds-mono flex items-center"
                        style={{
                          gap: 6,
                          fontSize: 10.5,
                          color: "var(--ds-fg-subtle)",
                          marginTop: 2,
                        }}
                      >
                        <span>
                          {r.mediaType === "MOVIE" ? "MOVIE" : "TV"}
                          {r.releaseYear ? ` · ${r.releaseYear}` : ""}
                        </span>
                        <span>·</span>
                        <span>{new Date(r.createdAt).toLocaleDateString()}</span>
                      </div>
                      <AvailabilityBadges
                        plexAvailable={availability?.plexAvailable}
                        jellyfinAvailable={availability?.jellyfinAvailable}
                        arrPending={availability?.arrPending}
                        requested={availability?.requested}
                        showPlex={showPlex}
                        showJellyfin={showJellyfin}
                        className="mt-1.5"
                      />
                      {r.note && (
                        <p
                          style={{
                            marginTop: 8,
                            padding: "6px 10px",
                            borderRadius: 4,
                            background: "var(--ds-bg-1)",
                            borderLeft:
                              "2px solid var(--ds-accent-ring)",
                            fontSize: 11.5,
                            color: "var(--ds-fg-muted)",
                          }}
                        >
                          &quot;{r.note}&quot;
                        </p>
                      )}
                    </div>
                  </Link>

                  <Chip tone={STATUS_TONE[r.status]}>
                    {STATUS_LABEL[r.status]}
                  </Chip>
                </div>
              );
            })}
          </div>

          {totalPages > 1 && (
            <div
              className="flex items-center justify-between"
              style={{ marginTop: 24 }}
            >
              <p
                className="ds-mono"
                style={{ fontSize: 11, color: "var(--ds-fg-subtle)" }}
              >
                Page {page} of {totalPages}
              </p>
              <div className="flex items-center gap-2">
                <PagerLink href={page > 1 ? pageHref(page - 1) : undefined}>
                  Previous
                </PagerLink>
                <PagerLink
                  href={page < totalPages ? pageHref(page + 1) : undefined}
                >
                  Next
                </PagerLink>
              </div>
            </div>
          )}
        </>
      )}
    </div>
  );
}

function PagerLink({
  href,
  children,
}: {
  href?: string;
  children: React.ReactNode;
}) {
  const style: React.CSSProperties = {
    display: "inline-flex",
    alignItems: "center",
    justifyContent: "center",
    padding: "0 12px",
    height: 28,
    borderRadius: 6,
    border: "1px solid var(--ds-border)",
    background: href ? "var(--ds-bg-2)" : "transparent",
    color: href ? "var(--ds-fg-muted)" : "var(--ds-fg-disabled)",
    fontSize: 11,
    fontWeight: 500,
  };
  if (!href) return <span style={style}>{children}</span>;
  return (
    <Link href={href} style={style}>
      {children}
    </Link>
  );
}
