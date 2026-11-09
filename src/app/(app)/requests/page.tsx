import { requireAppSession } from "@/lib/require-app-session";
import { prisma } from "@/lib/prisma";
import { posterUrl } from "@/lib/tmdb";
import { Suspense } from "react";
import { ClipboardList, Film, Tv2 } from "@/components/icons";
import Image from "next/image";
import Link from "next/link";
import { LiveRefresh } from "@/components/live-refresh";
import { FilterPills, SearchBox } from "@/components/user-list-filters";
import { PaginationBar } from "@/components/media/pagination-bar";
import type { Prisma, RequestStatus } from "@/generated/prisma";
import { attachAllAvailability } from "@/lib/attach-all";
import { getBadgeVisibility } from "@/lib/badge-visibility";
import { isFeatureEnabled } from "@/lib/features";
import { AvailabilityBadges } from "@/components/media/availability-badges";
import type { TmdbMedia } from "@/lib/tmdb-types";
import { Chip, EmptyState, PageHeader } from "@/components/ui/design";
import { LocalDateText } from "@/components/local-date";
import { REQUEST_STATUS_TONE } from "@/lib/status-labels";
import { RequestThread } from "@/components/requests/request-thread";
import { getTranslator } from "@/lib/i18n/server";
import type { Translator } from "@/lib/i18n/translate";
import { sanitizeContainsSearch } from "@/lib/sanitize";
import { redirect } from "next/navigation";
import { commentLinkToLocate, ownRequestCommentPage, ownRequestsOrderBy } from "@/lib/request-comment-deep-link";
import { parsePageNumber } from "@/lib/pagination";
import { first, type PageSearchParams } from "@/lib/search-params";

export const dynamic = "force-dynamic";

const VALID_SORTS = ["newest", "oldest"] as const;
type RequestSort = (typeof VALID_SORTS)[number];

const PAGE_SIZE = 20;

// Status labels, in the filter pills' order. Keyed by the Prisma enum, so a
// new status is a compile error here; a ?status= is valid exactly when it
// names a key.
const STATUS_LABEL_KEY: Record<RequestStatus, string> = {
  PENDING: "requests.status.pending",
  APPROVED: "requests.status.approved",
  AVAILABLE: "requests.status.available",
  DECLINED: "requests.status.declined",
};

function parseStatus(value: string | undefined): RequestStatus | null {
  return value !== undefined && Object.hasOwn(STATUS_LABEL_KEY, value) ? (value as RequestStatus) : null;
}

function parseSort(value: string | undefined): RequestSort {
  return VALID_SORTS.find((s) => s === value) ?? "newest";
}

const REQUEST_LIST_SELECT = {
  id: true, mediaType: true, tmdbId: true, title: true,
  posterPath: true, releaseYear: true, status: true, note: true,
  adminNote: true, permanentlyDeclined: true,
  createdAt: true, updatedAt: true,
  _count: { select: { comments: true } },
} as const satisfies Prisma.MediaRequestSelect;

export default async function RequestsPage({
  searchParams,
}: {
  searchParams: Promise<PageSearchParams>;
}) {
  // The gate and the reads that don't depend on the query, together: the
  // flags are cheap DB reads, and a redirect() from the gate still wins.
  const [session, t, sp, commentsEnabled, plexEnabled, jellyfinEnabled] = await Promise.all([
    requireAppSession(),
    getTranslator(),
    searchParams,
    isFeatureEnabled("feature.behavior.requestComments"),
    isFeatureEnabled("feature.integration.plex"),
    isFeatureEnabled("feature.integration.jellyfin"),
  ]);

  // A repeated query key arrives as an array at runtime; first() takes its
  // first value (a `.trim()` on the array would 500 the page).
  const { page: pageParam, comments: commentsRaw } = sp;
  // ?comments=<requestId> (from a comment notification) opens that row's thread.
  const openCommentsId = first(commentsRaw);
  const qParam = first(sp.q);
  // Clamped: an oversized ?page= drove `skip` past Prisma's limit and 500'd the
  // page instead of showing the past-the-end state.
  const page = parsePageNumber(pageParam);
  const skip = (page - 1) * PAGE_SIZE;

  const status = parseStatus(first(sp.status));
  const sort = parseSort(first(sp.sort));
  // Prisma's `contains` becomes a SQL ILIKE, where % and _ are wildcards.
  // sanitizeContainsSearch strips those and caps the length so a crafted
  // search can't make the query slow (same as /api/votes).
  const q = sanitizeContainsSearch((qParam ?? "").trim());

  // The list and the pills' counts share this, so they cannot disagree.
  const baseWhere: Prisma.MediaRequestWhereInput = {
    requestedBy: session.user.id,
    ...(q ? { title: { contains: q, mode: "insensitive" } } : {}),
  };
  const where: Prisma.MediaRequestWhereInput = { ...baseWhere, ...(status ? { status } : {}) };

  // A comment link names a request, not a page. On arrival from one (see
  // commentLinkToLocate), go to the page that holds the viewer's own request
  // under the current filter, with an explicit page so a later live refresh of
  // that URL never relocates them. The param rides along to open the thread.
  const locateId = commentsEnabled ? commentLinkToLocate(pageParam, commentsRaw) : null;
  if (locateId) {
    const target = await ownRequestCommentPage(where, locateId, sort === "oldest" ? "asc" : "desc", PAGE_SIZE);
    if (target !== null) redirect(pageHref(target, locateId));
  }

  const [requests, statusCountsRaw] = await Promise.all([
    prisma.mediaRequest.findMany({
      where,
      select: REQUEST_LIST_SELECT,
      orderBy: ownRequestsOrderBy(sort === "oldest" ? "asc" : "desc"),
      skip,
      take: PAGE_SIZE,
    }),
    // The pills' per-status counts. `where` is this filter plus the status, so
    // the list's total comes from these too (below) — no separate count query.
    prisma.mediaRequest.groupBy({
      by: ["status"],
      where: baseWhere,
      _count: { status: true },
    }),
  ]);

  const statusCounts: Partial<Record<string, number>> = Object.fromEntries(
    statusCountsRaw.map((r) => [r.status, r._count.status]),
  );
  const totalAllStatuses = statusCountsRaw.reduce((s, r) => s + r._count.status, 0);
  const total = status ? (statusCounts[status] ?? 0) : totalAllStatuses;

  const totalPages = Math.ceil(total / PAGE_SIZE);

  // Integration flags passed explicitly — they default to TRUE when omitted.
  const { showPlex, showJellyfin } = getBadgeVisibility(session, {
    plex: plexEnabled,
    jellyfin: jellyfinEnabled,
  });
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
    // includeHidden: a user's own requests must stay visible even if they've since
    // hidden the title from discovery.
    { skipRatings: true, includeHidden: true },
  );
  const availabilityByKey = new Map(
    enriched.map((e) => [`${e.id}:${e.mediaType}`, e]),
  );

  function pageHref(p: number, comments?: string): string {
    const params = new URLSearchParams();
    // A comment link's target always names its page, even page 1: a URL with
    // `page` is never located again (commentLinkToLocate).
    if (p > 1 || comments) params.set("page", String(p));
    if (status) params.set("status", status);
    if (sort !== "newest") params.set("sort", sort);
    if (q) params.set("q", q);
    if (comments) params.set("comments", comments);
    return `/requests${params.toString() ? `?${params.toString()}` : ""}`;
  }

  const hasFilters = status !== null || sort !== "newest" || q !== "";

  const subtitle =
    hasFilters && totalAllStatuses !== total
      ? t("requests.countOfTotal", { count: total, total: totalAllStatuses })
      : t("requests.count", { count: total });

  return (
    <div className="ds-page-enter">
      <LiveRefresh on={["request:updated", "request:deleted"]} />
      <PageHeader title={t("requests.title")} subtitle={subtitle} />

      <div className="flex flex-col gap-3 mb-5 sm:flex-row sm:flex-wrap sm:items-center sm:justify-between">
        <FilterPills
          param="status"
          active={status ?? ""}
          label={t("requests.filter.statusLabel")}
          options={[
            { value: "", label: t("requests.filter.all"), count: totalAllStatuses },
            ...Object.entries(STATUS_LABEL_KEY).map(([value, key]) => ({ value, label: t(key), count: statusCounts[value] ?? 0 })),
          ]}
          preserve={["sort", "q"]}
        />
        <div className="flex flex-col gap-3 sm:flex-row sm:flex-wrap sm:items-center">
          <FilterPills
            param="sort"
            active={sort === "newest" ? "" : sort}
            label={t("requests.filter.sortLabel")}
            options={[
              { value: "", label: t("requests.sort.newest") },
              { value: "oldest", label: t("requests.sort.oldest") },
            ]}
            preserve={["status", "q"]}
          />
          <SearchBox
            param="q"
            initial={q}
            placeholder={t("requests.searchPlaceholder")}
            preserve={["status", "sort"]}
          />
        </div>
      </div>

      {requests.length === 0 ? (
        <RequestsEmptyState total={total} hasFilters={hasFilters} firstPageHref={pageHref(1)} t={t} />
      ) : (
        <>
          <div className="flex flex-col" style={{ gap: 8 }}>
            {requests.map((r) => (
              <div key={r.id}>
                <RequestRow
                  request={r}
                  availability={availabilityByKey.get(`${r.tmdbId}:${r.mediaType === "MOVIE" ? "movie" : "tv"}`)}
                  showPlex={showPlex}
                  showJellyfin={showJellyfin}
                  t={t}
                />
                {commentsEnabled && (
                  <RequestThread
                    requestId={r.id}
                    viewerIsManager={false}
                    requestNote={r.note}
                    declineNote={r.status === "DECLINED" ? r.adminNote : null}
                    closed={r.permanentlyDeclined}
                    initialCount={r._count.comments}
                    defaultOpen={openCommentsId === r.id}
                  />
                )}
              </div>
            ))}
          </div>

          <Suspense>
            <PaginationBar currentPage={page} totalPages={totalPages} />
          </Suspense>
        </>
      )}
    </div>
  );
}

// Keyed on the paged slice, not `total`: `?page=9` with 3 requests has
// total=3 and requests=[], and the pager below is hidden whenever
// totalPages <= 1 — so a past-the-end page used to render the "3 requests"
// header above an empty list with no way back short of editing the URL.
// Mirrors /popular's "No more results" state. The recovery action rides the
// primitive's cta slot (same position, weight and hover as /votes and
// /issues), not an inline link.
function RequestsEmptyState({
  total,
  hasFilters,
  firstPageHref,
  t,
}: {
  total: number;
  hasFilters: boolean;
  firstPageHref: string;
  t: Translator;
}) {
  if (total > 0) {
    return (
      <EmptyState
        icon={ClipboardList}
        title={t("requests.empty.pageTitle")}
        description={t("requests.empty.pageDescription")}
        cta={{ href: firstPageHref, label: t("requests.empty.backToFirst") }}
      />
    );
  }
  if (hasFilters) {
    return (
      <EmptyState
        icon={ClipboardList}
        title={t("requests.empty.filteredTitle")}
        description={t("requests.empty.filteredDescription")}
      />
    );
  }
  return (
    <EmptyState
      icon={ClipboardList}
      title={t("requests.empty.noneTitle")}
      description={t("requests.empty.noneDescription")}
      cta={{ href: "/movies", label: t("requests.empty.browseMovies") }}
    />
  );
}

type RequestListItem = Pick<
  Prisma.MediaRequestGetPayload<{ select: typeof REQUEST_LIST_SELECT }>,
  "id" | "mediaType" | "tmdbId" | "title" | "posterPath" | "releaseYear" | "status" | "note" | "createdAt"
>;

// One of the viewer's requests: poster, title, meta line, availability, the
// note and the status chip. The title links to the detail page.
function RequestRow({
  request: r,
  availability,
  showPlex,
  showJellyfin,
  t,
}: {
  request: RequestListItem;
  availability: TmdbMedia | undefined;
  showPlex: boolean;
  showJellyfin: boolean;
  t: Translator;
}) {
  const poster = posterUrl(r.posterPath, "w342");
  return (
    <div
      className="flex items-start transition-colors bg-[var(--ds-bg-2)] hover:bg-[var(--ds-bg-3)] border border-[var(--ds-border)]"
      style={{
        gap: 14,
        padding: 14,
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
            className="font-medium truncate transition-colors group-hover:text-[var(--ds-accent-text)]"
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
              {r.mediaType === "MOVIE" ? t("requests.mediaType.movie") : t("requests.mediaType.tv")}
              {r.releaseYear ? ` · ${r.releaseYear}` : ""}
            </span>
            <span>·</span>
            <span>
              {/* Viewer's timezone, not the container's — a server-side
                  toLocaleDateString() formats in the runtime TZ (UTC in
                  Docker), so an evening request showed tomorrow's date. */}
              <LocalDateText iso={r.createdAt.toISOString()} />
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
            <p
              // Clamped in the list row (a 500-char note is otherwise a
              // ~9-line row) and keeps its line breaks, like /issues. No
              // quotation marks — the sibling pages never had them.
              className="line-clamp-3 whitespace-pre-wrap"
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
              {r.note}
            </p>
          )}
        </div>
      </Link>

      <Chip tone={REQUEST_STATUS_TONE[r.status]}>
        {t(STATUS_LABEL_KEY[r.status])}
      </Chip>
    </div>
  );
}
