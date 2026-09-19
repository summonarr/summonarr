// Skeleton for Notifications: PageHeader, the right-aligned "mark all read /
// clear" link row, then NotificationList rows — 40×60 poster, title + body
// lines, a timestamp and the two icon buttons (~82px each, 8px apart).
import { Bar, SKELETON_CARD, SkeletonHeader } from "@/components/loading/poster-grid-skeleton";

export default function Loading() {
  return (
    <div className="animate-pulse">
      <SkeletonHeader />
      <div style={{ marginTop: 16 }}>
        <div className="flex items-center justify-end gap-3" style={{ marginBottom: 10 }}>
          <Bar w={84} h={12} />
          <Bar w={52} h={12} />
        </div>
        <div className="flex flex-col" style={{ gap: 8 }}>
          {Array.from({ length: 8 }).map((_, i) => (
            <div key={i} className="flex gap-3 items-start" style={{ ...SKELETON_CARD, padding: "10px 12px", borderRadius: 8 }}>
              <Bar w={40} h={60} r={4} />
              <div className="min-w-0 flex-1 flex flex-col" style={{ gap: 6 }}>
                <Bar w="45%" h={13} />
                <Bar w="80%" h={12} />
                <Bar w={64} h={10} />
              </div>
              <div className="flex flex-col items-center gap-1.5 shrink-0">
                <Bar w={15} h={15} />
                <Bar w={15} h={15} />
              </div>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
