// Generic shimmer skeleton for admin pages (tables, dashboards, stats). Neutral
// enough to sit under the whole admin subtree via a single loading.tsx, so slow
// admin routes (library diff, audit log, stats, users, backup) show feedback
// instead of blocking on the server render. Every admin page opens with the
// shared PageHeader + subtitle, so the header is the kit's SkeletonHeader (33px
// title line box, 18px subtitle line box, mb-5); the body is neutral 44px rows.
import { Bar, SKELETON_CARD, SkeletonHeader } from "@/components/loading/poster-grid-skeleton";

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

// ── Queue / issues pieces ────────────────────────────────────────────────────
// The two most-visited admin pages compose their own skeletons from these so
// the streamed page lands on the same footprint (stat row, pill filter bar,
// ~110px request cards; tab strip + two-pane issue grid) instead of jumping
// from the generic 44px rows. Fills are --ds-bg-3 / SKELETON_CARD for the same
// light-mode reason the kit documents.

// `.ds-stat-row` of StatCards without a hint: padding 14/16, the 10.5px label's
// ~14px line box, mb 6, the 26px value's ~36px line box → 84px. Same mb-24 as
// the queue page.
export function AdminStatRowSkeleton({ count = 4 }: { count?: number }) {
  return (
    <div className="ds-stat-row" style={{ marginBottom: 24 }}>
      {Array.from({ length: count }).map((_, i) => (
        <div key={i} style={{ ...SKELETON_CARD, borderRadius: 8, padding: "14px 16px", height: 84 }}>
          <div className="flex items-center" style={{ height: 14 }}>
            <Bar w={64} h={9} />
          </div>
          <div className="flex items-center" style={{ height: 36, marginTop: 6 }}>
            <Bar w={56} h={22} />
          </div>
        </div>
      ))}
    </div>
  );
}

// One bordered pill group as the filter bars render it: padding 2 around
// 26px pills (5px 12px text-xs) → 30px tall, radius 8. `widths` are the pills.
export function AdminPillGroupSkeleton({ widths }: { widths: number[] }) {
  return (
    <div className="flex gap-1 max-w-full" style={{ ...SKELETON_CARD, padding: 2, borderRadius: 8 }}>
      {widths.map((w, i) => (
        <Bar key={i} w={w} h={26} r={6} />
      ))}
    </div>
  );
}

// AdminFilterBar: the five status pills left; the three type pills and the
// 32px compact sort select right; `mb-4`, wrapping like the real bar.
export function AdminQueueFilterBarSkeleton() {
  return (
    <div className="flex flex-wrap items-center justify-between gap-3 mb-4">
      <AdminPillGroupSkeleton widths={[52, 84, 92, 88, 94]} />
      <div className="flex flex-wrap items-center gap-3">
        <AdminPillGroupSkeleton widths={[44, 66, 48]} />
        <Bar w={120} h={32} r={8} style={SKELETON_CARD} />
      </div>
    </div>
  );
}

// Card-height rows: the request list's ~110px cards at gap 8 (60px poster +
// requester lines), the issue cards' ~88px (p-4 around a 56px poster) at gap 12.
export function AdminCardRowsSkeleton({
  rows,
  height,
  gap = 8,
}: {
  rows: number;
  height: number;
  gap?: number;
}) {
  return (
    <div className="flex flex-col" style={{ gap }}>
      {Array.from({ length: rows }).map((_, i) => (
        <Bar key={i} w="100%" h={height} r={8} style={SKELETON_CARD} />
      ))}
    </div>
  );
}

// The admin request QUEUE (/admin): PageHeader with the Sync button → the
// 4-card stat row → AdminFilterBar → five request cards.
export function AdminQueueSkeleton() {
  return (
    <div className="animate-pulse">
      <SkeletonHeader subtitle right />
      <AdminStatRowSkeleton />
      <AdminQueueFilterBarSkeleton />
      <AdminCardRowsSkeleton rows={5} height={110} />
    </div>
  );
}
