import { getMovieGenres, getTVGenres, getWatchProviders, tmdbLanguageFor, type TmdbMedia } from "@/lib/tmdb";
import type { SummonarrSession } from "@/lib/api-auth";
import { runBrowseQuery } from "@/lib/browse-query";
import { tmdbAuth } from "@/lib/tmdb-auth";
import { LiveRefresh } from "@/components/live-refresh";
import { BrowseGrid } from "@/components/media/browse-grid";
import { PageHeader } from "@/components/ui/design";
import { getLocale, getTranslator } from "@/lib/i18n/server";
import { discoverFiltersOf, hasActiveFilters, parseBrowseFilters } from "@/lib/browse-filters";
import { parsePageNumber } from "@/lib/pagination";
import { searchParamGetter, type PageSearchParams } from "@/lib/search-params";
import { canRequest } from "@/lib/permissions";

// The /movies and /tv browse pages: one body, the route files are thin
// wrappers (they differ only in the media type, genre list and labels).
const BROWSE_CONFIG = {
  movie: { genres: getMovieGenres, titleKey: "nav.movies", requestType: "MOVIE", logLabel: "movies", listLabel: "movie" },
  tv: { genres: getTVGenres, titleKey: "nav.tvShows", requestType: "TV", logLabel: "tv", listLabel: "tv" },
} as const;

export type BrowseMediaType = keyof typeof BROWSE_CONFIG;

/** The page's tab title — the nav label, in the viewer's language. */
export async function browsePageTitle(mediaType: BrowseMediaType): Promise<string> {
  const t = await getTranslator();
  return t(BROWSE_CONFIG[mediaType].titleKey);
}

export async function BrowsePage({
  mediaType,
  session,
  searchParams,
}: {
  mediaType: BrowseMediaType;
  /** From the route's own requireAppSession() gate. */
  session: SummonarrSession;
  searchParams: Promise<PageSearchParams>;
}) {
  const config = BROWSE_CONFIG[mediaType];
  const [sp, t, locale] = await Promise.all([searchParams, getTranslator(), getLocale()]);
  // One parser for every surface (browse-filters.ts); a repeated key counts
  // its first value, as /api/browse's URLSearchParams.get does.
  const browseFilters = parseBrowseFilters(searchParamGetter(sp));
  const { ratingFilter, watchRegion, hideAvailable } = browseFilters;
  const requestedPage  = parsePageNumber(sp.page);

  const filters = discoverFiltersOf(browseFilters);

  // Shared with /api/browse — see src/lib/browse-query.ts. The helper THROWS on
  // a first-page failure; a server component has no prior state to preserve, so
  // it degrades to an empty grid here, which is what the per-page .catch() used
  // to do inline.
  // `failed` distinguishes "TMDB is down" from "no results" — the grid
  // renders a retry banner for the first and an empty state for the second,
  // and the old per-page .catch() collapsed both into the latter.
  const query = (p: number) =>
    runBrowseQuery({ mediaType, page: p, filters, hideAvailable, ratingFilter, session })
      .then((r) => ({ ...r, failed: false }))
      .catch((err: unknown) => {
        console.error(`[browse] ${config.logLabel} page query failed:`, err instanceof Error ? err.message : err);
        return { items: [] as TmdbMedia[], totalPages: 1, showPlex: false, showJellyfin: false, failed: true };
      });
  // A failed list degrades to an empty control rather than failing the page,
  // but says why in the log. Genre names follow the viewer's language: the
  // localized list is cached under its own key, the English one is untouched
  // (guardrail 40a).
  const [genres, providers, firstBrowse] = await Promise.all([
    config.genres(tmdbLanguageFor(locale)).catch((err: unknown) => {
      console.warn(`[browse] ${config.listLabel} genre list failed:`, err instanceof Error ? err.message : err);
      return [];
    }),
    getWatchProviders(mediaType, watchRegion).catch((err: unknown) => {
      console.warn(`[browse] ${config.listLabel} watch-provider list failed:`, err instanceof Error ? err.message : err);
      return [];
    }),
    query(requestedPage),
  ]);
  // Clamp the page ONCE and hand every surface the same number, the way
  // /upcoming does. A stale bookmark (`?page=600` on a set that has shrunk to
  // 500 pages) used to show "Page 500 of 500" in the header while the grid said
  // "past the end" and the pager highlighted 600. TMDB serves one page per
  // call, so the clamped page is re-read — one extra fetch, only on this
  // stale-URL path, and only when the first read itself succeeded (a failed
  // read reports totalPages 1 and would otherwise always "clamp").
  const browse =
    !firstBrowse.failed && requestedPage > firstBrowse.totalPages
      ? await query(Math.max(1, firstBrowse.totalPages))
      : firstBrowse;
  const page = Math.max(1, Math.min(requestedPage, browse.totalPages));
  const { items, totalPages, showPlex, showJellyfin, failed } = browse;

  // Header subtitle. Same predicate as BrowseGrid's own `hasFilters`
  // (hasActiveFilters — watchRegion alone narrows nothing the user asked for);
  // the grid used to render this line itself and pull it up under the header
  // with a negative margin.
  const hasFilters = hasActiveFilters(browseFilters);
  // `items` is ONE TMDB page (~20), not the result set, so a bare count would
  // read "20 results" above a pager offering hundreds of pages. Page-scoped when
  // there is more than one page; a count only when this page is everything.
  // A failed fetch states no number — the grid's retry banner says what happened.
  const subtitle = !hasFilters
    ? t("browse.popularNow")
    : failed
      ? t("browse.filteredResults")
      : totalPages > 1
        ? t("browse.pageOf", { page, total: totalPages })
        : t("browse.results", { count: items.length });

  return (
    <div className="ds-page-enter">
      <LiveRefresh on={["request:new", "request:updated", "request:deleted"]} />
      <PageHeader title={t(config.titleKey)} subtitle={subtitle} />
      <BrowseGrid
        initialItems={items}
        initialTotalPages={totalPages}
        initialPage={page}
        genres={genres}
        watchProviders={providers}
        showPlex={showPlex}
        showJellyfin={showJellyfin}
        maxYear={new Date().getUTCFullYear() + 1}
        failed={failed}
        tokenMissing={tmdbAuth() === null}
        canRequest={canRequest(session.user.permissions, config.requestType, false)}
      />
    </div>
  );
}
