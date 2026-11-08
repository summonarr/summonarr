import { Suspense } from "react";
import { RatingsWarmButton, ActivityWarmButton, AuditRetentionForm } from "@/components/settings/settings-ui";
import { ResyncLibraryButton } from "@/components/admin/resync-library-button";
import { SyncTVEpisodesButton } from "@/components/admin/sync-tv-episodes-button";
import { MasterDbFillButton } from "@/components/admin/master-db-fill-button";
import { CronJobTable } from "@/components/settings/cron-job-table";
import { readDbCounts } from "@/lib/settings-db-counts";
import { countUniqueLibraryItems } from "@/lib/library-iterator";
import { configuredLibrarySyncServers } from "@/lib/library-sync-jobs";
import type { Locale } from "@/lib/i18n/locales";
import type { Translator } from "@/lib/i18n/translate";
import type { SettingsOf } from "./settings-data";
import { buildCronJobs } from "./cron-jobs";
import { countCurrentShares } from "./current-shares";
import { loadCronRuns } from "./system-tab-data";
import { MetricGrid, MetricHeading, SettingsCard } from "./ui";

export const SYSTEM_TAB_KEYS = ["auditPiiRetentionDays"] as const;

// The "Current shares" tile's value: awaited behind its own <Suspense>, because
// the live Plex/Jellyfin calls behind it can take up to ~30s against an
// unreachable plex.tv and must not hold the rest of the System tab.
async function CurrentSharesValue({ count, locale }: { count: Promise<number | null>; locale: Locale }) {
  const n = await count;
  return <>{n !== null ? n.toLocaleString(locale) : "—"}</>;
}

export async function SystemTab({ cfg, t, locale }: { cfg: SettingsOf<typeof SYSTEM_TAB_KEYS>; t: Translator; locale: Locale }) {
  // Started first so it overlaps the database reads, and awaited only inside
  // the tile's <Suspense>: live server calls must not hold the tab. An
  // unconfigured server is never asked (guardrail 36).
  const currentShares = countCurrentShares().catch(() => null);
  // Every connected Plex/Jellyfin server, default and named (guardrail 35), so
  // the sync buttons resync each one and skip a server that is not there
  // instead of POSTing to it and reading the resulting 400 as a failure
  // (guardrail 36).
  const [counts, uniqueLibraryItems, cronRuns, syncServers] = await Promise.all([
    readDbCounts(new Date()),
    countUniqueLibraryItems(),
    loadCronRuns(),
    configuredLibrarySyncServers(),
  ]);
  // Read the clock ONCE, here on the server, and pass the resulting counts to
  // the client component as plain numbers (guardrail 16) — the cron table is
  // a "use client" component, so a clock read on its side of the boundary
  // would be the hydration bug that guardrail exists to prevent.
  // eslint-disable-next-line react-hooks/purity -- server component; Date.now() runs once per request
  const oneHourAgoMs = Date.now() - 60 * 60 * 1000;
  const cronJobs = buildCronJobs(t, process.env, cronRuns.lastRuns, cronRuns.histories, oneHourAgoMs);

  const n = (value: number) => value.toLocaleString(locale);
  const libraryTotal = uniqueLibraryItems;
  const coveragePct = libraryTotal > 0 ? Math.min(100, Math.round((counts.tmdbCoreEntries / libraryTotal) * 100)) : 0;

  return (
    <>
      <SettingsCard
        id="scheduled-jobs"
        title={t("settings.section.scheduledJobs.title")}
        description={t("settings.section.scheduledJobs.description")}
      >
        <CronJobTable jobs={cronJobs} />
      </SettingsCard>

      <SettingsCard
        id="audit-log-settings"
        title={t("settings.section.auditLog.title")}
        description={t("settings.section.auditLog.description")}
      >
        <AuditRetentionForm initialDays={cfg.auditPiiRetentionDays ?? ""} />
      </SettingsCard>

      <SettingsCard
        id="db-metrics"
        title={t("settings.section.dbMetrics.title")}
        description={t("settings.section.dbMetrics.description")}
      >
        <div className="space-y-6">
          <div>
            <MetricHeading>{t("settings.metrics.requests.heading")}</MetricHeading>
            <MetricGrid
              items={[
                { label: t("settings.metrics.total"),     value: n(counts.totalRequests) },
                { label: t("settings.metrics.pending"),   value: n(counts.pendingRequests) },
                { label: t("settings.metrics.approved"),  value: n(counts.approvedRequests) },
                { label: t("settings.metrics.available"), value: n(counts.availableRequests) },
                { label: t("settings.metrics.declined"),  value: n(counts.declinedRequests) },
                { label: t("settings.metrics.movies"),    value: n(counts.movieRequests) },
                { label: t("settings.metrics.tvShows"),  value: n(counts.tvRequests) },
              ]}
            />
          </div>

          <div className="border-t border-zinc-800 pt-5">
            <MetricHeading>{t("settings.metrics.users.heading")}</MetricHeading>
            <MetricGrid
              items={[
                { label: t("settings.metrics.total"),          value: n(counts.totalUsers) },
                { label: t("settings.metrics.admins"),         value: n(counts.adminUsers) },
                { label: t("settings.metrics.issueAdmins"),   value: n(counts.issueAdminUsers) },
                { label: t("settings.metrics.discordLinked"), value: n(counts.discordLinkedUsers) },
              ]}
            />
          </div>

          <div className="border-t border-zinc-800 pt-5">
            <MetricHeading>{t("settings.metrics.issues.heading")}</MetricHeading>
            <MetricGrid
              items={[
                { label: t("settings.metrics.total"),       value: n(counts.totalIssues) },
                { label: t("settings.metrics.open"),        value: n(counts.openIssues) },
                { label: t("settings.metrics.inProgress"), value: n(counts.inProgressIssues) },
                { label: t("settings.metrics.resolved"),    value: n(counts.resolvedIssues) },
              ]}
            />
          </div>

          <div className="border-t border-zinc-800 pt-5">
            <div className="flex items-center justify-between mb-3">
              <MetricHeading spaced={false}>{t("settings.metrics.libraryCache.heading")}</MetricHeading>
              <div className="flex items-center gap-2 flex-wrap">
                <ResyncLibraryButton servers={syncServers} />
                <SyncTVEpisodesButton />
                <RatingsWarmButton />
                <ActivityWarmButton />
              </div>
            </div>
            <MetricGrid
              items={[
                { label: t("settings.metrics.plexItems"),           value: n(counts.plexItems) },
                { label: t("settings.metrics.jellyfinItems"),        value: n(counts.jellyfinItems) },
                { label: t("settings.metrics.tvEpisodes"),           value: n(counts.episodeCacheEntries) },
                { label: t("settings.metrics.plexTvCoverage"),      value: t("settings.metrics.coverageShows", { covered: n(counts.plexShowsWithEps), total: n(counts.plexTvShows) }) },
                { label: t("settings.metrics.jellyfinTvCoverage"),  value: t("settings.metrics.coverageShows", { covered: n(counts.jellyfinShowsWithEps), total: n(counts.jellyfinTvShows) }) },
                { label: t("settings.metrics.tmdbCache"),            value: n(counts.tmdbCacheEntries) },
                { label: t("settings.metrics.omdbCache"),            value: n(counts.omdbCacheEntries) },
                { label: t("settings.metrics.upcoming"),              value: n(counts.upcomingItems) },
                { label: t("settings.metrics.radarrWanted"),         value: n(counts.radarrWanted) },
                { label: t("settings.metrics.radarrAvailable"),      value: n(counts.radarrAvailable) },
                { label: t("settings.metrics.sonarrWanted"),         value: n(counts.sonarrWanted) },
                { label: t("settings.metrics.sonarrAvailable"),      value: n(counts.sonarrAvailable) },
                { label: t("settings.metrics.deletionVotes"),        value: n(counts.deletionVotes) },
              ]}
            />
          </div>

          <div className="border-t border-zinc-800 pt-5">
            <MetricHeading>{t("settings.metrics.tmdbCore.heading")}</MetricHeading>
            <p className="text-xs text-zinc-500 mb-3">
              {t("settings.metrics.tmdbCore.description")}
            </p>
            <MetricGrid
              className="mb-4"
              items={[
                { label: t("settings.metrics.totalEntries"),   value: n(counts.tmdbCoreEntries) },
                { label: t("settings.metrics.movies"),           value: n(counts.tmdbCoreMovies) },
                { label: t("settings.metrics.tvShows"),         value: n(counts.tmdbCoreTv) },
                { label: t("settings.metrics.libraryCoverage"), value: libraryTotal > 0 ? `~${coveragePct}%` : "—", dim: counts.tmdbCoreEntries === 0 },
              ]}
            />
            <MasterDbFillButton servers={syncServers} />
          </div>

          <div className="border-t border-zinc-800 pt-5">
            <MetricHeading>{t("settings.metrics.playHistory.heading")}</MetricHeading>
            <MetricGrid
              items={[
                { label: t("settings.metrics.recordedSessions"),  value: n(counts.playHistoryEntries) },
                { label: t("settings.metrics.mediaServerUsers"), value: n(counts.mediaServerUsers) },
                {
                  label: t("settings.metrics.currentShares"),
                  value: (
                    <Suspense fallback="…">
                      <CurrentSharesValue count={currentShares} locale={locale} />
                    </Suspense>
                  ),
                },
                { label: t("settings.metrics.discordSearchCache"), value: n(counts.discordCacheEntries) },
              ]}
            />
          </div>
        </div>
      </SettingsCard>
    </>
  );
}
