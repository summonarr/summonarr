// Shared pieces for the tabbed admin Activity skeletons (overview, users,
// recent, stats). Each route renders PageHeader → ActivityFilterBar → content,
// and ActivityFilterBar is one `mb-6 space-y-3` block: the sub-page tab strip
// (32px tabs, pb-3 + a hairline) always, then the Period / Source / Type
// segment row (a text-xs label beside a 34px bordered group) ONLY on the
// overview and stats routes (`showFilters` in activity-filter-bar.tsx).
// KpiStripSkeleton mirrors KpiStrip in activity-sections.tsx — one bordered
// `resp-kpi` strip (radius 10, mb 22) whose cells are padding 14 around a
// 14px label line box, gap 6, the 22px value's 33px line box, gap 6 and the
// 22px sparkline (~109px). The strip keeps `resp-kpi`, so it reflows to 3 and
// then 2 columns at the same 1180 / 899 breakpoints as the real one.
import { Bar, SKELETON_CARD } from "@/components/loading/poster-grid-skeleton";

// Tab labels: Overview / History / Users / Stats / Recently Added at text-sm
// with px-3.
const TAB_WIDTHS = [84, 70, 58, 56, 124];
// [label, group] widths for the Period (4 presets + Custom) / Source / Type
// segment groups.
const FILTER_GROUPS: [number, number][] = [
  [36, 196],
  [40, 132],
  [28, 140],
];

export function ActivityTabsSkeleton({ filters = false }: { filters?: boolean }) {
  return (
    <div className="mb-6 space-y-3">
      <div
        className="flex items-center gap-1 pb-3 overflow-hidden"
        style={{ borderBottom: "1px solid var(--ds-border)" }}
      >
        {TAB_WIDTHS.map((w, i) => (
          <Bar key={i} w={w} h={32} r={6} />
        ))}
      </div>
      {filters && (
        <div className="flex flex-wrap items-center gap-4">
          {FILTER_GROUPS.map(([label, group], i) => (
            <div key={i} className="flex items-center gap-1">
              <Bar w={label} h={10} style={{ marginRight: 4 }} />
              <Bar w={group} h={34} r={8} style={SKELETON_CARD} />
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

export function KpiStripSkeleton({ count = 6 }: { count?: number }) {
  return (
    <div style={{ marginBottom: 22 }}>
      <div
        className="resp-kpi"
        style={{
          ...SKELETON_CARD,
          display: "grid",
          gridTemplateColumns: `repeat(${count}, minmax(0, 1fr))`,
          borderRadius: 10,
          overflow: "hidden",
        }}
      >
        {Array.from({ length: count }).map((_, i) => (
          <div
            key={i}
            className="flex flex-col min-w-0"
            style={{
              padding: 14,
              gap: 6,
              borderRight: i < count - 1 ? "1px solid var(--ds-border)" : "none",
            }}
          >
            <div className="flex items-center" style={{ height: 14 }}>
              <Bar w={64} h={9} />
            </div>
            <div className="flex items-center" style={{ height: 33 }}>
              <Bar w={72} h={22} />
            </div>
            <Bar w="80%" h={22} />
          </div>
        ))}
      </div>
    </div>
  );
}

// ActivityCard stand-in (radius 10, hairline) with a SectionHeader line.
export function ActivityCardSkeleton({ h }: { h: number }) {
  return (
    <div style={{ ...SKELETON_CARD, borderRadius: 10, padding: 18, height: h }}>
      <div className="flex items-center" style={{ height: 20, marginBottom: 12 }}>
        <Bar w={140} h={12} />
      </div>
      <Bar w="100%" h={Math.max(0, h - 20 - 12 - 36 - 2)} r={6} />
    </div>
  );
}
