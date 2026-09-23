// Skeleton for Profile: PageHeader with subtitle, then the two-column card
// layout (lg:grid-cols-2, stacked below lg) — the account card with its 44px
// avatar plus Discord / password / sessions cards on the left, notification
// preferences + push devices on the right. Cards are ProfileCard's
// padding-20 radius-10 box.
import { Bar, SKELETON_CARD, SkeletonHeader } from "@/components/loading/poster-grid-skeleton";

function Card({ title = true, lines = 2, button = false }: { title?: boolean; lines?: number; button?: boolean }) {
  return (
    <div style={{ ...SKELETON_CARD, borderRadius: 10, padding: 20 }}>
      {title && <Bar w={140} h={15} style={{ marginBottom: 16 }} />}
      <div className="flex flex-col" style={{ gap: 10 }}>
        {Array.from({ length: lines }).map((_, i) => (
          <Bar key={i} w={i % 2 ? "55%" : "80%"} h={12} />
        ))}
      </div>
      {button && <Bar w={120} h={32} r={8} style={{ marginTop: 14 }} />}
    </div>
  );
}

export default function Loading() {
  return (
    <div className="animate-pulse">
      <SkeletonHeader subtitle />
      <div className="max-w-2xl lg:max-w-6xl lg:grid lg:grid-cols-2 lg:gap-6">
        <div className="flex flex-col" style={{ gap: 20 }}>
          <div className="flex items-center" style={{ ...SKELETON_CARD, borderRadius: 10, padding: 20, gap: 14 }}>
            <Bar w={44} h={44} r={999} />
            <div className="flex flex-col" style={{ gap: 6 }}>
              <Bar w={120} h={14} />
              <Bar w={180} h={12} />
            </div>
          </div>
          <Card lines={2} button />
          <Card lines={3} button />
          <Card lines={2} />
        </div>
        <div className="flex flex-col lg:mt-0" style={{ gap: 20, marginTop: 20 }}>
          <Card lines={5} />
          <Card lines={2} />
        </div>
      </div>
    </div>
  );
}
