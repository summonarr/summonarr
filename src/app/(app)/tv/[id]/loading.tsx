// Loading skeleton for the TV detail page — the route fetches TMDB details +
// credits + suggestions + season/availability lookups before render. Same
// shell as the page: ds-detail-bleed, the aspect-video backdrop, the 160px
// poster + title block in ds-detail-body, then the cast grid and the season
// rows (44px poster thumb, 12px padding → ~90px each).
import { Bar, CastSectionSkeleton, DetailHeroSkeleton, SKELETON_CARD } from "@/components/loading/poster-grid-skeleton";

export default function Loading() {
  return (
    <div className="ds-detail-bleed animate-pulse">
      <DetailHeroSkeleton />
      <CastSectionSkeleton />
      <section style={{ padding: "0 16px 32px" }}>
        <Bar w={80} h={18} style={{ marginBottom: 12 }} />
        <div className="flex flex-col" style={{ gap: 8 }}>
          {Array.from({ length: 4 }).map((_, i) => (
            <div key={i} className="flex items-center" style={{ ...SKELETON_CARD, gap: 14, padding: 12, borderRadius: 8 }}>
              <Bar w={44} h={66} r={4} />
              <div className="flex-1 flex flex-col" style={{ gap: 6 }}>
                <Bar w={140} h={13} />
                <Bar w={220} h={10} style={{ maxWidth: "100%" }} />
              </div>
              <Bar w={18} h={18} />
            </div>
          ))}
        </div>
      </section>
    </div>
  );
}
