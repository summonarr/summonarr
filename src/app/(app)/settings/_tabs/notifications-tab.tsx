import { EmailForm, EnableUserEmailsToggle, DiscordBotForm, IosPushRelayForm, AnnounceUpdateButton } from "@/components/settings/settings-ui";
import { NotificationAgentsManager } from "@/components/settings/notification-agents-manager";
import { ArrWatchForm } from "@/components/settings/forms/arr-watch-form";
import { ARR_WATCH_DISK_LOW_PERCENT_KEY, parseDiskLowPercent } from "@/lib/arr-watch";
import { isFeatureEnabled } from "@/lib/features";
import { SECRET_MASK_SENTINEL } from "@/lib/secret-mask";
import { DISCORD_KEYS, discordFormInitial } from "@/components/settings/forms/discord-bot-keys";
import type { Translator } from "@/lib/i18n/translate";
import type { SettingsOf } from "./settings-data";
import { SettingsCard, StatusBadge } from "./ui";

export const NOTIFICATIONS_TAB_KEYS = [
  "emailBackend", "smtpHost", "smtpPort", "smtpUser", "smtpPassword", "smtpFrom", "resendApiKey", "resendFrom", "enableUserEmails",
  ...DISCORD_KEYS,
  "apnsRelayUrl", "apnsRelayKey", "recommendedIosBuild",
  ARR_WATCH_DISK_LOW_PERCENT_KEY,
] as const;

export async function NotificationsTab({ cfg, t }: { cfg: SettingsOf<typeof NOTIFICATIONS_TAB_KEYS>; t: Translator }) {
  const agentsFeatureEnabled = await isFeatureEnabled("feature.integration.webhooks");
  return (
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
        <DiscordBotForm {...discordFormInitial(cfg)} />
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
  );
}
