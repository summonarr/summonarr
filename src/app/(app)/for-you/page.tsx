export const dynamic = "force-dynamic";

import { MediaCard } from "@/components/media/media-card";
import { PaginationBar } from "@/components/media/pagination-bar";
import { attachAllAvailability } from "@/lib/attach-all";
import { Suspense } from "react";
import { requireAppSession } from "@/lib/require-app-session";
import { isFeatureEnabled, requireFeature } from "@/lib/features";
import { getBadgeVisibility } from "@/lib/badge-visibility";
import { getShow4kVisibility } from "@/lib/four-k-visibility";
import {
  getUserRecommendations,
  getRecommendationsComputedAt,
  summarizeRecommendationSeeds,
} from "@/lib/recommendations";
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
import { RebuildRecommendationsButton } from "@/components/media/rebuild-recommendations-button";
import { Filter, Sparkles } from "@/components/icons";
import type { TmdbMedia } from "@/lib/tmdb-types";
import { getTranslator } from "@/lib/i18n/server";
import type { Translator } from "@/lib/i18n/translate";

const PER_PAGE = 100;

// "updated 5m ago", localized. Same buckets as formatRelativeTime
// (src/lib/relative-time.ts), which is English-only. Server-rendered, so the
// browser receives finished text (guardrail 16 does not apply here).
function updatedLabel(t: Translator, date: Date): string {
  const minutes = Math.floor((Date.now() - date.getTime()) / 60_000);
  if (minutes < 1) return t("browse.forYou.updated.justNow");
  if (minutes < 60) return t("browse.forYou.updated.minutes", { count: minutes });
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return t("browse.forYou.updated.hours", { count: hours });
  return t("browse.forYou.updated.days", { count: Math.floor(hours / 24) });
}

// Dedicated "For You" page — the full ranked recommendation set behind the
// home rail (which shows only the top slice). Recommendations are precomputed
// per user by the warm-recommendations cron (see src/lib/recommendations.ts):
// "seeds" (titles the user recently watched, put on their watchlist or
// requested) are looked up in the stored suggestion graph, scored, and saved
// in UserRecommendation. This page only reads that stored result — it never
// calls TMDB.
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
  const [sp, session, plexEnabled, jellyfinEnabled, t] = await Promise.all([
    searchParams,
    requireAppSession(),
    isFeatureEnabled("feature.integration.plex"),
    isFeatureEnabled("feature.integration.jellyfin"),
    getTranslator(),
  ]);
  const availability = parseAvailability(sp.filter);
  const type = parseRecommendationType(sp.type);
  const sort = parseRecommendationSort(sp.sort);
  const page = Math.max(1, parseInt(sp.page ?? "1", 10) || 1);
  // Integration flags passed explicitly — they default to TRUE when omitted.
  const { showPlex, showJellyfin } = getBadgeVisibility(session, {
    plex: plexEnabled,
    jellyfin: jellyfinEnabled,
  });

  const [recommendations, computedAt, show4k] = await Promise.all([
    getUserRecommendations(session.user.id),
    getRecommendationsComputedAt(session.user.id),
    getShow4kVisibility(session),
  ]);

  // Enrich the WHOLE ranked set (≤ MAX_SERVED_RECOMMENDATIONS, 200 — the store
  // holds a deeper reserve that never reaches a read surface): the availability
  // filter below reads post-enrichment fields, so filtering before enriching
  // only the visible page would break both the filter and the total count.
  // attachAllAvailability preserves rank order and drops hidden titles, and its
  // availability answer is already per-user visibility-scoped (a restricted
  // server the viewer holds no grant for reads as unavailable).
  const enriched = await attachAllAvailability(recommendations, session.user.id, { show4k });
  const filtered = applyRecommendationView(enriched, { availability, type, sort });

  const offset = (page - 1) * PER_PAGE;
  const visible = filtered.slice(offset, offset + PER_PAGE);
  const totalPages = Math.max(1, Math.ceil(filtered.length / PER_PAGE));

  // The subtitle reads as one sentence about where these picks came from.
  // formatRelativeTime runs on the SERVER here, so the browser receives the
  // finished text and hydration can't disagree with it (guardrail 16 is about
  // Date.now() inside a "use client" render, which this is not).
  //
  // The seed counts are taken off `enriched` — the same set the "of N picks"
  // denominator reports — so the sentence describes ONE population throughout.
  // (`filtered` would re-count on every pill click; the shelf's provenance does
  // not change because the reader narrowed to TV.)
  const seeds = summarizeRecommendationSeeds(enriched);
  const seedParts: string[] = [];
  if (seeds.watchHistorySeeds > 0) {
    seedParts.push(t("browse.forYou.seeds.watched", { count: seeds.watchHistorySeeds }));
  }
  if (seeds.watchlistSeeds > 0) {
    seedParts.push(t("browse.forYou.seeds.watchlist", { count: seeds.watchlistSeeds }));
  }
  if (seeds.requestSeeds > 0) {
    seedParts.push(t("browse.forYou.seeds.requested", { count: seeds.requestSeeds }));
  }
  const seedList =
    seedParts.length > 1
      ? t("browse.forYou.seeds.join", { rest: seedParts.slice(0, -1).join(", "), last: seedParts[seedParts.length - 1] })
      : seedParts[0];
  // An all-fallback shelf (cold start) says so instead of implying these came
  // from a taste profile that does not exist yet.
  const allFallback = enriched.length > 0 && enriched.every((m) => m.fromTrendingFallback);
  const subtitle =
    enriched.length === 0
      ? t("browse.forYou.subtitle")
      : allFallback
        ? [
            t("browse.forYou.fallbackPicks", { count: filtered.length }),
            t("browse.forYou.fallbackHint"),
            computedAt ? updatedLabel(t, computedAt) : null,
          ]
            .filter(Boolean)
            .join(" · ")
        : [
            // "200 of 200 picks" says nothing the plain count doesn't.
            filtered.length === enriched.length
              ? t("browse.forYou.picks", { count: enriched.length })
              : t("browse.forYou.picksOf", { count: filtered.length, total: enriched.length }),
            seedParts.length > 0 ? t("browse.forYou.builtFrom", { seeds: seedList }) : null,
            computedAt ? updatedLabel(t, computedAt) : null,
          ]
            .filter(Boolean)
            .join(" · ");

  // "Back to page 1" keeps the reader's filters — only the page resets.
  const firstPageParams = new URLSearchParams();
  if (type) firstPageParams.set("type", type);
  if (availability) firstPageParams.set("filter", availability);
  if (sort !== "match") firstPageParams.set("sort", sort);
  const firstPageHref = firstPageParams.toString() ? `/for-you?${firstPageParams}` : "/for-you";

  const isAdmin = session.user.role === "ADMIN";

  return (
    <div className="ds-page-enter">
      {/* Only the events that can bring a title BACK onto this shelf. A title
          the viewer has a PENDING/APPROVED request for is excluded from it, so
          refreshing on their own request:new (or its APPROVED follow-up) made
          the card they had just requested vanish and reflowed the grid. A
          decline, an AVAILABLE flip or a deletion is what changes the shelf. */}
      <LiveRefresh
        on={["request:updated", "request:deleted"]}
        updatedStatuses={["DECLINED", "AVAILABLE"]}
      />

      {/* The rebuild control is admin-only, and cosmetic: the real gate is the
          endpoint, which resolves an admin session through getCronActor and
          401s anything else. The role here comes from requireAppSession
          (DB-checked), so a demotion hides it on the next render rather than
          after the JWT expires. It sits inline after "updated N ago" rather than
          as a header action — see the component for why. */}
      <PageHeader
        title={t("nav.forYou")}
        subtitle={
          isAdmin ? (
            <>
              {subtitle} · <RebuildRecommendationsButton />
            </>
          ) : (
            subtitle
          )
        }
      />

      {enriched.length > 0 && (
        <div className="flex items-center gap-x-5 gap-y-3 flex-wrap mb-6">
          <Suspense>
            <PillFilter
              label={t("browse.filter.type")}
              param="type"
              active={type}
              options={[
                { value: undefined, label: t("browse.type.all") },
                { value: "movie", label: t("nav.movies") },
                { value: "tv", label: t("nav.tvShows") },
              ]}
            />
          </Suspense>
          <Suspense>
            <PillFilter
              // Not "Show": beside "Type: TV Shows" it read as the TV filter.
              label={t("browse.forYou.filter.library")}
              param="filter"
              active={availability}
              options={[
                { value: undefined, label: t("browse.type.all") },
                { value: "available", label: t("browse.forYou.filter.onServer") },
                { value: "missing", label: t("browse.forYou.filter.notOnServer") },
              ]}
            />
          </Suspense>
          <Suspense>
            <PillFilter
              label={t("browse.filter.sort")}
              param="sort"
              // "match" is the default and is represented by the param's absence,
              // so it maps to undefined rather than to its own literal.
              active={sort === "match" ? undefined : sort}
              options={[
                { value: undefined, label: t("browse.forYou.sort.match") },
                { value: "newest", label: t("browse.forYou.sort.newest") },
                { value: "rating", label: t("browse.forYou.sort.rating") },
              ]}
            />
          </Suspense>
        </div>
      )}

      {visible.length === 0 ? (
        enriched.length === 0 ? (
          <EmptyState
            icon={Sparkles}
            title={t("browse.forYou.empty.title")}
            description={t("browse.forYou.empty.description")}
          />
        ) : page > 1 ? (
          <EmptyState
            icon={Filter}
            title={t("browse.empty.noMoreResults.title")}
            description={t("browse.empty.noMoreResults.description")}
            cta={{ href: firstPageHref, label: t("browse.empty.backToPage1") }}
          />
        ) : (
          <EmptyState
            icon={Filter}
            title={t("browse.forYou.noMatch.title")}
            description={
              availability === "available"
                ? t("browse.forYou.noMatch.available")
                : availability === "missing"
                  ? t("browse.forYou.noMatch.missing")
                  : t("browse.forYou.noMatch.other")
            }
            cta={{ href: "/for-you", label: t("browse.resetFilters") }}
          />
        )
      ) : (
        <div className="ds-media-grid">
          {visible.map((media) => (
            // The card is the grid item itself, with no wrapper: the grid
            // stretches its items, and a wrapper took the stretch while the
            // card stopped at its own content height — ragged rows. The
            // not-interested button sits in the poster's top-left corner, where
            // the availability chips go; MediaCard moves the chips down below
            // it whenever overlayAction is set, so nothing else is needed here.
            <MediaCard
              key={`${media.mediaType}-${media.id}`}
              media={media}
              showPlex={showPlex}
              showJellyfin={showJellyfin}
              size="md"
              caption={<RecommendationReason t={t} media={media} rankedOrder={sort === "match"} />}
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
function MatchTierChip({ t, tier }: { t: Translator; tier: NonNullable<TmdbMedia["matchTier"]> }) {
  const isTop = tier === "top";
  return (
    <span
      className={isTop ? "ds-chip ds-chip-accent" : "ds-chip"}
      style={{
        paddingLeft: 6,
        paddingRight: 7,
        ...(isTop
          ? {}
          : { background: "var(--ds-accent-soft)", color: "var(--ds-accent-text)", border: "1px solid var(--ds-accent-ring)" }),
      }}
      title={
        isTop
          ? t("browse.forYou.tier.topTitle")
          : t("browse.forYou.tier.strongTitle")
      }
    >
      {isTop ? t("browse.forYou.tier.top") : t("browse.forYou.tier.strong")}
    </span>
  );
}

// The "why" under a card, with the strength band above it. Both are optional and
// independent: a row written before the reason columns existed still gets a chip
// (rank is always known), and an unbanded pick still gets its reason line.
//
// `rankedOrder` is true under Best Match. There the grid's ORDER already says
// how strongly each pick ranks, so only "Top match" renders: with both bands the
// top third of the shelf — about two-thirds of page 1 — carried a chip, and a
// label on most cards labels nothing. Under Newest / Highest rated the order no
// longer carries the ranking, so both bands come back.
function RecommendationReason({ t, media, rankedOrder }: { t: Translator; media: TmdbMedia; rankedOrder: boolean }) {
  const why = media.recommendedBecause;
  const tier = media.matchTier === "strong" && rankedOrder ? undefined : media.matchTier;
  if (!why) {
    // A cold-start fallback pick says what it is. Deliberately NOT a match
    // chip and NOT a "Because you…" line — it was picked for everyone.
    if (media.fromTrendingFallback) {
      return (
        <p className="ds-mono m-0" style={{ fontSize: 11.5, color: "var(--ds-fg-muted)", lineHeight: 1.4 }}>
          {t("browse.popularNow")}
        </p>
      );
    }
    return tier ? (
      <div className="flex">
        <MatchTierChip t={t} tier={tier} />
      </div>
    ) : null;
  }

  // Every lead names what the viewer DID with the seed. "On your watchlist: X"
  // read as if the recommended title itself were on the watchlist.
  const lead =
    why.source === "WATCHLIST"
      ? t("browse.forYou.because.watchlist")
      : why.source === "REQUEST"
        ? t("browse.forYou.because.request")
        : t("browse.forYou.because.watched");
  // seedCount counts every seed that surfaced this title, the named one
  // included — so the "+N more" is the corroborating remainder.
  const others = why.seedCount - 1;

  // Only the seed TITLE is clamped, in its own block: clamping the whole
  // sentence let a long lead ("Because you watchlisted" wraps on a phone) or a
  // long title eat the line the seed's name needed, and cut "+ 3 more" to
  // "+ 3…". The clamped text stays whole in the DOM, so a screen reader still
  // hears all of it.
  return (
    <div className="flex flex-col gap-1 items-start">
      {tier && <MatchTierChip t={t} tier={tier} />}
      <p
        className="ds-mono m-0"
        style={{ fontSize: 11.5, color: "var(--ds-fg-muted)", lineHeight: 1.4 }}
        title={`${lead} ${why.title}`}
      >
        {lead}{" "}
        <span className="line-clamp-2" style={{ color: "var(--ds-fg)" }}>
          {why.title}
        </span>
      </p>
      {others > 0 && (
        <p className="ds-mono m-0" style={{ fontSize: 11.5, color: "var(--ds-fg-muted)", lineHeight: 1.4 }}>
          {t("browse.forYou.moreOfYours", { count: others })}
        </p>
      )}
    </div>
  );
}
