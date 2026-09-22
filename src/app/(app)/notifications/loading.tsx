// Skeleton for Notifications: PageHeader, the right-aligned "mark all read /
// clear" link row (mb 10), then NotificationList rows — padding 14, gap 14, a
// 44×66 poster, title (14px) + body (12px) + mono timestamp lines, and the
// two 32×32 icon buttons pulled into the corner by the -6px margin (~96px
// per row, 8px apart).
import { Bar, SKELETON_CARD, SkeletonHeader } from "@/components/loading/poster-grid-skeleton";

export default function Loading() {
  return (
    <div className="animate-pulse">
      <SkeletonHeader subtitle />
      <div>
        <div className="flex items-center justify-end gap-3" style={{ marginBottom: 10, height: 18 }}>
          <Bar w={84} h={12} />
          <Bar w={52} h={12} />
        </div>
        <div className="flex flex-col" style={{ gap: 8 }}>
          {Array.from({ length: 8 }).map((_, i) => (
            <div key={i} className="flex items-start" style={{ ...SKELETON_CARD, gap: 14, padding: 14, borderRadius: 8 }}>
              <Bar w={44} h={66} r={4} />
              <div className="min-w-0 flex-1 flex flex-col">
                <div className="flex items-center" style={{ height: 21 }}>
                  <Bar w="45%" h={14} />
                </div>
                <div className="flex items-center" style={{ height: 17, marginTop: 2 }}>
                  <Bar w="80%" h={12} />
                </div>
                <div className="flex items-center" style={{ height: 16, marginTop: 3 }}>
                  <Bar w={64} h={10} />
                </div>
              </div>
              <div className="flex flex-col items-center shrink-0" style={{ gap: 2, margin: "-6px -6px 0 0" }}>
                {[0, 1].map((j) => (
                  <div key={j} className="flex items-center justify-center" style={{ width: 32, height: 32 }}>
                    <Bar w={15} h={15} />
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
