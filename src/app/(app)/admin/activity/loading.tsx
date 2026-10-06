// Loading skeleton for the admin Activity OVERVIEW — the route is
// force-dynamic with several play-history aggregation queries before render,
// so a fallback keeps navigation feeling immediate. users/, recent/ and stats/
// have their own loading.tsx (their bodies differ), and the detail routes use
// activity-detail-skeleton.tsx. Shape mirrors admin/activity/page.tsx:
// PageHeader (subtitle + the Warm-cache button) → ActivityFilterBar (tabs +
// period/source/type segments) → ActivityNowPlaying (SectionHeader, the
// ~78px "No active streams" card, mb 28) → the 6-cell resp-kpi strip →
// AnalyticsRow (`resp-analytics`, 1.5fr 1.2fr 1fr, gap 10, ~250px cards,
// stacking at ≤1180px) → the resp-grid-2 leaderboards → the CalendarSection
// card (~200px; TranscodePressure returns null when empty, so no stand-in) →
// the ONE recent-plays table card (header row + table), not loose rows. The
// History tab is its own segment (history/) with a table-shaped loading.tsx.
import { Bar, SKELETON_CARD, SkeletonHeader } from "@/components/loading/poster-grid-skeleton";
import {
  ActivityCardSkeleton,
  ActivityTableCardSkeleton,
  ActivityTabsSkeleton,
  KpiStripSkeleton,
} from "@/components/loading/activity-section-skeleton";

export default function Loading() {
  return (
    <div className="animate-pulse">
      <SkeletonHeader subtitle right />
      <ActivityTabsSkeleton filters />

      {/* ActivityNowPlaying: SectionHeader (~20px line, mb 12) + empty card */}
      <div style={{ marginBottom: 28 }}>
        <div className="flex items-center justify-between" style={{ height: 20, marginBottom: 12 }}>
          <Bar w={180} h={12} />
          <Bar w={48} h={10} />
        </div>
        <Bar w="100%" h={78} r={8} style={SKELETON_CARD} />
      </div>

      <KpiStripSkeleton />

      <div
        className="resp-analytics"
        style={{ display: "grid", gridTemplateColumns: "1.5fr 1.2fr 1fr", gap: 10, marginBottom: 22 }}
      >
        {Array.from({ length: 3 }).map((_, i) => (
          <ActivityCardSkeleton key={i} h={250} />
        ))}
      </div>

      <div
        className="resp-grid-2"
        style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10, marginBottom: 22 }}
      >
        <ActivityCardSkeleton h={300} />
        <ActivityCardSkeleton h={300} />
      </div>

      {/* CalendarSection: one ActivityCard holding the 365-day heatmap. */}
      <div style={{ marginBottom: 22 }}>
        <ActivityCardSkeleton h={200} />
      </div>

      {/* ActivityRecentPlays: ONE table card — header row, hairline, rows. */}
      <ActivityTableCardSkeleton rows={6} />
    </div>
  );
}
