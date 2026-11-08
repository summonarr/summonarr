import { MdblistForm, OmdbForm, TraktForm, RatingsVisibilityForm, CacheManagementPanel, IpinfoForm, WebhookSecretForm, WebhookUrls } from "@/components/settings/settings-ui";
import { ArrHealthPanel } from "@/components/admin/arr-health-panel";
import { parseHiddenRatingSources } from "@/lib/ratings-visibility";
import { MDBLIST_PLAN_SETTING_KEY, parseMdblistPlanSetting } from "@/lib/mdblist-plan";
import { getMdblistUsageSnapshot } from "@/lib/mdblist";
import { SECRET_MASK_SENTINEL } from "@/lib/secret-mask";
import { siteBaseUrl } from "@/lib/site-base-url";
import type { Translator } from "@/lib/i18n/translate";
import type { SettingsOf } from "./settings-data";
import { SettingsCard, StatusBadge } from "./ui";

export const INTEGRATIONS_TAB_KEYS = [
  "mdblistApiKey", MDBLIST_PLAN_SETTING_KEY, "omdbApiKey", "traktClientId", "traktClientSecret", "ratingsHiddenSources",
  "ipinfoToken",
  "webhookSecret", "sonarrWebhookSecret", "radarrWebhookSecret", "sonarr4kWebhookSecret", "radarr4kWebhookSecret",
  // Whether the 4K instances exist, for their webhook rows.
  "radarr4kUrl", "radarr4kApiKey", "sonarr4kUrl", "sonarr4kApiKey",
  // The copyable webhook URLs' root.
  "siteUrl",
] as const;

export async function IntegrationsTab({ cfg, t }: { cfg: SettingsOf<typeof INTEGRATIONS_TAB_KEYS>; t: Translator }) {
  // What MDBList last reported about the account, for the plan picker. Only
  // the fields the form shows reach the browser.
  const snapshot = await getMdblistUsageSnapshot();
  const mdblistUsage = {
    reportedLimit: snapshot.reportedLimit,
    reportedPlan: snapshot.reportedPlan,
    usedToday: snapshot.usedToday,
    backgroundStopped: snapshot.backgroundStopped,
    pausedUntil: snapshot.pausedUntil,
  };
  // A cleared Site URL ("") falls through to AUTH_URL, and BASE_PATH is on the
  // end so a sub-path install's URLs resolve. The token itself never reaches
  // the page (the copy button fetches it).
  const baseUrl = siteBaseUrl(cfg.siteUrl, process.env.AUTH_URL, process.env.BASE_PATH);
  return (
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
            usage={mdblistUsage}
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
  );
}
