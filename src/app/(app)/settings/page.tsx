import { authActive } from "@/lib/auth";
import { prisma, getSettingDecryptFailures } from "@/lib/prisma";
import { Prisma } from "@/generated/prisma";
import { parseCronLastRun, parseCronRunHistory, countCronRunsSince, CRON_RUN_HISTORY_LIMIT } from "@/lib/cron-auth";
import { redirect } from "next/navigation";
import { hasPermission, Permission } from "@/lib/permissions";
import { getPlexAccounts } from "@/lib/plex";
import { getJellyfinUserCount } from "@/lib/jellyfin";
import { countUniqueLibraryItems } from "@/lib/library-iterator";
import { PageHeader } from "@/components/ui/design";
import { ArrForm, WebhookSecretForm, WebhookUrls, PlexConnectForm, JellyfinSyncForm, DonationForm, MotdForm, SiteTitleForm, SiteUrlForm, RateLimitForm, SessionForm, EmailForm, DiscordBotForm, OmdbForm, MdblistForm, TraktForm, IpinfoForm, CacheManagementPanel, LibraryMatchForm, RatingsWarmButton, ActivityWarmButton, QuotaForm, EnableUserEmailsToggle, MaintenanceForm, DeletionVoteThresholdForm, DisableLocalLoginToggle, JellyfinRestrictSignInToggle, EnableMachineSessionToggle, Request4kAllToggle, RatingsVisibilityForm, IosPushRelayForm, AnnounceUpdateButton, AuditRetentionForm } from "@/components/settings/settings-ui";
import { ArrInstancesManager } from "@/components/settings/arr-instances-manager";
import { MediaInstancesManager } from "@/components/settings/media-instances-manager";
import { PlayHistorySettingsForm } from "@/components/settings/play-history-settings";
import { WatchGradeSettingsForm } from "@/components/settings/watch-grade-settings";
import { ResyncLibraryButton } from "@/components/admin/resync-library-button";
import { SyncTVEpisodesButton } from "@/components/admin/sync-tv-episodes-button";
import { MasterDbFillButton } from "@/components/admin/master-db-fill-button";
import { SettingsTabNav, type TabId } from "@/components/settings/settings-tab-nav";
import { SettingsNav } from "@/components/settings/settings-nav";
import { CronJobTable, type CronJobInfo } from "@/components/settings/cron-job-table";
import { FeaturesForm } from "@/components/settings/features-form";
import { getFeatureFlags, groupFeaturesByCategory } from "@/lib/features";
import { parseHiddenRatingSources } from "@/lib/ratings-visibility";
import { mfaEnforcementDisabledByEnv } from "@/lib/mfa/policy";
import { RequireAdminMfaToggle } from "@/components/settings/forms/require-admin-mfa-toggle";
import { getLocale, getTranslator } from "@/lib/i18n/server";
import type { Translator } from "@/lib/i18n/translate";

// Labels and groups are catalog keys, translated at render (never at module
// load — the locale is per request).
type TabSection = { id: string; i18nKey: string; group: string };

const TAB_SECTIONS: Record<TabId, TabSection[]> = {
  site: [
    { id: "general", i18nKey: "settings.nav.general", group: "settings.group.site" },
    { id: "rate-limiting", i18nKey: "settings.nav.rateLimiting", group: "settings.group.site" },
    { id: "quotas", i18nKey: "settings.nav.quotas", group: "settings.group.site" },
    { id: "deletion-votes", i18nKey: "settings.nav.deletionVotes", group: "settings.group.site" },
    { id: "authentication", i18nKey: "settings.nav.authentication", group: "settings.group.site" },
    { id: "sessions", i18nKey: "settings.nav.sessions", group: "settings.group.site" },
    { id: "maintenance", i18nKey: "settings.nav.maintenance", group: "settings.group.site" },
    { id: "motd", i18nKey: "settings.nav.motd", group: "settings.group.site" },
    { id: "donations", i18nKey: "settings.nav.donations", group: "settings.group.site" },
  ],
  media: [
    { id: "plex", i18nKey: "settings.nav.plex", group: "settings.group.mediaServers" },
    { id: "jellyfin", i18nKey: "settings.nav.jellyfin", group: "settings.group.mediaServers" },
    { id: "media-instances", i18nKey: "settings.nav.mediaInstances", group: "settings.group.mediaServers" },
    { id: "play-history", i18nKey: "settings.nav.playHistory", group: "settings.group.mediaServers" },
    { id: "watch-grades", i18nKey: "settings.nav.watchGrades", group: "settings.group.mediaServers" },
    { id: "library-matching", i18nKey: "settings.nav.libraryMatching", group: "settings.group.mediaServers" },
    { id: "radarr", i18nKey: "settings.nav.radarr", group: "settings.group.automation" },
    { id: "radarr4k", i18nKey: "settings.nav.radarr4k", group: "settings.group.automation" },
    { id: "sonarr", i18nKey: "settings.nav.sonarr", group: "settings.group.automation" },
    { id: "sonarr4k", i18nKey: "settings.nav.sonarr4k", group: "settings.group.automation" },
    { id: "arr-instances", i18nKey: "settings.nav.arrInstances", group: "settings.group.automation" },
  ],
  notifications: [
    { id: "email", i18nKey: "settings.nav.email", group: "settings.group.notifications" },
    { id: "discord-bot", i18nKey: "settings.nav.discordBot", group: "settings.group.notifications" },
    { id: "ios-push-relay", i18nKey: "settings.nav.iosPushRelay", group: "settings.group.notifications" },
  ],
  integrations: [
    { id: "external-ratings", i18nKey: "settings.nav.externalRatings", group: "settings.group.integrations" },
    { id: "ip-geolocation", i18nKey: "settings.nav.ipGeolocation", group: "settings.group.integrations" },
    { id: "webhooks", i18nKey: "settings.nav.webhooks", group: "settings.group.integrations" },
  ],
  features: [],
  system: [
    { id: "scheduled-jobs", i18nKey: "settings.nav.scheduledJobs", group: "settings.group.system" },
    { id: "audit-log-settings", i18nKey: "settings.nav.auditLogSettings", group: "settings.group.system" },
    { id: "db-metrics", i18nKey: "settings.nav.dbMetrics", group: "settings.group.system" },
  ],
};

export const dynamic = "force-dynamic";

// Scheduled-job intervals arrive from env as a raw second count. Every other
// column in that table is already humanised ("21m ago", "170.7s"), so a bare
// "86400s" was the one value nobody could read at a glance. Unparseable or
// non-positive values are shown verbatim rather than silently normalised — an
// operator who typo'd the env var needs to see what they actually set.
function formatInterval(t: Translator, seconds: string | undefined, fallback: string): string {
  const raw = seconds ?? fallback;
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) return raw;
  if (n === 3_600) return t("settings.cron.interval.hourly");
  if (n === 86_400) return t("settings.cron.interval.daily");
  if (n === 604_800) return t("settings.cron.interval.weekly");
  if (n % 86_400 === 0) return `${n / 86_400}d`;
  if (n % 3_600 === 0) return `${n / 3_600}h`;
  if (n % 60 === 0) return `${n / 60}m`;
  return `${n}s`;
}

function StatusBadge({ connected, t }: { connected: boolean; t: Translator }) {
  if (connected) {
    return (
      <span className="ds-chip ds-chip-approved">
        <span
          style={{
            width: 6,
            height: 6,
            borderRadius: 999,
            background: "var(--ds-success)",
          }}
        />
        {t("settings.common.connected")}
      </span>
    );
  }
  return (
    <span className="ds-chip">{t("settings.common.notConfigured")}</span>
  );
}


const ALL_KEYS = [
  "radarrUrl", "radarrApiKey", "radarrRootFolder", "radarrQualityProfileId", "radarrMinimumAvailability",
  "sonarrUrl", "sonarrApiKey", "sonarrRootFolder", "sonarrQualityProfileId", "sonarrLanguageProfileId",
  "webhookSecret", "sonarrWebhookSecret", "radarrWebhookSecret",
  "radarr4kUrl", "radarr4kApiKey", "radarr4kRootFolder", "radarr4kQualityProfileId", "radarr4kMinimumAvailability", "radarr4kWebhookSecret",
  "sonarr4kUrl", "sonarr4kApiKey", "sonarr4kRootFolder", "sonarr4kQualityProfileId", "sonarr4kLanguageProfileId", "sonarr4kWebhookSecret",
  "request4kAll",
  // plexAdminToken is read here so the page can tell the sync buttons whether
  // Plex is configured — the same url+token pair /api/sync/plex itself checks.
  "plexAdminEmail", "plexServerUrl", "plexAdminToken", "plexLibraries", "plexPathStripPrefix", "plexMoviePathStripPrefix", "plexTvPathStripPrefix",
  "jellyfinUrl", "jellyfinApiKey", "jellyfinLibraries", "jellyfinPathStripPrefix", "jellyfinMoviePathStripPrefix", "jellyfinTvPathStripPrefix",
  "donationPaypal", "donationVenmo", "donationZelle", "donationAmazon", "donationPatreon", "donationBuyMeACoffee",
  "motdEnabled", "motdTitle", "motdBody",
  "siteTitle", "siteUrl",
  "rateLimitRegister", "rateLimitRequests", "rateLimitIssues",
  "maxPushSubscriptions",
  "quotaLimit", "quotaPeriod",
  "maintenanceEnabled", "maintenanceMessage",
  "sessionDefaultDuration", "sessionMobileDuration", "sessionMaxDuration",
  "smtpHost", "smtpPort", "smtpUser", "smtpPassword", "smtpFrom", "enableUserEmails",
  "emailBackend", "resendApiKey", "resendFrom",
  "discordBotToken", "discordClientId", "discordGuildId", "discordPublicKey", "discordAutoApproveRoles", "discordRequireLinkedAccount", "discordRequireLinkedAccountSite", "discordAdminRequestChannelId", "discordWelcomeChannelId", "discordNotifyChannelId", "discordInviteUrl",
  "discordLinkedRoleId", "discordPlexRoleId", "discordJellyfinRoleId", "discordAdminRoleId", "discordIssueAdminRoleId",
  "deletionVoteThreshold",
  "disableLocalLogin",
  "requireMfaForAdmins",
  "jellyfinRestrictSignIn",
  "enableMachineSession", "machineSessionAllowedIps",
  "playHistoryEnabled", "playHistoryPlexEnabled", "playHistoryJellyfinEnabled",
  "playHistoryWatchedThreshold", "playHistoryCompletionThreshold", "playHistoryArcGapDays",
  "playHistoryPollingInterval", "playHistoryRetentionDays",
  "watchGradeGraceDays", "watchGradeWindowDays", "watchGradeTvPercent", "watchGradeOtherViewers",
  "watchGradeBandA", "watchGradeBandB", "watchGradeBandC", "watchGradeBandD", "watchGradeMinRequests",
  "omdbApiKey", "mdblistApiKey", "traktClientId", "ratingsHiddenSources",
  "ipinfoToken",
  "apnsRelayUrl", "apnsRelayKey", "recommendedIosBuild",
  "auditPiiRetentionDays",
] as const;

const VALID_TABS: TabId[] = ["site", "media", "notifications", "integrations", "features", "system"];

export default async function SettingsPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string>>;
}) {
  const [sp, session] = await Promise.all([searchParams, authActive()]);
  if (!session || !hasPermission(session.user.permissions, Permission.ADMIN)) redirect("/");

  const [t, locale] = await Promise.all([getTranslator(), getLocale()]);
  const rawTab = sp.tab as TabId | undefined;
  const tab: TabId = rawTab && VALID_TABS.includes(rawTab) ? rawTab : "site";

  const rows = await prisma.setting.findMany({ where: { key: { in: [...ALL_KEYS] } } });
  const cfg = Object.fromEntries(rows.map((r) => [r.key, r.value]));
  // Read AFTER findMany so the set reflects this render's decrypt outcomes.
  // safeDecryptSettingValue clears entries on successful read, so the banner
  // disappears automatically on the next page load after the operator re-saves.
  const decryptFailures = getSettingDecryptFailures();

  // Exactly the gates /api/sync/plex and /api/sync/jellyfin apply themselves, so
  // the sync buttons can skip a server that is not there instead of POSTing to
  // it and reading the resulting 400 as a failure. Default instance only, which
  // is what those buttons sync — they send no `instance` slug (guardrail 35).
  const plexConfigured = !!(cfg.plexServerUrl && cfg.plexAdminToken);
  const jellyfinConfigured = !!(cfg.jellyfinUrl && cfg.jellyfinApiKey);

  const baseUrl = cfg.siteUrl?.replace(/\/$/, "") ?? process.env.AUTH_URL?.replace(/\/$/, "") ?? "http://localhost:3000";

  let metrics: {
    totalRequests: number; pendingRequests: number; approvedRequests: number;
    availableRequests: number; declinedRequests: number; movieRequests: number; tvRequests: number;
    totalUsers: number; adminUsers: number; issueAdminUsers: number; discordLinkedUsers: number;
    totalIssues: number; openIssues: number; inProgressIssues: number; resolvedIssues: number;
    plexItems: number; jellyfinItems: number; plexTvShows: number; jellyfinTvShows: number;
    plexShowsWithEps: number; jellyfinShowsWithEps: number;
    uniqueLibraryItems: number;
    tmdbCacheEntries: number; omdbCacheEntries: number;
    upcomingItems: number; episodeCacheEntries: number; radarrWanted: number; radarrAvailable: number; sonarrWanted: number; sonarrAvailable: number;
    deletionVotes: number;
    tmdbCoreEntries: number; tmdbCoreMovies: number; tmdbCoreTv: number;
    playHistoryEntries: number; mediaServerUsers: number; discordCacheEntries: number;
    currentShares: number | null;
    cronJobs: CronJobInfo[];
  } | null = null;

  if (tab === "system") {
    const [
      totalRequests, pendingRequests, approvedRequests, availableRequests, declinedRequests,
      movieRequests, tvRequests,
      totalUsers, adminUsers, issueAdminUsers, discordLinkedUsers,
      totalIssues, openIssues, inProgressIssues, resolvedIssues,
      plexItems, jellyfinItems, plexTvShows, jellyfinTvShows,
      plexShowsWithEps, jellyfinShowsWithEps,
      tmdbCacheEntries, omdbCacheEntries, upcomingItems, episodeCacheEntries,
      radarrWanted, radarrAvailable, sonarrWanted, sonarrAvailable, deletionVotes,
      tmdbCoreEntries, tmdbCoreMovies, tmdbCoreTv,
      playHistoryEntries, mediaServerUsers, discordCacheEntries,
      uniqueLibraryItems,
    ] = await Promise.all([
      prisma.mediaRequest.count(),
      prisma.mediaRequest.count({ where: { status: "PENDING" } }),
      prisma.mediaRequest.count({ where: { status: "APPROVED" } }),
      prisma.mediaRequest.count({ where: { status: "AVAILABLE" } }),
      prisma.mediaRequest.count({ where: { status: "DECLINED" } }),
      prisma.mediaRequest.count({ where: { mediaType: "MOVIE" } }),
      prisma.mediaRequest.count({ where: { mediaType: "TV" } }),
      prisma.user.count(),
      prisma.user.count({ where: { role: "ADMIN" } }),
      prisma.user.count({ where: { role: "ISSUE_ADMIN" } }),
      prisma.user.count({ where: { NOT: { discordId: null } } }),
      prisma.issue.count(),
      prisma.issue.count({ where: { status: "OPEN" } }),
      prisma.issue.count({ where: { status: "IN_PROGRESS" } }),
      prisma.issue.count({ where: { status: "RESOLVED" } }),
      prisma.plexLibraryItem.count(),
      prisma.jellyfinLibraryItem.count(),

      // TV COVERAGE: both halves must come from the SAME population or the
      // ratio is meaningless — this pair used to read 1,798 / 1,796 because the
      // numerator counted DISTINCT tmdbId in TVEpisodeCache while the
      // denominator was a raw row count on the library table. Two ways they
      // drifted: the library tables are keyed [tmdbId, mediaType,
      // serverInstance] so a title on two servers counted twice, and
      // TVEpisodeCache has no serverInstance column and is only rewritten when
      // every configured instance's fetch succeeds (guardrail 35), so it lags
      // and retains rows for titles the library no longer holds.
      //
      // Denominator: DISTINCT shows in the library. Numerator: those of them
      // that actually have episode rows. The EXISTS makes covered ≤ total by
      // construction, so a stale episode-cache row can never push it over 100%.
      prisma.$queryRaw<[{ count: bigint }]>(Prisma.sql`SELECT COUNT(DISTINCT "tmdbId")::bigint AS count FROM "PlexLibraryItem" WHERE "mediaType" = 'TV'`).then((r) => Number(r[0].count)),
      prisma.$queryRaw<[{ count: bigint }]>(Prisma.sql`SELECT COUNT(DISTINCT "tmdbId")::bigint AS count FROM "JellyfinLibraryItem" WHERE "mediaType" = 'TV'`).then((r) => Number(r[0].count)),

      prisma.$queryRaw<[{ count: bigint }]>(Prisma.sql`
        SELECT COUNT(DISTINCT p."tmdbId")::bigint AS count
        FROM "PlexLibraryItem" p
        WHERE p."mediaType" = 'TV'
          AND EXISTS (SELECT 1 FROM "TVEpisodeCache" e WHERE e."tmdbId" = p."tmdbId" AND e.source = 'plex')
      `).then((r) => Number(r[0].count)),
      prisma.$queryRaw<[{ count: bigint }]>(Prisma.sql`
        SELECT COUNT(DISTINCT j."tmdbId")::bigint AS count
        FROM "JellyfinLibraryItem" j
        WHERE j."mediaType" = 'TV'
          AND EXISTS (SELECT 1 FROM "TVEpisodeCache" e WHERE e."tmdbId" = j."tmdbId" AND e.source = 'jellyfin')
      `).then((r) => Number(r[0].count)),
      prisma.tmdbCache.count({ where: { key: { not: { startsWith: "omdb:" } } } }),
      prisma.tmdbCache.count({ where: { key: { startsWith: "omdb:" } } }),
      prisma.upcomingCacheItem.count(),
      prisma.tVEpisodeCache.count(),
      prisma.radarrWantedItem.count(),
      prisma.radarrAvailableItem.count(),
      prisma.sonarrWantedItem.count(),
      prisma.sonarrAvailableItem.count(),
      prisma.deletionVote.count(),
      prisma.tmdbMediaCore.count(),
      prisma.tmdbMediaCore.count({ where: { mediaType: "MOVIE" } }),
      prisma.tmdbMediaCore.count({ where: { mediaType: "TV" } }),
      prisma.playHistory.count(),
      prisma.mediaServerUser.count(),
      prisma.discordSearchCache.count({ where: { expiresAt: { gt: new Date() } } }),

      countUniqueLibraryItems(),
    ]);

    // plexAdminToken / jellyfinUrl / jellyfinApiKey are all in ALL_KEYS, so `cfg`
    // already holds the decrypted values (the prisma extension decrypts findMany
    // rows exactly as it does findUnique) — no second read needed.
    let currentShares: number | null = null;
    const shareCounts = await Promise.allSettled([
      cfg.plexServerUrl && cfg.plexAdminToken
        ? getPlexAccounts(cfg.plexServerUrl, cfg.plexAdminToken).then((a) => a.length)
        : Promise.resolve(null),
      cfg.jellyfinUrl && cfg.jellyfinApiKey
        ? getJellyfinUserCount(cfg.jellyfinUrl, cfg.jellyfinApiKey)
        : Promise.resolve(null),
    ]);
    const plexCount = shareCounts[0].status === "fulfilled" ? shareCounts[0].value : null;
    const jfCount   = shareCounts[1].status === "fulfilled" ? shareCounts[1].value : null;
    if (plexCount !== null || jfCount !== null) {
      currentShares = (plexCount ?? 0) + (jfCount ?? 0);
    }

    const cronTargets = [
      "sync:full", "upcoming-cache", "ratings-sync", "list-cache",
      "activity", "mdblist", "omdb", "recommendations", "library", "audit-log:pii-scrub", "auth-sessions:purge-expired",
      "trash-sync", "download-policies", "plex-watchlist",
    ];
    // Primary source: `Setting` rows written by `recordCronRun` on every run
    // (admin- or cron-triggered). Several warm jobs deliberately skip the
    // audit log on cron to avoid flooding, so reading the audit table alone
    // showed stale "Last Run" values for those jobs.
    const settingKeys = cronTargets.map((t) => `cron:lastRun:${t}`);
    const [lastRunSettings, lastRuns] = await Promise.all([
      prisma.setting.findMany({
        where: { key: { in: settingKeys } },
        select: { key: true, value: true },
      }),
      // One index-bounded LIMIT-1 read per target (`@@index([target])`), NOT a
      // single `distinct: ["target"]` query: Prisma's query compiler implements
      // `distinct` client-side, so that shape transferred EVERY audit row for
      // these targets (the orchestrator writes one per run, kept for 365 days)
      // into Node on each System-tab render just to keep one per target.
      Promise.all(
        cronTargets.map((target) =>
          prisma.auditLog.findFirst({
            where: { target },
            orderBy: { createdAt: "desc" },
            select: { target: true, createdAt: true, details: true },
          }),
        ),
      ),
    ]);
    const lastRunMap = new Map<string, { createdAt: Date; details: string | null }>();
    // Bounded run history, Setting-rows only — the audit-log fallback below has
    // no equivalent, so a target that only ever reported there stays null and
    // the table simply omits a rate for it rather than showing a wrong one.
    const historyMap = new Map<string, ReturnType<typeof parseCronRunHistory>>();
    for (const s of lastRunSettings) {
      historyMap.set(s.key.replace(/^cron:lastRun:/, ""), parseCronRunHistory(s.value));
    }
    // Read the clock ONCE, here on the server, and pass the resulting counts to
    // the client component as plain numbers (guardrail 16) — the cron table is
    // a "use client" component, so a clock read on its side of the boundary
    // would be the hydration bug that guardrail exists to prevent.
    // eslint-disable-next-line react-hooks/purity -- server component; Date.now() runs once per request
    const oneHourAgoMs = Date.now() - 60 * 60 * 1000;
    // The audit log is the fallback for jobs that only ever logged there
    // (e.g. upcoming-cache, trash-sync). Once a job has a Setting row, the
    // loop after this one overwrites the fallback with it.
    for (const r of lastRuns) {
      if (!r) continue;
      lastRunMap.set(r.target, { createdAt: r.createdAt, details: r.details });
    }
    for (const s of lastRunSettings) {
      const target = s.key.replace(/^cron:lastRun:/, "");
      const parsed = parseCronLastRun(s.value);
      if (!parsed) continue;
      // parseCronLastRun passes `at` through verbatim (its tests pin that), so a
      // corrupted / hand-edited row can carry a non-date here. `new Date(garbage)`
      // is an Invalid Date and `toISOString()` on it throws, taking the whole
      // System tab down — skip the row and let the audit-log fallback stand.
      const atMs = Date.parse(parsed.at);
      if (!Number.isFinite(atMs)) continue;
      lastRunMap.set(target, {
        createdAt: new Date(atMs),
        details: JSON.stringify({ durationMs: parsed.durationMs, ok: parsed.ok }),
      });
    }

    metrics = {
      totalRequests, pendingRequests, approvedRequests, availableRequests, declinedRequests,
      movieRequests, tvRequests,
      totalUsers, adminUsers, issueAdminUsers, discordLinkedUsers,
      totalIssues, openIssues, inProgressIssues, resolvedIssues,
      plexItems, jellyfinItems, plexTvShows, jellyfinTvShows,
      plexShowsWithEps, jellyfinShowsWithEps,
      tmdbCacheEntries, omdbCacheEntries,
      upcomingItems, episodeCacheEntries, radarrWanted, radarrAvailable, sonarrWanted, sonarrAvailable, deletionVotes,
      tmdbCoreEntries, tmdbCoreMovies, tmdbCoreTv,
      playHistoryEntries, mediaServerUsers, discordCacheEntries,
      uniqueLibraryItems,
      currentShares,
      cronJobs: buildCronJobs(lastRunMap, historyMap, oneHourAgoMs),
    };
  }

  function buildCronJobs(
    lastRunMap: Map<string, { createdAt: Date; details: string | null }>,
    historyMap: Map<string, ReturnType<typeof parseCronRunHistory>>,
    oneHourAgoMs: number,
  ): CronJobInfo[] {
    function lastRunInfo(target: string): {
      lastRun: string | null;
      lastDuration: number | null;
      lastStatus: "ok" | "error" | null;
      runsLastHour: number | null;
      runsLastHourCapped: boolean;
    } {
      const history = historyMap.get(target);
      // null (not 0) when there is no ledger history at all: "we do not know
      // this job's rate" and "this job ran zero times in the last hour" are
      // different answers, and only the second one is worth rendering.
      const runsLastHour = history && history.length > 0 ? countCronRunsSince(history, oneHourAgoMs) : null;
      // The history is bounded, so a saturated count is a floor, not a total.
      const runsLastHourCapped = runsLastHour != null && runsLastHour >= CRON_RUN_HISTORY_LIMIT;
      const row = lastRunMap.get(target);
      if (!row) return { lastRun: null, lastDuration: null, lastStatus: null, runsLastHour, runsLastHourCapped };
      let durationMs: number | null = null;
      // ok=false marks the run as failed. Setting-row writes always include `ok`;
      // legacy audit-log fallback rows don't, so default to "ok" when absent.
      let lastStatus: "ok" | "error" = "ok";
      try {
        const d = row.details ? JSON.parse(row.details) : null;
        if (d?.durationMs != null) durationMs = d.durationMs;
        if (d?.ok === false) lastStatus = "error";
      } catch { }
      return { lastRun: row.createdAt.toISOString(), lastDuration: durationMs, lastStatus, runsLastHour, runsLastHourCapped };
    }

    return [
      { name: t("settings.cron.job.librarySync.name"), description: t("settings.cron.job.librarySync.description"), endpoint: "/api/sync", interval: formatInterval(t, process.env.SYNC_INTERVAL, "3600"), ...lastRunInfo("sync:full") },
      { name: t("settings.cron.job.upcomingSync.name"), description: t("settings.cron.job.upcomingSync.description"), endpoint: "/api/sync/upcoming", interval: formatInterval(t, process.env.UPCOMING_SYNC_INTERVAL, "86400"), ...lastRunInfo("upcoming-cache") },
      { name: t("settings.cron.job.ratingsSync.name"), description: t("settings.cron.job.ratingsSync.description"), endpoint: "/api/sync/ratings", interval: formatInterval(t, process.env.RATINGS_SYNC_INTERVAL, "86400"), ...lastRunInfo("ratings-sync") },
      { name: t("settings.cron.job.warmListCache.name"), description: t("settings.cron.job.warmListCache.description"), endpoint: "/api/cron/warm-list-cache", interval: formatInterval(t, process.env.LIST_CACHE_SYNC_INTERVAL, "21600"), ...lastRunInfo("list-cache") },
      { name: t("settings.cron.job.warmActivity.name"), description: t("settings.cron.job.warmActivity.description"), endpoint: "/api/cron/warm-activity", interval: formatInterval(t, process.env.WARM_ACTIVITY_INTERVAL, "1800"), ...lastRunInfo("activity") },
      { name: t("settings.cron.job.warmMdblist.name"), description: t("settings.cron.job.warmMdblist.description"), endpoint: "/api/cron/warm-mdblist", interval: formatInterval(t, process.env.WARM_MDBLIST_INTERVAL, "86400"), ...lastRunInfo("mdblist") },
      { name: t("settings.cron.job.warmOmdb.name"), description: t("settings.cron.job.warmOmdb.description"), endpoint: "/api/cron/warm-omdb", interval: formatInterval(t, process.env.WARM_OMDB_INTERVAL, "86400"), ...lastRunInfo("omdb") },
      { name: t("settings.cron.job.warmRecommendations.name"), description: t("settings.cron.job.warmRecommendations.description"), endpoint: "/api/cron/warm-recommendations", interval: formatInterval(t, process.env.WARM_RECOMMENDATIONS_INTERVAL, "43200"), ...lastRunInfo("recommendations") },
      // Distinct from Admin -> Library's "Warm library cache" button, which
      // POSTs /api/admin/library-warm: that one runs the metadata walk ALONE,
      // records no cron run, and so never appears in this table. This row is
      // the only browser trigger that also builds the suggestion graph.
      { name: t("settings.cron.job.warmLibrary.name"), description: t("settings.cron.job.warmLibrary.description"), endpoint: "/api/cron/warm-library", interval: formatInterval(t, process.env.WARM_LIBRARY_INTERVAL, "86400"), ...lastRunInfo("library") },
      { name: t("settings.cron.job.purgeSessions.name"), description: t("settings.cron.job.purgeSessions.description"), endpoint: "/api/cron/purge-auth-sessions", interval: formatInterval(t, process.env.PURGE_SESSIONS_INTERVAL, "86400"), ...lastRunInfo("auth-sessions:purge-expired") },
      { name: t("settings.cron.job.scrubAuditPii.name"), description: t("settings.cron.job.scrubAuditPii.description"), endpoint: "/api/cron/scrub-audit-pii", interval: formatInterval(t, process.env.SCRUB_AUDIT_PII_INTERVAL, "86400"), ...lastRunInfo("audit-log:pii-scrub") },
      { name: t("settings.cron.job.trashSync.name"), description: t("settings.cron.job.trashSync.description"), endpoint: "/api/cron/trash-sync", interval: formatInterval(t, process.env.TRASH_SYNC_INTERVAL, "86400"), ...lastRunInfo("trash-sync") },
      { name: t("settings.cron.job.plexWatchlist.name"), description: t("settings.cron.job.plexWatchlist.description"), endpoint: "/api/cron/sync-plex-watchlists", interval: formatInterval(t, process.env.PLEX_WATCHLIST_SYNC_INTERVAL, "1800"), ...lastRunInfo("plex-watchlist") },
      { name: t("settings.cron.job.downloadPolicy.name"), description: t("settings.cron.job.downloadPolicy.description"), endpoint: "/api/cron/sync-download-policies", interval: formatInterval(t, process.env.SYNC_INTERVAL, "3600"), ...lastRunInfo("download-policies") },
    ];
  }

  return (
    <div className="ds-page-enter">
      <PageHeader
        title={t("nav.settings")}
        subtitle={t("settings.subtitle")}
      />

      {decryptFailures.length > 0 && (
        <div
          role="alert"
          style={{
            padding: 16,
            // Theme tokens, not raw rgba/hex: the old #fca5a5 text was a
            // dark-theme pink that read ~1.8:1 on the light theme (guardrail 42).
            background: "color-mix(in oklab, var(--ds-danger) 8%, transparent)",
            border: "1px solid color-mix(in oklab, var(--ds-danger) 35%, transparent)",
            borderRadius: 10,
            marginBottom: 16,
          }}
        >
          <div style={{ display: "flex", alignItems: "flex-start", gap: 12 }}>
            <div
              aria-hidden
              style={{
                flexShrink: 0,
                width: 22,
                height: 22,
                borderRadius: 999,
                background: "color-mix(in oklab, var(--ds-danger) 18%, transparent)",
                color: "var(--ds-danger)",
                display: "inline-flex",
                alignItems: "center",
                justifyContent: "center",
                fontSize: 13,
                fontWeight: 700,
                lineHeight: 1,
              }}
            >
              !
            </div>
            <div style={{ flex: 1, minWidth: 0 }}>
              <h3 style={{ fontSize: 14, fontWeight: 600, color: "var(--ds-danger)", margin: 0 }}>
                {t("settings.decrypt.title", { count: decryptFailures.length })}
              </h3>
              <p style={{ fontSize: 12, color: "var(--ds-fg-muted)", margin: "4px 0 8px", lineHeight: 1.5 }}>
                {t("settings.decrypt.bodyBefore", { count: decryptFailures.length })}{" "}
                <code style={{ fontFamily: "var(--font-mono, ui-monospace)" }}>TOKEN_ENCRYPTION_KEY</code>{" "}
                {t("settings.decrypt.bodyAfter")}
              </p>
              <ul style={{ fontSize: 12, color: "var(--ds-fg)", margin: 0, paddingLeft: 18, lineHeight: 1.7 }}>
                {decryptFailures.map((k) => (
                  <li key={k}>
                    <code style={{ fontFamily: "var(--font-mono, ui-monospace)" }}>{k}</code>
                  </li>
                ))}
              </ul>
            </div>
          </div>
        </div>
      )}

      <SettingsTabNav activeTab={tab} />

      <div className="lg:flex lg:gap-8" style={{ marginTop: 24 }}>
        {TAB_SECTIONS[tab].length > 1 && (
          <aside className="hidden lg:block w-48 shrink-0">
            <div className="sticky top-4">
              <SettingsNav
                items={TAB_SECTIONS[tab].map((sec) => ({ id: sec.id, label: t(sec.i18nKey), group: t(sec.group) }))}
              />
            </div>
          </aside>
        )}
        {/* `settings-sections` gives every direct child with an id a
            scroll-margin-top (globals.css) so the side-nav's plain #hash
            anchors land below the sticky chrome instead of flush against it. */}
        <div className="settings-sections max-w-3xl flex-1 flex flex-col" style={{ gap: 16 }}>

        {tab === "site" && (
          <>
            <div id="general" style={{padding:22,background:"var(--ds-bg-2)",border:"1px solid var(--ds-border)",borderRadius:10}}>
              <div className="mb-5">
                <h2 className="font-semibold" style={{fontSize:15,letterSpacing:"-0.01em",color:"var(--ds-fg)",margin:0}}>{t("settings.section.general.title")}</h2>
                <p style={{fontSize:12,color:"var(--ds-fg-muted)",margin:"4px 0 0",lineHeight:1.5}}>{t("settings.section.general.description")}</p>
              </div>
              <div className="space-y-6">
                <SiteTitleForm initialTitle={cfg.siteTitle ?? ""} />
                <SiteUrlForm initialUrl={cfg.siteUrl ?? ""} />
              </div>
            </div>

            <div id="rate-limiting" style={{padding:22,background:"var(--ds-bg-2)",border:"1px solid var(--ds-border)",borderRadius:10}}>
              <div className="mb-5">
                <h2 className="font-semibold" style={{fontSize:15,letterSpacing:"-0.01em",color:"var(--ds-fg)",margin:0}}>{t("settings.section.rateLimiting.title")}</h2>
                <p style={{fontSize:12,color:"var(--ds-fg-muted)",margin:"4px 0 0",lineHeight:1.5}}>{t("settings.section.rateLimiting.description")}</p>
              </div>
              <RateLimitForm
                initialRegister={cfg.rateLimitRegister ?? ""}
                initialRequests={cfg.rateLimitRequests ?? ""}
                initialIssues={cfg.rateLimitIssues ?? ""}
                initialMaxPushSubscriptions={cfg.maxPushSubscriptions ?? ""}
              />
            </div>

            <div id="quotas" style={{padding:22,background:"var(--ds-bg-2)",border:"1px solid var(--ds-border)",borderRadius:10}}>
              <div className="mb-5">
                <h2 className="font-semibold" style={{fontSize:15,letterSpacing:"-0.01em",color:"var(--ds-fg)",margin:0}}>{t("settings.section.quotas.title")}</h2>
                <p style={{fontSize:12,color:"var(--ds-fg-muted)",margin:"4px 0 0",lineHeight:1.5}}>{t("settings.section.quotas.description")}</p>
              </div>
              <QuotaForm
                initialLimit={cfg.quotaLimit ?? ""}
                initialPeriod={cfg.quotaPeriod ?? ""}
              />
            </div>

            <div id="deletion-votes" style={{padding:22,background:"var(--ds-bg-2)",border:"1px solid var(--ds-border)",borderRadius:10}}>
              <div className="mb-5">
                <h2 className="font-semibold" style={{fontSize:15,letterSpacing:"-0.01em",color:"var(--ds-fg)",margin:0}}>{t("settings.section.deletionVotes.title")}</h2>
                <p style={{fontSize:12,color:"var(--ds-fg-muted)",margin:"4px 0 0",lineHeight:1.5}}>{t("settings.section.deletionVotes.description")}</p>
              </div>
              <DeletionVoteThresholdForm initialThreshold={cfg.deletionVoteThreshold ?? ""} />
            </div>

            <div id="authentication" style={{padding:22,background:"var(--ds-bg-2)",border:"1px solid var(--ds-border)",borderRadius:10}}>
              <div className="mb-5">
                <h2 className="font-semibold" style={{fontSize:15,letterSpacing:"-0.01em",color:"var(--ds-fg)",margin:0}}>{t("settings.section.authentication.title")}</h2>
                <p style={{fontSize:12,color:"var(--ds-fg-muted)",margin:"4px 0 0",lineHeight:1.5}}>{t("settings.section.authentication.description")}</p>
              </div>
              <DisableLocalLoginToggle initialDisabled={cfg.disableLocalLogin === "true"} />
              <RequireAdminMfaToggle
                initialRequired={cfg.requireMfaForAdmins === "true"}
                envOverride={mfaEnforcementDisabledByEnv()}
              />
              <JellyfinRestrictSignInToggle initialRestrict={cfg.jellyfinRestrictSignIn !== "false"} />
              <EnableMachineSessionToggle
                initialEnabled={cfg.enableMachineSession === "true"}
                initialAllowedIps={cfg.machineSessionAllowedIps ?? ""}
              />
            </div>

            <div id="sessions" style={{padding:22,background:"var(--ds-bg-2)",border:"1px solid var(--ds-border)",borderRadius:10}}>
              <div className="mb-5">
                <h2 className="font-semibold" style={{fontSize:15,letterSpacing:"-0.01em",color:"var(--ds-fg)",margin:0}}>{t("settings.section.sessions.title")}</h2>
                <p style={{fontSize:12,color:"var(--ds-fg-muted)",margin:"4px 0 0",lineHeight:1.5}}>{t("settings.section.sessions.description")}</p>
              </div>
              <SessionForm
                initialDefaultDuration={cfg.sessionDefaultDuration ?? ""}
                initialMobileDuration={cfg.sessionMobileDuration ?? ""}
                initialMaxDuration={cfg.sessionMaxDuration ?? ""}
              />
            </div>

            <div id="maintenance" style={{padding:22,background:"var(--ds-bg-2)",border:"1px solid var(--ds-border)",borderRadius:10}}>
              <div className="mb-5">
                <h2 className="font-semibold" style={{fontSize:15,letterSpacing:"-0.01em",color:"var(--ds-fg)",margin:0}}>{t("settings.section.maintenance.title")}</h2>
                <p style={{fontSize:12,color:"var(--ds-fg-muted)",margin:"4px 0 0",lineHeight:1.5}}>{t("settings.section.maintenance.description")}</p>
              </div>
              <MaintenanceForm
                initialEnabled={cfg.maintenanceEnabled === "true"}
                initialMessage={cfg.maintenanceMessage ?? ""}
              />
            </div>

            <div id="motd" style={{padding:22,background:"var(--ds-bg-2)",border:"1px solid var(--ds-border)",borderRadius:10}}>
              <div className="mb-5">
                <h2 className="font-semibold" style={{fontSize:15,letterSpacing:"-0.01em",color:"var(--ds-fg)",margin:0}}>{t("settings.section.motd.title")}</h2>
                <p style={{fontSize:12,color:"var(--ds-fg-muted)",margin:"4px 0 0",lineHeight:1.5}}>{t("settings.section.motd.description")}</p>
              </div>
              <MotdForm
                initialEnabled={cfg.motdEnabled === "true"}
                initialTitle={cfg.motdTitle ?? ""}
                initialBody={cfg.motdBody ?? ""}
              />
            </div>

            <div id="donations" style={{padding:22,background:"var(--ds-bg-2)",border:"1px solid var(--ds-border)",borderRadius:10}}>
              <div className="mb-5">
                <h2 className="font-semibold" style={{fontSize:15,letterSpacing:"-0.01em",color:"var(--ds-fg)",margin:0}}>{t("settings.section.donations.title")}</h2>
                <p style={{fontSize:12,color:"var(--ds-fg-muted)",margin:"4px 0 0",lineHeight:1.5}}>{t("settings.section.donations.description")}</p>
              </div>
              <DonationForm
                initialPaypal={cfg.donationPaypal ?? ""}
                initialVenmo={cfg.donationVenmo ?? ""}
                initialZelle={cfg.donationZelle ?? ""}
                initialAmazon={cfg.donationAmazon ?? ""}
                initialPatreon={cfg.donationPatreon ?? ""}
                initialBuyMeACoffee={cfg.donationBuyMeACoffee ?? ""}
              />
            </div>
          </>
        )}

        {tab === "media" && (
          <>
            <div id="plex" style={{padding:22,background:"var(--ds-bg-2)",border:"1px solid var(--ds-border)",borderRadius:10}}>
              <div className="mb-5">
                <div className="flex items-center gap-3 mb-0.5">
                  <h2 className="font-semibold" style={{fontSize:15,letterSpacing:"-0.01em",color:"var(--ds-fg)",margin:0}}>Plex</h2>
                  <StatusBadge t={t} connected={!!cfg.plexAdminEmail} />
                </div>
                <p className="text-sm text-zinc-500">{t("settings.section.plex.description")}</p>
              </div>
              <PlexConnectForm
                initialEmail={cfg.plexAdminEmail ?? ""}
                initialServerUrl={cfg.plexServerUrl ?? ""}
                initialPlexLibraries={cfg.plexLibraries ?? ""}
                siteUrl={cfg.siteUrl ?? process.env.AUTH_URL ?? ""}
              />
            </div>

            <div id="jellyfin" style={{padding:22,background:"var(--ds-bg-2)",border:"1px solid var(--ds-border)",borderRadius:10}}>
              <div className="mb-5">
                <div className="flex items-center gap-3 mb-0.5">
                  <h2 className="font-semibold" style={{fontSize:15,letterSpacing:"-0.01em",color:"var(--ds-fg)",margin:0}}>Jellyfin</h2>
                  <StatusBadge t={t} connected={!!(cfg.jellyfinUrl && cfg.jellyfinApiKey)} />
                </div>
                <p className="text-sm text-zinc-500">{t("settings.section.jellyfin.description")}</p>
              </div>
              <JellyfinSyncForm
                initialUrl={cfg.jellyfinUrl ?? ""}
                initialApiKey={cfg.jellyfinApiKey ? "••••••••" : ""}
                initialJellyfinLibraries={cfg.jellyfinLibraries ?? ""}
              />
            </div>

            <div id="media-instances" style={{padding:22,background:"var(--ds-bg-2)",border:"1px solid var(--ds-border)",borderRadius:10}}>
              <div className="mb-5">
                <h2 className="font-semibold" style={{fontSize:15,letterSpacing:"-0.01em",color:"var(--ds-fg)",margin:0}}>{t("settings.section.mediaInstances.title")}</h2>
                <p className="text-sm text-zinc-500 mt-1">{t("settings.section.mediaInstances.description")}</p>
              </div>
              <div className="space-y-8">
                <MediaInstancesManager service="plex" />
                <MediaInstancesManager service="jellyfin" />
              </div>
            </div>

            <div id="play-history" style={{padding:22,background:"var(--ds-bg-2)",border:"1px solid var(--ds-border)",borderRadius:10}}>
              <div className="mb-5">
                <h2 className="font-semibold" style={{fontSize:15,letterSpacing:"-0.01em",color:"var(--ds-fg)",margin:0}}>{t("settings.section.playHistory.title")}</h2>
                <p style={{fontSize:12,color:"var(--ds-fg-muted)",margin:"4px 0 0",lineHeight:1.5}}>{t("settings.section.playHistory.description")}</p>
              </div>
              <PlayHistorySettingsForm
                initialEnabled={cfg.playHistoryEnabled ?? ""}
                initialPlexEnabled={cfg.playHistoryPlexEnabled ?? ""}
                initialJellyfinEnabled={cfg.playHistoryJellyfinEnabled ?? ""}
                initialWatchedThreshold={cfg.playHistoryWatchedThreshold ?? "80"}
                initialCompletionThreshold={cfg.playHistoryCompletionThreshold ?? "90"}
                initialArcGapDays={cfg.playHistoryArcGapDays ?? "14"}
                initialPollingInterval={cfg.playHistoryPollingInterval ?? "5"}
                initialRetentionDays={cfg.playHistoryRetentionDays ?? "0"}
              />
            </div>

            <div id="watch-grades" style={{padding:22,background:"var(--ds-bg-2)",border:"1px solid var(--ds-border)",borderRadius:10}}>
              <div className="mb-5">
                <h2 className="font-semibold" style={{fontSize:15,letterSpacing:"-0.01em",color:"var(--ds-fg)",margin:0}}>{t("settings.section.watchGrades.title")}</h2>
                <p style={{fontSize:12,color:"var(--ds-fg-muted)",margin:"4px 0 0",lineHeight:1.5}}>{t("settings.section.watchGrades.description")}</p>
              </div>
              <WatchGradeSettingsForm
                initial={{
                  graceDays: cfg.watchGradeGraceDays ?? "",
                  windowDays: cfg.watchGradeWindowDays ?? "",
                  tvEpisodePercent: cfg.watchGradeTvPercent ?? "",
                  otherViewers: cfg.watchGradeOtherViewers ?? "",
                  bandA: cfg.watchGradeBandA ?? "",
                  bandB: cfg.watchGradeBandB ?? "",
                  bandC: cfg.watchGradeBandC ?? "",
                  bandD: cfg.watchGradeBandD ?? "",
                  minGradedRequests: cfg.watchGradeMinRequests ?? "",
                }}
              />
            </div>

            <div id="library-matching" style={{padding:22,background:"var(--ds-bg-2)",border:"1px solid var(--ds-border)",borderRadius:10}}>
              <div className="mb-5">
                <h2 className="font-semibold" style={{fontSize:15,letterSpacing:"-0.01em",color:"var(--ds-fg)",margin:0}}>{t("settings.section.libraryMatching.title")}</h2>
                <p style={{fontSize:12,color:"var(--ds-fg-muted)",margin:"4px 0 0",lineHeight:1.5}}>{t("settings.section.libraryMatching.description")}</p>
              </div>
              <LibraryMatchForm
                initialPlexMoviePrefix={cfg.plexMoviePathStripPrefix ?? ""}
                initialPlexTvPrefix={cfg.plexTvPathStripPrefix ?? ""}
                initialJellyfinMoviePrefix={cfg.jellyfinMoviePathStripPrefix ?? ""}
                initialJellyfinTvPrefix={cfg.jellyfinTvPathStripPrefix ?? ""}
              />
            </div>

            <div id="radarr" style={{padding:22,background:"var(--ds-bg-2)",border:"1px solid var(--ds-border)",borderRadius:10}}>
              <div className="mb-5">
                <div className="flex items-center gap-3 mb-0.5">
                  <h2 className="font-semibold" style={{fontSize:15,letterSpacing:"-0.01em",color:"var(--ds-fg)",margin:0}}>Radarr</h2>
                  <StatusBadge t={t} connected={!!(cfg.radarrUrl && cfg.radarrApiKey)} />
                </div>
                <p className="text-sm text-zinc-500">{t("settings.section.radarr.description")}</p>
              </div>
              <ArrForm
                service="radarr"
                initialUrl={cfg.radarrUrl ?? ""}
                initialApiKey={cfg.radarrApiKey ? "••••••••" : ""}
                initialRootFolder={cfg.radarrRootFolder ?? ""}
                initialQualityProfileId={cfg.radarrQualityProfileId ?? ""}
                initialMinimumAvailability={cfg.radarrMinimumAvailability ?? ""}
              />
            </div>

            <div id="radarr4k" style={{padding:22,background:"var(--ds-bg-2)",border:"1px solid var(--ds-border)",borderRadius:10}}>
              <div className="mb-5">
                <div className="flex items-center gap-3 mb-0.5">
                  <h2 className="font-semibold" style={{fontSize:15,letterSpacing:"-0.01em",color:"var(--ds-fg)",margin:0}}>Radarr 4K <span style={{fontSize:12,color:"var(--ds-fg-subtle)",fontWeight:400}}>{t("settings.common.optional")}</span></h2>
                  <StatusBadge t={t} connected={!!(cfg.radarr4kUrl && cfg.radarr4kApiKey)} />
                </div>
                <p className="text-sm text-zinc-500">{t("settings.section.radarr4k.description")}</p>
              </div>
              <ArrForm
                service="radarr"
                variant="4k"
                initialUrl={cfg.radarr4kUrl ?? ""}
                initialApiKey={cfg.radarr4kApiKey ? "••••••••" : ""}
                initialRootFolder={cfg.radarr4kRootFolder ?? ""}
                initialQualityProfileId={cfg.radarr4kQualityProfileId ?? ""}
                initialMinimumAvailability={cfg.radarr4kMinimumAvailability ?? ""}
              />
            </div>

            <div id="sonarr" style={{padding:22,background:"var(--ds-bg-2)",border:"1px solid var(--ds-border)",borderRadius:10}}>
              <div className="mb-5">
                <div className="flex items-center gap-3 mb-0.5">
                  <h2 className="font-semibold" style={{fontSize:15,letterSpacing:"-0.01em",color:"var(--ds-fg)",margin:0}}>Sonarr</h2>
                  <StatusBadge t={t} connected={!!(cfg.sonarrUrl && cfg.sonarrApiKey)} />
                </div>
                <p className="text-sm text-zinc-500">{t("settings.section.sonarr.description")}</p>
              </div>
              <ArrForm
                service="sonarr"
                initialUrl={cfg.sonarrUrl ?? ""}
                initialApiKey={cfg.sonarrApiKey ? "••••••••" : ""}
                initialRootFolder={cfg.sonarrRootFolder ?? ""}
                initialQualityProfileId={cfg.sonarrQualityProfileId ?? ""}
                initialLanguageProfileId={cfg.sonarrLanguageProfileId ?? ""}
              />
            </div>

            <div id="sonarr4k" style={{padding:22,background:"var(--ds-bg-2)",border:"1px solid var(--ds-border)",borderRadius:10}}>
              <div className="mb-5">
                <div className="flex items-center gap-3 mb-0.5">
                  <h2 className="font-semibold" style={{fontSize:15,letterSpacing:"-0.01em",color:"var(--ds-fg)",margin:0}}>Sonarr 4K <span style={{fontSize:12,color:"var(--ds-fg-subtle)",fontWeight:400}}>{t("settings.common.optional")}</span></h2>
                  <StatusBadge t={t} connected={!!(cfg.sonarr4kUrl && cfg.sonarr4kApiKey)} />
                </div>
                <p className="text-sm text-zinc-500">{t("settings.section.sonarr4k.description")}</p>
              </div>
              <ArrForm
                service="sonarr"
                variant="4k"
                initialUrl={cfg.sonarr4kUrl ?? ""}
                initialApiKey={cfg.sonarr4kApiKey ? "••••••••" : ""}
                initialRootFolder={cfg.sonarr4kRootFolder ?? ""}
                initialQualityProfileId={cfg.sonarr4kQualityProfileId ?? ""}
                initialLanguageProfileId={cfg.sonarr4kLanguageProfileId ?? ""}
              />
            </div>

            <div style={{padding:22,background:"var(--ds-bg-2)",border:"1px solid var(--ds-border)",borderRadius:10}}>
              <Request4kAllToggle initialEnabled={cfg.request4kAll === "true"} />
            </div>

            <div id="arr-instances" style={{padding:22,background:"var(--ds-bg-2)",border:"1px solid var(--ds-border)",borderRadius:10}}>
              <div className="mb-5">
                <h2 className="font-semibold" style={{fontSize:15,letterSpacing:"-0.01em",color:"var(--ds-fg)",margin:0}}>{t("settings.section.arrInstances.title")}</h2>
                <p className="text-sm text-zinc-500 mt-1">{t("settings.section.arrInstances.description")}</p>
              </div>
              <ArrInstancesManager />
            </div>
          </>
        )}

        {tab === "notifications" && (
          <>
            <div id="email" style={{padding:22,background:"var(--ds-bg-2)",border:"1px solid var(--ds-border)",borderRadius:10}}>
              <div className="mb-5">
                <div className="flex items-center gap-3 mb-0.5">
                  <h2 className="font-semibold" style={{fontSize:15,letterSpacing:"-0.01em",color:"var(--ds-fg)",margin:0}}>{t("settings.section.email.title")}</h2>
                  <StatusBadge t={t} connected={cfg.emailBackend === "resend" ? !!cfg.resendApiKey : !!cfg.smtpHost} />
                </div>
                <p className="text-sm text-zinc-500">{t("settings.section.email.description")}</p>
              </div>
              <EmailForm
                initialBackend={cfg.emailBackend === "resend" ? "resend" : "smtp"}
                initialHost={cfg.smtpHost ?? ""}
                initialPort={cfg.smtpPort ?? ""}
                initialUser={cfg.smtpUser ?? ""}
                initialPassword={cfg.smtpPassword ? "••••••••" : ""}
                initialFrom={cfg.smtpFrom ?? ""}
                initialResendApiKey={cfg.resendApiKey ? "••••••••" : ""}
                initialResendFrom={cfg.resendFrom ?? ""}
              />
              <EnableUserEmailsToggle initialEnabled={cfg.enableUserEmails === "true"} />
            </div>

            <div id="discord-bot" style={{padding:22,background:"var(--ds-bg-2)",border:"1px solid var(--ds-border)",borderRadius:10}}>
              <div className="mb-5">
                <div className="flex items-center gap-3 mb-0.5">
                  <h2 className="font-semibold" style={{fontSize:15,letterSpacing:"-0.01em",color:"var(--ds-fg)",margin:0}}>{t("settings.section.discordBot.title")}</h2>
                  <StatusBadge t={t} connected={!!cfg.discordBotToken} />
                </div>
                <p className="text-sm text-zinc-500">{t("settings.section.discordBot.description")}</p>
              </div>
              <DiscordBotForm
                initialBotToken={cfg.discordBotToken ? "••••••••" : ""}
                initialClientId={cfg.discordClientId ?? ""}
                initialGuildId={cfg.discordGuildId ?? ""}
                initialPublicKey={cfg.discordPublicKey ?? ""}
                initialAutoApproveRoles={cfg.discordAutoApproveRoles ?? ""}
                initialRequireLinkedAccount={cfg.discordRequireLinkedAccount === "true"}
                initialRequireLinkedAccountSite={cfg.discordRequireLinkedAccountSite === "true"}
                initialAdminRequestChannelId={cfg.discordAdminRequestChannelId ?? ""}
                initialWelcomeChannelId={cfg.discordWelcomeChannelId ?? ""}
                initialNotifyChannelId={cfg.discordNotifyChannelId ?? ""}
                initialInviteUrl={cfg.discordInviteUrl ?? ""}
                initialLinkedRoleId={cfg.discordLinkedRoleId ?? ""}
                initialPlexRoleId={cfg.discordPlexRoleId ?? ""}
                initialJellyfinRoleId={cfg.discordJellyfinRoleId ?? ""}
                initialAdminRoleId={cfg.discordAdminRoleId ?? ""}
                initialIssueAdminRoleId={cfg.discordIssueAdminRoleId ?? ""}
              />
            </div>

            <div id="ios-push-relay" style={{padding:22,background:"var(--ds-bg-2)",border:"1px solid var(--ds-border)",borderRadius:10}}>
              <div className="mb-5">
                <h2 className="font-semibold" style={{fontSize:15,letterSpacing:"-0.01em",color:"var(--ds-fg)",margin:0}}>{t("settings.section.iosPushRelay.title")}</h2>
                <p style={{fontSize:12,color:"var(--ds-fg-muted)",margin:"4px 0 0",lineHeight:1.5}}>
                  {t("settings.section.iosPushRelay.description")}
                </p>
              </div>
              <div className="space-y-6">
                <IosPushRelayForm
                  initialRelayUrl={cfg.apnsRelayUrl ?? ""}
                  initialRelayKey={cfg.apnsRelayKey ? "••••••••" : ""}
                  initialRecommendedBuild={cfg.recommendedIosBuild ?? ""}
                />
                <div className="border-t border-zinc-800 pt-5">
                  <AnnounceUpdateButton />
                </div>
              </div>
            </div>
          </>
        )}

        {tab === "integrations" && (
          <>
            <div id="external-ratings" style={{padding:22,background:"var(--ds-bg-2)",border:"1px solid var(--ds-border)",borderRadius:10}}>
              <div className="mb-5">
                <div className="flex items-center gap-3 mb-0.5">
                  <h2 className="font-semibold" style={{fontSize:15,letterSpacing:"-0.01em",color:"var(--ds-fg)",margin:0}}>{t("settings.section.externalRatings.title")}</h2>
                  <StatusBadge t={t} connected={!!(cfg.mdblistApiKey || cfg.omdbApiKey || cfg.traktClientId)} />
                </div>
                <p className="text-sm text-zinc-500">
                  {t("settings.section.externalRatings.description")}
                </p>
              </div>
              <div className="space-y-6">
                <MdblistForm initialApiKey={cfg.mdblistApiKey ? "••••••••" : ""} />
                <div className="border-t border-zinc-800 pt-5">
                  <OmdbForm initialApiKey={cfg.omdbApiKey ? "••••••••" : ""} />
                </div>
                <div className="border-t border-zinc-800 pt-5">
                  <TraktForm initialApiKey={cfg.traktClientId ? "••••••••" : ""} />
                </div>
                <div className="border-t border-zinc-800 pt-5">
                  <RatingsVisibilityForm initialHidden={parseHiddenRatingSources(cfg.ratingsHiddenSources)} />
                </div>
                <div className="border-t border-zinc-800 pt-5">
                  <CacheManagementPanel />
                </div>
              </div>
            </div>

            <div id="ip-geolocation" style={{padding:22,background:"var(--ds-bg-2)",border:"1px solid var(--ds-border)",borderRadius:10}}>
              <div className="mb-5">
                <div className="flex items-center gap-3 mb-0.5">
                  <h2 className="font-semibold" style={{fontSize:15,letterSpacing:"-0.01em",color:"var(--ds-fg)",margin:0}}>{t("settings.section.ipGeolocation.title")}</h2>
                  <StatusBadge t={t} connected={!!cfg.ipinfoToken} />
                </div>
                <p className="text-sm text-zinc-500">{t("settings.section.ipGeolocation.description")}</p>
              </div>
              <IpinfoForm initialApiKey={cfg.ipinfoToken ? "••••••••" : ""} />
            </div>

            <div id="webhooks" style={{padding:22,background:"var(--ds-bg-2)",border:"1px solid var(--ds-border)",borderRadius:10}}>
              <div className="mb-5">
                <h2 className="font-semibold" style={{fontSize:15,letterSpacing:"-0.01em",color:"var(--ds-fg)",margin:0}}>{t("settings.section.webhooks.title")}</h2>
                <p style={{fontSize:12,color:"var(--ds-fg-muted)",margin:"4px 0 0",lineHeight:1.5}}>
                  {t("settings.section.webhooks.description")}
                </p>
              </div>
              <div className="space-y-6">
                <WebhookSecretForm
                  initialSecret={cfg.webhookSecret ? "••••••••" : ""}
                  initialSonarrSecret={cfg.sonarrWebhookSecret ? "••••••••" : ""}
                  initialRadarrSecret={cfg.radarrWebhookSecret ? "••••••••" : ""}
                  initialSonarr4kSecret={cfg.sonarr4kWebhookSecret ? "••••••••" : ""}
                  initialRadarr4kSecret={cfg.radarr4kWebhookSecret ? "••••••••" : ""}
                />
                <div className="border-t border-zinc-800 pt-5">
                  <WebhookUrls
                    baseUrl={baseUrl}
                    radarrHasSecret={!!cfg.radarrWebhookSecret}
                    sonarrHasSecret={!!cfg.sonarrWebhookSecret}
                    radarr4kHasSecret={!!cfg.radarr4kWebhookSecret}
                    sonarr4kHasSecret={!!cfg.sonarr4kWebhookSecret}
                    radarr4kConfigured={!!(cfg.radarr4kUrl && cfg.radarr4kApiKey)}
                    sonarr4kConfigured={!!(cfg.sonarr4kUrl && cfg.sonarr4kApiKey)}
                    legacyHasSecret={!!cfg.webhookSecret}
                  />
                </div>
              </div>
            </div>
          </>
        )}

        {tab === "features" && (
          <FeaturesForm
            initialFlags={await getFeatureFlags()}
            groups={(() => {
              const g = groupFeaturesByCategory();
              return [
                { category: "pages" as const,        title: t("settings.features.group.pages.title"), description: t("settings.features.group.pages.description"), features: g.pages },
                { category: "behaviors" as const,    title: t("settings.features.group.behaviors.title"), description: t("settings.features.group.behaviors.description"), features: g.behaviors },
                { category: "integrations" as const, title: t("settings.features.group.integrations.title"), description: t("settings.features.group.integrations.description"), features: g.integrations },
                { category: "admin" as const,        title: t("settings.features.group.admin.title"), description: t("settings.features.group.admin.description"), features: g.admin },
              ];
            })()}
          />
        )}

        {tab === "system" && metrics && (
          <>
          <div id="scheduled-jobs" style={{padding:22,background:"var(--ds-bg-2)",border:"1px solid var(--ds-border)",borderRadius:10}}>
            <div className="mb-5">
              <h2 className="font-semibold" style={{fontSize:15,letterSpacing:"-0.01em",color:"var(--ds-fg)",margin:0}}>{t("settings.section.scheduledJobs.title")}</h2>
              <p style={{fontSize:12,color:"var(--ds-fg-muted)",margin:"4px 0 0",lineHeight:1.5}}>{t("settings.section.scheduledJobs.description")}</p>
            </div>
            <CronJobTable jobs={metrics.cronJobs} />
          </div>

          <div id="audit-log-settings" style={{padding:22,background:"var(--ds-bg-2)",border:"1px solid var(--ds-border)",borderRadius:10}}>
            <div className="mb-5">
              <h2 className="font-semibold" style={{fontSize:15,letterSpacing:"-0.01em",color:"var(--ds-fg)",margin:0}}>{t("settings.section.auditLog.title")}</h2>
              <p style={{fontSize:12,color:"var(--ds-fg-muted)",margin:"4px 0 0",lineHeight:1.5}}>
                {t("settings.section.auditLog.description")}
              </p>
            </div>
            <AuditRetentionForm initialDays={cfg.auditPiiRetentionDays ?? ""} />
          </div>

          <div id="db-metrics" style={{padding:22,background:"var(--ds-bg-2)",border:"1px solid var(--ds-border)",borderRadius:10}}>
            <div className="mb-5">
              <h2 className="font-semibold" style={{fontSize:15,letterSpacing:"-0.01em",color:"var(--ds-fg)",margin:0}}>{t("settings.section.dbMetrics.title")}</h2>
              <p style={{fontSize:12,color:"var(--ds-fg-muted)",margin:"4px 0 0",lineHeight:1.5}}>{t("settings.section.dbMetrics.description")}</p>
            </div>
            <div className="space-y-6">

              <div>
                <h3 className="text-xs font-semibold uppercase tracking-wider text-zinc-500 mb-3">{t("settings.metrics.requests.heading")}</h3>
                <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
                  {[
                    { label: t("settings.metrics.total"),     value: metrics.totalRequests },
                    { label: t("settings.metrics.pending"),   value: metrics.pendingRequests },
                    { label: t("settings.metrics.approved"),  value: metrics.approvedRequests },
                    { label: t("settings.metrics.available"), value: metrics.availableRequests },
                    { label: t("settings.metrics.declined"),  value: metrics.declinedRequests },
                    { label: t("settings.metrics.movies"),    value: metrics.movieRequests },
                    { label: t("settings.metrics.tvShows"),  value: metrics.tvRequests },
                  ].map(({ label, value }) => (
                    <div key={label} className="bg-zinc-800 border border-zinc-800 rounded-lg px-4 py-3">
                      <p className="text-xs text-zinc-500 mb-1">{label}</p>
                      <p className="text-xl font-semibold text-zinc-100 tabular-nums">{value.toLocaleString(locale)}</p>
                    </div>
                  ))}
                </div>
              </div>

              <div className="border-t border-zinc-800 pt-5">
                <h3 className="text-xs font-semibold uppercase tracking-wider text-zinc-500 mb-3">{t("settings.metrics.users.heading")}</h3>
                <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
                  {[
                    { label: t("settings.metrics.total"),          value: metrics.totalUsers },
                    { label: t("settings.metrics.admins"),         value: metrics.adminUsers },
                    { label: t("settings.metrics.issueAdmins"),   value: metrics.issueAdminUsers },
                    { label: t("settings.metrics.discordLinked"), value: metrics.discordLinkedUsers },
                  ].map(({ label, value }) => (
                    <div key={label} className="bg-zinc-800 border border-zinc-800 rounded-lg px-4 py-3">
                      <p className="text-xs text-zinc-500 mb-1">{label}</p>
                      <p className="text-xl font-semibold text-zinc-100 tabular-nums">{value.toLocaleString(locale)}</p>
                    </div>
                  ))}
                </div>
              </div>

              <div className="border-t border-zinc-800 pt-5">
                <h3 className="text-xs font-semibold uppercase tracking-wider text-zinc-500 mb-3">{t("settings.metrics.issues.heading")}</h3>
                <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
                  {[
                    { label: t("settings.metrics.total"),       value: metrics.totalIssues },
                    { label: t("settings.metrics.open"),        value: metrics.openIssues },
                    { label: t("settings.metrics.inProgress"), value: metrics.inProgressIssues },
                    { label: t("settings.metrics.resolved"),    value: metrics.resolvedIssues },
                  ].map(({ label, value }) => (
                    <div key={label} className="bg-zinc-800 border border-zinc-800 rounded-lg px-4 py-3">
                      <p className="text-xs text-zinc-500 mb-1">{label}</p>
                      <p className="text-xl font-semibold text-zinc-100 tabular-nums">{value.toLocaleString(locale)}</p>
                    </div>
                  ))}
                </div>
              </div>

              <div className="border-t border-zinc-800 pt-5">
                <div className="flex items-center justify-between mb-3">
                  <h3 className="text-xs font-semibold uppercase tracking-wider text-zinc-500">{t("settings.metrics.libraryCache.heading")}</h3>
                  <div className="flex items-center gap-2 flex-wrap">
                    <ResyncLibraryButton plexConfigured={plexConfigured} jellyfinConfigured={jellyfinConfigured} />
                    <SyncTVEpisodesButton />
                    <RatingsWarmButton />
                    <ActivityWarmButton />
                  </div>
                </div>
                <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
                  {[
                    { label: t("settings.metrics.plexItems"),           value: metrics.plexItems.toLocaleString(locale) },
                    { label: t("settings.metrics.jellyfinItems"),        value: metrics.jellyfinItems.toLocaleString(locale) },
                    { label: t("settings.metrics.tvEpisodes"),           value: metrics.episodeCacheEntries.toLocaleString(locale) },
                    { label: t("settings.metrics.plexTvCoverage"),      value: t("settings.metrics.coverageShows", { covered: metrics.plexShowsWithEps.toLocaleString(locale), total: metrics.plexTvShows.toLocaleString(locale) }) },
                    { label: t("settings.metrics.jellyfinTvCoverage"),  value: t("settings.metrics.coverageShows", { covered: metrics.jellyfinShowsWithEps.toLocaleString(locale), total: metrics.jellyfinTvShows.toLocaleString(locale) }) },
                    { label: t("settings.metrics.tmdbCache"),            value: metrics.tmdbCacheEntries.toLocaleString(locale) },
                    { label: t("settings.metrics.omdbCache"),            value: metrics.omdbCacheEntries.toLocaleString(locale) },
                    { label: t("settings.metrics.upcoming"),              value: metrics.upcomingItems.toLocaleString(locale) },
                    { label: t("settings.metrics.radarrWanted"),         value: metrics.radarrWanted.toLocaleString(locale) },
                    { label: t("settings.metrics.radarrAvailable"),      value: metrics.radarrAvailable.toLocaleString(locale) },
                    { label: t("settings.metrics.sonarrWanted"),         value: metrics.sonarrWanted.toLocaleString(locale) },
                    { label: t("settings.metrics.sonarrAvailable"),      value: metrics.sonarrAvailable.toLocaleString(locale) },
                    { label: t("settings.metrics.deletionVotes"),        value: metrics.deletionVotes.toLocaleString(locale) },
                  ].map(({ label, value }) => (
                    <div key={label} className="bg-zinc-800 border border-zinc-800 rounded-lg px-4 py-3">
                      <p className="text-xs text-zinc-500 mb-1">{label}</p>
                      <p className="text-xl font-semibold text-zinc-100 tabular-nums">{value}</p>
                    </div>
                  ))}
                </div>
              </div>

              <div className="border-t border-zinc-800 pt-5">
                <h3 className="text-xs font-semibold uppercase tracking-wider text-zinc-500 mb-3">{t("settings.metrics.tmdbCore.heading")}</h3>
                <p className="text-xs text-zinc-500 mb-3">
                  {t("settings.metrics.tmdbCore.description")}
                </p>
                <div className="grid grid-cols-2 sm:grid-cols-4 gap-2 mb-4">
                  {(() => {
                    const total = metrics.tmdbCoreEntries;

                    const libTotal = metrics.uniqueLibraryItems;
                    const coveragePct = libTotal > 0 ? Math.min(100, Math.round((total / libTotal) * 100)) : 0;
                    return [
                      { label: t("settings.metrics.totalEntries"),   value: total.toLocaleString(locale) },
                      { label: t("settings.metrics.movies"),           value: metrics.tmdbCoreMovies.toLocaleString(locale) },
                      { label: t("settings.metrics.tvShows"),         value: metrics.tmdbCoreTv.toLocaleString(locale) },
                      { label: t("settings.metrics.libraryCoverage"), value: libTotal > 0 ? `~${coveragePct}%` : "—", dim: total === 0 },
                    ].map(({ label, value, dim }) => (
                      <div key={label} className="bg-zinc-800 border border-zinc-800 rounded-lg px-4 py-3">
                        <p className="text-xs text-zinc-500 mb-1">{label}</p>
                        <p className={`text-xl font-semibold tabular-nums ${dim ? "text-zinc-500" : "text-zinc-100"}`}>{value}</p>
                      </div>
                    ));
                  })()}
                </div>
                <MasterDbFillButton plexConfigured={plexConfigured} jellyfinConfigured={jellyfinConfigured} />
              </div>

              <div className="border-t border-zinc-800 pt-5">
                <h3 className="text-xs font-semibold uppercase tracking-wider text-zinc-500 mb-3">{t("settings.metrics.playHistory.heading")}</h3>
                <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
                  {[
                    { label: t("settings.metrics.recordedSessions"),  value: metrics.playHistoryEntries.toLocaleString(locale) },
                    { label: t("settings.metrics.mediaServerUsers"), value: metrics.mediaServerUsers.toLocaleString(locale) },
                    { label: t("settings.metrics.currentShares"),     value: metrics.currentShares !== null ? metrics.currentShares.toLocaleString(locale) : "—" },
                    { label: t("settings.metrics.discordSearchCache"), value: metrics.discordCacheEntries.toLocaleString(locale) },
                  ].map(({ label, value }) => (
                    <div key={label} className="bg-zinc-800 border border-zinc-800 rounded-lg px-4 py-3">
                      <p className="text-xs text-zinc-500 mb-1">{label}</p>
                      <p className="text-xl font-semibold text-zinc-100 tabular-nums">{value}</p>
                    </div>
                  ))}
                </div>
              </div>

            </div>
          </div>
          </>
        )}

        </div>
      </div>
    </div>
  );
}
