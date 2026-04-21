import { auth } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { Prisma } from "@/generated/prisma";
import { redirect } from "next/navigation";
import { getPlexAccounts } from "@/lib/plex";
import { getJellyfinUserCount } from "@/lib/jellyfin";
import { countUniqueLibraryItems } from "@/lib/library-iterator";
import { Card } from "@/components/ui/card";
import { ArrForm, WebhookSecretForm, WebhookUrls, PlexConnectForm, JellyfinSyncForm, DonationForm, MotdForm, SiteTitleForm, SiteUrlForm, RateLimitForm, SessionForm, EmailForm, DiscordBotForm, OmdbForm, MdblistForm, TraktForm, RatingsCacheClearButton, LibraryMatchForm, RatingsWarmButton, ActivityWarmButton, QuotaForm, EnableUserEmailsToggle, MaintenanceForm, DeletionVoteThresholdForm, DisableLocalLoginToggle, EnableMachineSessionToggle } from "@/components/settings/settings-ui";
import { PlayHistorySettingsForm } from "@/components/settings/play-history-settings";
import { ResyncLibraryButton } from "@/components/admin/resync-library-button";
import { SyncTVEpisodesButton } from "@/components/admin/sync-tv-episodes-button";
import { MasterDbFillButton } from "@/components/admin/master-db-fill-button";
import { SettingsTabNav, type TabId } from "@/components/settings/settings-tab-nav";
import { CronJobTable, type CronJobInfo } from "@/components/settings/cron-job-table";
import { FeaturesForm } from "@/components/settings/features-form";
import { getFeatureFlags, groupFeaturesByCategory } from "@/lib/features";

export const dynamic = "force-dynamic";

function StatusBadge({ connected, label = "Connected" }: { connected: boolean; label?: string }) {
  if (connected) {
    return (
      <span className="inline-flex items-center gap-1.5 text-xs px-2 py-0.5 rounded-full bg-green-500/10 text-green-400 font-medium border border-green-500/20">
        <span className="w-1.5 h-1.5 rounded-full bg-green-400" />
        {label}
      </span>
    );
  }
  return (
    <span className="inline-flex items-center text-xs px-2 py-0.5 rounded-full bg-zinc-800 text-zinc-500 font-medium border border-zinc-700">
      Not configured
    </span>
  );
}

const ALL_KEYS = [
  "radarrUrl", "radarrApiKey", "radarrRootFolder", "radarrQualityProfileId",
  "sonarrUrl", "sonarrApiKey", "sonarrRootFolder", "sonarrQualityProfileId",
  "webhookSecret", "plexAdminEmail", "plexServerUrl", "plexLibraries", "plexPathStripPrefix", "plexMoviePathStripPrefix", "plexTvPathStripPrefix",
  "jellyfinUrl", "jellyfinApiKey", "jellyfinLibraries", "jellyfinPathStripPrefix", "jellyfinMoviePathStripPrefix", "jellyfinTvPathStripPrefix",
  "donationPaypal", "donationVenmo", "donationZelle", "donationAmazon",
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
  "enableMachineSession",
  "playHistoryEnabled", "playHistoryPlexEnabled", "playHistoryJellyfinEnabled",
  "playHistoryWatchedThreshold", "playHistoryPollingInterval", "playHistoryRetentionDays",
  "omdbApiKey", "mdblistApiKey", "traktClientId",
] as const;

const VALID_TABS: TabId[] = ["site", "media", "notifications", "integrations", "features", "system"];

export default async function SettingsPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string>>;
}) {
  const [sp, session] = await Promise.all([searchParams, auth()]);
  if (!session || session.user.role !== "ADMIN") redirect("/");

  const rawTab = sp.tab as TabId | undefined;
  const tab: TabId = rawTab && VALID_TABS.includes(rawTab) ? rawTab : "site";

  const rows = await prisma.setting.findMany({ where: { key: { in: [...ALL_KEYS] } } });
  const cfg = Object.fromEntries(rows.map((r) => [r.key, r.value]));

  const baseUrl = cfg.siteUrl?.replace(/\/$/, "") ?? process.env.NEXTAUTH_URL?.replace(/\/$/, "") ?? "http://localhost:3000";

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
      prisma.plexLibraryItem.count({ where: { mediaType: "TV" } }),
      prisma.jellyfinLibraryItem.count({ where: { mediaType: "TV" } }),

      prisma.$queryRaw<[{ count: bigint }]>(Prisma.sql`SELECT COUNT(DISTINCT "tmdbId")::bigint AS count FROM "TVEpisodeCache" WHERE source = 'plex'`).then((r) => Number(r[0].count)),
      prisma.$queryRaw<[{ count: bigint }]>(Prisma.sql`SELECT COUNT(DISTINCT "tmdbId")::bigint AS count FROM "TVEpisodeCache" WHERE source = 'jellyfin'`).then((r) => Number(r[0].count)),
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

    const [plexTokenRow, jellyfinUrlRow, jellyfinKeyRow] = await Promise.all([
      prisma.setting.findUnique({ where: { key: "plexAdminToken" } }),
      prisma.setting.findUnique({ where: { key: "jellyfinUrl" } }),
      prisma.setting.findUnique({ where: { key: "jellyfinApiKey" } }),
    ]);
    let currentShares: number | null = null;
    const shareCounts = await Promise.allSettled([
      cfg.plexServerUrl && plexTokenRow?.value
        ? getPlexAccounts(cfg.plexServerUrl, plexTokenRow.value).then((a) => a.length)
        : Promise.resolve(null),
      jellyfinUrlRow?.value && jellyfinKeyRow?.value
        ? getJellyfinUserCount(jellyfinUrlRow.value, jellyfinKeyRow.value)
        : Promise.resolve(null),
    ]);
    const plexCount = shareCounts[0].status === "fulfilled" ? shareCounts[0].value : null;
    const jfCount   = shareCounts[1].status === "fulfilled" ? shareCounts[1].value : null;
    if (plexCount !== null || jfCount !== null) {
      currentShares = (plexCount ?? 0) + (jfCount ?? 0);
    }

    const cronTargets = [
      "sync:full", "upcoming-cache", "ratings-sync", "list-cache",
      "activity", "mdblist", "omdb", "audit-log:pii-scrub", "auth-sessions:purge-expired",
      "trash-sync",
    ];
    const lastRuns = await prisma.cronRun.findMany({
      where: { target: { in: cronTargets } },
      select: { target: true, lastRunAt: true, durationMs: true, status: true },
    });
    const lastRunMap = new Map(lastRuns.map((r) => [r.target, r]));

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
      cronJobs: buildCronJobs(lastRunMap),
    };
  }

  function buildCronJobs(lastRunMap: Map<string, { lastRunAt: Date; durationMs: number | null; status: string }>): CronJobInfo[] {
    function lastRunInfo(target: string): { lastRun: string | null; lastDuration: number | null; lastStatus: "ok" | "error" | null } {
      const row = lastRunMap.get(target);
      if (!row) return { lastRun: null, lastDuration: null, lastStatus: null };
      return {
        lastRun: row.lastRunAt.toISOString(),
        lastDuration: row.durationMs,
        lastStatus: row.status === "error" ? "error" : "ok",
      };
    }

    return [
      { name: "Library Sync", description: "Plex + Jellyfin library, Radarr/Sonarr state", endpoint: "/api/sync", interval: `${process.env.SYNC_INTERVAL ?? "3600"}s`, ...lastRunInfo("sync:full") },
      { name: "Upcoming Sync", description: "Upcoming movies and TV from TMDB", endpoint: "/api/sync/upcoming", interval: `${process.env.UPCOMING_SYNC_INTERVAL ?? "86400"}s`, ...lastRunInfo("upcoming-cache") },
      { name: "Ratings Sync", description: "Pre-warm MDBList/OMDB ratings for trending/popular", endpoint: "/api/sync/ratings", interval: `${process.env.RATINGS_SYNC_INTERVAL ?? "86400"}s`, ...lastRunInfo("ratings-sync") },
      { name: "Warm List Cache", description: "TMDB, Trakt, MDBList lists + genres + providers", endpoint: "/api/cron/warm-list-cache", interval: `${process.env.LIST_CACHE_SYNC_INTERVAL ?? "21600"}s`, ...lastRunInfo("list-cache") },
      { name: "Warm Activity", description: "Play history stats for admin dashboard", endpoint: "/api/cron/warm-activity", interval: `${process.env.WARM_ACTIVITY_INTERVAL ?? "1800"}s`, ...lastRunInfo("activity") },
      { name: "Warm MDBList", description: "MDBList ratings for entire library", endpoint: "/api/cron/warm-mdblist", interval: `${process.env.WARM_MDBLIST_INTERVAL ?? "86400"}s`, ...lastRunInfo("mdblist") },
      { name: "Warm OMDB", description: "OMDB ratings fallback for entire library", endpoint: "/api/cron/warm-omdb", interval: `${process.env.WARM_OMDB_INTERVAL ?? "86400"}s`, ...lastRunInfo("omdb") },
      { name: "Purge Sessions", description: "Delete expired auth sessions", endpoint: "/api/cron/purge-auth-sessions", interval: `${process.env.PURGE_SESSIONS_INTERVAL ?? "86400"}s`, ...lastRunInfo("auth-sessions:purge-expired") },
      { name: "Scrub Audit PII", description: "Remove IP/UA from audit entries older than 90 days", endpoint: "/api/cron/scrub-audit-pii", interval: `${process.env.SCRUB_AUDIT_PII_INTERVAL ?? "86400"}s`, ...lastRunInfo("audit-log:pii-scrub") },
      { name: "TRaSH Sync", description: "Refresh TRaSH-Guides catalog and re-apply managed specs", endpoint: "/api/cron/trash-sync", interval: `${process.env.TRASH_SYNC_INTERVAL ?? "86400"}s`, ...lastRunInfo("trash-sync") },
    ];
  }

  return (
    <div>
      <div className="mb-6">
        <h1 className="text-2xl font-bold mb-1">Settings</h1>
        <p className="text-zinc-400 text-sm">Configure integrations and preferences</p>
      </div>

      <SettingsTabNav activeTab={tab} />

      <div className="mt-6 space-y-4 max-w-3xl">

        {tab === "site" && (
          <>
            <Card className="bg-zinc-900 border-zinc-800 p-6">
              <div className="mb-5">
                <h2 className="font-semibold text-white text-lg">General</h2>
                <p className="text-sm text-zinc-500 mt-0.5">Basic branding for your instance.</p>
              </div>
              <div className="space-y-6">
                <SiteTitleForm initialTitle={cfg.siteTitle ?? ""} />
                <SiteUrlForm initialUrl={cfg.siteUrl ?? ""} />
              </div>
            </Card>

            <Card className="bg-zinc-900 border-zinc-800 p-6">
              <div className="mb-5">
                <h2 className="font-semibold text-white text-lg">Rate Limiting</h2>
                <p className="text-sm text-zinc-500 mt-0.5">
                  Maximum actions allowed per user within the time window. Set to 0 to disable.
                </p>
              </div>
              <RateLimitForm
                initialRegister={cfg.rateLimitRegister ?? ""}
                initialRequests={cfg.rateLimitRequests ?? ""}
                initialIssues={cfg.rateLimitIssues ?? ""}
                initialMaxPushSubscriptions={cfg.maxPushSubscriptions ?? ""}
              />
            </Card>

            <Card className="bg-zinc-900 border-zinc-800 p-6">
              <div className="mb-5">
                <h2 className="font-semibold text-white text-lg">Quotas</h2>
                <p className="text-sm text-zinc-500 mt-0.5">
                  Limit how many requests each user can submit in a rolling time period. Admins and quota-exempt users are never restricted.
                </p>
              </div>
              <QuotaForm
                initialLimit={cfg.quotaLimit ?? ""}
                initialPeriod={cfg.quotaPeriod ?? ""}
              />
            </Card>

            <Card className="bg-zinc-900 border-zinc-800 p-6">
              <div className="mb-5">
                <h2 className="font-semibold text-white text-lg">Deletion Votes</h2>
                <p className="text-sm text-zinc-500 mt-0.5">
                  Users can vote to remove items from the library. When an item reaches the threshold, admins are notified.
                </p>
              </div>
              <DeletionVoteThresholdForm initialThreshold={cfg.deletionVoteThreshold ?? ""} />
            </Card>

            <Card className="bg-zinc-900 border-zinc-800 p-6">
              <div className="mb-5">
                <h2 className="font-semibold text-white text-lg">Authentication</h2>
                <p className="text-sm text-zinc-500 mt-0.5">
                  Control which sign-in methods are available. External providers (Plex, Jellyfin, OIDC) are configured via environment variables.
                </p>
              </div>
              <DisableLocalLoginToggle initialDisabled={cfg.disableLocalLogin === "true"} />
              <EnableMachineSessionToggle initialEnabled={cfg.enableMachineSession === "true"} />
            </Card>

            <Card className="bg-zinc-900 border-zinc-800 p-6">
              <div className="mb-5">
                <h2 className="font-semibold text-white text-lg">Sessions</h2>
                <p className="text-sm text-zinc-500 mt-0.5">
                  Control how long users stay logged in. The &quot;Remember me&quot; duration applies when users check that option at login.
                </p>
              </div>
              <SessionForm
                initialDefaultDuration={cfg.sessionDefaultDuration ?? ""}
                initialMobileDuration={cfg.sessionMobileDuration ?? ""}
                initialMaxDuration={cfg.sessionMaxDuration ?? ""}
              />
            </Card>

            <Card className="bg-zinc-900 border-zinc-800 p-6">
              <div className="mb-5">
                <h2 className="font-semibold text-white text-lg">Maintenance Mode</h2>
                <p className="text-sm text-zinc-500 mt-0.5">
                  When enabled, non-admin users will see a maintenance page instead of the app.
                </p>
              </div>
              <MaintenanceForm
                initialEnabled={cfg.maintenanceEnabled === "true"}
                initialMessage={cfg.maintenanceMessage ?? ""}
              />
            </Card>

            <Card className="bg-zinc-900 border-zinc-800 p-6">
              <div className="mb-5">
                <h2 className="font-semibold text-white text-lg">Message of the Day</h2>
                <p className="text-sm text-zinc-500 mt-0.5">
                  Optional popup shown to users once per session after login. Leave blank to disable.
                </p>
              </div>
              <MotdForm
                initialEnabled={cfg.motdEnabled === "true"}
                initialTitle={cfg.motdTitle ?? ""}
                initialBody={cfg.motdBody ?? ""}
              />
            </Card>

            <Card className="bg-zinc-900 border-zinc-800 p-6">
              <div className="mb-5">
                <h2 className="font-semibold text-white text-lg">Donations</h2>
                <p className="text-sm text-zinc-500 mt-0.5">
                  Configure donation links shown to users on the Donate page.
                </p>
              </div>
              <DonationForm
                initialPaypal={cfg.donationPaypal ?? ""}
                initialVenmo={cfg.donationVenmo ?? ""}
                initialZelle={cfg.donationZelle ?? ""}
                initialAmazon={cfg.donationAmazon ?? ""}
              />
            </Card>
          </>
        )}

        {tab === "media" && (
          <>
            <Card className="bg-zinc-900 border-zinc-800 p-6">
              <div className="mb-5">
                <div className="flex items-center gap-3 mb-0.5">
                  <h2 className="font-semibold text-white text-lg">Plex</h2>
                  <StatusBadge connected={!!cfg.plexAdminEmail} />
                </div>
                <p className="text-sm text-zinc-500">
                  Allow users shared with your Plex account to sign in with Plex.
                </p>
              </div>
              <PlexConnectForm
                initialEmail={cfg.plexAdminEmail ?? ""}
                initialServerUrl={cfg.plexServerUrl ?? ""}
                initialPlexLibraries={cfg.plexLibraries ?? ""}
                siteUrl={cfg.siteUrl ?? process.env.NEXTAUTH_URL ?? ""}
              />
            </Card>

            <Card className="bg-zinc-900 border-zinc-800 p-6">
              <div className="mb-5">
                <div className="flex items-center gap-3 mb-0.5">
                  <h2 className="font-semibold text-white text-lg">Jellyfin</h2>
                  <StatusBadge connected={!!(cfg.jellyfinUrl && cfg.jellyfinApiKey)} />
                </div>
                <p className="text-sm text-zinc-500">
                  Sync your Jellyfin library to show availability badges on media.
                </p>
              </div>
              <JellyfinSyncForm
                initialUrl={cfg.jellyfinUrl ?? ""}
                initialApiKey={cfg.jellyfinApiKey ? "••••••••" : ""}
                initialJellyfinLibraries={cfg.jellyfinLibraries ?? ""}
              />
            </Card>

            <Card className="bg-zinc-900 border-zinc-800 p-6">
              <div className="mb-5">
                <h2 className="font-semibold text-white text-lg">Play History</h2>
                <p className="text-sm text-zinc-500 mt-0.5">
                  Track playback sessions from Plex and Jellyfin. Configure webhook URLs in your media server to enable real-time tracking.
                </p>
              </div>
              <PlayHistorySettingsForm
                initialEnabled={cfg.playHistoryEnabled ?? ""}
                initialPlexEnabled={cfg.playHistoryPlexEnabled ?? ""}
                initialJellyfinEnabled={cfg.playHistoryJellyfinEnabled ?? ""}
                initialWatchedThreshold={cfg.playHistoryWatchedThreshold ?? "80"}
                initialPollingInterval={cfg.playHistoryPollingInterval ?? "5"}
                initialRetentionDays={cfg.playHistoryRetentionDays ?? "0"}
              />
            </Card>

            <Card className="bg-zinc-900 border-zinc-800 p-6">
              <div className="mb-5">
                <h2 className="font-semibold text-white text-lg">Library Matching</h2>
                <p className="text-sm text-zinc-500 mt-0.5">
                  Configure how file paths are normalised when comparing Plex and Jellyfin libraries for bad-match detection.
                </p>
              </div>
              <LibraryMatchForm
                initialPlexMoviePrefix={cfg.plexMoviePathStripPrefix ?? ""}
                initialPlexTvPrefix={cfg.plexTvPathStripPrefix ?? ""}
                initialJellyfinMoviePrefix={cfg.jellyfinMoviePathStripPrefix ?? ""}
                initialJellyfinTvPrefix={cfg.jellyfinTvPathStripPrefix ?? ""}
              />
            </Card>

            <Card className="bg-zinc-900 border-zinc-800 p-6">
              <div className="mb-5">
                <div className="flex items-center gap-3 mb-0.5">
                  <h2 className="font-semibold text-white text-lg">Radarr</h2>
                  <StatusBadge connected={!!(cfg.radarrUrl && cfg.radarrApiKey)} />
                </div>
                <p className="text-sm text-zinc-500">
                  Automatically send approved movie requests to Radarr.
                </p>
              </div>
              <ArrForm
                service="radarr"
                initialUrl={cfg.radarrUrl ?? ""}
                initialApiKey={cfg.radarrApiKey ? "••••••••" : ""}
                initialRootFolder={cfg.radarrRootFolder ?? ""}
                initialQualityProfileId={cfg.radarrQualityProfileId ?? ""}
              />
            </Card>

            <Card className="bg-zinc-900 border-zinc-800 p-6">
              <div className="mb-5">
                <div className="flex items-center gap-3 mb-0.5">
                  <h2 className="font-semibold text-white text-lg">Sonarr</h2>
                  <StatusBadge connected={!!(cfg.sonarrUrl && cfg.sonarrApiKey)} />
                </div>
                <p className="text-sm text-zinc-500">
                  Automatically send approved TV show requests to Sonarr.
                </p>
              </div>
              <ArrForm
                service="sonarr"
                initialUrl={cfg.sonarrUrl ?? ""}
                initialApiKey={cfg.sonarrApiKey ? "••••••••" : ""}
                initialRootFolder={cfg.sonarrRootFolder ?? ""}
                initialQualityProfileId={cfg.sonarrQualityProfileId ?? ""}
              />
            </Card>
          </>
        )}

        {tab === "notifications" && (
          <>
            <Card className="bg-zinc-900 border-zinc-800 p-6">
              <div className="mb-5">
                <div className="flex items-center gap-3 mb-0.5">
                  <h2 className="font-semibold text-white text-lg">Email</h2>
                  <StatusBadge connected={cfg.emailBackend === "resend" ? !!cfg.resendApiKey : !!cfg.smtpHost} />
                </div>
                <p className="text-sm text-zinc-500">
                  Send admins an email when a new request or issue is submitted. Saving will send a test email to your account.
                </p>
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
            </Card>

            <Card className="bg-zinc-900 border-zinc-800 p-6">
              <div className="mb-5">
                <div className="flex items-center gap-3 mb-0.5">
                  <h2 className="font-semibold text-white text-lg">Discord Bot</h2>
                  <StatusBadge connected={!!cfg.discordBotToken} />
                </div>
                <p className="text-sm text-zinc-500">
                  Allow Discord users to request media via slash commands using Discord&apos;s HTTP Interactions endpoint. No extra process or environment variables needed.
                </p>
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
            </Card>
          </>
        )}

        {tab === "integrations" && (
          <>
            <Card className="bg-zinc-900 border-zinc-800 p-6">
              <div className="mb-5">
                <div className="flex items-center gap-3 mb-0.5">
                  <h2 className="font-semibold text-white text-lg">External Ratings</h2>
                  <StatusBadge connected={!!(cfg.mdblistApiKey || cfg.omdbApiKey || cfg.traktClientId)} />
                </div>
                <p className="text-sm text-zinc-500">
                  Adds IMDb, Rotten Tomatoes, RT Audience, Metacritic, and Trakt ratings to media pages.
                  MDBList is recommended — it covers TV shows and adds Audience scores.
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
                <div className="border-t border-zinc-800 pt-5 space-y-4">
                  <h3 className="text-sm font-medium text-zinc-300">Cache Management</h3>
                  <div className="flex items-center gap-3">
                    <RatingsWarmButton />
                  </div>
                  <RatingsCacheClearButton />
                </div>
              </div>
            </Card>

            <Card className="bg-zinc-900 border-zinc-800 p-6">
              <div className="mb-5">
                <h2 className="font-semibold text-white text-lg">Webhooks</h2>
                <p className="text-sm text-zinc-500 mt-0.5">
                  Add these URLs in Radarr/Sonarr → Settings → Connect → Webhook so requests
                  are marked Available the moment a download completes.
                </p>
              </div>
              <div className="space-y-6">
                <WebhookSecretForm initialSecret={cfg.webhookSecret ? "••••••••" : ""} />
                <div className="border-t border-zinc-800 pt-5">
                  <WebhookUrls baseUrl={baseUrl} secret={cfg.webhookSecret ?? ""} />
                </div>
              </div>
            </Card>
          </>
        )}

        {tab === "features" && (
          <FeaturesForm
            initialFlags={await getFeatureFlags()}
            groups={(() => {
              const g = groupFeaturesByCategory();
              return [
                { category: "pages" as const,        title: "User pages",         description: "Hide or show user-facing nav sections and their pages.", features: g.pages },
                { category: "behaviors" as const,    title: "Behaviors",          description: "Turn on or off specific features of the app.", features: g.behaviors },
                { category: "integrations" as const, title: "Integrations",       description: "Toggle external integrations on or off without clearing their config.", features: g.integrations },
                { category: "admin" as const,        title: "Admin pages",        description: "Hide or show admin-only pages and their nav entries.", features: g.admin },
              ];
            })()}
          />
        )}

        {tab === "system" && metrics && (
          <>
          <Card className="bg-zinc-900 border-zinc-800 p-6">
            <div className="mb-5">
              <h2 className="font-semibold text-white text-lg">Scheduled Jobs</h2>
              <p className="text-sm text-zinc-500 mt-0.5">Background cron jobs and their current status. Click Run to trigger on demand.</p>
            </div>
            <CronJobTable jobs={metrics.cronJobs} />
          </Card>

          <Card className="bg-zinc-900 border-zinc-800 p-6">
            <div className="mb-5">
              <h2 className="font-semibold text-white text-lg">DB Metrics</h2>
              <p className="text-sm text-zinc-500 mt-0.5">Read-only snapshot of database row counts.</p>
            </div>
            <div className="space-y-6">

              <div>
                <h3 className="text-xs font-semibold uppercase tracking-wider text-zinc-500 mb-3">Requests</h3>
                <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
                  {[
                    { label: "Total",     value: metrics.totalRequests },
                    { label: "Pending",   value: metrics.pendingRequests },
                    { label: "Approved",  value: metrics.approvedRequests },
                    { label: "Available", value: metrics.availableRequests },
                    { label: "Declined",  value: metrics.declinedRequests },
                    { label: "Movies",    value: metrics.movieRequests },
                    { label: "TV Shows",  value: metrics.tvRequests },
                  ].map(({ label, value }) => (
                    <div key={label} className="bg-zinc-800 rounded-lg px-4 py-3">
                      <p className="text-xs text-zinc-500 mb-1">{label}</p>
                      <p className="text-xl font-semibold text-white tabular-nums">{value.toLocaleString()}</p>
                    </div>
                  ))}
                </div>
              </div>

              <div className="border-t border-zinc-800 pt-5">
                <h3 className="text-xs font-semibold uppercase tracking-wider text-zinc-500 mb-3">Users</h3>
                <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
                  {[
                    { label: "Total",          value: metrics.totalUsers },
                    { label: "Admins",         value: metrics.adminUsers },
                    { label: "Issue Admins",   value: metrics.issueAdminUsers },
                    { label: "Discord Linked", value: metrics.discordLinkedUsers },
                  ].map(({ label, value }) => (
                    <div key={label} className="bg-zinc-800 rounded-lg px-4 py-3">
                      <p className="text-xs text-zinc-500 mb-1">{label}</p>
                      <p className="text-xl font-semibold text-white tabular-nums">{value.toLocaleString()}</p>
                    </div>
                  ))}
                </div>
              </div>

              <div className="border-t border-zinc-800 pt-5">
                <h3 className="text-xs font-semibold uppercase tracking-wider text-zinc-500 mb-3">Issues</h3>
                <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
                  {[
                    { label: "Total",       value: metrics.totalIssues },
                    { label: "Open",        value: metrics.openIssues },
                    { label: "In Progress", value: metrics.inProgressIssues },
                    { label: "Resolved",    value: metrics.resolvedIssues },
                  ].map(({ label, value }) => (
                    <div key={label} className="bg-zinc-800 rounded-lg px-4 py-3">
                      <p className="text-xs text-zinc-500 mb-1">{label}</p>
                      <p className="text-xl font-semibold text-white tabular-nums">{value.toLocaleString()}</p>
                    </div>
                  ))}
                </div>
              </div>

              <div className="border-t border-zinc-800 pt-5">
                <div className="flex items-center justify-between mb-3">
                  <h3 className="text-xs font-semibold uppercase tracking-wider text-zinc-500">Library Cache</h3>
                  <div className="flex items-center gap-2 flex-wrap">
                    <ResyncLibraryButton />
                    <SyncTVEpisodesButton />
                    <RatingsWarmButton />
                    <ActivityWarmButton />
                  </div>
                </div>
                <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
                  {[
                    { label: "Plex Items",           value: metrics.plexItems.toLocaleString() },
                    { label: "Jellyfin Items",        value: metrics.jellyfinItems.toLocaleString() },
                    { label: "TV Episodes",           value: metrics.episodeCacheEntries.toLocaleString() },
                    { label: "Plex TV Coverage",      value: `${metrics.plexShowsWithEps.toLocaleString()} / ${metrics.plexTvShows.toLocaleString()} shows` },
                    { label: "Jellyfin TV Coverage",  value: `${metrics.jellyfinShowsWithEps.toLocaleString()} / ${metrics.jellyfinTvShows.toLocaleString()} shows` },
                    { label: "TMDB Cache",            value: metrics.tmdbCacheEntries.toLocaleString() },
                    { label: "OMDB Cache",            value: metrics.omdbCacheEntries.toLocaleString() },
                    { label: "Upcoming",              value: metrics.upcomingItems.toLocaleString() },
                    { label: "Radarr Wanted",         value: metrics.radarrWanted.toLocaleString() },
                    { label: "Radarr Available",      value: metrics.radarrAvailable.toLocaleString() },
                    { label: "Sonarr Wanted",         value: metrics.sonarrWanted.toLocaleString() },
                    { label: "Sonarr Available",      value: metrics.sonarrAvailable.toLocaleString() },
                    { label: "Deletion Votes",        value: metrics.deletionVotes.toLocaleString() },
                  ].map(({ label, value }) => (
                    <div key={label} className="bg-zinc-800 rounded-lg px-4 py-3">
                      <p className="text-xs text-zinc-500 mb-1">{label}</p>
                      <p className="text-xl font-semibold text-white tabular-nums">{value}</p>
                    </div>
                  ))}
                </div>
              </div>

              <div className="border-t border-zinc-800 pt-5">
                <h3 className="text-xs font-semibold uppercase tracking-wider text-zinc-500 mb-3">TmdbMediaCore</h3>
                <p className="text-xs text-zinc-600 mb-3">
                  Normalised metadata table (title, poster, year, rating) used by all grid pages to avoid live TMDB calls.
                  Populated automatically as pages are browsed; use Initial DB Fill to seed it immediately.
                </p>
                <div className="grid grid-cols-2 sm:grid-cols-4 gap-2 mb-4">
                  {(() => {
                    const total = metrics.tmdbCoreEntries;

                    const libTotal = metrics.uniqueLibraryItems;
                    const coveragePct = libTotal > 0 ? Math.min(100, Math.round((total / libTotal) * 100)) : 0;
                    return [
                      { label: "Total Entries",   value: total.toLocaleString() },
                      { label: "Movies",           value: metrics.tmdbCoreMovies.toLocaleString() },
                      { label: "TV Shows",         value: metrics.tmdbCoreTv.toLocaleString() },
                      { label: "Library Coverage", value: libTotal > 0 ? `~${coveragePct}%` : "—", dim: total === 0 },
                    ].map(({ label, value, dim }) => (
                      <div key={label} className="bg-zinc-800 rounded-lg px-4 py-3">
                        <p className="text-xs text-zinc-500 mb-1">{label}</p>
                        <p className={`text-xl font-semibold tabular-nums ${dim ? "text-zinc-500" : "text-white"}`}>{value}</p>
                      </div>
                    ));
                  })()}
                </div>
                <MasterDbFillButton />
              </div>

              <div className="border-t border-zinc-800 pt-5">
                <h3 className="text-xs font-semibold uppercase tracking-wider text-zinc-500 mb-3">Play History</h3>
                <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
                  {[
                    { label: "Recorded Sessions",  value: metrics.playHistoryEntries.toLocaleString() },
                    { label: "Media Server Users", value: metrics.mediaServerUsers.toLocaleString() },
                    { label: "Current Shares",     value: metrics.currentShares !== null ? metrics.currentShares.toLocaleString() : "—" },
                    { label: "Discord Search Cache", value: metrics.discordCacheEntries.toLocaleString() },
                  ].map(({ label, value }) => (
                    <div key={label} className="bg-zinc-800 rounded-lg px-4 py-3">
                      <p className="text-xs text-zinc-500 mb-1">{label}</p>
                      <p className="text-xl font-semibold text-white tabular-nums">{value}</p>
                    </div>
                  ))}
                </div>
              </div>

            </div>
          </Card>
          </>
        )}

      </div>
    </div>
  );
}
