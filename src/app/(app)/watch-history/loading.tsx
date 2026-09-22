// Skeleton for Watch History: PageHeader with subtitle, then WatchHistoryList's
// FilterBar — the ~36px All/Movies/TV segmented control on the LEFT, a flex
// spacer, and the mono stats line + the 170×32 search box on the right (gap 8,
// mb 16) — then rows: padding 14, gap 14, a 44×66 poster, title + source/meta
// lines and the right-aligned when / duration / progress column (~96px per
// row, 8px apart).
import { Bar, SKELETON_CARD, SkeletonHeader } from "@/components/loading/poster-grid-skeleton";

export default function Loading() {
  return (
    <div className="animate-pulse">
      <SkeletonHeader subtitle />
      <div>
        <div className="flex items-center flex-wrap" style={{ gap: 8, marginBottom: 16 }}>
          <Bar w={160} h={36} r={8} style={{ ...SKELETON_CARD, maxWidth: "100%" }} />
          <div className="flex-1" />
          <div className="flex items-center flex-wrap" style={{ gap: 10 }}>
            <Bar w={150} h={11} />
            <Bar w={170} h={32} r={6} style={SKELETON_CARD} />
          </div>
        </div>
        <div className="flex flex-col" style={{ gap: 8 }}>
          {Array.from({ length: 8 }).map((_, i) => (
            <div key={i} className="flex items-center" style={{ ...SKELETON_CARD, gap: 14, padding: 14, borderRadius: 8 }}>
              <Bar w={44} h={66} r={4} />
              <div className="min-w-0 flex-1 flex flex-col">
                <div className="flex items-center" style={{ height: 20 }}>
                  <Bar w="40%" h={13} />
                </div>
                <div className="flex items-center" style={{ height: 16, marginTop: 3 }}>
                  <Bar w="28%" h={10} />
                </div>
              </div>
              <div className="flex flex-col items-end shrink-0" style={{ gap: 3 }}>
                {[56, 40, 48].map((w, j) => (
                  <div key={j} className="flex items-center" style={{ height: 16 }}>
                    <Bar w={w} h={10} />
                  </div>
                ))}
              </div>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
