export const dynamic = "force-dynamic";

import { MediaCard } from "@/components/media/media-card";
import { PaginationBar } from "@/components/media/pagination-bar";
import { attachAllAvailability } from "@/lib/attach-all";
import { Suspense } from "react";
import { requireAppSession } from "@/lib/require-app-session";
import { requireFeature } from "@/lib/features";
import { getBadgeVisibility } from "@/lib/badge-visibility";
import { getShow4kVisibility } from "@/lib/four-k-visibility";
import { getUserRecommendations, getRecommendationSummary } from "@/lib/recommendations";
import { formatRelativeTime } from "@/lib/relative-time";
import {
  applyRecommendationView,
  parseAvailability,
  parseRecommendationSort,
  parseRecommendationType,
} from "@/lib/recommendation-view";
import { LiveRefresh } from "@/components/live-refresh";
import { PageHeader, EmptyState } from "@/components/ui/design";
import { PillFilter } from "@/components/media/pill-filter";
import { NotInterestedButton } from "@/components/media/not-interested-button";
import { Filter, Sparkles } from "@/components/icons";
import type { TmdbMedia } from "@/lib/tmdb-types";

const PER_PAGE = 100;

// Dedicated "For You" page — the full ranked recommendation set behind the
// home rail (which shows only the top slice). Recommendations are precomputed
// per user by the warm-recommendations cron (see src/lib/recommendations.ts):
// seeds come from the last 180 days of watched history plus the watchlist,
// fanned through TMDB's recommendations/similar, scored by seed weight, and
// cached in UserRecommendation. This page never calls TMDB.
//
// Unlike a plain browse grid it also EXPLAINS itself: the header reports when
// this user's set was last built and how many of their own titles produced it,
// and every card names the strongest seed behind that particular pick.
export default async function ForYouPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string>>;
}) {
  await requireFeature("feature.page.forYou");
  const [sp, session] = await Promise.all([searchParams, requireAppSession()]);
  const availability = parseAvailability(sp.filter);
  const type = parseRecommendationType(sp.type);
  const sort = parseRecommendationSort(sp.sort);
  const page = Math.max(1, parseInt(sp.page ?? "1", 10) || 1);
  const { showPlex, showJellyfin } = getBadgeVisibility(session);

  const [recommendations, summary, show4k] = await Promise.all([
    getUserRecommendations(session.user.id),
    getRecommendationSummary(session.user.id),
    getShow4kVisibility(session),
  ]);

  // Enrich the WHOLE ranked set (≤ MAX_STORED_RECOMMENDATIONS_PER_USER, 200):
  // the availability filter below reads post-enrichment fields, so filtering
  // before enriching only the visible page would break both the filter and the
  // total count. attachAllAvailability preserves rank order and drops hidden
  // titles, and its availability answer is already per-user visibility-scoped
  // (a restricted server the viewer holds no grant for reads as unavailable).
  const enriched = await attachAllAvailability(recommendations, session.user.id, { show4k });
  const filtered = applyRecommendationView(enriched, { availability, type, sort });

  const offset = (page - 1) * PER_PAGE;
  const visible = filtered.slice(offset, offset + PER_PAGE);
  const totalPages = Math.max(1, Math.ceil(filtered.length / PER_PAGE));

  // Reads as one sentence about where these picks came from. formatRelativeTime
  // is called on the SERVER here (this page is force-dynamic and PageHeader is a
  // server component), so the string is computed once and hydration receives the
  // identical text — the guardrail-16 hazard is a Date.now() inside a "use
  // client" render, which this is not.
  const seedParts: string[] = [];
  if (summary.watchHistorySeeds > 0) {
    seedParts.push(`${summary.watchHistorySeeds} you watched`);
  }
  if (summary.watchlistSeeds > 0) {
    seedParts.push(`${summary.watchlistSeeds} on your watchlist`);
  }
  const subtitle =
    enriched.length === 0
      ? "Picked from your watch history and watchlist"
      : [
          `${filtered.length} of ${enriched.length} picks`,
          seedParts.length > 0 ? `built from ${seedParts.join(" and ")}` : null,
          summary.computedAt ? `updated ${formatRelativeTime(summary.computedAt)}` : null,
        ]
          .filter(Boolean)
          .join(" · ");

  return (
    <div className="ds-page-enter">
      <LiveRefresh on={["request:new", "request:updated", "request:deleted"]} />

      <PageHeader title="For You" subtitle={subtitle} />

      {enriched.length > 0 && (
        <div className="flex items-center gap-x-5 gap-y-3 flex-wrap mb-5">
          <Suspense>
            <PillFilter
              label="Type"
              param="type"
              active={type}
              options={[
                { value: undefined, label: "All" },
                { value: "movie", label: "Movies" },
                { value: "tv", label: "TV" },
              ]}
            />
          </Suspense>
          <Suspense>
            <PillFilter
              label="Show"
              param="filter"
              active={availability}
              options={[
                { value: undefined, label: "All" },
                { value: "available", label: "On your server" },
                { value: "missing", label: "Not on server" },
              ]}
            />
          </Suspense>
          <Suspense>
            <PillFilter
              label="Sort"
              param="sort"
              // "match" is the default and is represented by the param's absence,
              // so it maps to undefined rather than to its own literal.
              active={sort === "match" ? undefined : sort}
              options={[
                { value: undefined, label: "Best match" },
                { value: "newest", label: "Newest" },
                { value: "rating", label: "Highest rated" },
              ]}
            />
          </Suspense>
        </div>
      )}

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
            title="No picks match these filters"
            description={
              availability === "available"
                ? "None of your current picks are on your server yet — request some, or switch back to All."
                : availability === "missing"
                  ? "Every current pick is already on your server — switch back to All."
                  : "Nothing matches that combination — try widening one of the filters."
            }
            cta={{ href: "/for-you", label: "Reset filters" }}
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
              caption={<RecommendationReason media={media} />}
              overlayAction={
                <NotInterestedButton
                  tmdbId={media.id}
                  mediaType={media.mediaType === "movie" ? "MOVIE" : "TV"}
                  title={media.title}
                  posterPath={media.posterPath}
                />
              }
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

// Match-strength band, shown because SORTING HIDES THE RANKING: once the grid is
// ordered by Newest or Highest rated, nothing on the page says which picks the
// engine actually rates. Only the labelled bands render — most of a 200-title
// shelf carries no chip, which is what keeps the label meaning something.
function MatchTierChip({ tier }: { tier: NonNullable<TmdbMedia["matchTier"]> }) {
  const isTop = tier === "top";
  return (
    <span
      className={isTop ? "ds-chip ds-chip-accent" : "ds-chip"}
      style={{
        paddingLeft: 6,
        paddingRight: 7,
        ...(isTop
          ? {}
          : { background: "var(--ds-accent-soft)", color: "var(--ds-accent)", border: "1px solid var(--ds-accent-ring)" }),
      }}
      title={
        isTop
          ? "Among the highest-ranked picks the engine built for you"
          : "Ranked well above the rest of your picks"
      }
    >
      {isTop ? "Top match" : "Strong match"}
    </span>
  );
}

// The "why" under a card, with the strength band above it. Both are optional and
// independent: a row written before the reason columns existed still gets a chip
// (rank is always known), and an unbanded pick still gets its reason line.
function RecommendationReason({ media }: { media: TmdbMedia }) {
  const why = media.recommendedBecause;
  if (!why) {
    return media.matchTier ? (
      <div className="flex">
        <MatchTierChip tier={media.matchTier} />
      </div>
    ) : null;
  }

  const lead = why.source === "WATCHLIST" ? "On your watchlist:" : "Because you watched";
  // seedCount counts every seed that surfaced this title, the named one
  // included — so the "+N more" is the corroborating remainder.
  const others = why.seedCount - 1;

  return (
    <div className="flex flex-col gap-1 items-start">
      {media.matchTier && <MatchTierChip tier={media.matchTier} />}
      <p
        className="ds-mono m-0 line-clamp-2"
        style={{ fontSize: 10.5, color: "var(--ds-fg-subtle)", lineHeight: 1.4 }}
        title={
          others > 0
            ? `${lead} ${why.title}, plus ${others} other title${others === 1 ? "" : "s"} you've seen`
            : `${lead} ${why.title}`
        }
      >
        {lead}{" "}
        <span style={{ color: "var(--ds-fg-muted)" }}>{why.title}</span>
        {others > 0 && <span> + {others} more</span>}
      </p>
    </div>
  );
}
