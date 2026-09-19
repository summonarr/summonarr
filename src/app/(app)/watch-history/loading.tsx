// Skeleton for Watch History: PageHeader with subtitle, the stats line with the
// All/Movies/TV segmented control + search box on the right, then
// WatchHistoryList rows — 40×60 poster, title + meta lines, and the
// right-aligned when/duration column (~82px each, 8px apart).
import { Bar, SKELETON_CARD, SkeletonHeader } from "@/components/loading/poster-grid-skeleton";

export default function Loading() {
  return (
    <div className="animate-pulse">
      <SkeletonHeader subtitle />
      <div style={{ marginTop: 16 }}>
        <div className="flex flex-wrap items-center justify-between" style={{ gap: 10, marginBottom: 12 }}>
          <Bar w={170} h={11} />
          <div className="flex items-center" style={{ gap: 8 }}>
            <Bar w={150} h={28} r={7} style={SKELETON_CARD} />
            <Bar w={170} h={28} r={7} style={SKELETON_CARD} />
          </div>
        </div>
        <div className="flex flex-col" style={{ gap: 8 }}>
          {Array.from({ length: 8 }).map((_, i) => (
            <div key={i} className="flex gap-3 items-center" style={{ ...SKELETON_CARD, padding: "10px 12px", borderRadius: 8 }}>
              <Bar w={40} h={60} r={4} />
              <div className="min-w-0 flex-1 flex flex-col" style={{ gap: 6 }}>
                <Bar w="40%" h={13} />
                <Bar w="28%" h={10} />
              </div>
              <div className="flex flex-col items-end shrink-0" style={{ gap: 4 }}>
                <Bar w={64} h={10} />
                <Bar w={40} h={10} />
              </div>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
