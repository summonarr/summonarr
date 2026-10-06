import { authActive } from "@/lib/auth";
import { redirect } from "next/navigation";
import { hasPermission, Permission } from "@/lib/permissions";
import { getPlayHistoryStats } from "@/lib/play-history";
import { PageHeader } from "@/components/ui/design";
import { ActivityFilterBar } from "@/components/admin/activity-filter-bar";
import { ActivityStatsRedesign } from "@/components/admin/activity-stats-redesign";
import { getTranslator } from "@/lib/i18n/server";
import { isFeatureEnabled } from "@/lib/features";
import Link from "next/link";

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

  const [stats, t, requestStatsOn] = await Promise.all([
    getPlayHistoryStats({ days, source, mediaType }),
    getTranslator(),
    isFeatureEnabled("feature.admin.stats"),
  ]);

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
      <ActivityStatsRedesign stats={stats} days={days} />
    </div>
  );
}
