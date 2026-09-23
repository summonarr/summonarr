// Skeleton for admin Activity → Server Users. Shape mirrors users/page.tsx:
// PageHeader with subtitle, ActivityFilterBar's tab strip only (no period /
// source / type segments on this route), the max-w-xs (320px) search input
// (py-1.5 text-sm ≈ 34px, mb-4), then the table Card (py-4, radius 12) — a
// 40px text-xs header row and 52px rows (py-3 around the 28px avatar).
import { Bar, SKELETON_CARD, SkeletonHeader } from "@/components/loading/poster-grid-skeleton";
import { ActivityTabsSkeleton } from "@/components/loading/activity-section-skeleton";

export default function Loading() {
  return (
    <div className="animate-pulse">
      <SkeletonHeader subtitle />
      <ActivityTabsSkeleton />
      <div className="mb-4">
        <Bar w="100%" h={34} r={8} style={{ ...SKELETON_CARD, maxWidth: 320 }} />
      </div>
      <div className="overflow-hidden rounded-xl py-4" style={SKELETON_CARD}>
        <div
          className="flex items-center gap-6 px-4"
          style={{ height: 41, borderBottom: "1px solid var(--ds-border)" }}
        >
          {[48, 52, 40, 72, 72].map((w, i) => (
            <Bar key={i} w={w} h={10} />
          ))}
        </div>
        {Array.from({ length: 8 }).map((_, i) => (
          <div
            key={i}
            className="flex items-center gap-6 px-4"
            style={{ height: 53, borderBottom: "1px solid var(--ds-border)" }}
          >
            <div className="flex items-center gap-2.5" style={{ width: 150 }}>
              <Bar w={28} h={28} r={999} />
              <Bar w={90} h={12} />
            </div>
            <Bar w={44} h={16} />
            <Bar w={36} h={12} />
            <Bar w={40} h={12} />
            <Bar w={64} h={10} />
          </div>
        ))}
      </div>
    </div>
  );
}
