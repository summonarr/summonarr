// Loading skeleton for the admin Audit Log. The route is force-dynamic, so
// every filter navigation (each debounced keystroke in the user/target boxes)
// re-renders through this fallback; the subtree-wide admin skeleton (header +
// eight bars) made the page jump from uniform bars to ~200px of controls plus
// a table on each one. Shape mirrors audit-log-table.tsx's first screen:
// PageHeader (subtitle) → the 32px group segmented control → the control row
// (hide-cron, view toggle, export, scrub at ~30px; the action pills only
// appear once a group is selected, so the default landing has none) → the
// filter row (two date inputs + two 30px text inputs) → the table card with a
// ~40px header and 44px rows.
import { Bar, ControlRow, SKELETON_CARD, SKELETON_FILL, SkeletonHeader } from "@/components/loading/poster-grid-skeleton";

const ROWS = 8;

export default function Loading() {
  return (
    <div className="animate-pulse">
      <SkeletonHeader subtitle />

      <div className="space-y-3 mb-4">
        <ControlRow w={300} />

        <div className="flex flex-wrap items-center justify-between gap-2">
          <div />
          <div className="flex flex-wrap items-center gap-2">
            <Bar w={104} h={30} r={6} />
            <Bar w={60} h={30} r={6} />
            <Bar w={80} h={30} r={6} />
            <Bar w={96} h={30} r={6} />
          </div>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          <Bar w={160} h={30} r={6} />
          <Bar w={160} h={30} r={6} />
          <Bar w={160} h={30} r={6} />
          <Bar w={160} h={30} r={6} />
        </div>
      </div>

      <div className="overflow-hidden rounded-xl" style={SKELETON_CARD}>
        <div className="flex items-center gap-6 px-4" style={{ height: 40, borderBottom: "1px solid var(--ds-border)" }}>
          {Array.from({ length: 4 }).map((_, i) => (
            <Bar key={i} w={56} h={10} />
          ))}
        </div>
        {Array.from({ length: ROWS }).map((_, i) => (
          <div
            key={i}
            className="flex items-center gap-6 px-4"
            style={{ height: 44, borderBottom: i === ROWS - 1 ? undefined : "1px solid var(--ds-border)" }}
          >
            <Bar w={64} h={10} />
            <Bar w={96} h={12} />
            <div style={{ width: 120, height: 20, borderRadius: 4, background: SKELETON_FILL, flexShrink: 0 }} />
            <Bar w={140} h={10} />
          </div>
        ))}
      </div>
    </div>
  );
}
