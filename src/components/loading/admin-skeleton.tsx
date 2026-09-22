// Generic shimmer skeleton for admin pages (tables, dashboards, stats). Neutral
// enough to sit under the whole admin subtree via a single loading.tsx, so slow
// admin routes (library diff, audit log, stats, users, backup) show feedback
// instead of blocking on the server render. Every admin page opens with the
// shared PageHeader + subtitle, so the header is the kit's SkeletonHeader (33px
// title line box, 18px subtitle line box, mb-5); the body is neutral 44px rows.
import { SKELETON_CARD, SkeletonHeader } from "@/components/loading/poster-grid-skeleton";

export function AdminSkeleton({ rows = 8 }: { rows?: number }) {
  return (
    <div className="animate-pulse">
      <SkeletonHeader subtitle />
      <div className="flex flex-col gap-2">
        {Array.from({ length: rows }).map((_, i) => (
          <div key={i} className="rounded" style={{ ...SKELETON_CARD, height: 44 }} />
        ))}
      </div>
    </div>
  );
}
