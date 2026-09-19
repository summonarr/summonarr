// Root (app) loading boundary — primarily for the home/discover page, the
// heaviest route (7 TMDB rail fetches + availability enrichment): on a cold
// TMDB cache, navigating to "/" used to block with zero feedback. Shaped like
// Discover: PageHeader (+ the hide-available toggle), the trending hero pair
// (.ds-discover-hero-pair, stacks below 900px; each hero is the real 20px-
// padded .ds-discover-hero poster+content grid, so ≈310px tall on desktop),
// then wrapping .ds-media-grid sections of MediaCard tiles under a section
// title — NOT horizontal rails, which is what the old skeleton drew and what
// made the real page reflow on swap.
//
// NOTE: this also covers every child segment without its own loading.tsx.
// After the per-route skeletons landed that is only "/" itself and /donate (a
// static page; the flash there is negligible). Every other segment — the
// browse grids, both detail pages, for-you, watchlist, hidden, notifications,
// watch-history, my-stats + wrapped, profile, person, requests, issues, votes,
// settings and the admin subtree — has its own boundary and never falls
// through to this one.
import {
  Bar,
  MediaCardTile,
  SKELETON_CARD,
  SKELETON_FILL,
  SkeletonHeader,
} from "@/components/loading/poster-grid-skeleton";

export default function Loading() {
  return (
    <div className="animate-pulse">
      <SkeletonHeader subtitle right />

      {/* Trending hero pair */}
      <div className="ds-discover-hero-pair">
        {Array.from({ length: 2 }).map((_, i) => (
          <div key={i} className="ds-discover-hero" style={{ ...SKELETON_CARD, borderRadius: 12, padding: 20 }}>
            <div className="rounded-lg" style={{ aspectRatio: "2 / 3", background: SKELETON_FILL }} />
            <div className="flex flex-col justify-center" style={{ gap: 10 }}>
              <Bar w={110} h={10} />
              <Bar w="70%" h={24} />
              <Bar w="45%" h={12} />
              <div className="flex flex-col" style={{ gap: 6, marginTop: 6 }}>
                <Bar w="95%" h={12} />
                <Bar w="88%" h={12} />
                <Bar w="60%" h={12} />
              </div>
              <div className="flex" style={{ gap: 8, marginTop: 8 }}>
                <Bar w={110} h={32} r={8} />
                <Bar w={90} h={32} r={8} />
              </div>
            </div>
          </div>
        ))}
      </div>

      {/* Sections: DiscoverRow = title row (mb-3) + a wrapping card grid, 36px apart */}
      {Array.from({ length: 2 }).map((_, s) => (
        <section key={s} style={{ marginBottom: 36 }}>
          <div className="flex flex-col mb-3" style={{ gap: 4 }}>
            <Bar w={180} h={18} />
            <Bar w={90} h={11} />
          </div>
          <div className="ds-media-grid">
            {Array.from({ length: 6 }).map((_, i) => (
              <MediaCardTile key={i} />
            ))}
          </div>
        </section>
      ))}
    </div>
  );
}
