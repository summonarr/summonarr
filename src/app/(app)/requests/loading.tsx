// Skeleton for the Requests list while server-side Prisma queries warm up.
// Shape: PageHeader with subtitle, the status FilterPills row with the sort
// pills + 32px SearchBox on the right (mb-5), then rows — 44px poster thumb
// inside 14px padding (~94px each, 8px apart) with title, meta and chips.
import { Bar, ControlRow, SKELETON_CARD, SkeletonHeader } from "@/components/loading/poster-grid-skeleton";

export default function Loading() {
  return (
    <div className="animate-pulse">
      <SkeletonHeader subtitle />
      <div className="flex flex-col gap-3 mb-5 sm:flex-row sm:items-center sm:justify-between">
        <ControlRow w={340} />
        <div className="flex items-center gap-3">
          <ControlRow w={130} />
          <Bar w={192} h={32} r={6} style={{ ...SKELETON_CARD, maxWidth: "100%" }} />
        </div>
      </div>
      <div className="flex flex-col" style={{ gap: 8 }}>
        {Array.from({ length: 8 }).map((_, i) => (
          <div key={i} className="flex items-start" style={{ ...SKELETON_CARD, gap: 14, padding: 14, borderRadius: 8 }}>
            <Bar w={44} h={66} r={4} />
            <div className="flex-1 min-w-0 flex flex-col" style={{ gap: 6 }}>
              <Bar w="45%" h={14} />
              <Bar w="30%" h={10} />
              <Bar w={120} h={18} r={999} style={{ marginTop: 4 }} />
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
