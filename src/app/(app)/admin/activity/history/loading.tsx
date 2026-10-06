// Skeleton for admin Activity → History. Shape mirrors history/page.tsx:
// PageHeader with subtitle (no action button), ActivityFilterBar WITH the
// period / source / type segment row (`showFilters` is on for this route),
// then ActivityHistoryTable's single card — the search + dates + export
// toolbar, a hairline, and the 920px-min table rows. Table-shaped on purpose:
// this tab used to be a `?tab=history` branch of the overview and flashed the
// KPI strip + chart cards before swapping to a table.
import { SkeletonHeader } from "@/components/loading/poster-grid-skeleton";
import {
  ActivityTableCardSkeleton,
  ActivityTabsSkeleton,
} from "@/components/loading/activity-section-skeleton";

export default function Loading() {
  return (
    <div className="animate-pulse">
      <SkeletonHeader subtitle />
      <ActivityTabsSkeleton filters />
      <ActivityTableCardSkeleton rows={12} toolbar />
    </div>
  );
}
