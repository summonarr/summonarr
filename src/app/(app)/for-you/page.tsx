export const dynamic = "force-dynamic";

import { MediaCard } from "@/components/media/media-card";
import { PaginationBar } from "@/components/media/pagination-bar";
import { attachAllAvailability } from "@/lib/attach-all";
import { Suspense } from "react";
import { requireAppSession } from "@/lib/require-app-session";
import { requireFeature } from "@/lib/features";
import { getBadgeVisibility } from "@/lib/badge-visibility";
import { getShow4kVisibility } from "@/lib/four-k-visibility";
import { getUserRecommendations } from "@/lib/recommendations";
import { LiveRefresh } from "@/components/live-refresh";
import { PageHeader, EmptyState } from "@/components/ui/design";
import { AvailabilityFilter, type AvailabilityFilterValue } from "@/components/media/availability-filter";
import { Filter, Sparkles } from "@/components/icons";

const PER_PAGE = 36;

// Dedicated "For You" page — the full ranked recommendation set behind the
// home rail (which shows only the top slice). Recommendations are precomputed
// per user by the warm-recommendations cron (see src/lib/recommendations.ts):
// seeds come from the last 180 days of watched history plus the watchlist,
// fanned through TMDB's recommendations/similar, scored by seed weight, and
// cached in UserRecommendation. This page never calls TMDB.
export default async function ForYouPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string>>;
}) {
  await requireFeature("feature.page.forYou");
  const [sp, session] = await Promise.all([searchParams, requireAppSession()]);
  const filter: AvailabilityFilterValue =
    sp.filter === "available" || sp.filter === "missing" ? sp.filter : undefined;
  const page = Math.max(1, parseInt(sp.page ?? "1", 10) || 1);
  const { showPlex, showJellyfin } = getBadgeVisibility(session);

  const [recommendations, show4k] = await Promise.all([
    getUserRecommendations(session.user.id),
    getShow4kVisibility(session),
  ]);

  // Enrich the WHOLE ranked set (≤ MAX_STORED_RECOMMENDATIONS_PER_USER, ~100):
  // the availability filter below reads post-enrichment fields, so filtering
  // before enriching only the visible page would break both the filter and the
  // total count. attachAllAvailability preserves rank order and drops hidden
  // titles, and its availability answer is already per-user visibility-scoped
  // (a restricted server the viewer holds no grant for reads as unavailable).
  const enriched = await attachAllAvailability(recommendations, session.user.id, { show4k });

  const filtered =
    filter === "available"
      ? enriched.filter((m) => m.plexAvailable || m.jellyfinAvailable)
      : filter === "missing"
        ? enriched.filter((m) => !(m.plexAvailable || m.jellyfinAvailable))
        : enriched;

  const offset = (page - 1) * PER_PAGE;
  const visible = filtered.slice(offset, offset + PER_PAGE);
  const totalPages = Math.max(1, Math.ceil(filtered.length / PER_PAGE));

  const subtitle =
    filtered.length > 0
      ? `${filtered.length} picks based on what you watch`
      : "Picked based on what you watch";

  return (
    <div className="ds-page-enter">
      <LiveRefresh on={["request:new", "request:updated", "request:deleted"]} />

      <PageHeader
        title="For You"
        subtitle={subtitle}
        right={
          <Suspense>
            <AvailabilityFilter active={filter} />
          </Suspense>
        }
      />

      {visible.length === 0 ? (
        enriched.length === 0 ? (
          <EmptyState
            icon={Sparkles}
            title="No recommendations yet"
            description="Picks are built from your watch history and watchlist and refresh on a schedule — watch or watchlist a few titles and check back soon."
          />
        ) : page > 1 ? (
          <EmptyState
            icon={Filter}
            title="No more results on this page"
            description="Try going back to the first page."
            cta={{ href: "/for-you", label: "Back to page 1" }}
          />
        ) : (
          <EmptyState
            icon={Filter}
            title="No picks match this filter"
            description={
              filter === "available"
                ? "None of your current picks are on your server yet — request some, or switch back to All."
                : "Every current pick is already on your server — switch back to All."
            }
            cta={{ href: "/for-you", label: "Show all" }}
          />
        )
      ) : (
        <div className="ds-media-grid">
          {visible.map((media) => (
            <MediaCard
              key={`${media.mediaType}-${media.id}`}
              media={media}
              showPlex={showPlex}
              showJellyfin={showJellyfin}
              size="md"
            />
          ))}
        </div>
      )}

      <Suspense>
        <PaginationBar currentPage={page} totalPages={totalPages} />
      </Suspense>
    </div>
  );
}
