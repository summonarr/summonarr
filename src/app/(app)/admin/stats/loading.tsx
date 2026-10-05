// Skeleton for admin → Statistics. Mirrors page.tsx: header with the playback
// link, the period FilterBar, the six KPI StatCards, then section cards
// (attention, requests, fulfillment, month chart). The storage and grade
// sections stream in behind their own Suspense fallbacks, so they're not here.
import { Bar, ControlRow, SkeletonHeader } from "@/components/loading/poster-grid-skeleton";

const CARD = {
  background: "var(--ds-bg-2)",
  border: "1px solid var(--ds-border)",
  borderRadius: 8,
} as const;

export default function Loading() {
  return (
    <div className="animate-pulse">
      <SkeletonHeader subtitle right />
      <div className="mb-4">
        <ControlRow w={300} />
      </div>
      <div className="grid grid-cols-2 sm:grid-cols-3 xl:grid-cols-6" style={{ gap: 10, marginBottom: 20 }}>
        {Array.from({ length: 6 }).map((_, i) => (
          <div key={i} style={{ ...CARD, padding: "14px 16px", height: 98 }}>
            <Bar w={90} h={10} />
            <div style={{ marginTop: 10 }}><Bar w={70} h={24} /></div>
          </div>
        ))}
      </div>
      {[260, 220, 180, 210].map((h, i) => (
        <div key={i} style={{ ...CARD, padding: 20, height: h, marginBottom: 20 }}>
          <Bar w={160} h={14} />
        </div>
      ))}
    </div>
  );
}
