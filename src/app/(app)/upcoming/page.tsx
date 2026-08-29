export const dynamic = "force-dynamic";

import { getUpcomingMovies, getUpcomingTV, type TmdbMedia } from "@/lib/tmdb";
import { MediaCard } from "@/components/media/media-card";
import { attachAllAvailability } from "@/lib/attach-all";
import { prisma } from "@/lib/prisma";
import { Suspense } from "react";
import { HideAvailableToggle } from "@/components/media/hide-available-toggle";
import { requireAppSession } from "@/lib/require-app-session";
import { getBadgeVisibility } from "@/lib/badge-visibility";
import { getShow4kVisibility } from "@/lib/four-k-visibility";
import { requireFeature } from "@/lib/features";
import { LiveRefresh } from "@/components/live-refresh";
import { PageHeader, EmptyState } from "@/components/ui/design";
import { PaginationBar } from "@/components/media/pagination-bar";
import { AlertTriangle, Calendar } from "@/components/icons";

// One screenful, matching POPULAR_PER_PAGE. See the note at the slice below for
// why this page needed bounding at all.
const UPCOMING_PER_PAGE = 40;

// Reads still-fresh (within 49h) not-yet-released titles from the UpcomingCacheItem table.
async function getUpcomingFromCache(): Promise<TmdbMedia[]> {
  const today = new Date().toISOString().slice(0, 10);
  const rows = await prisma.upcomingCacheItem.findMany({
    where: {
      cachedAt: { gt: new Date(Date.now() - 49 * 60 * 60 * 1000) },
      releaseDate: { gte: today },
    },
    orderBy: { releaseDate: "asc" },
    take: 500,
  });
  return rows.map((r) => ({
    id: r.tmdbId,
    mediaType: r.mediaType === "MOVIE" ? "movie" : ("tv" as TmdbMedia["mediaType"]),
    title: r.title,
    overview: r.overview,
    posterPath: r.posterPath,
    backdropPath: r.backdropPath,
    releaseDate: r.releaseDate,
    releaseYear: r.releaseYear,
    voteAverage: r.voteAverage,
  }));
}

export default async function UpcomingPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string>>;
}) {
  await requireFeature("feature.page.upcoming");
  const [sp, session] = await Promise.all([searchParams, requireAppSession()]);
  const hideAvailable = sp.hideAvailable === "1";
  const { showPlex, showJellyfin } = getBadgeVisibility(session);
  const raw: TmdbMedia[] = [];
  let loadFailed = false;
  try {
    const today = new Date().toISOString().slice(0, 10);

    let all = await getUpcomingFromCache();
    const hasMovies = all.some((m) => m.mediaType === "movie");
    const hasTV = all.some((m) => m.mediaType === "tv");
    if (!hasMovies || !hasTV) {
      // Fall back to live TMDB for whichever side the cache is missing — covers
      // both a cold cache and the transitional state where prior runs cached
      // currently-airing TV (past first_air_date) that the gte filter now drops.
      const [movies, tv] = await Promise.all([
        hasMovies ? Promise.resolve([] as TmdbMedia[]) : getUpcomingMovies(),
        hasTV ? Promise.resolve([] as TmdbMedia[]) : getUpcomingTV(),
      ]);
      all = [...all, ...movies, ...tv];
    }

    const movies = all.filter((m) => m.mediaType === "movie");
    const tv = all.filter((m) => m.mediaType === "tv");

    const futureMovies = movies.filter((m) => m.releaseDate && m.releaseDate >= today);
    const futureTV = tv.filter((m) => m.releaseDate && m.releaseDate >= today);

    const maxLen = Math.max(futureMovies.length, futureTV.length);
    for (let i = 0; i < maxLen; i++) {
      if (i < futureMovies.length) raw.push(futureMovies[i]);
      if (i < futureTV.length) raw.push(futureTV[i]);
    }
  } catch (err) {
    loadFailed = true;
    console.error("[upcoming] failed to load upcoming titles", err);
  }

  const show4k = await getShow4kVisibility(session);
  let items = await attachAllAvailability(raw, session?.user.id, { show4k });

  if (hideAvailable) {
    // Gate on the user's own server visibility, matching /api/upcoming. Without
    // it a Plex-pinned user had Jellyfin-only titles hidden here but kept by the
    // route, so the same toggle produced two different lists.
    items = items.filter((m) => !((showPlex && m.plexAvailable) || (showJellyfin && m.jellyfinAvailable)));
  }

  // PAGINATE. The cache query takes up to 500 rows and this page used to render
  // every one — 447 cards on a live instance, against ~20-40 on Discover or
  // Movies. Posters are lazy (next/image defaults to loading="lazy"), so the
  // cost was not the images: it was the DOM, and the ratings batcher, which
  // every MediaCard calls on MOUNT rather than on visibility. At 447 cards that
  // is three chained POSTs to /api/ratings/batch (MAX_BATCH is 200), each
  // resolving MDBList/OMDB server-side, before the grid finishes filling in.
  // One page is one batch.
  //
  // The slice happens AFTER enrichment on purpose: hideAvailable filters on
  // availability, so paginating first would give uneven pages. attachAll is a
  // fixed handful of bulk queries regardless of list length, so enriching the
  // full list costs about the same as enriching one page of it.
  const totalPages = Math.max(1, Math.ceil(items.length / UPCOMING_PER_PAGE));
  // Clamped, not trusted: ?page=99 (or a page that shrank when the user turned
  // on Hide Available) lands on the last real page instead of an empty grid.
  const page = Math.min(totalPages, Math.max(1, parseInt(sp.page ?? "1", 10) || 1));
  const pageItems = items.slice((page - 1) * UPCOMING_PER_PAGE, page * UPCOMING_PER_PAGE);

  return (
    <div className="ds-page-enter">
      <LiveRefresh on={["request:new", "request:updated", "request:deleted"]} />
      <PageHeader
        title="Upcoming"
        subtitle={
          items.length > 0
            ? `${(page - 1) * UPCOMING_PER_PAGE + 1}–${(page - 1) * UPCOMING_PER_PAGE + pageItems.length} of ${items.length} premiering soon`
            : "Movies and TV shows premiering soon"
        }
        right={
          <Suspense>
            <HideAvailableToggle active={hideAvailable} />
          </Suspense>
        }
      />

      {items.length === 0 ? (
        loadFailed ? (
          <EmptyState
            icon={AlertTriangle}
            title="Couldn’t load upcoming titles"
            description="TMDB is temporarily unavailable. Please try again shortly."
            cta={{ href: "/upcoming", label: "Retry" }}
          />
        ) : raw.length === 0 ? (
          <EmptyState
            icon={AlertTriangle}
            title="TMDB token not configured"
            description="Set TMDB_READ_TOKEN in your environment to enable discovery."
          />
        ) : (
          <EmptyState
            icon={Calendar}
            title="No upcoming titles to show"
            description="Everything upcoming is already available on your servers."
            cta={{ href: "/upcoming", label: "Clear filters" }}
          />
        )
      ) : (
        <>
          <div className="ds-media-grid">
            {pageItems.map((media) => (
              <MediaCard
                key={`${media.mediaType}-${media.id}`}
                media={media}
                showPlex={showPlex}
                showJellyfin={showJellyfin}
                size="md"
              />
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
