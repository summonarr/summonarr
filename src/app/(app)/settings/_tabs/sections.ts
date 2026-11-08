import type { TabId } from "@/components/settings/settings-tab-nav";

// Each tab's cards, in page order, for the sticky side nav (SettingsNav) — it
// links to each card's id and its scroll-spy walks this order. Labels and
// groups are catalog keys, translated at render (never at module load — the
// locale is per request). tests/settings-page-nav.test.mts holds every tab's
// rendered cards to this list.
export type TabSection = { id: string; i18nKey: string; group: string };

export const TAB_SECTIONS: Record<TabId, TabSection[]> = {
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

const VALID_TABS: readonly TabId[] = ["site", "media", "notifications", "integrations", "features", "system"];

/** The `?tab=` value as a tab, else the first one. */
export function settingsTab(raw: string | undefined): TabId {
  return VALID_TABS.find((tab) => tab === raw) ?? "site";
}
