import { authActive } from "@/lib/auth";
import { redirect } from "next/navigation";
import { hasPermission, Permission } from "@/lib/permissions";
import { PageHeader } from "@/components/ui/design";
import { ActivityFilterBar } from "@/components/admin/activity-filter-bar";
import { ActivityHistoryTable } from "@/components/admin/activity-history-table";
import { ActivityLiveRefresher } from "@/components/admin/activity-live-refresher";
import { requireFeature } from "@/lib/features";
import { getTranslator } from "@/lib/i18n/server";
import { firstParam, parseActivityFilters, type PageParam } from "@/lib/activity-days";
import { getStatsTimeZone } from "@/lib/stats-time-zone-data";

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
  // A repeated key arrives as an array; the parsers below take its first value.
  searchParams: Promise<{
    days?: PageParam;
    source?: PageParam;
    mediaType?: PageParam;
    from?: PageParam;
    to?: PageParam;
    watched?: PageParam;
    // Older deep links may still carry `tab=history`; ignored here.
    tab?: PageParam;
  }>;
}) {
  await requireFeature("feature.admin.activity");
  const session = await authActive();
  if (!session || !hasPermission(session.user.permissions, Permission.ADMIN)) redirect("/");

  const t = await getTranslator();

  const sp = await searchParams;
  const { days, source, mediaType } = parseActivityFilters(sp);
  const fromParam = firstParam(sp.from);
  const toParam = firstParam(sp.to);
  const watchedParam = firstParam(sp.watched);
  // Date deep-link from a calendar-cell "View these plays" link. Seeds the
  // history table's date filter. Validated to YYYY-MM-DD; anything else ignored.
  const isYmd = (v?: string) => !!v && /^\d{4}-\d{2}-\d{2}$/.test(v);
  const fromDate = isYmd(fromParam) ? fromParam : undefined;
  const toDate = isYmd(toParam) ? toParam : undefined;
  const initialWatched = watchedParam === "true" || watchedParam === "false" ? watchedParam : undefined;

  // eslint-disable-next-line react-hooks/purity -- server component; Date.now() runs once per request
  const periodCutoff = new Date(Date.now() - days * 24 * 60 * 60 * 1000);
  // The date filter's days are whole days in the statistics zone (the API reads
  // them there); the table names the zone beside the pickers.
  const timeZone = await getStatsTimeZone();

  return (
    <div className="ds-page-enter">
      <ActivityLiveRefresher />
      <PageHeader
        title={t("adminActivity.title")}
        subtitle={t("adminActivity.subtitle")}
      />
      <ActivityFilterBar />
      {/* Keyed on the period filters only. The table writes its own
          from/to/watched into the URL, so a live refresh re-renders this page
          with them; keyed on those too, every finished stream after a date
          edit would remount the table and drop its page, search and user
          filter. They only seed the table's state on a (re)mount. */}
      <ActivityHistoryTable
        key={`ht-${days}-${source ?? ""}-${mediaType ?? ""}`}
        source={source}
        mediaType={mediaType}
        days={days}
        startDateIso={periodCutoff.toISOString()}
        timeZone={timeZone}
        initialFromDate={fromDate}
        initialToDate={toDate}
        initialWatched={initialWatched}
      />
    </div>
  );
}
