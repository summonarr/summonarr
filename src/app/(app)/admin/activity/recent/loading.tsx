// Skeleton for admin Activity → Recently Added. Shape mirrors recent/page.tsx:
// PageHeader with subtitle, ActivityFilterBar's tab strip only (no segments on
// this route), then the 2 / sm:3 / md:4 / lg:5 / xl:6-column gap-4 grid of
// bare poster tiles — a rounded-lg 2:3 poster (mb-2), a text-xs title line
// (16px) and a text-[10px] year · added line (15px). Not the MediaCard grid:
// these tiles have no card chrome.
import { Bar, SKELETON_FILL, SkeletonHeader } from "@/components/loading/poster-grid-skeleton";
import { ActivityTabsSkeleton } from "@/components/loading/activity-section-skeleton";

export default function Loading() {
  return (
    <div className="animate-pulse">
      <SkeletonHeader subtitle />
      <ActivityTabsSkeleton />
      <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 xl:grid-cols-6 gap-4">
        {Array.from({ length: 18 }).map((_, i) => (
          <div key={i}>
            <div className="aspect-[2/3] w-full rounded-lg mb-2" style={{ background: SKELETON_FILL }} />
            <div className="flex items-center" style={{ height: 16 }}>
              <Bar w="75%" h={11} />
            </div>
            <div className="flex items-center" style={{ height: 15 }}>
              <Bar w="50%" h={9} />
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
