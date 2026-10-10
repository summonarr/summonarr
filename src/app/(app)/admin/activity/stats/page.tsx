import { authActive } from "@/lib/auth";
import { redirect } from "next/navigation";
import { hasPermission, Permission } from "@/lib/permissions";
import { getPlayHistoryStats, isPlayHistoryEnabled } from "@/lib/play-history";
import { parseActivityDays } from "@/lib/activity-days";
import { EmptyState, PageHeader } from "@/components/ui/design";
import { Activity } from "@/components/icons";
import { ActivityFilterBar } from "@/components/admin/activity-filter-bar";
import { ActivityStatsRedesign, type ActivityStatsData } from "@/components/admin/activity-stats-redesign";
import { getTranslator } from "@/lib/i18n/server";
import { isFeatureEnabled, requireFeature } from "@/lib/features";
import Link from "next/link";

export const dynamic = "force-dynamic";

export default async function StatsPage({
  searchParams,
}: {
  searchParams: Promise<{ days?: string; source?: string; mediaType?: string }>;
}) {
  // Same gate as the overview and history tabs: switching the Activity page off
  // used to leave this tab reachable by URL.
  await requireFeature("feature.admin.activity");
  const session = await authActive();
  if (!session || !hasPermission(session.user.permissions, Permission.ADMIN)) redirect("/");

  const { days: daysParam, source: sourceParam, mediaType: mediaTypeParam } =
    await searchParams;
  const days = parseActivityDays(daysParam);
  const source =
    sourceParam && ["plex", "jellyfin"].includes(sourceParam)
      ? sourceParam
      : undefined;
  const mediaType =
    mediaTypeParam && ["MOVIE", "TV"].includes(mediaTypeParam)
      ? mediaTypeParam
      : undefined;

  const [t, requestStatsOn, phEnabled] = await Promise.all([
    getTranslator(),
    isFeatureEnabled("feature.admin.stats"),
    isPlayHistoryEnabled(),
  ]);
  // Tracking off: every figure below would read as an idle server with nothing
  // saying why — the same notice the Activity overview shows. Skips the
  // aggregate fan-out entirely.
  const stats = phEnabled ? await getPlayHistoryStats({ days, source, mediaType }) : null;

  return (
    <div className="ds-page-enter">
      <PageHeader
        title={t("adminActivity.stats.title")}
        subtitle={t("adminActivity.stats.subtitle")}
        right={
          requestStatsOn ? (
            <Link href="/admin/stats" className="text-sm hover:underline" style={{ color: "var(--ds-accent-text)" }}>
              {t("adminActivity.stats.requestStatsLink")}
            </Link>
          ) : undefined
        }
      />
      <ActivityFilterBar />
      {stats ? (
        <ActivityStatsRedesign stats={pickStatsForPage(stats)} days={days} />
      ) : (
        <EmptyState
          icon={Activity}
          title={t("adminActivity.trackingOff.title")}
          description={t("adminActivity.trackingOff.description")}
          cta={{ href: "/settings?tab=media#play-history", label: t("adminActivity.trackingOff.cta") }}
        />
      )}
    </div>
  );
}

// Only the fields the Statistics tab draws: the shared result also carries the
// overview's heatmap, completion buckets and leaderboards, which would otherwise
// be serialized into this page's client payload for nothing.
function pickStatsForPage(stats: Awaited<ReturnType<typeof getPlayHistoryStats>>): ActivityStatsData {
  return {
    totalPlays: stats.totalPlays,
    totalWatchTimeHours: stats.totalWatchTimeHours,
    uniqueViewers: stats.uniqueViewers,
    totalBandwidthGB: stats.totalBandwidthGB,
    rewatchPlays: stats.rewatchPlays,
    rewatchRate: stats.rewatchRate,
    peakConcurrent: stats.peakConcurrent,
    prevPeriod: stats.prevPeriod,
    playsByDay: stats.playsByDay,
    watchTimeByDay: stats.watchTimeByDay,
    bandwidthByDay: stats.bandwidthByDay,
    uniqueViewersByDay: stats.uniqueViewersByDay,
    // The query ranks each source separately (top ten apiece). Ten overall,
    // ranked as one list: the overall top ten always sits inside that union,
    // so sorting it and keeping ten is exact.
    topUsers: [...stats.topUsers].sort((a, b) => b.count - a.count).slice(0, 10),
    topWatched: stats.topWatched,
    transcodeRatio: stats.transcodeRatio,
    transcodeReasons: stats.transcodeReasons,
    sourceSplit: stats.sourceSplit,
    playsByDow: stats.playsByDow,
    playsByHour: stats.playsByHour,
    resolutionBreakdown: stats.resolutionBreakdown,
    videoCodecBreakdown: stats.videoCodecBreakdown,
    audioCodecBreakdown: stats.audioCodecBreakdown,
    containerBreakdown: stats.containerBreakdown,
    bitrateBuckets: stats.bitrateBuckets,
    topPlayers: stats.topPlayers,
    playsByPlatform: stats.playsByPlatform,
    topDevices: stats.topDevices,
    decadeBreakdown: stats.decadeBreakdown,
  };
}
