import { ArrForm, PlexConnectForm, JellyfinSyncForm, LibraryMatchForm, Request4kAllToggle } from "@/components/settings/settings-ui";
import { ArrInstancesManager } from "@/components/settings/arr-instances-manager";
import { MediaInstancesManager } from "@/components/settings/media-instances-manager";
import { PlayHistorySettingsForm } from "@/components/settings/play-history-settings";
import { WatchGradeSettingsForm } from "@/components/settings/watch-grade-settings";
import { PlexWatchlistServerToggles } from "@/components/settings/forms/plex-watchlist-server-toggles";
import { LocalDateTime } from "@/components/local-date-time";
import { SlotText } from "@/components/i18n/slot-text";
import { SLOT } from "@/lib/i18n/slot";
import { parsePlexWatchlistServerStatus } from "@/lib/plex-watchlist";
import { SECRET_MASK_SENTINEL } from "@/lib/secret-mask";
import { STATS_TIME_ZONE_KEY, processTimeZone } from "@/lib/stats-time-zone";
import type { Translator } from "@/lib/i18n/translate";
import type { SettingsOf } from "./settings-data";
import { OptionalTitle, SettingsCard, StatusBadge } from "./ui";

export const MEDIA_TAB_KEYS = [
  // siteUrl is the Plex connect flow's forward URL.
  "siteUrl",
  "plexAdminEmail", "plexServerUrl", "plexLibraries",
  "plexWatchlistServerSource", "plexWatchlistServerAutoEnroll", "plexWatchlistServerStatus",
  "jellyfinUrl", "jellyfinApiKey", "jellyfinLibraries",
  "playHistoryEnabled", "playHistoryPlexEnabled", "playHistoryJellyfinEnabled",
  "concurrentStreamLimit", "playHistoryWatchedThreshold", "playHistoryCompletionThreshold", "playHistoryArcGapDays",
  "playHistoryPollingInterval", "playHistoryRetentionDays", STATS_TIME_ZONE_KEY,
  "watchGradeGraceDays", "watchGradeWindowDays", "watchGradeTvPercent", "watchGradeOtherViewers",
  "watchGradeBandA", "watchGradeBandB", "watchGradeBandC", "watchGradeBandD", "watchGradeMinRequests",
  "plexMoviePathStripPrefix", "plexTvPathStripPrefix", "jellyfinMoviePathStripPrefix", "jellyfinTvPathStripPrefix",
  "radarrUrl", "radarrApiKey", "radarrRootFolder", "radarrQualityProfileId", "radarrMinimumAvailability", "radarrExternalUrl",
  "radarr4kUrl", "radarr4kApiKey", "radarr4kRootFolder", "radarr4kQualityProfileId", "radarr4kMinimumAvailability", "radarr4kExternalUrl",
  "sonarrUrl", "sonarrApiKey", "sonarrRootFolder", "sonarrQualityProfileId", "sonarrLanguageProfileId", "sonarrExternalUrl",
  "sonarr4kUrl", "sonarr4kApiKey", "sonarr4kRootFolder", "sonarr4kQualityProfileId", "sonarr4kLanguageProfileId", "sonarr4kExternalUrl",
  "request4kAll",
] as const;

type MediaSettings = SettingsOf<typeof MEDIA_TAB_KEYS>;

// The server-token watchlist's last run. The run time is formatted on the
// CLIENT (LocalDateTime, mounted-gated — guardrail 16) so it reads in the
// viewer's timezone, not the container's. The sentence comes from one catalog
// string, so it is translated with `SLOT` where `{time}` goes (SlotText).
function PlexWatchlistStatusLine({ raw, t }: { raw: string | undefined; t: Translator }) {
  const st = parsePlexWatchlistServerStatus(raw);
  if (!st) return <p className="text-xs text-zinc-500 mt-4">{t("settings.plexWatchlist.status.never")}</p>;
  const counts = { ok: 0, private: 0, error: 0 };
  for (const v of Object.values(st.users)) counts[v]++;
  const summary = t("settings.plexWatchlist.status.summary", {
    time: SLOT,
    ok: counts.ok,
    private: counts.private,
    error: counts.error,
    unmatched: st.unmatchedFriends,
  });
  return (
    <p className="text-xs text-zinc-500 mt-4">
      <SlotText text={summary}>
        <LocalDateTime iso={st.updatedAt} />
      </SlotText>
    </p>
  );
}

export function MediaTab({ cfg, t }: { cfg: MediaSettings; t: Translator }) {
  return (
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
        {cfg.plexWatchlistServerSource === "true" && <PlexWatchlistStatusLine raw={cfg.plexWatchlistServerStatus} t={t} />}
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
          initialStatsTimeZone={cfg[STATS_TIME_ZONE_KEY] ?? ""}
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
        title={<OptionalTitle name="Radarr 4K" t={t} />}
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
        title={<OptionalTitle name="Sonarr 4K" t={t} />}
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
  );
}
