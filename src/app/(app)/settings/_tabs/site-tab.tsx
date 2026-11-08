import { SiteTitleForm, SiteUrlForm, RateLimitForm, QuotaForm, DeletionVoteThresholdForm, SessionForm, MaintenanceForm, MotdForm, DonationForm, DisableLocalLoginToggle, JellyfinRestrictSignInToggle, EnableMachineSessionToggle } from "@/components/settings/settings-ui";
import { RequireAdminMfaToggle } from "@/components/settings/forms/require-admin-mfa-toggle";
import { OidcAllowlistForm } from "@/components/settings/forms/oidc-allowlist-form";
import { DEFAULT_OIDC_ALLOWLIST, OIDC_ALLOWLIST_SETTING_KEY, parseOidcAllowlist } from "@/lib/oidc-allowlist";
import { isOidcConfigured } from "@/lib/oidc";
import { getSyncableMediaInstances } from "@/lib/media-instance-registry";
import { mfaEnforcementDisabledByEnv } from "@/lib/mfa/policy";
import type { Translator } from "@/lib/i18n/translate";
import type { SettingsOf } from "./settings-data";
import { SettingsCard } from "./ui";

export const SITE_TAB_KEYS = [
  "siteTitle", "siteUrl",
  "rateLimitRegister", "rateLimitRequests", "rateLimitIssues", "maxPushSubscriptions",
  "quotaLimit", "quotaPeriod",
  "deletionVoteThreshold",
  "disableLocalLogin", "requireMfaForAdmins", "jellyfinRestrictSignIn",
  "enableMachineSession", "machineSessionAllowedIps", OIDC_ALLOWLIST_SETTING_KEY,
  "sessionDefaultDuration", "sessionMobileDuration", "sessionMaxDuration",
  "maintenanceEnabled", "maintenanceMessage",
  "motdEnabled", "motdTitle", "motdBody",
  "donationPaypal", "donationVenmo", "donationZelle", "donationAmazon", "donationPatreon", "donationBuyMeACoffee",
] as const;

// Whether any non-password sign-in works — the login page's own predicates for
// its Plex / Jellyfin / SSO tabs. "Disable local login" can't be switched on
// without one (the settings route refuses it too).
async function externalSignInConfigured(): Promise<boolean> {
  if (isOidcConfigured()) return true;
  const instances = await Promise.all([getSyncableMediaInstances("plex"), getSyncableMediaInstances("jellyfin")]);
  return instances.some((list) => list.length > 0);
}

export async function SiteTab({ cfg, t }: { cfg: SettingsOf<typeof SITE_TAB_KEYS>; t: Translator }) {
  const externalSignIn = await externalSignInConfigured();
  // null ⇒ the stored allowlist doesn't parse, and sign-in is refusing every
  // OIDC login until it is re-saved (guardrail 34e).
  const oidcAllowlist = parseOidcAllowlist(cfg[OIDC_ALLOWLIST_SETTING_KEY]);
  return (
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
            externalSignInConfigured={externalSignIn}
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
  );
}
