// Skeleton for admin Activity → Statistics. Shape mirrors stats/page.tsx +
// ActivityStatsRedesign: PageHeader with subtitle, ActivityFilterBar WITH the
// period / source / type segments (stats is the other route that shows them),
// the 6-cell resp-kpi strip, the 2×2 resp-grid-2 trend cards (SectionHeader +
// a 120px AreaChart + axis line, ~204px), then the resp-grid-3 leaderboard
// row. No Now Playing section — that is overview-only.
import { SkeletonHeader } from "@/components/loading/poster-grid-skeleton";
import {
  ActivityCardSkeleton,
  ActivityTabsSkeleton,
  KpiStripSkeleton,
} from "@/components/loading/activity-section-skeleton";

export default function Loading() {
  return (
    <div className="animate-pulse">
      <SkeletonHeader subtitle />
      <ActivityTabsSkeleton filters />
      <KpiStripSkeleton />
      <div
        className="resp-grid-2"
        style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10, marginBottom: 22 }}
      >
        {Array.from({ length: 4 }).map((_, i) => (
          <ActivityCardSkeleton key={i} h={204} />
        ))}
      </div>
      <div
        className="resp-grid-3"
        style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 10, marginBottom: 22 }}
      >
        {Array.from({ length: 3 }).map((_, i) => (
          <ActivityCardSkeleton key={i} h={320} />
        ))}
      </div>
    </div>
  );
}
