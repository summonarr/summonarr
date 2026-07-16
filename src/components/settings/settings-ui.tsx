// Compatibility barrel — this file used to hold every settings form component
// (~4,200 lines). Each form now lives in its own file under ./forms/; the
// re-exports below preserve the original public surface so importers keep
// using "@/components/settings/settings-ui" unchanged.
export { ArrForm } from "./forms/arr-form";
export { WebhookSecretForm } from "./forms/webhook-secret-form";
export { WebhookUrls } from "./forms/webhook-urls";
export { PlexConnectForm } from "./forms/plex-connect-form";
export { JellyfinSyncForm } from "./forms/jellyfin-sync-form";
export { DonationForm } from "./forms/donation-form";
export { RateLimitForm } from "./forms/rate-limit-form";
export { IosPushRelayForm } from "./forms/ios-push-relay-form";
export { AnnounceUpdateButton } from "./forms/announce-update-button";
export { SessionForm } from "./forms/session-form";
export { SiteTitleForm } from "./forms/site-title-form";
export { SiteUrlForm } from "./forms/site-url-form";
export { MaintenanceForm } from "./forms/maintenance-form";
export { MotdForm } from "./forms/motd-form";
export { DiscordBotForm } from "./forms/discord-bot-form";
export { EmailForm } from "./forms/email-form";
export { RatingsWarmButton } from "./forms/ratings-warm-button";
export { CacheManagementPanel } from "./forms/cache-management-panel";
export { ActivityWarmButton } from "./forms/activity-warm-button";
export { OmdbForm } from "./forms/omdb-form";
export { MdblistForm } from "./forms/mdblist-form";
export { TraktForm } from "./forms/trakt-form";
export { IpinfoForm } from "./forms/ipinfo-form";
export { LibraryMatchForm } from "./forms/library-match-form";
export { QuotaForm } from "./forms/quota-form";
export { EnableUserEmailsToggle } from "./forms/enable-user-emails-toggle";
export { DeletionVoteThresholdForm } from "./forms/deletion-vote-threshold-form";
export { DisableLocalLoginToggle } from "./forms/disable-local-login-toggle";
export { JellyfinRestrictSignInToggle } from "./forms/jellyfin-restrict-sign-in-toggle";
export { RatingsVisibilityForm } from "./forms/ratings-visibility-form";
export { Request4kAllToggle } from "./forms/request-4k-all-toggle";
export { EnableMachineSessionToggle } from "./forms/enable-machine-session-toggle";
