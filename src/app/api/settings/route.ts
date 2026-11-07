import { NextResponse } from "next/server";
import { readJsonCapped } from "@/lib/body-size";
import { withAdmin } from "@/lib/api-auth";
import { invalidateSessionDurationsCache } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { testRadarrConnection, testSonarrConnection } from "@/lib/arr";
import { getJellyfinMediaFolders } from "@/lib/jellyfin";
import { checkRateLimit } from "@/lib/rate-limit";
import { EMAIL_TRANSPORT_KEYS, sendTestEmail, type EmailTransportOverrides } from "@/lib/email";
import { AUDIT_PII_RETENTION_MAX_DAYS, AUDIT_PII_RETENTION_MIN_DAYS, logAuditTx } from "@/lib/audit";
import { SECRET_MASK_SENTINEL } from "@/lib/secret-mask";
import { localeForRequest } from "@/lib/i18n/server-locale";
import { invalidatePublicKeyCache } from "@/lib/discord-interactions/signature";
import { getClientIp } from "@/lib/rate-limit";
import { sanitizeText } from "@/lib/sanitize";
import { putDiscordCommands, recordDiscordSchemaHash } from "@/lib/discord-register";
import { FEATURE_KEYS, invalidateFeatureFlagCache } from "@/lib/features";
import { invalidateApnsRelayCache } from "@/lib/push";
import { SETTINGS_SENSITIVE_KEYS_SET } from "@/lib/settings-sensitive-keys";
import { parseIpAllowlist, isValidIpOrCidr } from "@/lib/ip-allowlist";
import { stripUrlUserinfo, validateServerUrl } from "@/lib/server-url";
import { WATCH_GRADE_SETTING_KEYS, watchGradeCrossFieldError, watchGradeSettingError } from "@/lib/watch-grade";
import { mergedWatchGradeSettings } from "@/lib/watch-grade-data";
import { translatorForRequest } from "@/lib/i18n/server-locale";
import type { Translator } from "@/lib/i18n/translate";
import { processSingleton } from "@/lib/process-singleton";
import { TRACKING_STAMP_KEYS, trackingStampsFor } from "@/lib/never-watched";
import { NEVER_WATCHED_FEATURE_KEY } from "@/lib/never-watched-data";
import { CLEANUP_FEATURE_KEY } from "@/lib/library-cleanup-data";
import { invalidateNeverWatchedReport } from "@/lib/never-watched-report";
import { clearArrSnapshots, isArrConfigKey } from "@/lib/arr-snapshot";
import { MDBLIST_PLAN_SETTING_KEY, isMdblistPlanSetting } from "@/lib/mdblist-plan";
import { invalidateMdblistPlanCache } from "@/lib/mdblist";
import { getSyncableMediaInstances } from "@/lib/media-instance-registry";
import { isOidcConfigured } from "@/lib/oidc";
import { STATS_TIME_ZONE_KEY, normalizeTimeZone } from "@/lib/stats-time-zone";
import { databaseKnowsTimeZone, invalidateStatsTimeZone } from "@/lib/stats-time-zone-data";

// The settings this route writes that the never-watched report reads (guardrail
// 14d): a tracking switch (and its stamp) moves a server's coverage, retention
// moves the coverage floor, and the two feature flags decide whether a row can
// be "eligible" at all. The report is cached ~2 minutes; a write of any of these
// drops it, after the commit (switching tracking OFF changes the verdict too, so
// this keys on the switches themselves, not only on the stamps written).
const NEVER_WATCHED_INPUT_KEYS: ReadonlySet<string> = new Set([
  ...Object.keys(TRACKING_STAMP_KEYS),
  "playHistoryRetentionDays",
  CLEANUP_FEATURE_KEY,
  NEVER_WATCHED_FEATURE_KEY,
]);

const SETTINGS_SCHEMA = [
  ["siteTitle",                     false],
  ["siteUrl",                       false],
  ["radarrUrl",                     false],
  // The address a BROWSER uses for the instance — the "Open in Radarr" links.
  // Never fetched by the server. Blank = fall back to radarrUrl.
  ["radarrExternalUrl",             false],
  ["radarrApiKey",                  true ],
  ["radarrRootFolder",              false],
  ["radarrQualityProfileId",        false],
  // Radarr-only: when a movie counts as "available" to search
  // (announced/inCinemas/released). Empty = don't send, Radarr's default.
  ["radarrMinimumAvailability",     false],
  ["sonarrUrl",                     false],
  ["sonarrExternalUrl",             false],
  ["sonarrApiKey",                  true ],
  ["sonarrRootFolder",              false],
  ["sonarrQualityProfileId",        false],
  // Sonarr v3 only (v4 removed language profiles). Empty = don't send.
  ["sonarrLanguageProfileId",       false],
  ["webhookSecret",                 true ],
  ["sonarrWebhookSecret",           true ],
  ["radarrWebhookSecret",           true ],
  // Optional 4K instances (second Radarr/Sonarr). Sensitive keys must also be
  // listed in SETTINGS_SENSITIVE_KEYS (boot alignment check enforces it).
  ["radarr4kUrl",                   false],
  ["radarr4kExternalUrl",           false],
  ["radarr4kApiKey",                true ],
  ["radarr4kRootFolder",            false],
  ["radarr4kQualityProfileId",      false],
  ["radarr4kMinimumAvailability",   false],
  ["radarr4kWebhookSecret",         true ],
  ["sonarr4kUrl",                   false],
  ["sonarr4kExternalUrl",           false],
  ["sonarr4kApiKey",                true ],
  ["sonarr4kRootFolder",            false],
  ["sonarr4kQualityProfileId",      false],
  ["sonarr4kLanguageProfileId",     false],
  ["sonarr4kWebhookSecret",         true ],
  // Server-wide 4K: when "true", any user who can request the base media type
  // can also request 4K, without the per-user REQUEST_4K permission.
  ["request4kAll",                  false],
  ["plexAdminToken",                true ],
  ["plexAdminEmail",                false],
  ["plexServerUrl",                 false],
  ["plexLibraries",                 false],
  ["plexPathStripPrefix",           false],
  ["plexMoviePathStripPrefix",      false],
  ["plexTvPathStripPrefix",         false],
  ["jellyfinUrl",                   false],
  ["jellyfinApiKey",                true ],
  ["jellyfinLibraries",             false],
  ["jellyfinPathStripPrefix",       false],
  ["jellyfinMoviePathStripPrefix",  false],
  ["jellyfinTvPathStripPrefix",     false],
  ["jellyfinRestrictSignIn",        false],
  ["donationPaypal",                false],
  ["donationVenmo",                 false],
  ["donationZelle",                 false],
  ["donationAmazon",                false],
  ["donationPatreon",               false],
  ["donationBuyMeACoffee",          false],
  ["motdEnabled",                    false],
  ["motdTitle",                     false],
  ["motdBody",                      false],
  ["rateLimitRegister",             false],
  ["rateLimitRequests",             false],
  ["rateLimitIssues",               false],
  ["smtpHost",                      false],
  ["smtpPort",                      false],
  ["smtpUser",                      false],
  ["smtpPassword",                  true ],
  ["smtpFrom",                      false],
  ["emailBackend",                  false],
  ["resendApiKey",                  true ],
  ["resendFrom",                    false],
  ["discordBotToken",               true ],
  ["discordClientId",               false],
  ["discordGuildId",                false],
  ["discordPublicKey",              false],
  ["discordAutoApproveRoles",       false],
  ["discordRequireLinkedAccount",   false],
  ["discordRequireLinkedAccountSite", false],
  ["discordAdminRequestChannelId",  false],
  ["discordWelcomeChannelId",       false],
  ["discordLinkedRoleId",           false],
  ["discordPlexRoleId",             false],
  ["discordJellyfinRoleId",         false],
  ["discordAdminRoleId",            false],
  ["discordIssueAdminRoleId",       false],
  ["discordInviteUrl",              false],
  ["discordNotifyChannelId",        false],
  ["omdbApiKey",                    true ],
  ["mdblistApiKey",                 true ],
  // The MDBList plan the budget is kept against (mdblist-plan.ts).
  ["mdblistPlan",                   false],
  ["traktClientId",                 true ],
  // The Trakt app's secret — with the client id, what lets users connect their
  // own Trakt accounts (src/lib/trakt-user.ts).
  ["traktClientSecret",             true ],
  ["ratingsHiddenSources",          false],
  ["ipinfoToken",                   true ],
  // vapidPrivateKey is deliberately NOT here: push.ts generates the VAPID pair
  // itself and nothing in the UI types it. Admin-writable, a lone private half
  // no longer matched the stored public key and every web-push send failed.
  ["sessionDefaultDuration",        false],
  ["sessionMobileDuration",         false],
  ["sessionMaxDuration",            false],
  ["enableUserEmails",              false],
  ["quotaLimit",                    false],
  ["quotaPeriod",                   false],
  ["maxPushSubscriptions",          false],
  ["maintenanceEnabled",            false],
  ["maintenanceMessage",            false],
  ["deletionVoteThreshold",         false],
  // Days before audit-row PII (IP/UA/userName, auth-event details) is scrubbed —
  // read via getAuditPiiRetentionDays() by the scrub cron AND the manual scrub.
  ["auditPiiRetentionDays",         false],
  ["disableLocalLogin",              false],
  // "true" ⇒ a local-credentials ADMIN with no second factor is redirected from
  // /admin to enroll (src/lib/mfa/policy.ts; SUMMONARR_DISABLE_MFA_ENFORCEMENT
  // is the env escape hatch).
  ["requireMfaForAdmins",            false],
  ["playHistoryEnabled",             false],
  ["playHistoryPlexEnabled",         false],
  ["playHistoryJellyfinEnabled",     false],
  ["playHistoryWatchedThreshold",    false],
  ["concurrentStreamLimit",          false],
  ["playHistoryCompletionThreshold", false],
  ["playHistoryArcGapDays",          false],
  ["playHistoryPollingInterval",     false],
  ["playHistoryRetentionDays",       false],
  // The zone the activity statistics bucket hours and days in (an IANA name;
  // blank = the server process's own zone). stats-time-zone.ts.
  ["statsTimeZone",                  false],
  // Request watch grades (src/lib/watch-grade.ts). Bounds are validated below
  // against the same table the read side parses with.
  ["watchGradeGraceDays",            false],
  ["watchGradeWindowDays",           false],
  ["watchGradeTvPercent",            false],
  ["watchGradeOtherViewers",         false],
  ["watchGradeBandA",                false],
  ["watchGradeBandB",                false],
  ["watchGradeBandC",                false],
  ["watchGradeBandD",                false],
  ["watchGradeMinRequests",          false],
  ["enableMachineSession",           false],
  ["machineSessionAllowedIps",       false],
  ["apnsRelayUrl",                    false],
  // Optional bearer key for the APNs relay. Sent as "Authorization: Bearer <key>"
  // on every relay POST when set; clearable so relay auth can be turned off.
  ["apnsRelayKey",                    true ],
  // Soft-upgrade lever: iOS build number the operator recommends. Exposed via
  // /api/config/public so the app can show a dismissible update sheet. NOT the
  // hard 426 gate (that's MIN_CLIENT in src/lib/api-version.ts).
  ["recommendedIosBuild",             false],
  ["trashGuidesEnabled",              false],
  ["trashSyncCustomFormats",          false],
  ["trashSyncCustomFormatGroups",     false],
  ["trashSyncQualityProfiles",        false],
  ["trashSyncNaming",                 false],
  ["trashSyncQualitySizes",           false],
  ["trashGithubToken",                true ],
  // trashLastRefreshAt / trashLastRefreshTruncatedAt are cron bookkeeping rows
  // written by trash.ts, not settings — an admin-typed value there read as NaN.
  // Plex watchlist auto-request through the server owner's token (guardrail
  // 34b, src/lib/plex-friends-watchlist.ts). "true"|"false"; plaintext.
  ["plexWatchlistServerSource",       false],
  ["plexWatchlistServerAutoEnroll",   false],
  // Feature toggles — see src/lib/features.ts for the registry. All stored as "true"|"false".
  ["feature.page.top",                false],
  ["feature.page.popular",            false],
  ["feature.page.upcoming",           false],
  ["feature.page.issues",             false],
  ["feature.page.votes",              false],
  ["feature.page.donate",             false],
  ["feature.page.forYou",             false],
  ["feature.page.recentlyAdded",      false],
  ["feature.behavior.activeSessions", false],
  ["feature.behavior.activityCalendar", false],
  ["feature.behavior.watchGrades",    false],
  ["feature.behavior.requestComments", false],
  ["feature.behavior.issueAutoResolve", false],
  ["feature.behavior.watchlistAutoRequest", false],
  ["feature.behavior.forYouCoWatch", false],
  ["feature.integration.plex",        false],
  ["feature.integration.jellyfin",    false],
  ["feature.integration.radarr",      false],
  ["feature.integration.sonarr",      false],
  ["feature.integration.discord",     false],
  ["feature.integration.email",       false],
  ["feature.integration.push",        false],
  ["feature.integration.calendar",    false],
  ["feature.integration.webhooks",    false],
  ["feature.admin.stats",             false],
  ["feature.admin.activity",          false],
  ["feature.admin.auditLog",          false],
  ["feature.admin.backup",            false],
  ["feature.admin.apiDocs",           false],
  ["feature.admin.cleanup",           false],
  ["feature.admin.neverWatched",      false],
  ["feature.admin.watchSync",         false],
] as const satisfies ReadonlyArray<readonly [string, boolean]>;

type AllowedKey = (typeof SETTINGS_SCHEMA)[number][0];
const ALLOWED_KEYS = SETTINGS_SCHEMA.map(([k]) => k) as unknown as readonly AllowedKey[];
const ALLOWED_KEY_SET: ReadonlySet<string> = new Set<string>(ALLOWED_KEYS);
const isAllowedKey = (key: string): key is AllowedKey => ALLOWED_KEY_SET.has(key);
const SENSITIVE_KEYS = new Set<string>(
  SETTINGS_SCHEMA.filter(([, sensitive]) => sensitive).map(([k]) => k)
);

// GET sends this instead of a stored secret, and PATCH reads it back as "keep
// the saved value". Shared with the client forms (secret-mask.ts).
const MASKED_VALUE = SECRET_MASK_SENTINEL;

// Readable here (the settings page shows the connected account), never written:
// Connect Plex (/api/settings/plex, plex-admin-connect.ts) validates the token
// against plex.tv, writes the token and its account email together and clears
// PlexTokenCache. A PATCH did none of that, so a stale email stayed on the
// sign-in allow list.
const PLEX_CONNECT_ONLY_KEYS: ReadonlySet<string> = new Set(["plexAdminToken", "plexAdminEmail"]);

// Defense-in-depth boot check: bail loud if the writable-schema sensitive set
// drifts from SETTINGS_SENSITIVE_KEYS_SET (which the Prisma extension uses to
// gate encryption). A mismatch ships as either plaintext-at-rest or
// ciphertext-as-API-key — both silent failure modes.
(function assertSensitiveKeysAligned() {
  for (const k of SENSITIVE_KEYS) {
    if (!SETTINGS_SENSITIVE_KEYS_SET.has(k)) {
      throw new Error(
        `[settings] '${k}' is sensitive in SETTINGS_SCHEMA but missing from SETTINGS_SENSITIVE_KEYS — encryption will not fire`,
      );
    }
  }
  // A sensitive key the route does not expose at all (vapidPrivateKey — generated
  // by push.ts, never admin-typed) is fine: GET never returns it and PATCH never
  // writes it. The hole this guards is a key the route DOES expose as plaintext.
  for (const k of SETTINGS_SENSITIVE_KEYS_SET) {
    if (ALLOWED_KEY_SET.has(k) && !SENSITIVE_KEYS.has(k)) {
      throw new Error(
        `[settings] '${k}' is in SETTINGS_SENSITIVE_KEYS but not marked sensitive in SETTINGS_SCHEMA — GET would return it in cleartext`,
      );
    }
  }
})();

// Keys whose value is a full URL pointing at an upstream service. PATCH validates
// these (no embedded credentials, http/https only); GET strips any pre-existing
// embedded credential before sending the value to the admin client.
const URL_KEYS = new Set<string>([
  "siteUrl",
  "radarrUrl",
  "radarr4kUrl",
  "sonarrUrl",
  "sonarr4kUrl",
  "radarrExternalUrl",
  "radarr4kExternalUrl",
  "sonarrExternalUrl",
  "sonarr4kExternalUrl",
  "plexServerUrl",
  "jellyfinUrl",
  "discordInviteUrl",
  "apnsRelayUrl",
]);

// URL_KEYS that must use https:// only (no plaintext http). The APNs relay
// carries push payloads / device tokens, so the transport must be encrypted.
const HTTPS_ONLY_URL_KEYS = new Set<string>([
  "apnsRelayUrl",
]);

// Per-key write cooldown prevents rapid settings toggling (e.g. maintenanceEnabled spam)
const KEY_COOLDOWN_MS = 10_000;
const lastKeyWriteAt = processSingleton("settings:lastKeyWriteAt", () => new Map<string, number>());
// Feature-flag keys are exempt from the cooldown. The Features admin tab is a
// rapid-toggle UI by design — a 10s cooldown makes the second click of an
// accidental double-click look "stuck" (PATCH returns 429 → client rolls back
// the optimistic flip). Spam protection for this tab is handled client-side
// via trailing-edge coalescing in features-form.tsx plus the general
// admin-settings rate limit (10 PATCHes / minute).
// The standalone toggles below share that shape: each click PATCHes the same
// key and the control rolls back on a non-ok response, so a 429 inside the
// cooldown snaps it to the state the admin just tried to leave. The ratings grid
// is worse — 11 checkboxes all write ratingsHiddenSources.
const COOLDOWN_EXEMPT = new Set<string>([
  ...FEATURE_KEYS,
  "ratingsHiddenSources",
  "request4kAll",
  "plexWatchlistServerSource",
  "plexWatchlistServerAutoEnroll",
  "requireMfaForAdmins",
]);
processSingleton("settings:lastKeyWriteSweep", () =>
  setInterval(() => {
    const cutoff = Date.now() - KEY_COOLDOWN_MS;
    for (const [key, ts] of lastKeyWriteAt) {
      if (ts < cutoff) lastKeyWriteAt.delete(key);
    }
  }, 60_000).unref(),
);

// Boolean switches. Every reader compares against the literal ("=== \"true\"", or
// "!== \"false\"" for the default-on ones), so any other string silently reads as
// one side while the audit row still records a toggle — `maintenanceEnabled: "yes"`
// was audited MAINTENANCE_TOGGLE and enabled nothing. Only the two literals are
// stored. Every FEATURE_KEYS entry is "true"|"false" too (features.ts).
const BOOLEAN_KEYS = new Set<string>([
  ...FEATURE_KEYS,
  "maintenanceEnabled",
  "motdEnabled",
  "enableUserEmails",
  "disableLocalLogin",
  "requireMfaForAdmins",
  "enableMachineSession",
  "playHistoryEnabled",
  "playHistoryPlexEnabled",
  "playHistoryJellyfinEnabled",
  "jellyfinRestrictSignIn",
  "request4kAll",
  "discordRequireLinkedAccount",
  "discordRequireLinkedAccountSite",
  "trashGuidesEnabled",
  "trashSyncCustomFormats",
  "trashSyncCustomFormatGroups",
  "trashSyncQualityProfiles",
  "trashSyncNaming",
  "trashSyncQualitySizes",
  "plexWatchlistServerSource",
  "plexWatchlistServerAutoEnroll",
]);

// 90 days. auth.ts cap()s the three session TTLs to the same ceiling on READ as
// the backstop; the write side REFUSES an out-of-range value instead of silently
// rewriting it (the old loop stored "3600" for "30" / "abc" and the cap for
// anything larger, so the form said Saved for a value that was never saved).
const MAX_SESSION_SECONDS = 7_776_000;

// Integer settings with inclusive bounds, mirroring each reader's clamp so a value
// accepted here can never be silently replaced by the default on read:
// play-history.ts (thresholds 0–100, else 80/90; arc gap 1–365, else 14;
// retention — 0 = keep forever, a typo like "9O" used to read as 0 = OFF),
// quota.ts / votes (0 = off, "abc" used to read as off), push/subscribe (the
// per-user subscription cap), auth.ts (session TTLs). Digits only, like the
// sibling integer checks: parseInt would read "1e3" as 1.
const NUMERIC_BOUNDS: Partial<Record<AllowedKey, readonly [min: number, max: number]>> = {
  playHistoryWatchedThreshold: [0, 100],
  // 0 = off. An alert threshold (stream-limit.ts), not an enforcement.
  concurrentStreamLimit: [0, 50],
  playHistoryCompletionThreshold: [0, 100],
  playHistoryArcGapDays: [1, 365],
  playHistoryRetentionDays: [0, 3650],
  quotaLimit: [0, 10_000],
  deletionVoteThreshold: [0, 10_000],
  maxPushSubscriptions: [1, 100],
  sessionDefaultDuration: [60, MAX_SESSION_SECONDS],
  sessionMobileDuration: [60, MAX_SESSION_SECONDS],
  sessionMaxDuration: [60, MAX_SESSION_SECONDS],
  // email.ts throws "Invalid SMTP port" for anything else, on every send.
  smtpPort: [1, 65_535],
  // Recorded only (the live cadence is PLAY_HISTORY_SYNC_INTERVAL); the form's
  // own min/max.
  playHistoryPollingInterval: [5, 600],
};

// Radarr/Sonarr profile ids are positive integers. arr.ts reads anything else
// as "unset", so a typo silently dropped the profile from every add.
// Language profiles are Sonarr v3 only.
const POSITIVE_INT_KEYS: ReadonlySet<string> = new Set([
  "radarrQualityProfileId",
  "radarr4kQualityProfileId",
  "sonarrQualityProfileId",
  "sonarr4kQualityProfileId",
  "sonarrLanguageProfileId",
  "sonarr4kLanguageProfileId",
]);

// Closed sets. Their readers fall back quietly on anything else (quota.ts reads
// it as a week, email.ts as SMTP), so a typo was Saved and never applied.
const ENUM_VALUES: Partial<Record<AllowedKey, readonly string[]>> = {
  quotaPeriod: ["day", "week", "month"],
  emailBackend: ["smtp", "resend"],
};

// Library selections: comma-separated Plex section keys / Jellyfin item ids.
// The ids go into upstream query strings, so only id characters are stored.
const LIBRARY_LIST_KEYS: ReadonlySet<string> = new Set(["plexLibraries", "jellyfinLibraries"]);
const LIBRARY_ID_RE = /^[A-Za-z0-9_-]+$/;

const MAX_LENGTHS: Partial<Record<AllowedKey, number>> = { motdBody: 5000 };
const DEFAULT_MAX_LENGTH = 2000;

const USER_FACING_KEYS: ReadonlySet<string> = new Set(["motdTitle", "motdBody", "siteTitle", "maintenanceMessage"]);

// Donation keys accept either a plain handle (e.g. "@alice") or a link. A link
// must be https:// (checked in the PATCH loop), which also rules out dangerous
// schemes like javascript: or data: in the <a href> the donate page renders.
// donationAmazon has no handle form, so it must always be an https:// link.
const DONATION_URL_KEYS: ReadonlySet<string> = new Set([
  "donationPaypal",
  "donationVenmo",
  "donationZelle",
  "donationAmazon",
  "donationPatreon",
  "donationBuyMeACoffee",
]);

const SECRET_KEY_SUFFIXES = ["ApiKey", "Secret", "Token"] as const;
const isSecretShapedKey = (k: string) => SECRET_KEY_SUFFIXES.some((suffix) => k.endsWith(suffix));

const CONTROL_CHAR_RE = /[\x00-\x1f\x7f]/;

// Keys that may be written empty to clear them. Most keys skip empty writes so
// the client can echo back unchanged/masked values without wiping them; the IP
// allowlist must be clearable to lift the restriction, the relay key to turn
// relay auth off, the recommended build to retract the update prompt, and the
// relay URL to restore the publisher-default relay (push.ts falls back to
// DEFAULT_APNS_RELAY_URL when the stored value is empty).
const CLEARABLE_KEYS: ReadonlySet<string> = new Set([
  "machineSessionAllowedIps",
  "apnsRelayKey",
  "recommendedIosBuild",
  "apnsRelayUrl",
  // Third-party API keys: the Integrations forms offer a Remove action, and a
  // blank value that is silently dropped would report Saved while the old key
  // keeps working (ApiKeySettingForm). Readers treat "" as unset.
  "ipinfoToken",
  "omdbApiKey",
  "mdblistApiKey",
  // Removing either switches per-user Trakt connections off (the cron and
  // the profile card need both); the id alone also drives the public Trakt
  // lists. Readers treat "" as unset.
  "traktClientId",
  "traktClientSecret",
  // The TRaSH GitHub token card's Remove. loadGithubToken (trash.ts) reads ""
  // as no token, and its 30s cache lets the removal through on its own.
  "trashGithubToken",
  // Webhook secrets must be clearable or the admin form silently lies: it
  // offers a blank field to remove the secret, the write is skipped as an
  // empty value, and the UI still reports Saved while the OLD secret stays
  // valid. An operator who believed they had rotated or removed webhook auth
  // had done neither. Clearing one makes that instance secretless, and the
  // handlers reject a webhook when every instance secret is empty (401), so
  // the end state is "this webhook is off", not "this webhook is open".
  "webhookSecret",
  "radarrWebhookSecret",
  "sonarrWebhookSecret",
  "radarr4kWebhookSecret",
  "sonarr4kWebhookSecret",
  // Optional per-instance add-payload fields: clearing one means "stop
  // sending the field" (back to the arr service's own default) — without
  // clearability, once set they could never be unset from the form.
  "radarrMinimumAvailability",
  "radarr4kMinimumAvailability",
  "sonarrLanguageProfileId",
  "sonarr4kLanguageProfileId",
  // Blank = the "Open in Radarr/Sonarr" links use the connection URL again
  // (arrBrowserBase skips an empty value).
  "radarrExternalUrl",
  "radarr4kExternalUrl",
  "sonarrExternalUrl",
  "sonarr4kExternalUrl",
  // Blank = fall back to the 90-day default in getAuditPiiRetentionDays,
  // exactly what the form's helper text promises.
  "auditPiiRetentionDays",
  // Blank = the WATCH_GRADE_DEFAULTS value, as the Watch Grades form says.
  "watchGradeGraceDays",
  "watchGradeWindowDays",
  "watchGradeTvPercent",
  "watchGradeOtherViewers",
  "watchGradeBandA",
  "watchGradeBandB",
  "watchGradeBandC",
  "watchGradeBandD",
  "watchGradeMinRequests",
  // Optional Discord routing. Blanking the notify channel is the documented
  // way back to DMs ("Leave blank to send DMs"), and a role/invite id can
  // otherwise only be replaced, never removed.
  "discordAdminRequestChannelId",
  "discordWelcomeChannelId",
  "discordNotifyChannelId",
  "discordInviteUrl",
  "discordLinkedRoleId",
  "discordPlexRoleId",
  "discordJellyfinRoleId",
  "discordAdminRoleId",
  "discordIssueAdminRoleId",
  "discordAutoApproveRoles",
  // Core Discord app ids. A blank guild id is the documented switch from
  // guild-scoped to GLOBAL command registration (the registration below reads
  // "" as null); a blank client id / public key turns the bot off (registration
  // skips, /api/interactions answers 503). Without clearability the form
  // reported "Saved" while the old id stayed live and could never be removed.
  // discordBotToken is NOT here, like smtpPassword below: masked on GET.
  "discordGuildId",
  "discordClientId",
  "discordPublicKey",
  // Blank = fall back to window.location.origin / AUTH_URL, which every
  // reader already does with `||`. Otherwise a wrong public URL (an old
  // domain feeding the Plex forwardUrl and email links) could only be
  // replaced, never removed, while the form still said "Saved".
  "siteUrl",
  // Blank = the default "Summonarr" (the form's own placeholder); the sidebar,
  // login and setup pages all read it with `|| "Summonarr"` and the layout's
  // generateMetadata skips a falsy title. Same bug as siteUrl: emptying the
  // field said Saved while the old custom name stayed.
  "siteTitle",
  // /api/config publishes these to every visitor, so removing a payment
  // handle (a Zelle phone/email is personal data) has to actually remove it.
  "donationPaypal",
  "donationVenmo",
  "donationZelle",
  "donationAmazon",
  "donationPatreon",
  "donationBuyMeACoffee",
  // "Leave blank to use the username as the sender" (email.ts: smtpFrom ||
  // smtpUser), and a stale smtpUser forces AUTH on a relay that wants none.
  // smtpPassword is deliberately NOT here: it is masked on GET, so a blank
  // submit is indistinguishable from an echo and must never wipe the secret.
  // smtpPort isn't either: email.ts reads "" as an invalid port.
  "smtpFrom",
  "smtpUser",
  // Blank = send Resend mail from smtpFrom (email.ts resolveFromAddress).
  "resendFrom",
  // Empty = "sync every library", which is what each picker promises when no
  // box is ticked; every sync consumer already reads an empty value that way.
  "jellyfinLibraries",
  "plexLibraries",
  // bad-matches.ts treats an empty prefix as "no prefix", so writing empty is
  // the correct end state for removing a wrong one.
  "plexMoviePathStripPrefix",
  "plexTvPathStripPrefix",
  "jellyfinMoviePathStripPrefix",
  "jellyfinTvPathStripPrefix",
  // Optional user-facing copy: blank restores the built-in maintenance text
  // and drops the MOTD title/body.
  "maintenanceMessage",
  "motdTitle",
  "motdBody",
  // Blank = off, what "Set to 0 to disable" promises: parseQuotaLimit and the
  // vote routes' parseInt read "" as 0.
  "quotaLimit",
  "deletionVoteThreshold",
  // Blank = the built-in default each form shows as its placeholder:
  // parseRateLimit and getSessionDurations fall back on "". These forms start
  // blank on a fresh install, so blank must stay a valid answer.
  "rateLimitRegister",
  "rateLimitRequests",
  "rateLimitIssues",
  "maxPushSubscriptions",
  "sessionDefaultDuration",
  "sessionMobileDuration",
  "sessionMaxDuration",
  // Blank = the server process's own zone (resolveStatsTimeZone).
  "statsTimeZone",
]);

// Connection tests, run against the config a PATCH is about to save (submitted
// values over the stored rows) BEFORE anything is written: approvals, crons
// and webhooks never see an unverified URL or key, and a failure leaves nothing
// to roll back. A probe runs when either half of its pair is submitted,
// changed or not — re-pressing "Save & Test" re-tests. The messages stay in
// English for TEST_RESULT_MESSAGE_KEYS; the result keys are what the forms
// (arr-form, jellyfin-sync-form) and the iOS app read.
interface ConnectionProbe {
  urlKey: AllowedKey;
  keyKey: AllowedKey;
  okKey: string;
  errorKey: string;
  message: string;
  run: (url: string, apiKey: string) => Promise<string | true>;
}

const CONNECTION_PROBES: readonly ConnectionProbe[] = [
  { urlKey: "radarrUrl", keyKey: "radarrApiKey", okKey: "radarrVersion", errorKey: "radarrError", message: "Radarr connection failed", run: testRadarrConnection },
  { urlKey: "sonarrUrl", keyKey: "sonarrApiKey", okKey: "sonarrVersion", errorKey: "sonarrError", message: "Sonarr connection failed", run: testSonarrConnection },
  { urlKey: "radarr4kUrl", keyKey: "radarr4kApiKey", okKey: "radarr4kVersion", errorKey: "radarr4kError", message: "Radarr 4K connection failed", run: testRadarrConnection },
  { urlKey: "sonarr4kUrl", keyKey: "sonarr4kApiKey", okKey: "sonarr4kVersion", errorKey: "sonarr4kError", message: "Sonarr 4K connection failed", run: testSonarrConnection },
  // The Jellyfin URL feeds the hourly orchestrator, the 5s play-history poller
  // (guardrail 19's sole Jellyfin history writer) and Jellyfin sign-in.
  // getJellyfinMediaFolders routes through safeFetchAdminConfigured (5a).
  {
    urlKey: "jellyfinUrl", keyKey: "jellyfinApiKey", okKey: "jellyfinTested", errorKey: "jellyfinError", message: "Jellyfin connection failed",
    run: async (url, apiKey) => { await getJellyfinMediaFolders(url, apiKey); return true; },
  },
];

// Saving any of these sends the requesting admin a test email.
const EMAIL_PROBE_TRIGGERS = ["smtpHost", "smtpPassword", "resendApiKey", "emailBackend"] as const;
// An SMTP reply can be up to 1 MB and is passed through to the admin as is.
const SMTP_ERROR_MAX = 500;

// A value a client sent on purpose: not empty, not the echoed mask.
const isRealValue = (value: unknown): value is string =>
  typeof value === "string" && value.length > 0 && value !== MASKED_VALUE;

// The connectivity-test messages are kept in English and translated only on the
// way out. An upstream-supplied message (an SMTP error's own text) has no entry
// and passes through unchanged.
const TEST_RESULT_MESSAGE_KEYS: Record<string, string> = {
  "Radarr connection failed": "apiAdmin.settings.test.radarr",
  "Sonarr connection failed": "apiAdmin.settings.test.sonarr",
  "Radarr 4K connection failed": "apiAdmin.settings.test.radarr4k",
  "Sonarr 4K connection failed": "apiAdmin.settings.test.sonarr4k",
  "Jellyfin connection failed": "apiAdmin.common.jellyfinConnectionFailed",
  "Email test failed. Check your email settings.": "apiAdmin.settings.test.email",
};

function localizeTestResults(results: Record<string, unknown>, t: Translator): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(results)) {
    const key = typeof v === "string" && k.endsWith("Error") ? TEST_RESULT_MESSAGE_KEYS[v] : undefined;
    out[k] = key ? t(key) : v;
  }
  return out;
}

// AuditLog.details is VarChar(8000) and the SETTINGS_CHANGE row is written
// INSIDE the save transaction, so an oversized details string failed the insert
// and rolled the whole save back (a ~4k-char MOTD body, before + after, did).
// Long values are cut with a length marker; if many long values still don't
// fit, the values are dropped and the changed keys kept. JS length counts
// UTF-16 units, never fewer than the characters Postgres counts.
const AUDIT_DETAILS_MAX = 8000;
const AUDIT_VALUE_CAPS = [1000, 100] as const;

function capAuditValue(value: string, cap: number): string {
  if (value.length <= cap) return value;
  let head = value.slice(0, cap);
  if (/[\uD800-\uDBFF]$/.test(head)) head = head.slice(0, -1); // don't split a surrogate pair
  return `${head}… [${value.length} chars]`;
}

function settingsAuditDetails(
  keys: string[],
  before: Record<string, string>,
  after: Record<string, string>,
): Record<string, unknown> {
  // Returns the object whose JSON (as the audit row builder writes it) fits.
  const fits = (details: Record<string, unknown>) => JSON.stringify(details).length <= AUDIT_DETAILS_MAX;
  const capAll = (values: Record<string, string>, cap: number) =>
    Object.fromEntries(Object.entries(values).map(([k, v]) => [k, capAuditValue(v, cap)]));
  for (const cap of AUDIT_VALUE_CAPS) {
    const details = { keys, before: capAll(before, cap), after: capAll(after, cap) };
    if (fits(details)) return details;
  }
  const keysOnly = { keys, valuesOmitted: true };
  return fits(keysOnly) ? keysOnly : { keyCount: keys.length, valuesOmitted: true };
}

export const GET = withAdmin(async (_req, _ctx, _session) => {
  const rows = await prisma.setting.findMany({
    where: { key: { in: [...ALLOWED_KEYS] } },
  });

  const settings = Object.fromEntries(
    rows.map((r) => {
      if (SENSITIVE_KEYS.has(r.key)) return [r.key, r.value ? MASKED_VALUE : ""];
      if (URL_KEYS.has(r.key) && r.value) return [r.key, stripUrlUserinfo(r.value)];
      return [r.key, r.value];
    })
  ) as Partial<Record<AllowedKey, string>>;

  return NextResponse.json(settings);
});

export const PATCH = withAdmin(async (req, _ctx, session) => {
  const t = translatorForRequest(req);
  if (!checkRateLimit(`admin-settings:${session.user.id}`, 10, 60 * 1000)) {
    return NextResponse.json({ error: t("apiAdmin.common.tooManyRequestsLater") }, { status: 429 });
  }

  const parsed = await readJsonCapped<Record<string, string>>(req, 65536);
  if (parsed instanceof NextResponse) return parsed;
  const body = parsed;

  // The connection probes this body asks for: a real value for either half of a
  // pair. Their stored halves are read with the submitted keys, so each probe
  // can test the candidate config.
  const probes = CONNECTION_PROBES.filter((p) => isRealValue(body[p.urlKey]) || isRealValue(body[p.keyKey]));
  const emailProbe = EMAIL_PROBE_TRIGGERS.some((k) => isRealValue(body[k]));

  // The stored value of every key this PATCH names (sensitive ones come back
  // decrypted from the Prisma extension and are only ever compared, never
  // echoed). Resending a stored value is not a change: past the type and length
  // checks it is not validated, written, audited or cooldown-checked. Forms
  // resend whole sections, and treating those as edits audited untouched keys,
  // flushed caches and 429'd the next save on a key nobody changed.
  const readKeys = new Set(Object.keys(body).filter(isAllowedKey));
  for (const p of probes) {
    readKeys.add(p.urlKey);
    readKeys.add(p.keyKey);
  }
  const stored = new Map<string, string>(
    readKeys.size > 0
      ? (await prisma.setting.findMany({ where: { key: { in: [...readKeys] } } })).map((r) => [r.key, r.value])
      : [],
  );

  for (const [key, value] of Object.entries(body)) {
    if (!isAllowedKey(key)) continue;

    // Reject a type/length violation here instead of letting the `submitted`
    // filter below silently drop the key: a dropped key never reaches the
    // upsert loop, never lands in `changedKeys` or the audit row, yet the route
    // still answered 200 {ok:true} — an over-cap MOTD or a scripted boolean
    // `maintenanceEnabled` looked "Saved" in the UI while nothing was written.
    if (typeof value !== "string") {
      return NextResponse.json(
        { error: t("apiAdmin.settings.mustBeString", { key }) },
        { status: 400 },
      );
    }
    const maxLen = MAX_LENGTHS[key] ?? DEFAULT_MAX_LENGTH;
    if (value.length > maxLen) {
      return NextResponse.json(
        { error: t("apiAdmin.settings.tooLong", { key, max: maxLen }) },
        { status: 400 },
      );
    }

    if (value === MASKED_VALUE || value.length === 0) continue;
    // Only a new value is held to the rules below. A form resubmits every field
    // of its section, and a field saved before a rule existed (an http://
    // donation link, say) would otherwise 400 every later save of the whole
    // section, with nothing in the UI saying which field blocks it. An
    // unchanged value is never written, so nothing it could break is touched.
    if (value === stored.get(key)) continue;

    if (PLEX_CONNECT_ONLY_KEYS.has(key)) {
      return NextResponse.json({ error: t("apiAdmin.settings.plexConnectOnly", { key }) }, { status: 400 });
    }

    // A secret that still contains the mask's bullets is the mask with a key
    // pasted after it (the form's field held the placeholder as its value).
    // Only the exact mask means "keep"; anything else would be stored as the
    // credential and only fail later, upstream.
    if (SENSITIVE_KEYS.has(key) && value.includes(MASKED_VALUE[0])) {
      return NextResponse.json({ error: t("apiAdmin.settings.maskedPlaceholder", { key }) }, { status: 400 });
    }

    if (URL_KEYS.has(key)) {
      // Shared with /api/admin/media-instances so the default-instance keys and
      // the per-instance keys reject the exact same shapes (scheme, embedded
      // credentials). Length is already enforced by the per-key check above.
      const urlErr = validateServerUrl(value, { httpsOnly: HTTPS_ONLY_URL_KEYS.has(key) }, t);
      if (urlErr) {
        return NextResponse.json({ error: t("apiAdmin.settings.invalidUrl", { key, reason: urlErr }) }, { status: 400 });
      }
    }

    if (DONATION_URL_KEYS.has(key)) {
      // donationAmazon must always be a full URL; the others may be a plain handle
      // (e.g. "@alice"). Apply scheme guard when value looks URL-shaped (contains "://").
      const looksLikeUrl = value.includes("://");
      const requireUrl = key === "donationAmazon";
      if (looksLikeUrl || requireUrl) {
        // https ONLY, matching the renderer. /donate's safeUrl() drops anything
        // that isn't https:, so an http:// link saved cleanly here and then
        // silently rendered as dead text — the admin got a success toast for a
        // link that could never work. Reject at write time instead. (Tightening
        // this side rather than loosening the page: a donation link is exactly
        // where an http downgrade matters.) /donate's safeUrl() stays the actual
        // XSS boundary.
        try {
          const parsed = new URL(value);
          if (parsed.protocol !== "https:") {
            return NextResponse.json(
              { error: t("apiAdmin.settings.donationHttps"), code: "invalid-url" },
              { status: 400 },
            );
          }
        } catch {
          // Same { error } shape as every other 400 here, so the form can show the
          // reason; `code` keeps a machine-readable discriminator for API clients.
          return NextResponse.json(
            { error: t("apiAdmin.settings.donationHttps"), code: "invalid-url" },
            { status: 400 },
          );
        }
      }
    }

    if (isSecretShapedKey(key) && CONTROL_CHAR_RE.test(value)) {
      return NextResponse.json(
        { error: t("apiAdmin.settings.controlChars", { key }) },
        { status: 400 },
      );
    }

    if (key === "machineSessionAllowedIps") {
      const bad = parseIpAllowlist(value).find((t) => !isValidIpOrCidr(t));
      if (bad) {
        return NextResponse.json(
          { error: t("apiAdmin.settings.invalidIp", { key, value: String(bad) }) },
          { status: 400 },
        );
      }
    }

    // Rate-limit caps must be a positive integer. "0" (or any non-integer)
    // silently disables throttling in checkRateLimit, which treats a limit of
    // 0 as "always allowed" — an admin must never be able to turn off a limiter
    // by typo.
    // Digits only: parseInt("1e3") is 1, so a typed "1e3" (which a number input
    // accepts) passed the range and was stored verbatim — read back as 1/min.
    if (key.startsWith("rateLimit")) {
      const n = parseInt(value, 10);
      if (!/^\d+$/.test(value) || !Number.isFinite(n) || n < 1 || n > 10_000) {
        return NextResponse.json(
          { error: t("apiAdmin.settings.intRange10000", { key }) },
          { status: 400 },
        );
      }
    }

    // Relay bearer key: forwarded verbatim in an Authorization header, so it
    // must be a single printable-ASCII token (no whitespace, no control chars)
    // and long enough to not be a typo'd fragment. Commas are excluded because
    // the relay reads its keys from a comma-separated env list — a key
    // containing "," could never match on the relay side.
    if (key === "apnsRelayKey") {
      if (value.length < 8 || value.length > 200 || !/^[\x21-\x7e]+$/.test(value) || value.includes(",")) {
        return NextResponse.json(
          { error: t("apiAdmin.settings.printableAscii", { key }) },
          { status: 400 },
        );
      }
    }

    // Recommended iOS build is compared numerically against the app's build
    // number — persist only a plain positive integer.
    if (key === "recommendedIosBuild") {
      if (!/^\d+$/.test(value)) {
        return NextResponse.json(
          { error: t("apiAdmin.settings.intRangeMillion", { key }) },
          { status: 400 },
        );
      }
      const n = parseInt(value, 10);
      if (!Number.isFinite(n) || n < 1 || n > 1_000_000) {
        return NextResponse.json(
          { error: t("apiAdmin.settings.intRangeMillion", { key }) },
          { status: 400 },
        );
      }
    }

    // Every boolean switch (incl. the server-token watchlist pair) stores only
    // the two literals — see BOOLEAN_KEYS.
    if (BOOLEAN_KEYS.has(key) && value !== "true" && value !== "false") {
      return NextResponse.json(
        { error: t("apiAdmin.settings.trueFalse", { key }) },
        { status: 400 },
      );
    }

    // Bounded integers — see NUMERIC_BOUNDS. A 400 here replaces the old
    // silent session-duration rewrite and the readers' silent fallbacks.
    const bounds = NUMERIC_BOUNDS[key];
    if (bounds) {
      const n = /^\d+$/.test(value) ? parseInt(value, 10) : NaN;
      if (!Number.isInteger(n) || n < bounds[0] || n > bounds[1]) {
        return NextResponse.json(
          { error: t("apiAdmin.settings.intRange", { key, min: bounds[0], max: bounds[1] }) },
          { status: 400 },
        );
      }
    }

    const allowedValues = ENUM_VALUES[key];
    if (allowedValues && !allowedValues.includes(value)) {
      return NextResponse.json(
        { error: t("apiAdmin.settings.oneOf", { key, values: allowedValues.join(", ") }) },
        { status: 400 },
      );
    }

    // The ids are interpolated into upstream query strings (ParentId=…).
    // Readers split on "," and drop blanks, so blank items are tolerated.
    if (LIBRARY_LIST_KEYS.has(key)) {
      const ids = value.split(",").map((id) => id.trim()).filter(Boolean);
      if (!ids.every((id) => LIBRARY_ID_RE.test(id))) {
        return NextResponse.json({ error: t("apiAdmin.settings.libraryIds", { key }) }, { status: 400 });
      }
    }

    // The MDBList plan is one of the known plans or "auto"; anything else would
    // read back as "auto" and silently drop the admin's choice.
    if (key === MDBLIST_PLAN_SETTING_KEY && !isMdblistPlanSetting(value)) {
      return NextResponse.json(
        { error: t("apiAdmin.settings.mdblistPlanInvalid", { key }) },
        { status: 400 },
      );
    }

    // Radarr minimum-availability is a closed enum on the movie resource — an
    // arbitrary string would 400 every future add on that instance.
    if (key === "radarrMinimumAvailability" || key === "radarr4kMinimumAvailability") {
      if (value !== "announced" && value !== "inCinemas" && value !== "released") {
        return NextResponse.json(
          { error: t("apiAdmin.settings.minimumAvailability", { key }) },
          { status: 400 },
        );
      }
    }

    // Radarr/Sonarr quality- and language-profile ids — see POSITIVE_INT_KEYS.
    if (POSITIVE_INT_KEYS.has(key)) {
      const n = parseInt(value, 10);
      if (!/^\d+$/.test(value) || !Number.isInteger(n) || n < 1) {
        return NextResponse.json(
          { error: t("apiAdmin.settings.positiveInt", { key }) },
          { status: 400 },
        );
      }
    }

    // Audit PII retention window. Lower bound matters: a tiny value (or "0")
    // would scrub identity off every fresh audit row, quietly destroying the
    // log's forensic value — same typo-proofing rationale as the rateLimit
    // floor above. The bounds are the read-side clamp's own constants.
    if (key === "auditPiiRetentionDays") {
      const n = parseInt(value, 10);
      if (!/^\d+$/.test(value) || !Number.isInteger(n) || n < AUDIT_PII_RETENTION_MIN_DAYS || n > AUDIT_PII_RETENTION_MAX_DAYS) {
        return NextResponse.json(
          { error: t("apiAdmin.settings.daysRange", { key }) },
          { status: 400 },
        );
      }
    }

    // Watch-grade tuning. The bounds live beside the read-side parser, so a value
    // accepted here can never be silently replaced by the default on read.
    const watchGradeError = watchGradeSettingError(key, value, t);
    if (watchGradeError) {
      return NextResponse.json({ error: watchGradeError }, { status: 400 });
    }

    // Discord application/guild IDs are snowflakes: 17–20 digit decimal integers.
    // Persist them validated so downstream consumers (command registration,
    // notifications, link/merge flows) never receive a malformed identifier.
    if (key === "discordClientId" || key === "discordGuildId") {
      if (!/^\d{17,20}$/.test(value)) {
        return NextResponse.json(
          { error: t("apiAdmin.settings.snowflake", { key }) },
          { status: 400 },
        );
      }
    }

    // The Discord public key is a raw 32-byte Ed25519 key: exactly 64 hex chars.
    // /api/interactions decodes it with Buffer.from(hex) inside a try/catch that
    // reads as "signature invalid", so a pasted key with a stray newline or a typo
    // saved fine and then EVERY interaction answered 401 — while command
    // registration (which never reads the key) kept succeeding. Trim first (a
    // trailing newline is the routine paste) and store the trimmed value.
    if (key === "discordPublicKey") {
      const trimmed = value.trim();
      if (!/^[0-9a-f]{64}$/i.test(trimmed)) {
        return NextResponse.json(
          { error: t("apiAdmin.settings.discordPublicKey", { key }) },
          { status: 400 },
        );
      }
      body[key] = trimmed; // the write filter below reads `body`, not this loop's snapshot
    }

    // The statistics zone is bound into every hour/day bucket of the activity
    // SQL. Only a zone that Intl knows by name AND Postgres can use is stored,
    // in Intl's canonical spelling ("america/new_york" → "America/New_York"); a
    // bare offset is refused, as Postgres reads "+05:00" with east and west
    // swapped. Blank clears it (CLEARABLE_KEYS): back to the process zone.
    if (key === STATS_TIME_ZONE_KEY) {
      const zone = normalizeTimeZone(value);
      if (!zone || !(await databaseKnowsTimeZone(zone))) {
        return NextResponse.json({ error: t("apiAdmin.settings.timeZoneInvalid", { key }) }, { status: 400 });
      }
      body[key] = zone;
    }
  }

  // Never leave the machine-session API enabled with an empty IP allowlist. The
  // machine-session route treats an empty allowlist as "no IP restriction", so
  // that combination would let anyone holding CRON_SECRET mint a full admin
  // session from any IP — a privilege-escalation hole.
  //
  // We check the EFFECTIVE state after this PATCH (incoming values merged over
  // the stored rows), so it catches both "turn the feature on with no allowlist"
  // and "clear the allowlist while the feature stays on".
  //
  // An empty enableMachineSession means "unchanged", not "off": it is not in
  // CLEARABLE_KEYS, so the write filter drops it and the stored row survives.
  // Reading "" as "off" would let an empty toggle + empty allowlist slip past.
  // For the allowlist, by contrast, an empty string IS a real clearing write.
  const enableMachineSessionValue =
    typeof body.enableMachineSession === "string" && body.enableMachineSession !== ""
      ? body.enableMachineSession
      : undefined;
  const touchesMachineSession =
    enableMachineSessionValue !== undefined || body.machineSessionAllowedIps !== undefined;
  if (touchesMachineSession) {
    const [enableRow, allowRow] = await Promise.all([
      enableMachineSessionValue === undefined
        ? prisma.setting.findUnique({ where: { key: "enableMachineSession" } })
        : Promise.resolve(null),
      body.machineSessionAllowedIps === undefined
        ? prisma.setting.findUnique({ where: { key: "machineSessionAllowedIps" } })
        : Promise.resolve(null),
    ]);
    const effectiveEnabled =
      enableMachineSessionValue !== undefined
        ? enableMachineSessionValue === "true"
        : enableRow?.value === "true";
    const effectiveAllowlistNonEmpty =
      typeof body.machineSessionAllowedIps === "string"
        ? parseIpAllowlist(body.machineSessionAllowedIps).length > 0
        : parseIpAllowlist(allowRow?.value).length > 0;
    if (effectiveEnabled && !effectiveAllowlistNonEmpty) {
      return NextResponse.json(
        {
          error: t("apiAdmin.settings.machineSessionAllowlist"),
        },
        { status: 400 },
      );
    }
  }

  // Switching local login OFF refuses every password sign-in, registration and
  // two-factor completion. With no other way in, the instance is locked to the
  // sessions that already exist, and once the admin's ends, recovery is a
  // database edit. So turning it on needs at least one external sign-in that
  // works — the same predicates the login page uses to show those tabs.
  // Turning it off ("false") is always allowed, and so is resending a stored
  // "true" (nothing is written).
  if (body.disableLocalLogin === "true" && stored.get("disableLocalLogin") !== "true") {
    const [plexInstances, jellyfinInstances] = await Promise.all([
      getSyncableMediaInstances("plex"),
      getSyncableMediaInstances("jellyfin"),
    ]);
    if (!isOidcConfigured() && plexInstances.length === 0 && jellyfinInstances.length === 0) {
      return NextResponse.json(
        { error: t("apiAdmin.settings.disableLocalLoginNeedsProvider") },
        { status: 400 },
      );
    }
  }

  // Watch-grade rules that span fields (window vs grace, cutoffs in descending
  // order). The per-key bounds above can't see them, and a broken combination
  // doesn't fail loudly: a window inside the grace period scores nothing, and
  // out-of-order cutoffs hand out the wrong letters. Checked against the merged
  // stored + incoming values, so a PATCH of one key that breaks another is caught.
  const touchesWatchGrade = Object.values(WATCH_GRADE_SETTING_KEYS).some((key) => body[key] !== undefined);
  if (touchesWatchGrade) {
    const conflict = watchGradeCrossFieldError(await mergedWatchGradeSettings(body), t);
    if (conflict) return NextResponse.json({ error: conflict }, { status: 400 });
  }

  // What the client asked for: allowlisted, not the echoed mask, and empty only
  // for a key that can be cleared. A blank for any other key can't be stored,
  // so it is reported back in `ignored` when it would have replaced a stored
  // value — "Saved" was the only answer before, while the old value stayed.
  const submitted = new Map<AllowedKey, string>();
  const ignored: string[] = [];
  for (const [k, v] of Object.entries(body)) {
    if (!isAllowedKey(k) || typeof v !== "string" || v === MASKED_VALUE) continue;
    if (v.length === 0 && !CLEARABLE_KEYS.has(k)) {
      if (stored.get(k)) ignored.push(k);
      continue;
    }
    submitted.set(k, USER_FACING_KEYS.has(k) ? sanitizeText(v) : v);
  }

  // Only a real change is written. A missing row and an empty one read the
  // same everywhere, so clearing a key that holds nothing is no change either.
  const entries = [...submitted].filter(([k, v]) => (stored.get(k) ?? "") !== v);
  const changedKeys = entries.map(([k]) => k);

  // Per-key cooldown, for keys this request changes. A cooldown-exempt switch
  // and a resent unchanged value never wait.
  const now = Date.now();
  for (const key of changedKeys) {
    if (COOLDOWN_EXEMPT.has(key)) continue;
    const last = lastKeyWriteAt.get(key);
    if (last !== undefined && now - last < KEY_COOLDOWN_MS) {
      const retryAfterMs = KEY_COOLDOWN_MS - (now - last);
      return NextResponse.json(
        { error: t("apiAdmin.settings.cooldown", { key, seconds: Math.ceil(retryAfterMs / 1000) }), retryAfterMs },
        { status: 429 }
      );
    }
  }

  const extra = ignored.length > 0 ? { ignored } : {};
  if (entries.length === 0 && probes.length === 0 && !emailProbe) {
    return NextResponse.json({ ok: true, ...extra });
  }

  // Claim the cooldown before the probes (which can take up to ~30s), so a
  // second save of the same key can't start while this one is in flight. It is
  // released when nothing gets written.
  const claimedAt = now;
  const claimed = changedKeys.filter((k) => !COOLDOWN_EXEMPT.has(k));
  for (const key of claimed) lastKeyWriteAt.set(key, claimedAt);
  const releaseCooldown = () => {
    for (const key of claimed) {
      if (lastKeyWriteAt.get(key) === claimedAt) lastKeyWriteAt.delete(key);
    }
  };

  // Test the candidate config before anything is written — see CONNECTION_PROBES.
  const testResults: Record<string, unknown> = {};
  const candidate = (key: AllowedKey) => submitted.get(key) || stored.get(key);
  // Each run resolves to whether it passed; they run side by side.
  const probeRuns: Promise<boolean>[] = [];
  for (const p of probes) {
    const url = candidate(p.urlKey);
    const apiKey = candidate(p.keyKey);
    if (!url || !apiKey) continue;
    probeRuns.push(
      p.run(url, apiKey).then(
        (ok) => { testResults[p.okKey] = ok; return true; },
        () => { testResults[p.errorKey] = p.message; return false; },
      ),
    );
  }
  const adminEmail = session.user.email;
  if (emailProbe && adminEmail) {
    const overrides: EmailTransportOverrides = {};
    for (const k of EMAIL_TRANSPORT_KEYS) {
      const v = submitted.get(k);
      if (v !== undefined) overrides[k] = v;
    }
    probeRuns.push(
      // Written in the requesting admin's language (they are the recipient).
      sendTestEmail(adminEmail, localeForRequest(req), overrides).then(
        () => { testResults.smtpTested = true; return true; },
        (err: unknown) => {
          testResults.smtpError = err instanceof Error
            ? capAuditValue(err.message, SMTP_ERROR_MAX)
            : "Email test failed. Check your email settings.";
          return false;
        },
      ),
    );
  }
  const testFailed = (await Promise.all(probeRuns)).includes(false);

  if (testFailed) {
    releaseCooldown();
    return NextResponse.json({ ok: false, ...localizeTestResults(testResults, t), ...extra }, { status: 422 });
  }
  if (entries.length === 0) {
    releaseCooldown();
    return NextResponse.json({ ok: true, ...localizeTestResults(testResults, t), ...extra });
  }

  const oldValues: Record<string, string> = {};
  for (const key of changedKeys) {
    const prior = stored.get(key);
    if (prior !== undefined) oldValues[key] = SENSITIVE_KEYS.has(key) ? "[redacted]" : prior;
  }
  const newValues: Record<string, string> = Object.fromEntries(entries.map(([k, v]) => [k, SENSITIVE_KEYS.has(k) ? "[redacted]" : v]));

  const auditIp = getClientIp(req.headers as Headers);
  const auditUa = req.headers.get("user-agent")?.slice(0, 512) ?? null;
  // A play while a tracking switch was off was never recorded, so the
  // never-watched verdict trusts recording only from the moment a switch last
  // came back on (guardrail 14d). Stamped in the same transaction as the flip.
  const stampEntries = trackingStampsFor(entries, stored, new Date());
  try {
    await prisma.$transaction(async (tx) => {
      // Sequential, not Promise.all: an interactive tx runs on one pinned
      // connection, so parallel statements serialize at best and can interleave
      // or deadlock at worst. Entries are bounded by the settings allowlist.
      for (const [key, value] of entries) {
        // Sensitive keys are encrypted at rest by the Prisma extension in src/lib/prisma.ts.
        // Do NOT pre-encrypt here — that produced double-encrypted rows (enc:v1:<enc:v1:…>)
        // which decrypted on read into the inner ciphertext, breaking Jellyfin/Radarr/etc auth.
        await tx.setting.upsert({
          where: { key },
          update: { value },
          create: { key, value },
        });
      }
      for (const [key, value] of stampEntries) {
        await tx.setting.upsert({ where: { key }, update: { value }, create: { key, value } });
      }
      // The shared row builder (audit.ts), on the tx client: same sanitizing as
      // every other audit row, and a failed write rolls the save back (26).
      await logAuditTx(tx, {
        userId: session.user.id,
        userName: session.user.name ?? session.user.email ?? "unknown",
        action: changedKeys.includes("maintenanceEnabled") ? "MAINTENANCE_TOGGLE" : "SETTINGS_CHANGE",
        target: "settings",
        details: settingsAuditDetails(changedKeys, oldValues, newValues),
        ipAddress: auditIp,
        userAgent: auditUa,
        provider: session.user.provider ?? null,
      });
    });
  } catch (err) {
    releaseCooldown();
    console.error("[audit] Settings transaction failed:", err);
    return NextResponse.json({ error: t("apiAdmin.settings.auditFailed") }, { status: 500 });
  }
  // Feature flags are memoized (features.ts); drop the memo so a toggle in this
  // write is visible on the very next check instead of after the TTL.
  invalidateFeatureFlagCache();
  const neverWatchedInputChanged = changedKeys.some((k) => NEVER_WATCHED_INPUT_KEYS.has(k));
  if (neverWatchedInputChanged) invalidateNeverWatchedReport();
  // A Radarr/Sonarr connection or integration switch changed: the admin arr
  // pages' snapshots may name an instance that is gone or switched off (5h).
  const arrConfigChanged = changedKeys.some(isArrConfigKey);
  if (arrConfigChanged) clearArrSnapshots();
  // Same for the APNs relay config, which push.ts memoizes for 30s. The admin
  // flow is "save the relay key, then press Send test notification", so a stale
  // read lands on exactly the interaction used to verify the change.
  invalidateApnsRelayCache();
  // The MDBList plan is memoized for 30s too (mdblist.ts); a new plan applies now.
  if (changedKeys.includes(MDBLIST_PLAN_SETTING_KEY)) invalidateMdblistPlanCache();
  // A new statistics zone applies on the next request: the zone is part of every
  // bucketed aggregate's cache key, so dropping the zone memo is enough.
  if (changedKeys.includes(STATS_TIME_ZONE_KEY)) invalidateStatsTimeZone();
  if (changedKeys.some((k) => k === "sessionDefaultDuration" || k === "sessionMobileDuration" || k === "sessionMaxDuration")) {
    invalidateSessionDurationsCache();
  }
  if (changedKeys.some((k) => k === "discordBotToken" || k === "discordClientId" || k === "discordGuildId" || k === "discordPublicKey")) {
    invalidatePublicKeyCache();
  }

  // Re-register the slash commands only once the write is DURABLE (the task
  // re-reads the DB), and only on a real CHANGE to the registration inputs:
  // the Discord form posts every field on every save, and a presence gate fired
  // this bulk-overwrite PUT on a Channels/Roles-tab save that touched neither.
  // `updated` holds changed values only. discordPublicKey does not affect
  // command registration and is left out.
  const updated = Object.fromEntries(entries);
  const discordRegistrationChanged = (["discordBotToken", "discordClientId", "discordGuildId"] as const).some(
    (k) => k in updated && updated[k] !== stored.get(k),
  );
  if (discordRegistrationChanged) {
    void (async () => {
      try {
        const rows = await prisma.setting.findMany({
          where: { key: { in: ["discordBotToken", "discordClientId", "discordGuildId"] } },
        });
        const cfg = Object.fromEntries(rows.map((r) => [r.key, r.value]));
        if (!cfg.discordBotToken || !cfg.discordClientId) return;

        const DISCORD_SNOWFLAKE = /^\d{1,20}$/;
        if (!DISCORD_SNOWFLAKE.test(cfg.discordClientId)) {
          console.error("[discord] Invalid discordClientId — must be a numeric snowflake");
          return;
        }
        if (cfg.discordGuildId && !DISCORD_SNOWFLAKE.test(cfg.discordGuildId)) {
          console.error("[discord] Invalid discordGuildId — must be a numeric snowflake");
          return;
        }

        const guildId = cfg.discordGuildId?.trim() || null;
        const res = await putDiscordCommands(cfg.discordBotToken, cfg.discordClientId, guildId);
        if (!res.ok) {
          console.error(`[discord] Command re-registration failed: ${res.status} ${await res.text()}`);
        } else {
          // Keep the boot self-heal's hash in step so it won't redundantly re-push.
          await recordDiscordSchemaHash(guildId);
        }
      } catch (err) {
        console.error("[discord] Command re-registration error:", err);
      }
    })();
  }

  return NextResponse.json({ ok: true, ...localizeTestResults(testResults, t), ...extra });
});
