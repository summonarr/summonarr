import { authActive } from "@/lib/auth";
import { redirect } from "next/navigation";
import { hasPermission, Permission } from "@/lib/permissions";
import { PageHeader } from "@/components/ui/design";
import { ActivityFilterBar } from "@/components/admin/activity-filter-bar";
import { ActivityHistoryTable } from "@/components/admin/activity-history-table";
import { ActivityLiveRefresher } from "@/components/admin/activity-live-refresher";
import { requireFeature } from "@/lib/features";
import { getTranslator } from "@/lib/i18n/server";

export const dynamic = "force-dynamic";

// The History tab of Admin → Activity. It is its own route segment rather than
// a `?tab=history` branch of the overview so Next shows the table-shaped
// loading.tsx beside it while the dynamic render runs — the overview's
// loading.tsx draws the KPI strip and chart cards, the wrong shape here. The
// gate, the search-param parsing and the props handed to ActivityHistoryTable
// are exactly what the overview branch had; `/admin/activity?tab=history`
// redirects here with its filters, so older deep links keep working.
export default async function ActivityHistoryPage({
  searchParams,
}: {
  searchParams: Promise<{
    days?: string;
    source?: string;
    mediaType?: string;
    from?: string;
    to?: string;
    watched?: string;
    // Older deep links may still carry `tab=history`; ignored here.
    tab?: string;
  }>;
}) {
  await requireFeature("feature.admin.activity");
  const session = await authActive();
  if (!session || !hasPermission(session.user.permissions, Permission.ADMIN)) redirect("/");

  const t = await getTranslator();

  const { days: daysParam, source: sourceParam, mediaType: mediaTypeParam, from: fromParam, to: toParam, watched: watchedParam } = await searchParams;
  const days = Math.min(Math.max(parseInt(daysParam ?? "30", 10) || 30, 1), 3650);
  const source = sourceParam && ["plex", "jellyfin"].includes(sourceParam) ? sourceParam : undefined;
  const mediaType = mediaTypeParam && ["MOVIE", "TV"].includes(mediaTypeParam) ? mediaTypeParam : undefined;
  // Date deep-link from a calendar-cell "View these plays" link. Seeds the
  // history table's date filter. Validated to YYYY-MM-DD; anything else ignored.
  const isYmd = (v?: string) => !!v && /^\d{4}-\d{2}-\d{2}$/.test(v);
  const fromDate = isYmd(fromParam) ? fromParam : undefined;
  const toDate = isYmd(toParam) ? toParam : undefined;
  const initialWatched = watchedParam === "true" || watchedParam === "false" ? watchedParam : undefined;

  // eslint-disable-next-line react-hooks/purity -- server component; Date.now() runs once per request
  const periodCutoff = new Date(Date.now() - days * 24 * 60 * 60 * 1000);

  return (
    <div className="ds-page-enter">
      <ActivityLiveRefresher />
      <PageHeader
        title={t("adminActivity.title")}
        subtitle={t("adminActivity.subtitle")}
      />
      <ActivityFilterBar />
      <ActivityHistoryTable
        key={`ht-${days}-${source ?? ""}-${mediaType ?? ""}-${fromDate ?? ""}-${toDate ?? ""}-${initialWatched ?? ""}`}
        source={source}
        mediaType={mediaType}
        days={days}
        startDateIso={periodCutoff.toISOString()}
        initialFromDate={fromDate}
        initialToDate={toDate}
        initialWatched={initialWatched}
      />
    </div>
  );
}
