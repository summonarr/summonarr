import { auth } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { posterUrl } from "@/lib/tmdb";
import { Badge } from "@/components/ui/badge";
import { Film, Tv2 } from "lucide-react";
import Image from "next/image";
import Link from "next/link";
import { Button } from "@/components/ui/button";
import { LiveRefresh } from "@/components/live-refresh";
import { FilterPills, SearchBox } from "@/components/user-list-filters";
import type { Prisma } from "@/generated/prisma";
import { attachAllAvailability } from "@/lib/attach-all";
import { getBadgeVisibility } from "@/lib/badge-visibility";
import { AvailabilityBadges } from "@/components/media/availability-badges";
import type { TmdbMedia } from "@/lib/tmdb-types";

export const dynamic = "force-dynamic";

const STATUS_STYLES: Record<string, string> = {
  PENDING:   "bg-yellow-500/10 text-yellow-400 border-yellow-500/20",
  APPROVED:  "bg-green-500/10 text-green-400 border-green-500/20",
  DECLINED:  "bg-red-500/10 text-red-400 border-red-500/20",
  AVAILABLE: "bg-indigo-500/10 text-indigo-400 border-indigo-500/20",
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

  return (
    <div>
      <LiveRefresh on={["request:updated", "request:deleted"]} />
      <h1 className="text-2xl font-bold mb-1">My Requests</h1>
      <p className="text-zinc-400 text-sm mb-6">
        {total} request{total !== 1 ? "s" : ""}
        {hasFilters && totalAllStatuses !== total ? ` (of ${totalAllStatuses} total)` : ""}
      </p>

      <div className="flex flex-col gap-3 mb-6 sm:flex-row sm:items-center sm:justify-between">
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
        <div className="rounded-lg bg-zinc-900 border border-zinc-800 p-10 text-center text-zinc-500 text-sm">
          {hasFilters
            ? "No requests match these filters."
            : "No requests yet. Find something on Discover, Movies, or TV and hit Request."}
        </div>
      ) : (
        <>
          <div className="flex flex-col gap-3">
            {requests.map((r) => {
              const poster = posterUrl(r.posterPath, "w342");
              const availability = availabilityByKey.get(
                `${r.tmdbId}:${r.mediaType === "MOVIE" ? "movie" : "tv"}`,
              );
              return (
                <div
                  key={r.id}
                  className="flex items-start gap-4 rounded-lg bg-zinc-900 border border-zinc-800 p-4"
                >
                  <Link
                    href={r.mediaType === "MOVIE" ? `/movie/${r.tmdbId}` : `/tv/${r.tmdbId}`}
                    className="flex items-start gap-4 flex-1 min-w-0 group"
                  >
                  <div className="relative w-12 h-16 shrink-0 rounded bg-zinc-700 overflow-hidden">
                    {poster ? (
                      <Image src={poster} alt={r.title} fill className="object-cover" sizes="48px" />
                    ) : (
                      <div className="absolute inset-0 flex items-center justify-center text-zinc-600">
                        {r.mediaType === "MOVIE" ? <Film className="w-5 h-5" /> : <Tv2 className="w-5 h-5" />}
                      </div>
                    )}
                  </div>

                  <div className="flex-1 min-w-0">
                    <p className="font-medium text-white truncate group-hover:text-indigo-400 transition-colors">{r.title}</p>
                    <div className="flex items-center gap-2 mt-0.5">
                      <span className="text-xs text-zinc-400">
                        {r.mediaType === "MOVIE" ? "Movie" : "TV Show"}
                        {r.releaseYear ? ` · ${r.releaseYear}` : ""}
                      </span>
                      <span className="text-zinc-600 text-xs">·</span>
                      <span className="text-xs text-zinc-500">
                        {new Date(r.createdAt).toLocaleDateString()}
                      </span>
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
                      <p className="mt-1.5 text-xs text-zinc-400 bg-zinc-800 rounded px-2 py-1 border-l-2 border-indigo-500/50">
                        &quot;{r.note}&quot;
                      </p>
                    )}
                  </div>
                  </Link>

                  <Badge className={`shrink-0 border text-xs font-medium ${STATUS_STYLES[r.status]}`}>
                    {STATUS_LABEL[r.status]}
                  </Badge>
                </div>
              );
            })}
          </div>

          {totalPages > 1 && (
            <div className="flex items-center justify-between mt-6">
              <p className="text-xs text-zinc-500">
                Page {page} of {totalPages}
              </p>
              <div className="flex items-center gap-2">
                {page > 1 ? (
                  <Link href={pageHref(page - 1)}>
                    <Button size="sm" variant="outline" className="h-7 px-3 text-xs border-zinc-700 text-zinc-400 hover:text-white">
                      Previous
                    </Button>
                  </Link>
                ) : (
                  <Button size="sm" variant="outline" disabled className="h-7 px-3 text-xs border-zinc-700 opacity-40">
                    Previous
                  </Button>
                )}
                {page < totalPages ? (
                  <Link href={pageHref(page + 1)}>
                    <Button size="sm" variant="outline" className="h-7 px-3 text-xs border-zinc-700 text-zinc-400 hover:text-white">
                      Next
                    </Button>
                  </Link>
                ) : (
                  <Button size="sm" variant="outline" disabled className="h-7 px-3 text-xs border-zinc-700 opacity-40">
                    Next
                  </Button>
                )}
              </div>
            </div>
          )}
        </>
      )}
    </div>
  );
}
