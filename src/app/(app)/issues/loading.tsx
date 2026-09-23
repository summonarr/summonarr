// Skeleton for the Issues list while Prisma loads thread metadata + counts.
// Shape: PageHeader with a two-line subtitle (the long "to report a new
// issue…" hint wraps), the status FilterPills row with the type pills (six
// options, ~450px) + SearchBox on the right (mb-5), then the xl two-pane
// layout — rows with a 44px poster thumb inside 14px padding (~96px each) on
// the left and the sticky 480px detail pane on the right (xl only, like the
// page).
import { Bar, ControlRow, SKELETON_CARD, SkeletonHeader } from "@/components/loading/poster-grid-skeleton";

export default function Loading() {
  return (
    <div className="animate-pulse">
      <SkeletonHeader subtitle subtitleLines={2} />
      <div className="flex flex-col gap-3 mb-5 sm:flex-row sm:items-center sm:justify-between">
        <ControlRow w={340} />
        <div className="flex items-center gap-3">
          <ControlRow w={450} />
          <Bar w={192} h={32} r={6} style={{ ...SKELETON_CARD, maxWidth: "100%" }} />
        </div>
      </div>
      <div className="xl:grid xl:grid-cols-[1fr_480px] xl:gap-6 xl:items-start">
        <div className="flex flex-col min-w-0" style={{ gap: 8 }}>
          {Array.from({ length: 6 }).map((_, i) => (
            <div key={i} className="flex items-start" style={{ ...SKELETON_CARD, gap: 14, padding: 14, borderRadius: 8 }}>
              <Bar w={44} h={66} r={4} />
              <div className="flex-1 min-w-0 flex flex-col" style={{ gap: 6 }}>
                <Bar w="45%" h={14} />
                <Bar w="65%" h={12} />
                <div className="flex" style={{ gap: 6, marginTop: 4 }}>
                  <Bar w={64} h={18} r={999} />
                  <Bar w={80} h={18} r={999} />
                </div>
              </div>
            </div>
          ))}
        </div>
        <aside className="hidden xl:block sticky top-6 h-[calc(100vh-3rem)]">
          <div className="h-full" style={{ ...SKELETON_CARD, borderRadius: 8, padding: 18 }}>
            <div className="flex items-start" style={{ gap: 14 }}>
              <Bar w={56} h={84} r={4} />
              <div className="flex-1 flex flex-col" style={{ gap: 8 }}>
                <Bar w="60%" h={16} />
                <Bar w="40%" h={12} />
              </div>
            </div>
          </div>
        </aside>
      </div>
    </div>
  );
}
