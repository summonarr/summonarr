import { authActive } from "@/lib/auth";
import { prisma, getSettingDecryptFailures } from "@/lib/prisma";
import { parseCronLastRun, parseCronRunHistory, countCronRunsSince, CRON_RUN_HISTORY_LIMIT } from "@/lib/cron-history";
import { redirect } from "next/navigation";
import { first, type PageSearchParams } from "@/lib/search-params";
import { hasPermission, Permission } from "@/lib/permissions";
import { countPlexServerMembers } from "@/lib/plex";
import { getJellyfinUserCount } from "@/lib/jellyfin";
import { countUniqueLibraryItems } from "@/lib/library-iterator";
import { readDbCounts, type DbCounts } from "@/lib/settings-db-counts";
import { PageHeader } from "@/components/ui/design";
import { NotificationAgentsManager } from "@/components/settings/notification-agents-manager";
import { ArrForm, WebhookSecretForm, WebhookUrls, PlexConnectForm, JellyfinSyncForm, DonationForm, MotdForm, SiteTitleForm, SiteUrlForm, RateLimitForm, SessionForm, EmailForm, DiscordBotForm, OmdbForm, MdblistForm, TraktForm, IpinfoForm, CacheManagementPanel, LibraryMatchForm, RatingsWarmButton, ActivityWarmButton, QuotaForm, EnableUserEmailsToggle, MaintenanceForm, DeletionVoteThresholdForm, DisableLocalLoginToggle, JellyfinRestrictSignInToggle, EnableMachineSessionToggle, Request4kAllToggle, RatingsVisibilityForm, IosPushRelayForm, AnnounceUpdateButton, AuditRetentionForm } from "@/components/settings/settings-ui";
import { ArrInstancesManager } from "@/components/settings/arr-instances-manager";
import { ArrHealthPanel } from "@/components/admin/arr-health-panel";
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
import { PlexWatchlistServerToggles } from "@/components/settings/forms/plex-watchlist-server-toggles";
import { parsePlexWatchlistServerStatus } from "@/lib/plex-watchlist";
import { getFeatureFlags, groupFeaturesByCategory, isFeatureEnabled } from "@/lib/features";
import { parseHiddenRatingSources } from "@/lib/ratings-visibility";
import { MDBLIST_PLAN_SETTING_KEY, parseMdblistPlanSetting } from "@/lib/mdblist-plan";
import { getMdblistUsageSnapshot } from "@/lib/mdblist";
import { mfaEnforcementDisabledByEnv } from "@/lib/mfa/policy";
import { RequireAdminMfaToggle } from "@/components/settings/forms/require-admin-mfa-toggle";
import { OidcAllowlistForm } from "@/components/settings/forms/oidc-allowlist-form";
import { DEFAULT_OIDC_ALLOWLIST, OIDC_ALLOWLIST_SETTING_KEY, parseOidcAllowlist } from "@/lib/oidc-allowlist";
import { isOidcConfigured } from "@/lib/oidc";
import { getSyncableMediaInstances } from "@/lib/media-instance-registry";
import { configuredLibrarySyncServers } from "@/lib/library-sync-jobs";
import { SECRET_MASK_SENTINEL } from "@/lib/secret-mask";
import { ArrWatchForm } from "@/components/settings/forms/arr-watch-form";
import { ARR_WATCH_DISK_LOW_PERCENT_KEY, parseDiskLowPercent } from "@/lib/arr-watch";
import { getLocale, getTranslator } from "@/lib/i18n/server";
import type { Locale } from "@/lib/i18n/locales";
import type { Translator } from "@/lib/i18n/translate";
import { Suspense, type ReactNode } from "react";
import { siteBaseUrl } from "@/lib/site-base-url";
import { LocalDateTime } from "@/components/local-date-time";
import { STATS_TIME_ZONE_KEY, processTimeZone } from "@/lib/stats-time-zone";

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
    { id: "plex-watchlist", i18nKey: "settings.nav.plexWatchlist", group: "settings.group.mediaServers" },
    { id: "jellyfin", i18nKey: "settings.nav.jellyfin", group: "settings.group.mediaServers" },
    { id: "media-instances", i18nKey: "settings.nav.mediaInstances", group: "settings.group.mediaServers" },
    { id: "play-history", i18nKey: "settings.nav.playHistory", group: "settings.group.mediaServers" },
    { id: "watch-grades", i18nKey: "settings.nav.watchGrades", group: "settings.group.mediaServers" },
    { id: "library-matching", i18nKey: "settings.nav.libraryMatching", group: "settings.group.mediaServers" },
    { id: "radarr", i18nKey: "settings.nav.radarr", group: "settings.group.automation" },
    { id: "radarr4k", i18nKey: "settings.nav.radarr4k", group: "settings.group.automation" },
    { id: "sonarr", i18nKey: "settings.nav.sonarr", group: "settings.group.automation" },
    { id: "sonarr4k", i18nKey: "settings.nav.sonarr4k", group: "settings.group.automation" },
    { id: "request-4k", i18nKey: "settings.nav.request4k", group: "settings.group.automation" },
    { id: "arr-instances", i18nKey: "settings.nav.arrInstances", group: "settings.group.automation" },
  ],
  notifications: [
    { id: "email", i18nKey: "settings.nav.email", group: "settings.group.notifications" },
    { id: "discord-bot", i18nKey: "settings.nav.discordBot", group: "settings.group.notifications" },
    { id: "ios-push-relay", i18nKey: "settings.nav.iosPushRelay", group: "settings.group.notifications" },
    { id: "notification-agents", i18nKey: "settings.nav.notificationAgents", group: "settings.group.notifications" },
    { id: "arr-alerts", i18nKey: "settings.nav.arrAlerts", group: "settings.group.notifications" },
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
  if (n % 86_400 === 0) return t("settings.cron.interval.days", { n: n / 86_400 });
  if (n % 3_600 === 0) return t("settings.cron.interval.hours", { n: n / 3_600 });
  if (n % 60 === 0) return t("settings.cron.interval.minutes", { n: n / 60 });
  return t("settings.cron.interval.seconds", { n });
}

function StatusBadge({ connected, t }: { connected: boolean; t: Translator }) {
  if (connected) {
    return (
      <span className="ds-chip ds-chip-approved">{t("settings.common.connected")}</span>
    );
  }
  return (
    <span className="ds-chip">{t("settings.common.notConfigured")}</span>
  );
}

// Every card on the page: one surface, one radius, one header recipe. The
// cards used to carry this inline and had drifted — descriptions were 14px
// subtle on some tabs and 12px muted on others, the badge row had its own
// margin, and one card had no header at all. `id` is what the side nav's
// `#hash` links and the scroll-spy target; `.settings-sections > [id]` in
// globals.css gives it the scroll margin.
function SettingsCard({
  id,
  title,
  description,
  badge,
  children,
}: {
  id: string;
  title: ReactNode;
  description?: ReactNode;
  badge?: ReactNode;
  children: ReactNode;
}) {
  const heading = (
    <h2 className="font-semibold" style={{ fontSize: 15, letterSpacing: "-0.01em", color: "var(--ds-fg)", margin: 0 }}>
      {title}
    </h2>
  );
  return (
    <div
      id={id}
      style={{ padding: 22, background: "var(--ds-bg-2)", border: "1px solid var(--ds-border)", borderRadius: "var(--ds-r-lg)" }}
    >
      <div className="mb-5">
        {badge ? <div className="flex items-center gap-3">{heading}{badge}</div> : heading}
        {description && (
          <p style={{ fontSize: 12, color: "var(--ds-fg-muted)", margin: "4px 0 0", lineHeight: 1.5 }}>{description}</p>
        )}
      </div>
      {children}
    </div>
  );
}

const ALL_KEYS = [
  "radarrUrl", "radarrApiKey", "radarrRootFolder", "radarrQualityProfileId", "radarrMinimumAvailability", "radarrExternalUrl",
  "sonarrUrl", "sonarrApiKey", "sonarrRootFolder", "sonarrQualityProfileId", "sonarrLanguageProfileId", "sonarrExternalUrl",
  "webhookSecret", "sonarrWebhookSecret", "radarrWebhookSecret",
  "radarr4kUrl", "radarr4kApiKey", "radarr4kRootFolder", "radarr4kQualityProfileId", "radarr4kMinimumAvailability", "radarr4kWebhookSecret", "radarr4kExternalUrl",
  "sonarr4kUrl", "sonarr4kApiKey", "sonarr4kRootFolder", "sonarr4kQualityProfileId", "sonarr4kLanguageProfileId", "sonarr4kWebhookSecret", "sonarr4kExternalUrl",
  "request4kAll",
  // plexAdminToken is read here for the system tab's Plex share count.
  "plexAdminEmail", "plexServerUrl", "plexAdminToken", "plexLibraries", "plexMoviePathStripPrefix", "plexTvPathStripPrefix",
  "jellyfinUrl", "jellyfinApiKey", "jellyfinLibraries", "jellyfinMoviePathStripPrefix", "jellyfinTvPathStripPrefix",
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
  "concurrentStreamLimit", "playHistoryWatchedThreshold", "playHistoryCompletionThreshold", "playHistoryArcGapDays",
  "playHistoryPollingInterval", "playHistoryRetentionDays", STATS_TIME_ZONE_KEY,
  "watchGradeGraceDays", "watchGradeWindowDays", "watchGradeTvPercent", "watchGradeOtherViewers",
  "watchGradeBandA", "watchGradeBandB", "watchGradeBandC", "watchGradeBandD", "watchGradeMinRequests",
  "omdbApiKey", "mdblistApiKey", MDBLIST_PLAN_SETTING_KEY, "traktClientId", "traktClientSecret", "ratingsHiddenSources",
  "ipinfoToken",
  "apnsRelayUrl", "apnsRelayKey", "recommendedIosBuild",
  "auditPiiRetentionDays",
  "plexWatchlistServerSource", "plexWatchlistServerAutoEnroll", "plexWatchlistServerStatus",
  ARR_WATCH_DISK_LOW_PERCENT_KEY,
  OIDC_ALLOWLIST_SETTING_KEY,
] as const;

// Placeholder a translated sentence is split on so a client-formatted value can
// be rendered in its place (see the Plex watchlist status line). NUL can't occur
// in a catalog string.
const TIME_SLOT = "\u0000";

// The MDBList plan picker's usage line before anything is known.
const EMPTY_MDBLIST_USAGE = {
  reportedLimit: null,
  reportedPlan: null,
  usedToday: null,
  backgroundStopped: false,
  pausedUntil: null,
} as const;

const VALID_TABS: TabId[] = ["site", "media", "notifications", "integrations", "features", "system"];

// Every scheduled job the System tab lists, once: the run-ledger target its
// last run and runs/h are read under, the endpoint its Run button POSTs to, and
// the interval env var with the container's default (docker-entrypoint.sh's
// _CRON_JOBS). Catalog keys are written out whole so the unused-key scan sees
// them.
const CRON_JOBS: ReadonlyArray<{
  target: string;
  nameKey: string;
  descriptionKey: string;
  endpoint: string;
  envVar: string;
  defaultSeconds: string;
}> = [
  { target: "sync:full", nameKey: "settings.cron.job.librarySync.name", descriptionKey: "settings.cron.job.librarySync.description", endpoint: "/api/sync", envVar: "SYNC_INTERVAL", defaultSeconds: "3600" },
  { target: "upcoming-cache", nameKey: "settings.cron.job.upcomingSync.name", descriptionKey: "settings.cron.job.upcomingSync.description", endpoint: "/api/sync/upcoming", envVar: "UPCOMING_SYNC_INTERVAL", defaultSeconds: "86400" },
  { target: "ratings-sync", nameKey: "settings.cron.job.ratingsSync.name", descriptionKey: "settings.cron.job.ratingsSync.description", endpoint: "/api/sync/ratings", envVar: "RATINGS_SYNC_INTERVAL", defaultSeconds: "86400" },
  { target: "list-cache", nameKey: "settings.cron.job.warmListCache.name", descriptionKey: "settings.cron.job.warmListCache.description", endpoint: "/api/cron/warm-list-cache", envVar: "LIST_CACHE_SYNC_INTERVAL", defaultSeconds: "21600" },
  { target: "activity", nameKey: "settings.cron.job.warmActivity.name", descriptionKey: "settings.cron.job.warmActivity.description", endpoint: "/api/cron/warm-activity", envVar: "WARM_ACTIVITY_INTERVAL", defaultSeconds: "1800" },
  { target: "mdblist", nameKey: "settings.cron.job.warmMdblist.name", descriptionKey: "settings.cron.job.warmMdblist.description", endpoint: "/api/cron/warm-mdblist", envVar: "WARM_MDBLIST_INTERVAL", defaultSeconds: "86400" },
  { target: "omdb", nameKey: "settings.cron.job.warmOmdb.name", descriptionKey: "settings.cron.job.warmOmdb.description", endpoint: "/api/cron/warm-omdb", envVar: "WARM_OMDB_INTERVAL", defaultSeconds: "86400" },
  { target: "recommendations", nameKey: "settings.cron.job.warmRecommendations.name", descriptionKey: "settings.cron.job.warmRecommendations.description", endpoint: "/api/cron/warm-recommendations", envVar: "WARM_RECOMMENDATIONS_INTERVAL", defaultSeconds: "43200" },
  // Distinct from Admin -> Library's "Warm library cache" button, which
  // POSTs /api/admin/library-warm: that one runs the metadata walk ALONE,
  // records no cron run, and so never appears in this table. This row is
  // the only browser trigger that also builds the suggestion graph.
  { target: "library", nameKey: "settings.cron.job.warmLibrary.name", descriptionKey: "settings.cron.job.warmLibrary.description", endpoint: "/api/cron/warm-library", envVar: "WARM_LIBRARY_INTERVAL", defaultSeconds: "86400" },
  { target: "auth-sessions:purge-expired", nameKey: "settings.cron.job.purgeSessions.name", descriptionKey: "settings.cron.job.purgeSessions.description", endpoint: "/api/cron/purge-auth-sessions", envVar: "PURGE_SESSIONS_INTERVAL", defaultSeconds: "86400" },
  { target: "notifications:purge", nameKey: "settings.cron.job.purgeNotifications.name", descriptionKey: "settings.cron.job.purgeNotifications.description", endpoint: "/api/cron/purge-notifications", envVar: "PURGE_NOTIFICATIONS_INTERVAL", defaultSeconds: "86400" },
  { target: "audit-log:pii-scrub", nameKey: "settings.cron.job.scrubAuditPii.name", descriptionKey: "settings.cron.job.scrubAuditPii.description", endpoint: "/api/cron/scrub-audit-pii", envVar: "SCRUB_AUDIT_PII_INTERVAL", defaultSeconds: "86400" },
  { target: "trash-sync", nameKey: "settings.cron.job.trashSync.name", descriptionKey: "settings.cron.job.trashSync.description", endpoint: "/api/cron/trash-sync", envVar: "TRASH_SYNC_INTERVAL", defaultSeconds: "86400" },
  { target: "plex-watchlist", nameKey: "settings.cron.job.plexWatchlist.name", descriptionKey: "settings.cron.job.plexWatchlist.description", endpoint: "/api/cron/sync-plex-watchlists", envVar: "PLEX_WATCHLIST_SYNC_INTERVAL", defaultSeconds: "1800" },
  { target: "trakt", nameKey: "settings.cron.job.trakt.name", descriptionKey: "settings.cron.job.trakt.description", endpoint: "/api/cron/sync-trakt", envVar: "TRAKT_SYNC_INTERVAL", defaultSeconds: "1800" },
  { target: "upstream-watch", nameKey: "settings.cron.job.upstreamWatch.name", descriptionKey: "settings.cron.job.upstreamWatch.description", endpoint: "/api/cron/refresh-upstream-watch", envVar: "UPSTREAM_WATCH_SYNC_INTERVAL", defaultSeconds: "86400" },
  { target: "watch-sync", nameKey: "settings.cron.job.watchSync.name", descriptionKey: "settings.cron.job.watchSync.description", endpoint: "/api/cron/watch-sync", envVar: "WATCH_SYNC_INTERVAL", defaultSeconds: "300" },
  { target: "arr-watch", nameKey: "settings.cron.job.arrWatch.name", descriptionKey: "settings.cron.job.arrWatch.description", endpoint: "/api/cron/arr-watch", envVar: "ARR_WATCH_INTERVAL", defaultSeconds: "900" },
  { target: "arr-snapshots", nameKey: "settings.cron.job.arrSnapshots.name", descriptionKey: "settings.cron.job.arrSnapshots.description", endpoint: "/api/cron/refresh-arr-snapshots", envVar: "ARR_SNAPSHOT_INTERVAL", defaultSeconds: "300" },
  // Not a container cron of its own: the orchestrator runs the same pass every
  // sync, so it shares the library sync's interval.
  { target: "download-policies", nameKey: "settings.cron.job.downloadPolicy.name", descriptionKey: "settings.cron.job.downloadPolicy.description", endpoint: "/api/cron/sync-download-policies", envVar: "SYNC_INTERVAL", defaultSeconds: "3600" },
];

// One metric group's tiles. Values arrive formatted, so toLocaleString runs
// here on the server in the page's locale; `dim` greys a value that means
// "nothing yet".
function MetricGrid({ items, className }: { items: Array<{ label: string; value: ReactNode; dim?: boolean }>; className?: string }) {
  return (
    <div className={className ? `grid grid-cols-2 sm:grid-cols-4 gap-2 ${className}` : "grid grid-cols-2 sm:grid-cols-4 gap-2"}>
      {items.map(({ label, value, dim }) => (
        <div key={label} className="bg-zinc-800 border border-zinc-800 rounded-lg px-4 py-3">
          <p className="text-xs text-zinc-500 mb-1">{label}</p>
          <p className={`text-xl font-semibold tabular-nums ${dim ? "text-zinc-500" : "text-zinc-100"}`}>{value}</p>
        </div>
      ))}
    </div>
  );
}

// The "Current shares" tile's value: awaited behind its own <Suspense>, because
// the live Plex/Jellyfin calls behind it can take up to ~30s against an
// unreachable plex.tv and must not hold the rest of the System tab.
async function CurrentSharesValue({ count, locale }: { count: Promise<number | null>; locale: Locale }) {
  const n = await count;
  return <>{n !== null ? n.toLocaleString(locale) : "—"}</>;
}

export default async function SettingsPage({
  searchParams,
}: {
  searchParams: Promise<PageSearchParams>;
}) {
  const [sp, session] = await Promise.all([searchParams, authActive()]);
  if (!session || !hasPermission(session.user.permissions, Permission.ADMIN)) redirect("/");

  const [t, locale] = await Promise.all([getTranslator(), getLocale()]);
  const rawTab = first(sp.tab) as TabId | undefined;
  const tab: TabId = rawTab && VALID_TABS.includes(rawTab) ? rawTab : "site";

  const rows = await prisma.setting.findMany({ where: { key: { in: [...ALL_KEYS] } } });
  const cfg = Object.fromEntries(rows.map((r) => [r.key, r.value]));
  const agentsFeatureEnabled = tab === "notifications" ? await isFeatureEnabled("feature.integration.webhooks") : true;
  // Read AFTER findMany so the set reflects this render's decrypt outcomes.
  // safeDecryptSettingValue clears entries on successful read, so the banner
  // disappears automatically on the next page load after the operator re-saves.
  const decryptFailures = getSettingDecryptFailures();
  // null ⇒ the stored allowlist doesn't parse, and sign-in is refusing every
  // OIDC login until it is re-saved (guardrail 34e).
  const oidcAllowlist = parseOidcAllowlist(cfg[OIDC_ALLOWLIST_SETTING_KEY]);
  // What MDBList last reported about the account, for the plan picker. Only the
  // integrations tab shows it.
  const mdblistSnapshot = tab === "integrations" ? await getMdblistUsageSnapshot() : null;
  // Whether any non-password sign-in works — the login page's own predicates for
  // its Plex / Jellyfin / SSO tabs. "Disable local login" can't be switched on
  // without one (the settings route refuses it too).
  const externalSignInConfigured =
    tab === "site"
      ? isOidcConfigured() ||
        (await Promise.all([getSyncableMediaInstances("plex"), getSyncableMediaInstances("jellyfin")])).some(
          (instances) => instances.length > 0,
        )
      : true;
  // Only the fields the form shows reach the browser.
  const mdblistUsage = mdblistSnapshot && {
    reportedLimit: mdblistSnapshot.reportedLimit,
    reportedPlan: mdblistSnapshot.reportedPlan,
    usedToday: mdblistSnapshot.usedToday,
    backgroundStopped: mdblistSnapshot.backgroundStopped,
    pausedUntil: mdblistSnapshot.pausedUntil,
  };

  // Every connected Plex/Jellyfin server, default and named (guardrail 35), so
  // the system tab's sync buttons resync each one and skip a server that is not
  // there instead of POSTing to it and reading the resulting 400 as a failure
  // (guardrail 36).
  const syncServers = tab === "system" ? await configuredLibrarySyncServers() : [];

  // The copyable webhook URLs' root: a cleared Site URL ("") falls through to
  // AUTH_URL, and BASE_PATH is on the end so a sub-path install's URLs resolve.
  // The token itself never reaches the page (the copy button fetches it).
  const baseUrl = siteBaseUrl(cfg.siteUrl, process.env.AUTH_URL, process.env.BASE_PATH);

  let metrics: (DbCounts & {
    uniqueLibraryItems: number;
    currentShares: Promise<number | null>;
    cronJobs: CronJobInfo[];
  }) | null = null;

  if (tab === "system") {
    // Started first so it overlaps the database reads, and awaited only inside
    // the tile's <Suspense> (CurrentSharesValue): live server calls must not
    // hold the tab. An unconfigured server is never asked (guardrail 36).
    // plexAdminToken / jellyfinUrl / jellyfinApiKey are all in ALL_KEYS, so `cfg`
    // already holds the decrypted values (the prisma extension decrypts findMany
    // rows exactly as it does findUnique) — no second read needed.
    const currentShares = Promise.allSettled([
      // This server's members (owner + the friends it is shared with), not
      // every plex.tv friend of the admin account; null when the server or
      // plex.tv can't answer, so the tile shows "—" rather than a wrong count.
      cfg.plexServerUrl && cfg.plexAdminToken
        ? countPlexServerMembers(cfg.plexAdminToken, cfg.plexServerUrl)
        : Promise.resolve(null),
      cfg.jellyfinUrl && cfg.jellyfinApiKey
        ? getJellyfinUserCount(cfg.jellyfinUrl, cfg.jellyfinApiKey)
        : Promise.resolve(null),
    ]).then(([plex, jellyfin]) => {
      const plexCount = plex.status === "fulfilled" ? plex.value : null;
      const jfCount = jellyfin.status === "fulfilled" ? jellyfin.value : null;
      return plexCount === null && jfCount === null ? null : (plexCount ?? 0) + (jfCount ?? 0);
    });

    // Primary source: `Setting` rows written by `recordCronRun` on every run
    // (admin- or cron-triggered). Several warm jobs deliberately skip the
    // audit log on cron to avoid flooding, so reading the audit table alone
    // showed stale "Last Run" values for those jobs.
    const cronTargets = CRON_JOBS.map((job) => job.target);
    const settingKeys = cronTargets.map((t) => `cron:lastRun:${t}`);
    const [counts, uniqueLibraryItems, lastRunSettings] = await Promise.all([
      readDbCounts(new Date()),
      countUniqueLibraryItems(),
      prisma.setting.findMany({
        where: { key: { in: settingKeys } },
        select: { key: true, value: true },
      }),
    ]);

    const lastRunMap = new Map<string, { createdAt: Date; details: string | null }>();
    // Bounded run history, Setting-rows only — the audit-log fallback below has
    // no equivalent, so a target that only ever reported there stays null and
    // the table simply omits a rate for it rather than showing a wrong one.
    const historyMap = new Map<string, ReturnType<typeof parseCronRunHistory>>();
    for (const s of lastRunSettings) {
      const target = s.key.replace(/^cron:lastRun:/, "");
      historyMap.set(target, parseCronRunHistory(s.value));
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

    // The audit log is the fallback for a job with no usable ledger row (one
    // that has not run since the ledger existed), so it is asked only for those.
    // One index-bounded LIMIT-1 read per target (`@@index([target])`), NOT a
    // single `distinct: ["target"]` query: Prisma's query compiler implements
    // `distinct` client-side, so that shape transferred EVERY audit row for
    // these targets (the orchestrator writes one per run, kept for 365 days)
    // into Node on each System-tab render just to keep one per target.
    const unrecorded = cronTargets.filter((target) => !lastRunMap.has(target));
    const lastRuns = await Promise.all(
      unrecorded.map((target) =>
        prisma.auditLog.findFirst({
          where: { target },
          orderBy: { createdAt: "desc" },
          select: { target: true, createdAt: true, details: true },
        }),
      ),
    );
    for (const r of lastRuns) {
      if (!r) continue;
      lastRunMap.set(r.target, { createdAt: r.createdAt, details: r.details });
    }

    // Read the clock ONCE, here on the server, and pass the resulting counts to
    // the client component as plain numbers (guardrail 16) — the cron table is
    // a "use client" component, so a clock read on its side of the boundary
    // would be the hydration bug that guardrail exists to prevent.
    // eslint-disable-next-line react-hooks/purity -- server component; Date.now() runs once per request
    const oneHourAgoMs = Date.now() - 60 * 60 * 1000;

    metrics = {
      ...counts,
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

    return CRON_JOBS.map((job) => ({
      name: t(job.nameKey),
      description: t(job.descriptionKey),
      endpoint: job.endpoint,
      interval: formatInterval(t, process.env[job.envVar], job.defaultSeconds),
      ...lastRunInfo(job.target),
    }));
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
            <SettingsCard
              id="general"
              title={t("settings.section.general.title")}
              description={t("settings.section.general.description")}
            >
              <div className="space-y-6">
                <SiteTitleForm initialTitle={cfg.siteTitle ?? ""} />
                <SiteUrlForm initialUrl={cfg.siteUrl ?? ""} />
              </div>
            </SettingsCard>

            <SettingsCard
              id="rate-limiting"
              title={t("settings.section.rateLimiting.title")}
              description={t("settings.section.rateLimiting.description")}
            >
              <RateLimitForm
                initialRegister={cfg.rateLimitRegister ?? ""}
                initialRequests={cfg.rateLimitRequests ?? ""}
                initialIssues={cfg.rateLimitIssues ?? ""}
                initialMaxPushSubscriptions={cfg.maxPushSubscriptions ?? ""}
              />
            </SettingsCard>

            <SettingsCard
              id="quotas"
              title={t("settings.section.quotas.title")}
              description={t("settings.section.quotas.description")}
            >
              <QuotaForm
                initialLimit={cfg.quotaLimit ?? ""}
                initialPeriod={cfg.quotaPeriod ?? ""}
              />
            </SettingsCard>

            <SettingsCard
              id="deletion-votes"
              title={t("settings.section.deletionVotes.title")}
              description={t("settings.section.deletionVotes.description")}
            >
              <DeletionVoteThresholdForm initialThreshold={cfg.deletionVoteThreshold ?? ""} />
            </SettingsCard>

            <SettingsCard
              id="authentication"
              title={t("settings.section.authentication.title")}
              description={t("settings.section.authentication.description")}
            >
              {/* The rows carry no spacing or rules of their own; this stack
                  supplies both, so the rows read as one list (the features
                  tab's switch list uses the same recipe). */}
              <div className="divide-y divide-[var(--ds-border)] [&>*]:py-3 [&>*:first-child]:pt-0 [&>*:last-child]:pb-0">
                <DisableLocalLoginToggle
                  initialDisabled={cfg.disableLocalLogin === "true"}
                  externalSignInConfigured={externalSignInConfigured}
                />
                <RequireAdminMfaToggle
                  initialRequired={cfg.requireMfaForAdmins === "true"}
                  envOverride={mfaEnforcementDisabledByEnv()}
                />
                <JellyfinRestrictSignInToggle initialRestrict={cfg.jellyfinRestrictSignIn !== "false"} />
                <EnableMachineSessionToggle
                  initialEnabled={cfg.enableMachineSession === "true"}
                  initialAllowedIps={cfg.machineSessionAllowedIps ?? ""}
                />
                <OidcAllowlistForm
                  initial={oidcAllowlist ?? DEFAULT_OIDC_ALLOWLIST}
                  initialUnreadable={oidcAllowlist === null}
                  oidcConfigured={isOidcConfigured()}
                />
              </div>
            </SettingsCard>

            <SettingsCard
              id="sessions"
              title={t("settings.section.sessions.title")}
              description={t("settings.section.sessions.description")}
            >
              <SessionForm
                initialDefaultDuration={cfg.sessionDefaultDuration ?? ""}
                initialMobileDuration={cfg.sessionMobileDuration ?? ""}
                initialMaxDuration={cfg.sessionMaxDuration ?? ""}
              />
            </SettingsCard>

            <SettingsCard
              id="maintenance"
              title={t("settings.section.maintenance.title")}
              description={t("settings.section.maintenance.description")}
            >
              <MaintenanceForm
                initialEnabled={cfg.maintenanceEnabled === "true"}
                initialMessage={cfg.maintenanceMessage ?? ""}
              />
            </SettingsCard>

            <SettingsCard
              id="motd"
              title={t("settings.section.motd.title")}
              description={t("settings.section.motd.description")}
            >
              <MotdForm
                initialEnabled={cfg.motdEnabled === "true"}
                initialTitle={cfg.motdTitle ?? ""}
                initialBody={cfg.motdBody ?? ""}
              />
            </SettingsCard>

            <SettingsCard
              id="donations"
              title={t("settings.section.donations.title")}
              description={t("settings.section.donations.description")}
            >
              <DonationForm
                initialPaypal={cfg.donationPaypal ?? ""}
                initialVenmo={cfg.donationVenmo ?? ""}
                initialZelle={cfg.donationZelle ?? ""}
                initialAmazon={cfg.donationAmazon ?? ""}
                initialPatreon={cfg.donationPatreon ?? ""}
                initialBuyMeACoffee={cfg.donationBuyMeACoffee ?? ""}
              />
            </SettingsCard>
          </>
        )}

        {tab === "media" && (
          <>
            <SettingsCard
              id="plex"
              title="Plex"
              badge={<StatusBadge t={t} connected={!!cfg.plexAdminEmail} />}
              description={t("settings.section.plex.description")}
            >
              <PlexConnectForm
                initialEmail={cfg.plexAdminEmail ?? ""}
                initialServerUrl={cfg.plexServerUrl ?? ""}
                initialPlexLibraries={cfg.plexLibraries ?? ""}
                siteUrl={cfg.siteUrl || process.env.AUTH_URL || ""}
              />
            </SettingsCard>

            <SettingsCard
              id="plex-watchlist"
              title={t("settings.section.plexWatchlist.title")}
              description={t("settings.section.plexWatchlist.description")}
            >
              <PlexWatchlistServerToggles
                initialServerSource={cfg.plexWatchlistServerSource === "true"}
                initialAutoEnroll={cfg.plexWatchlistServerAutoEnroll === "true"}
              />
              {cfg.plexWatchlistServerSource === "true" && (() => {
                const st = parsePlexWatchlistServerStatus(cfg.plexWatchlistServerStatus);
                if (!st) return <p className="text-xs text-zinc-500 mt-4">{t("settings.plexWatchlist.status.never")}</p>;
                const counts = { ok: 0, private: 0, error: 0 };
                for (const v of Object.values(st.users)) counts[v]++;
                // The run time is formatted on the CLIENT (LocalDateTime, mounted-gated
                // — guardrail 16) so it reads in the viewer's timezone, not the
                // container's. The sentence comes from one catalog string, so it is
                // translated with a sentinel where `{time}` goes and split there.
                const [beforeTime, afterTime] = t("settings.plexWatchlist.status.summary", {
                  time: TIME_SLOT,
                  ok: counts.ok,
                  private: counts.private,
                  error: counts.error,
                  unmatched: st.unmatchedFriends,
                }).split(TIME_SLOT);
                return (
                  <p className="text-xs text-zinc-500 mt-4">
                    {beforeTime}
                    <LocalDateTime iso={st.updatedAt} />
                    {afterTime}
                  </p>
                );
              })()}
            </SettingsCard>

            <SettingsCard
              id="jellyfin"
              title="Jellyfin"
              badge={<StatusBadge t={t} connected={!!(cfg.jellyfinUrl && cfg.jellyfinApiKey)} />}
              description={t("settings.section.jellyfin.description")}
            >
              <JellyfinSyncForm
                initialUrl={cfg.jellyfinUrl ?? ""}
                initialApiKey={cfg.jellyfinApiKey ? SECRET_MASK_SENTINEL : ""}
                initialJellyfinLibraries={cfg.jellyfinLibraries ?? ""}
              />
            </SettingsCard>

            <SettingsCard
              id="media-instances"
              title={t("settings.section.mediaInstances.title")}
              description={t("settings.section.mediaInstances.description")}
            >
              <div className="space-y-8">
                <MediaInstancesManager service="plex" />
                <MediaInstancesManager service="jellyfin" />
              </div>
            </SettingsCard>

            <SettingsCard
              id="play-history"
              title={t("settings.section.playHistory.title")}
              description={t("settings.section.playHistory.description")}
            >
              <PlayHistorySettingsForm
                initialEnabled={cfg.playHistoryEnabled ?? ""}
                initialPlexEnabled={cfg.playHistoryPlexEnabled ?? ""}
                initialJellyfinEnabled={cfg.playHistoryJellyfinEnabled ?? ""}
                initialWatchedThreshold={cfg.playHistoryWatchedThreshold ?? "80"}
                initialCompletionThreshold={cfg.playHistoryCompletionThreshold ?? "90"}
                initialArcGapDays={cfg.playHistoryArcGapDays ?? "14"}
                initialPollingInterval={cfg.playHistoryPollingInterval ?? "5"}
                initialRetentionDays={cfg.playHistoryRetentionDays ?? "0"}
                initialConcurrentStreamLimit={cfg.concurrentStreamLimit ?? "0"}
                initialStatsTimeZone={cfg.statsTimeZone ?? ""}
                // What a blank zone means: the server process's own (TZ).
                defaultStatsTimeZone={processTimeZone()}
              />
            </SettingsCard>

            <SettingsCard
              id="watch-grades"
              title={t("settings.section.watchGrades.title")}
              description={t("settings.section.watchGrades.description")}
            >
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
            </SettingsCard>

            <SettingsCard
              id="library-matching"
              title={t("settings.section.libraryMatching.title")}
              description={t("settings.section.libraryMatching.description")}
            >
              <LibraryMatchForm
                initialPlexMoviePrefix={cfg.plexMoviePathStripPrefix ?? ""}
                initialPlexTvPrefix={cfg.plexTvPathStripPrefix ?? ""}
                initialJellyfinMoviePrefix={cfg.jellyfinMoviePathStripPrefix ?? ""}
                initialJellyfinTvPrefix={cfg.jellyfinTvPathStripPrefix ?? ""}
              />
            </SettingsCard>

            <SettingsCard
              id="radarr"
              title="Radarr"
              badge={<StatusBadge t={t} connected={!!(cfg.radarrUrl && cfg.radarrApiKey)} />}
              description={t("settings.section.radarr.description")}
            >
              <ArrForm
                service="radarr"
                initialUrl={cfg.radarrUrl ?? ""}
                initialExternalUrl={cfg.radarrExternalUrl ?? ""}
                initialApiKey={cfg.radarrApiKey ? SECRET_MASK_SENTINEL : ""}
                initialRootFolder={cfg.radarrRootFolder ?? ""}
                initialQualityProfileId={cfg.radarrQualityProfileId ?? ""}
                initialMinimumAvailability={cfg.radarrMinimumAvailability ?? ""}
              />
            </SettingsCard>

            <SettingsCard
              id="radarr4k"
              title={<>Radarr 4K <span style={{fontSize:12,color:"var(--ds-fg-subtle)",fontWeight:400}}>{t("settings.common.optional")}</span></>}
              badge={<StatusBadge t={t} connected={!!(cfg.radarr4kUrl && cfg.radarr4kApiKey)} />}
              description={t("settings.section.radarr4k.description")}
            >
              <ArrForm
                service="radarr"
                variant="4k"
                initialUrl={cfg.radarr4kUrl ?? ""}
                initialExternalUrl={cfg.radarr4kExternalUrl ?? ""}
                initialApiKey={cfg.radarr4kApiKey ? SECRET_MASK_SENTINEL : ""}
                initialRootFolder={cfg.radarr4kRootFolder ?? ""}
                initialQualityProfileId={cfg.radarr4kQualityProfileId ?? ""}
                initialMinimumAvailability={cfg.radarr4kMinimumAvailability ?? ""}
              />
            </SettingsCard>

            <SettingsCard
              id="sonarr"
              title="Sonarr"
              badge={<StatusBadge t={t} connected={!!(cfg.sonarrUrl && cfg.sonarrApiKey)} />}
              description={t("settings.section.sonarr.description")}
            >
              <ArrForm
                service="sonarr"
                initialUrl={cfg.sonarrUrl ?? ""}
                initialExternalUrl={cfg.sonarrExternalUrl ?? ""}
                initialApiKey={cfg.sonarrApiKey ? SECRET_MASK_SENTINEL : ""}
                initialRootFolder={cfg.sonarrRootFolder ?? ""}
                initialQualityProfileId={cfg.sonarrQualityProfileId ?? ""}
                initialLanguageProfileId={cfg.sonarrLanguageProfileId ?? ""}
              />
            </SettingsCard>

            <SettingsCard
              id="sonarr4k"
              title={<>Sonarr 4K <span style={{fontSize:12,color:"var(--ds-fg-subtle)",fontWeight:400}}>{t("settings.common.optional")}</span></>}
              badge={<StatusBadge t={t} connected={!!(cfg.sonarr4kUrl && cfg.sonarr4kApiKey)} />}
              description={t("settings.section.sonarr4k.description")}
            >
              <ArrForm
                service="sonarr"
                variant="4k"
                initialUrl={cfg.sonarr4kUrl ?? ""}
                initialExternalUrl={cfg.sonarr4kExternalUrl ?? ""}
                initialApiKey={cfg.sonarr4kApiKey ? SECRET_MASK_SENTINEL : ""}
                initialRootFolder={cfg.sonarr4kRootFolder ?? ""}
                initialQualityProfileId={cfg.sonarr4kQualityProfileId ?? ""}
                initialLanguageProfileId={cfg.sonarr4kLanguageProfileId ?? ""}
              />
            </SettingsCard>

            <SettingsCard
              id="request-4k"
              title={t("settings.section.request4k.title")}
              description={t("settings.section.request4k.description")}
            >
              <Request4kAllToggle initialEnabled={cfg.request4kAll === "true"} />
            </SettingsCard>

            <SettingsCard
              id="arr-instances"
              title={t("settings.section.arrInstances.title")}
              description={t("settings.section.arrInstances.description")}
            >
              <ArrInstancesManager />
            </SettingsCard>
          </>
        )}

        {tab === "notifications" && (
          <>
            <SettingsCard
              id="email"
              title={t("settings.section.email.title")}
              badge={<StatusBadge t={t} connected={cfg.emailBackend === "resend" ? !!cfg.resendApiKey : !!cfg.smtpHost} />}
              description={t("settings.section.email.description")}
            >
              <EmailForm
                initialBackend={cfg.emailBackend === "resend" ? "resend" : "smtp"}
                initialHost={cfg.smtpHost ?? ""}
                initialPort={cfg.smtpPort ?? ""}
                initialUser={cfg.smtpUser ?? ""}
                initialPassword={cfg.smtpPassword ? SECRET_MASK_SENTINEL : ""}
                initialFrom={cfg.smtpFrom ?? ""}
                initialResendApiKey={cfg.resendApiKey ? SECRET_MASK_SENTINEL : ""}
                initialResendFrom={cfg.resendFrom ?? ""}
              />
              <EnableUserEmailsToggle initialEnabled={cfg.enableUserEmails === "true"} />
            </SettingsCard>

            <SettingsCard
              id="discord-bot"
              title={t("settings.section.discordBot.title")}
              badge={<StatusBadge t={t} connected={!!cfg.discordBotToken} />}
              description={t("settings.section.discordBot.description")}
            >
              <DiscordBotForm
                initialBotToken={cfg.discordBotToken ? SECRET_MASK_SENTINEL : ""}
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
            </SettingsCard>

            <SettingsCard
              id="ios-push-relay"
              title={t("settings.section.iosPushRelay.title")}
              description={t("settings.section.iosPushRelay.description")}
            >
              <div className="space-y-6">
                <IosPushRelayForm
                  initialRelayUrl={cfg.apnsRelayUrl ?? ""}
                  initialRelayKey={cfg.apnsRelayKey ? SECRET_MASK_SENTINEL : ""}
                  initialRecommendedBuild={cfg.recommendedIosBuild ?? ""}
                />
                <div className="border-t border-zinc-800 pt-5">
                  <AnnounceUpdateButton />
                </div>
              </div>
            </SettingsCard>

            <SettingsCard
              id="notification-agents"
              title={t("settings.section.notificationAgents.title")}
              description={t("settings.section.notificationAgents.description")}
            >
              <NotificationAgentsManager featureEnabled={agentsFeatureEnabled} />
            </SettingsCard>

            <SettingsCard
              id="arr-alerts"
              title={t("settings.section.arrAlerts.title")}
              description={t("settings.section.arrAlerts.description")}
            >
              <ArrWatchForm initialPercent={String(parseDiskLowPercent(cfg[ARR_WATCH_DISK_LOW_PERCENT_KEY]))} />
            </SettingsCard>
          </>
        )}

        {tab === "integrations" && (
          <>
            <SettingsCard
              id="external-ratings"
              title={t("settings.section.externalRatings.title")}
              badge={<StatusBadge t={t} connected={!!(cfg.mdblistApiKey || cfg.omdbApiKey || cfg.traktClientId)} />}
              description={t("settings.section.externalRatings.description")}
            >
              <div className="space-y-6">
                <MdblistForm
                  initialApiKey={cfg.mdblistApiKey ? SECRET_MASK_SENTINEL : ""}
                  initialPlan={parseMdblistPlanSetting(cfg[MDBLIST_PLAN_SETTING_KEY])}
                  usage={mdblistUsage ?? EMPTY_MDBLIST_USAGE}
                />
                <div className="border-t border-zinc-800 pt-5">
                  <OmdbForm initialApiKey={cfg.omdbApiKey ? SECRET_MASK_SENTINEL : ""} />
                </div>
                <div className="border-t border-zinc-800 pt-5">
                  <TraktForm
                    initialApiKey={cfg.traktClientId ? SECRET_MASK_SENTINEL : ""}
                    initialSecret={cfg.traktClientSecret ? SECRET_MASK_SENTINEL : ""}
                  />
                </div>
                <div className="border-t border-zinc-800 pt-5">
                  <RatingsVisibilityForm initialHidden={parseHiddenRatingSources(cfg.ratingsHiddenSources)} />
                </div>
                <div className="border-t border-zinc-800 pt-5">
                  <CacheManagementPanel />
                </div>
              </div>
            </SettingsCard>

            <SettingsCard
              id="ip-geolocation"
              title={t("settings.section.ipGeolocation.title")}
              badge={<StatusBadge t={t} connected={!!cfg.ipinfoToken} />}
              description={t("settings.section.ipGeolocation.description")}
            >
              <IpinfoForm initialApiKey={cfg.ipinfoToken ? SECRET_MASK_SENTINEL : ""} />
            </SettingsCard>

            <SettingsCard
              id="webhooks"
              title={t("settings.section.webhooks.title")}
              description={t("settings.section.webhooks.description")}
            >
              <div className="space-y-6">
                <WebhookSecretForm
                  initialSecret={cfg.webhookSecret ? SECRET_MASK_SENTINEL : ""}
                  initialSonarrSecret={cfg.sonarrWebhookSecret ? SECRET_MASK_SENTINEL : ""}
                  initialRadarrSecret={cfg.radarrWebhookSecret ? SECRET_MASK_SENTINEL : ""}
                  initialSonarr4kSecret={cfg.sonarr4kWebhookSecret ? SECRET_MASK_SENTINEL : ""}
                  initialRadarr4kSecret={cfg.radarr4kWebhookSecret ? SECRET_MASK_SENTINEL : ""}
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
                <div className="border-t border-zinc-800 pt-5">
                  <ArrHealthPanel variant="webhooks" />
                </div>
              </div>
            </SettingsCard>
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
          <SettingsCard
            id="scheduled-jobs"
            title={t("settings.section.scheduledJobs.title")}
            description={t("settings.section.scheduledJobs.description")}
          >
            <CronJobTable jobs={metrics.cronJobs} />
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
                <h3 className="text-xs font-semibold uppercase tracking-wider text-zinc-500 mb-3">{t("settings.metrics.requests.heading")}</h3>
                <MetricGrid
                  items={[
                    { label: t("settings.metrics.total"),     value: metrics.totalRequests.toLocaleString(locale) },
                    { label: t("settings.metrics.pending"),   value: metrics.pendingRequests.toLocaleString(locale) },
                    { label: t("settings.metrics.approved"),  value: metrics.approvedRequests.toLocaleString(locale) },
                    { label: t("settings.metrics.available"), value: metrics.availableRequests.toLocaleString(locale) },
                    { label: t("settings.metrics.declined"),  value: metrics.declinedRequests.toLocaleString(locale) },
                    { label: t("settings.metrics.movies"),    value: metrics.movieRequests.toLocaleString(locale) },
                    { label: t("settings.metrics.tvShows"),  value: metrics.tvRequests.toLocaleString(locale) },
                  ]}
                />
              </div>

              <div className="border-t border-zinc-800 pt-5">
                <h3 className="text-xs font-semibold uppercase tracking-wider text-zinc-500 mb-3">{t("settings.metrics.users.heading")}</h3>
                <MetricGrid
                  items={[
                    { label: t("settings.metrics.total"),          value: metrics.totalUsers.toLocaleString(locale) },
                    { label: t("settings.metrics.admins"),         value: metrics.adminUsers.toLocaleString(locale) },
                    { label: t("settings.metrics.issueAdmins"),   value: metrics.issueAdminUsers.toLocaleString(locale) },
                    { label: t("settings.metrics.discordLinked"), value: metrics.discordLinkedUsers.toLocaleString(locale) },
                  ]}
                />
              </div>

              <div className="border-t border-zinc-800 pt-5">
                <h3 className="text-xs font-semibold uppercase tracking-wider text-zinc-500 mb-3">{t("settings.metrics.issues.heading")}</h3>
                <MetricGrid
                  items={[
                    { label: t("settings.metrics.total"),       value: metrics.totalIssues.toLocaleString(locale) },
                    { label: t("settings.metrics.open"),        value: metrics.openIssues.toLocaleString(locale) },
                    { label: t("settings.metrics.inProgress"), value: metrics.inProgressIssues.toLocaleString(locale) },
                    { label: t("settings.metrics.resolved"),    value: metrics.resolvedIssues.toLocaleString(locale) },
                  ]}
                />
              </div>

              <div className="border-t border-zinc-800 pt-5">
                <div className="flex items-center justify-between mb-3">
                  <h3 className="text-xs font-semibold uppercase tracking-wider text-zinc-500">{t("settings.metrics.libraryCache.heading")}</h3>
                  <div className="flex items-center gap-2 flex-wrap">
                    <ResyncLibraryButton servers={syncServers} />
                    <SyncTVEpisodesButton />
                    <RatingsWarmButton />
                    <ActivityWarmButton />
                  </div>
                </div>
                <MetricGrid
                  items={[
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
                  ]}
                />
              </div>

              <div className="border-t border-zinc-800 pt-5">
                <h3 className="text-xs font-semibold uppercase tracking-wider text-zinc-500 mb-3">{t("settings.metrics.tmdbCore.heading")}</h3>
                <p className="text-xs text-zinc-500 mb-3">
                  {t("settings.metrics.tmdbCore.description")}
                </p>
                <MetricGrid
                  className="mb-4"
                  items={(() => {
                    const total = metrics.tmdbCoreEntries;

                    const libTotal = metrics.uniqueLibraryItems;
                    const coveragePct = libTotal > 0 ? Math.min(100, Math.round((total / libTotal) * 100)) : 0;
                    return [
                      { label: t("settings.metrics.totalEntries"),   value: total.toLocaleString(locale) },
                      { label: t("settings.metrics.movies"),           value: metrics.tmdbCoreMovies.toLocaleString(locale) },
                      { label: t("settings.metrics.tvShows"),         value: metrics.tmdbCoreTv.toLocaleString(locale) },
                      { label: t("settings.metrics.libraryCoverage"), value: libTotal > 0 ? `~${coveragePct}%` : "—", dim: total === 0 },
                    ];
                  })()}
                />
                <MasterDbFillButton servers={syncServers} />
              </div>

              <div className="border-t border-zinc-800 pt-5">
                <h3 className="text-xs font-semibold uppercase tracking-wider text-zinc-500 mb-3">{t("settings.metrics.playHistory.heading")}</h3>
                <MetricGrid
                  items={[
                    { label: t("settings.metrics.recordedSessions"),  value: metrics.playHistoryEntries.toLocaleString(locale) },
                    { label: t("settings.metrics.mediaServerUsers"), value: metrics.mediaServerUsers.toLocaleString(locale) },
                    {
                      label: t("settings.metrics.currentShares"),
                      value: (
                        <Suspense fallback="…">
                          <CurrentSharesValue count={metrics.currentShares} locale={locale} />
                        </Suspense>
                      ),
                    },
                    { label: t("settings.metrics.discordSearchCache"), value: metrics.discordCacheEntries.toLocaleString(locale) },
                  ]}
                />
              </div>

            </div>
          </SettingsCard>
          </>
        )}

        </div>
      </div>
    </div>
  );
}
