export const dynamic = "force-dynamic";

import type { Metadata } from "next";
import { MediaCard } from "@/components/media/media-card";
import { attachAllAvailability } from "@/lib/attach-all";
import { loadUpcomingTitles } from "@/lib/upcoming-list";
import { attachRatingsUnified } from "@/lib/omdb-availability";
import { localizeMedia } from "@/lib/tmdb-localize";
import { Suspense } from "react";
import { HideAvailableToggle } from "@/components/media/hide-available-toggle";
import { requireAppSession } from "@/lib/require-app-session";
import { getBadgeVisibility } from "@/lib/badge-visibility";
import { getShow4kVisibility } from "@/lib/four-k-visibility";
import { isFeatureEnabled, requireFeature } from "@/lib/features";
import { LiveRefresh } from "@/components/live-refresh";
import { PageHeader, EmptyState } from "@/components/ui/design";
import { PaginationBar } from "@/components/media/pagination-bar";
import { AlertTriangle, Calendar } from "@/components/icons";
import Link from "next/link";
import { getContentLocale, getTranslator } from "@/lib/i18n/server";
import type { Translator } from "@/lib/i18n/translate";
import { parsePageNumber } from "@/lib/pagination";
import { first, type PageSearchParams } from "@/lib/search-params";
import { canRequest } from "@/lib/permissions";

// One screenful, matching POPULAR_PER_PAGE. See the note at the slice below for
// why this page needed bounding at all.
const UPCOMING_PER_PAGE = 40;

// Tab / bookmark / history title — the nav label, in the viewer's language.
export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslator();
  return { title: t("nav.upcoming") };
}

export default async function UpcomingPage({
  searchParams,
}: {
  searchParams: Promise<PageSearchParams>;
}) {
  await requireFeature("feature.page.upcoming");
  const [sp, session, plexEnabled, jellyfinEnabled, calendarEnabled, t] = await Promise.all([
    searchParams,
    requireAppSession(),
    isFeatureEnabled("feature.integration.plex"),
    isFeatureEnabled("feature.integration.jellyfin"),
    isFeatureEnabled("feature.integration.calendar"),
    getTranslator(),
  ]);
  const hideAvailable = first(sp.hideAvailable) === "1";
  // Integration flags passed explicitly — they default to TRUE when omitted.
  const { showPlex, showJellyfin } = getBadgeVisibility(session, {
    plex: plexEnabled,
    jellyfin: jellyfinEnabled,
  });
  const canRequestMovie = canRequest(session.user.permissions, "MOVIE", false);
  const canRequestTv = canRequest(session.user.permissions, "TV", false);
  const { titles: raw, failed: loadFailed } = await loadUpcomingTitles();

  const show4k = await getShow4kVisibility(session);
  // Availability for the whole list (hideAvailable filters on it, and the page
  // count follows the filter); ratings and translations only for the page
  // shown, below — a cold language would otherwise fetch every title's.
  let items = await attachAllAvailability(raw, session.user.id, { show4k, skipRatings: true, skipLocalize: true });

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
  // The slice happens AFTER the availability pass on purpose: hideAvailable
  // filters on availability, so paginating first would give uneven pages. That
  // pass is a fixed handful of bulk queries regardless of list length; the
  // ratings pass (MDBList/OMDB refreshes for every miss) runs on the page only.
  const totalPages = Math.max(1, Math.ceil(items.length / UPCOMING_PER_PAGE));
  // Clamped, not trusted: ?page=99 (or a page that shrank when the user turned
  // on Hide Available) lands on the last real page instead of an empty grid.
  const page = Math.min(totalPages, parsePageNumber(sp.page));
  const [rated, contentLocale] = await Promise.all([
    attachRatingsUnified(items.slice((page - 1) * UPCOMING_PER_PAGE, page * UPCOMING_PER_PAGE)),
    getContentLocale(),
  ]);
  const pageItems = await localizeMedia(rated, contentLocale);

  return (
    <div className="ds-page-enter">
      <LiveRefresh on={["request:new", "request:updated", "request:deleted"]} />
      <PageHeader
        title={t("nav.upcoming")}
        subtitle={
          items.length > 0
            ? t("browse.upcoming.rangeSubtitle", {
                from: (page - 1) * UPCOMING_PER_PAGE + 1,
                to: (page - 1) * UPCOMING_PER_PAGE + pageItems.length,
                total: items.length,
              })
            : t("browse.upcoming.subtitle")
        }
        right={
          <div className="flex flex-wrap items-center gap-2">
            {calendarEnabled && (
              <Link
                href="/profile#calendar-feed"
                title={t("browse.upcoming.subscribeTitle")}
                className="ds-tap ds-hover-tint inline-flex items-center gap-1.5 font-medium"
                style={{
                  padding: "5px 12px",
                  minHeight: 32,
                  borderRadius: 6,
                  fontSize: 12,
                  background: "var(--ds-bg-2)",
                  color: "var(--ds-fg-muted)",
                  border: "1px solid var(--ds-border)",
                  whiteSpace: "nowrap",
                }}
              >
                <Calendar className="w-3.5 h-3.5" />
                {t("browse.upcoming.subscribe")}
              </Link>
            )}
            <Suspense>
              <HideAvailableToggle active={hideAvailable} />
            </Suspense>
          </div>
        }
      />

      {items.length === 0 ? (
        <UpcomingEmptyState loadFailed={loadFailed} hadTitles={raw.length > 0} hideAvailable={hideAvailable} t={t} />
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
                canRequest={media.mediaType === "movie" ? canRequestMovie : canRequestTv}
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

// Why the list is empty, most specific cause first.
function UpcomingEmptyState({
  loadFailed,
  hadTitles,
  hideAvailable,
  t,
}: {
  loadFailed: boolean;
  /** Whether any title came back before the viewer's filters. */
  hadTitles: boolean;
  hideAvailable: boolean;
  t: Translator;
}) {
  if (loadFailed) {
    return (
      <EmptyState
        icon={AlertTriangle}
        title={t("browse.upcoming.loadFailed.title")}
        description={t("browse.upcoming.loadFailed.description")}
        cta={{ href: "/upcoming", label: t("browse.retry") }}
      />
    );
  }
  if (!hadTitles) {
    // The TMDB helpers swallow outages into [] and an empty cache plus an
    // empty answer lands here too, so this can't be blamed on the token.
    return (
      <EmptyState
        icon={AlertTriangle}
        title={t("browse.upcoming.unavailable.title")}
        description={t("browse.upcoming.unavailable.description")}
        cta={{ href: "/upcoming", label: t("browse.retry") }}
      />
    );
  }
  if (hideAvailable) {
    return (
      <EmptyState
        icon={Calendar}
        title={t("browse.upcoming.none.title")}
        description={t("browse.upcoming.none.allAvailable")}
        cta={{ href: "/upcoming", label: t("browse.showAvailable") }}
      />
    );
  }
  // Titles came back but none survived enrichment: the user has hidden every
  // one of them.
  return (
    <EmptyState
      icon={Calendar}
      title={t("browse.upcoming.none.title")}
      description={t("browse.upcoming.none.allHidden")}
      cta={{ href: "/hidden", label: t("browse.manageHidden") }}
    />
  );
}
