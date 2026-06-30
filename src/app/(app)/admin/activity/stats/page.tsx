import { authActive } from "@/lib/auth";
import { redirect } from "next/navigation";
import { hasPermission, Permission } from "@/lib/permissions";
import { getPlayHistoryStats } from "@/lib/play-history";
import { PageHeader } from "@/components/ui/design";
import { ActivityFilterBar } from "@/components/admin/activity-filter-bar";
import { ActivityStatsRedesign } from "@/components/admin/activity-stats-redesign";

export const dynamic = "force-dynamic";

export default async function StatsPage({
  searchParams,
}: {
  searchParams: Promise<{ days?: string; source?: string; mediaType?: string }>;
}) {
  const session = await authActive();
  if (!session || !hasPermission(session.user.permissions, Permission.ADMIN)) redirect("/");

  const { days: daysParam, source: sourceParam, mediaType: mediaTypeParam } =
    await searchParams;
  const days = Math.min(Math.max(parseInt(daysParam ?? "30", 10) || 30, 1), 3650);
  const source =
    sourceParam && ["plex", "jellyfin"].includes(sourceParam)
      ? sourceParam
      : undefined;
  const mediaType =
    mediaTypeParam && ["MOVIE", "TV"].includes(mediaTypeParam)
      ? mediaTypeParam
      : undefined;

  const stats = await getPlayHistoryStats({ days, source, mediaType });

  return (
    <div className="ds-page-enter">
      <PageHeader
        title="Statistics"
        subtitle="Deeper playback analytics across Plex and Jellyfin."
      />
      <ActivityFilterBar />
      <ActivityStatsRedesign stats={stats} days={days} />
    </div>
  );
}
