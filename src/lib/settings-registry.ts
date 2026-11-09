// Every key the admin settings route (/api/settings) reads and writes, in one
// table: how a new value is checked, whether it is a secret, whether a blank
// clears it, whether it skips the write cooldown, and what a committed change
// must drop. Each entry's `type` is required, so a new key can't be accepted
// with no validation, and the checks below tie `sensitive` to the encryption
// gate's own list (guardrail 7a) and secret-shaped names to the credential check.
//
// The feature flags are not listed here: every key features.ts registers is
// a cooldown-exempt "true"|"false" switch, so a registered flag is writable by
// construction (an unlisted one used to render a toggle that never saved).
//
// The route composes these; nothing here touches the database except through
// the time-zone check the caller passes in.
import type { Translator } from "./i18n/translate";
import { FEATURE_KEYS, type FeatureKey } from "./features";
import { AUDIT_PII_RETENTION_MAX_DAYS, AUDIT_PII_RETENTION_MIN_DAYS } from "./audit";
import { SECRET_MASK_SENTINEL } from "./secret-mask";
import { SETTINGS_SENSITIVE_KEYS_SET } from "./settings-sensitive-keys";
import { parseIpAllowlist, isValidIpOrCidr } from "./ip-allowlist";
import { stripUrlUserinfo, validateServerUrl } from "./server-url";
import { sanitizeText } from "./sanitize";
import { watchGradeSettingError } from "./watch-grade";
import { MDBLIST_PLAN_SETTING_KEY, isMdblistPlanSetting } from "./mdblist-plan";
import { STATS_TIME_ZONE_KEY, normalizeTimeZone } from "./stats-time-zone";

// ── value types ──────────────────────────────────────────────────────────────

/** The 400 text an out-of-range integer gets (each is part of the wire contract). */
export type IntMessage = "intRange" | "intRange10000" | "intRangeMillion" | "positiveInt" | "daysRange";

export type SettingType =
  /** Free text, held to the length cap only (`noControlChars` also refuses control characters). */
  | { readonly kind: "text"; readonly noControlChars?: true }
  /** A credential whose name ends in ApiKey/Secret/Token: no control characters. */
  | { readonly kind: "secret" }
  /** A full upstream URL (shared rules with /api/admin/media-instances). */
  | { readonly kind: "url"; readonly httpsOnly?: true }
  /** A donation handle or https:// link; `linkOnly` has no handle form. */
  | { readonly kind: "donation"; readonly linkOnly?: true }
  /** Only the two literals every reader compares against. */
  | { readonly kind: "boolean" }
  /** Digits only, inside [min, max]. */
  | { readonly kind: "int"; readonly min: number; readonly max: number; readonly message: IntMessage }
  /** A closed set its reader would otherwise read some other way. */
  | { readonly kind: "enum"; readonly values: readonly string[]; readonly message: "oneOf" | "minimumAvailability" }
  | { readonly kind: "mdblistPlan" }
  | { readonly kind: "libraryIds" }
  | { readonly kind: "ipAllowlist" }
  | { readonly kind: "relayKey" }
  | { readonly kind: "snowflake" }
  | { readonly kind: "ed25519PublicKey" }
  | { readonly kind: "timeZone" }
  | { readonly kind: "watchGrade" };

/** What a committed change to a key must drop or redo (the route maps each to its call). */
export type SettingEffect =
  | "neverWatchedReport"
  | "playHistorySettings"
  | "mdblistPlan"
  | "statsTimeZone"
  | "watchGradeSettings"
  | "sessionDurations"
  | "discordPublicKey"
  | "discordCommands";

export interface SettingDef {
  readonly type: SettingType;
  /** Encrypted at rest and masked on GET; must match SETTINGS_SENSITIVE_KEYS (guardrail 7a). */
  readonly sensitive?: true;
  /**
   * A blank value is written. Every other key skips a blank, so a form can echo
   * back unchanged or masked values without wiping them.
   */
  readonly clearable?: true;
  /** Skips the per-key write cooldown: a control that PATCHes on every click. */
  readonly cooldownExempt?: true;
  /** User-facing copy, stored through sanitizeText. */
  readonly sanitize?: true;
  /** Defaults to DEFAULT_MAX_LENGTH. */
  readonly maxLength?: number;
  /** Written only by Connect Plex; a PATCH of it is refused. */
  readonly connectOnly?: true;
  readonly effects?: readonly SettingEffect[];
}

export const DEFAULT_MAX_LENGTH = 2000;

// 90 days. auth.ts cap()s the three session TTLs to the same ceiling on READ as
// the backstop; the write side REFUSES an out-of-range value instead of silently
// rewriting it (the old loop stored "3600" for "30" / "abc" and the cap for
// anything larger, so the form said Saved for a value that was never saved).
const MAX_SESSION_SECONDS = 7_776_000;

/** Discord application/guild ids: 17–20 digit snowflakes (also the re-registration's check). */
export const DISCORD_SNOWFLAKE_RE = /^\d{17,20}$/;

const TEXT = { kind: "text" } as const;
const SECRET = { kind: "secret" } as const;
const SERVER_URL = { kind: "url" } as const;
const BOOLEAN = { kind: "boolean" } as const;
const DONATION = { kind: "donation" } as const;
const SNOWFLAKE = { kind: "snowflake" } as const;
const WATCH_GRADE = { kind: "watchGrade" } as const;
const WATCH_GRADE_EFFECTS: readonly SettingEffect[] = ["watchGradeSettings"];
const LIBRARY_IDS = { kind: "libraryIds" } as const;
const int = (min: number, max: number, message: IntMessage = "intRange") => ({ kind: "int", min, max, message }) as const;
// Radarr/Sonarr profile ids. arr.ts reads anything else as "unset", so a typo
// silently dropped the profile from every add.
// Capped at int32 max: the arrs bind it to a 32-bit integer, so a larger digit
// string would be stored and only fail upstream.
const PROFILE_ID = int(1, 2_147_483_647, "positiveInt");
// A closed enum on Radarr's movie resource: anything else 400s every add.
const MINIMUM_AVAILABILITY = { kind: "enum", values: ["announced", "inCinemas", "released"], message: "minimumAvailability" } as const;

const NEVER_WATCHED_AND_PLAY_HISTORY = ["neverWatchedReport", "playHistorySettings"] as const;
const PLAY_HISTORY = ["playHistorySettings"] as const;
const DISCORD_REGISTRATION = ["discordPublicKey", "discordCommands"] as const;

// Integer bounds mirror each reader's clamp, so a value accepted here can never
// be silently replaced by the default on read: play-history.ts (thresholds
// 0–100, else 80/90; arc gap 1–365, else 14; retention — 0 = keep forever, a
// typo like "9O" used to read as 0 = OFF), quota.ts / votes (0 = off, "abc" used
// to read as off), push/subscribe (the per-user subscription cap), auth.ts
// (session TTLs). Digits only: parseInt would read "1e3" (which a number input
// accepts) as 1.
//
// Clearable keys, and why a blank is a real answer for each:
// - third-party API keys and the TRaSH token: the forms offer Remove, and a
//   dropped blank reported Saved while the old key kept working. Readers treat
//   "" as unset (trash.ts's 30s token cache lets the removal through).
// - webhook secrets: the form offers a blank field to remove one; a skipped
//   blank said Saved while the OLD secret stayed valid. A cleared instance is
//   secretless, and the handlers reject a webhook when every secret is empty
//   (401) — the end state is "this webhook is off", not "open".
// - optional add-payload fields (minimum availability, language profile):
//   blank = stop sending the field, back to the arr's own default.
// - external URLs: blank = the "Open in Radarr/Sonarr" links use the
//   connection URL again (arrBrowserBase skips an empty value).
// - Discord routing ids and the invite: blanking the notify channel is the
//   documented way back to DMs, and a role/invite could otherwise only be
//   replaced. A blank guild id switches registration to GLOBAL commands; a
//   blank client id / public key turns the bot off (registration skips,
//   /api/interactions answers 503).
// - siteUrl / siteTitle: every reader falls back with `||` (window origin /
//   AUTH_URL, "Summonarr").
// - donation handles: /api/config publishes them to every visitor, so removing
//   one (a Zelle phone or email is personal data) has to remove it.
// - library selections: empty = sync every library, what each picker promises.
// - path-strip prefixes: bad-matches.ts reads empty as no prefix.
// - maintenance/MOTD copy: blank restores the built-in text, drops the MOTD.
// - quota / vote threshold: blank = off ("Set to 0 to disable").
// - rate limits, push cap, session lengths: blank = the built-in default each
//   form shows as its placeholder (a fresh install's forms start blank).
// - smtpFrom ("blank = use the username"), smtpUser (a stale one forces AUTH on
//   a relay that wants none), resendFrom (blank = smtpFrom).
// - the IP allowlist (lifts the restriction), the relay key (relay auth off),
//   the relay URL (back to the publisher default), the recommended build
//   (retracts the update prompt), audit retention / watch grades / the stats
//   zone (back to their defaults).
// - the Discord bot token: its form starts the field EMPTY (blank = keep, never
//   sent) and offers an explicit Remove; the bare mask is dropped before the
//   write filter, so only that Remove ever sends a blank. Clearing it stops
//   command registration and role sync (both skip without a token).
// NOT clearable on purpose: masked secrets still edited through a mask echo
// (smtpPassword, the arr API keys) — a blank submit can't be told from an echo
// and must never wipe the secret; smtpPort, which email.ts reads "" as an
// invalid port.
const BASE_SETTINGS = {
  siteTitle: { type: TEXT, clearable: true, sanitize: true },
  siteUrl: { type: SERVER_URL, clearable: true },
  radarrUrl: { type: SERVER_URL },
  // The address a BROWSER uses for the instance — the "Open in Radarr" links.
  // Never fetched by the server. Blank = fall back to radarrUrl.
  radarrExternalUrl: { type: SERVER_URL, clearable: true },
  radarrApiKey: { type: SECRET, sensitive: true },
  radarrRootFolder: { type: TEXT },
  radarrQualityProfileId: { type: PROFILE_ID },
  // Radarr-only: when a movie counts as "available" to search
  // (announced/inCinemas/released). Empty = don't send, Radarr's default.
  radarrMinimumAvailability: { type: MINIMUM_AVAILABILITY, clearable: true },
  sonarrUrl: { type: SERVER_URL },
  sonarrExternalUrl: { type: SERVER_URL, clearable: true },
  sonarrApiKey: { type: SECRET, sensitive: true },
  sonarrRootFolder: { type: TEXT },
  sonarrQualityProfileId: { type: PROFILE_ID },
  // Sonarr v3 only (v4 removed language profiles). Empty = don't send.
  sonarrLanguageProfileId: { type: PROFILE_ID, clearable: true },
  webhookSecret: { type: SECRET, sensitive: true, clearable: true },
  sonarrWebhookSecret: { type: SECRET, sensitive: true, clearable: true },
  radarrWebhookSecret: { type: SECRET, sensitive: true, clearable: true },
  // Optional 4K instances (second Radarr/Sonarr).
  radarr4kUrl: { type: SERVER_URL },
  radarr4kExternalUrl: { type: SERVER_URL, clearable: true },
  radarr4kApiKey: { type: SECRET, sensitive: true },
  radarr4kRootFolder: { type: TEXT },
  radarr4kQualityProfileId: { type: PROFILE_ID },
  radarr4kMinimumAvailability: { type: MINIMUM_AVAILABILITY, clearable: true },
  radarr4kWebhookSecret: { type: SECRET, sensitive: true, clearable: true },
  sonarr4kUrl: { type: SERVER_URL },
  sonarr4kExternalUrl: { type: SERVER_URL, clearable: true },
  sonarr4kApiKey: { type: SECRET, sensitive: true },
  sonarr4kRootFolder: { type: TEXT },
  sonarr4kQualityProfileId: { type: PROFILE_ID },
  sonarr4kLanguageProfileId: { type: PROFILE_ID, clearable: true },
  sonarr4kWebhookSecret: { type: SECRET, sensitive: true, clearable: true },
  // Server-wide 4K: when "true", any user who can request the base media type
  // can also request 4K, without the per-user REQUEST_4K permission.
  request4kAll: { type: BOOLEAN, cooldownExempt: true },
  // Readable here (the settings page shows the connected account), never written:
  // Connect Plex (/api/settings/plex, plex-admin-connect.ts) validates the token
  // against plex.tv, writes the token and its account email together and clears
  // PlexTokenCache. A PATCH did none of that, so a stale email stayed on the
  // sign-in allow list.
  plexAdminToken: { type: SECRET, sensitive: true, connectOnly: true },
  plexAdminEmail: { type: TEXT, connectOnly: true },
  plexServerUrl: { type: SERVER_URL },
  // Comma-separated Plex section keys / Jellyfin item ids, interpolated into
  // upstream query strings: only id characters are stored.
  plexLibraries: { type: LIBRARY_IDS, clearable: true },
  plexPathStripPrefix: { type: TEXT },
  plexMoviePathStripPrefix: { type: TEXT, clearable: true },
  plexTvPathStripPrefix: { type: TEXT, clearable: true },
  jellyfinUrl: { type: SERVER_URL },
  jellyfinApiKey: { type: SECRET, sensitive: true },
  jellyfinLibraries: { type: LIBRARY_IDS, clearable: true },
  jellyfinPathStripPrefix: { type: TEXT },
  jellyfinMoviePathStripPrefix: { type: TEXT, clearable: true },
  jellyfinTvPathStripPrefix: { type: TEXT, clearable: true },
  jellyfinRestrictSignIn: { type: BOOLEAN },
  // A handle ("@alice") or a link; a link must be https://, which also rules out
  // javascript:/data: in the <a href> the donate page renders. Amazon has no
  // handle form.
  donationPaypal: { type: DONATION, clearable: true },
  donationVenmo: { type: DONATION, clearable: true },
  donationZelle: { type: DONATION, clearable: true },
  donationAmazon: { type: { kind: "donation", linkOnly: true }, clearable: true },
  donationPatreon: { type: DONATION, clearable: true },
  donationBuyMeACoffee: { type: DONATION, clearable: true },
  motdTitle: { type: TEXT, clearable: true, sanitize: true },
  motdBody: { type: TEXT, clearable: true, sanitize: true, maxLength: 5000 },
  // A positive integer: "0" (or any non-integer) silently disables throttling
  // in checkRateLimit, which treats a limit of 0 as "always allowed" — an admin
  // must never be able to turn off a limiter by typo.
  rateLimitRegister: { type: int(1, 10_000, "intRange10000"), clearable: true },
  rateLimitRequests: { type: int(1, 10_000, "intRange10000"), clearable: true },
  rateLimitIssues: { type: int(1, 10_000, "intRange10000"), clearable: true },
  smtpHost: { type: TEXT },
  // email.ts throws "Invalid SMTP port" for anything else, on every send.
  smtpPort: { type: int(1, 65_535) },
  smtpUser: { type: TEXT, clearable: true },
  // Not "secret" kind (its name isn't secret-shaped), but a pasted newline or tab
  // would break the SMTP AUTH exchange, so control characters are refused too.
  smtpPassword: { type: { kind: "text", noControlChars: true }, sensitive: true },
  smtpFrom: { type: TEXT, clearable: true },
  // Readers fall back quietly on anything else (email.ts reads it as SMTP).
  emailBackend: { type: { kind: "enum", values: ["smtp", "resend"], message: "oneOf" } },
  resendApiKey: { type: SECRET, sensitive: true },
  resendFrom: { type: TEXT, clearable: true },
  discordBotToken: { type: SECRET, sensitive: true, clearable: true, effects: DISCORD_REGISTRATION },
  // Persisted validated so command registration, notifications and the
  // link/merge flows never receive a malformed id.
  discordClientId: { type: SNOWFLAKE, clearable: true, effects: DISCORD_REGISTRATION },
  discordGuildId: { type: SNOWFLAKE, clearable: true, effects: DISCORD_REGISTRATION },
  // Does not affect command registration, only the interactions signature check.
  discordPublicKey: { type: { kind: "ed25519PublicKey" }, clearable: true, effects: ["discordPublicKey"] },
  discordAutoApproveRoles: { type: TEXT, clearable: true },
  discordRequireLinkedAccount: { type: BOOLEAN },
  discordRequireLinkedAccountSite: { type: BOOLEAN },
  discordAdminRequestChannelId: { type: TEXT, clearable: true },
  discordWelcomeChannelId: { type: TEXT, clearable: true },
  discordLinkedRoleId: { type: TEXT, clearable: true },
  discordPlexRoleId: { type: TEXT, clearable: true },
  discordJellyfinRoleId: { type: TEXT, clearable: true },
  discordAdminRoleId: { type: TEXT, clearable: true },
  discordIssueAdminRoleId: { type: TEXT, clearable: true },
  discordInviteUrl: { type: SERVER_URL, clearable: true },
  discordNotifyChannelId: { type: TEXT, clearable: true },
  omdbApiKey: { type: SECRET, sensitive: true, clearable: true },
  mdblistApiKey: { type: SECRET, sensitive: true, clearable: true },
  // The MDBList plan the budget is kept against (mdblist-plan.ts); anything but
  // "auto" or a known plan would read back as "auto". Memoized 30s in mdblist.ts.
  [MDBLIST_PLAN_SETTING_KEY]: { type: { kind: "mdblistPlan" }, effects: ["mdblistPlan"] },
  // With the secret, what lets users connect their own Trakt accounts
  // (trakt-user.ts); the id alone also drives the public Trakt lists.
  traktClientId: { type: TEXT, sensitive: true, clearable: true },
  traktClientSecret: { type: SECRET, sensitive: true, clearable: true },
  // 11 checkboxes in the ratings grid all write this one key.
  ratingsHiddenSources: { type: TEXT, cooldownExempt: true },
  ipinfoToken: { type: SECRET, sensitive: true, clearable: true },
  // vapidPrivateKey is deliberately NOT here: push.ts generates the VAPID pair
  // itself and nothing in the UI types it. Admin-writable, a lone private half
  // no longer matched the stored public key and every web-push send failed.
  sessionDefaultDuration: { type: int(60, MAX_SESSION_SECONDS), clearable: true, effects: ["sessionDurations"] },
  sessionMobileDuration: { type: int(60, MAX_SESSION_SECONDS), clearable: true, effects: ["sessionDurations"] },
  sessionMaxDuration: { type: int(60, MAX_SESSION_SECONDS), clearable: true, effects: ["sessionDurations"] },
  enableUserEmails: { type: BOOLEAN },
  quotaLimit: { type: int(0, 10_000), clearable: true },
  // quota.ts reads anything else as a week.
  quotaPeriod: { type: { kind: "enum", values: ["day", "week", "month"], message: "oneOf" } },
  // The per-user web-push subscription cap.
  maxPushSubscriptions: { type: int(1, 100), clearable: true },
  maintenanceEnabled: { type: BOOLEAN },
  maintenanceMessage: { type: TEXT, clearable: true, sanitize: true },
  deletionVoteThreshold: { type: int(0, 10_000), clearable: true },
  // Days before audit-row PII (IP/UA/userName, auth-event details) is scrubbed —
  // read via getAuditPiiRetentionDays() by the scrub cron AND the manual scrub.
  // The floor matters: a tiny value (or "0") would scrub identity off every
  // fresh audit row. The bounds are the read-side clamp's own constants.
  auditPiiRetentionDays: { type: int(AUDIT_PII_RETENTION_MIN_DAYS, AUDIT_PII_RETENTION_MAX_DAYS, "daysRange"), clearable: true },
  disableLocalLogin: { type: BOOLEAN },
  // "true" ⇒ a local-credentials ADMIN with no second factor is redirected from
  // /admin to enroll (src/lib/mfa/policy.ts; SUMMONARR_DISABLE_MFA_ENFORCEMENT
  // is the env escape hatch).
  requireMfaForAdmins: { type: BOOLEAN, cooldownExempt: true },
  // A tracking switch moves a server's coverage in the never-watched report
  // (guardrail 14d), and every playHistory* key is in play-history's 15s
  // settings memo.
  playHistoryPlexEnabled: { type: BOOLEAN, effects: NEVER_WATCHED_AND_PLAY_HISTORY },
  playHistoryJellyfinEnabled: { type: BOOLEAN, effects: NEVER_WATCHED_AND_PLAY_HISTORY },
  playHistoryWatchedThreshold: { type: int(0, 100), effects: PLAY_HISTORY },
  // 0 = off. An alert threshold (stream-limit.ts), not an enforcement.
  concurrentStreamLimit: { type: int(0, 50) },
  playHistoryCompletionThreshold: { type: int(0, 100), effects: PLAY_HISTORY },
  playHistoryArcGapDays: { type: int(1, 365), effects: PLAY_HISTORY },
  // Recorded only (the live cadence is PLAY_HISTORY_SYNC_INTERVAL); the form's
  // own min/max.
  playHistoryPollingInterval: { type: int(5, 600), effects: PLAY_HISTORY },
  // Retention moves the never-watched report's coverage floor.
  playHistoryRetentionDays: { type: int(0, 3650), effects: NEVER_WATCHED_AND_PLAY_HISTORY },
  // The zone the activity statistics bucket hours and days in (an IANA name;
  // blank = the server process's own zone). stats-time-zone.ts.
  [STATS_TIME_ZONE_KEY]: { type: { kind: "timeZone" }, clearable: true, effects: ["statsTimeZone"] },
  // Request watch grades (src/lib/watch-grade.ts), bounded by the same table
  // the read side parses with. Blank = the WATCH_GRADE_DEFAULTS value.
  watchGradeGraceDays: { type: WATCH_GRADE, clearable: true, effects: WATCH_GRADE_EFFECTS },
  watchGradeWindowDays: { type: WATCH_GRADE, clearable: true, effects: WATCH_GRADE_EFFECTS },
  watchGradeTvPercent: { type: WATCH_GRADE, clearable: true, effects: WATCH_GRADE_EFFECTS },
  watchGradeOtherViewers: { type: WATCH_GRADE, clearable: true, effects: WATCH_GRADE_EFFECTS },
  watchGradeBandA: { type: WATCH_GRADE, clearable: true, effects: WATCH_GRADE_EFFECTS },
  watchGradeBandB: { type: WATCH_GRADE, clearable: true, effects: WATCH_GRADE_EFFECTS },
  watchGradeBandC: { type: WATCH_GRADE, clearable: true, effects: WATCH_GRADE_EFFECTS },
  watchGradeBandD: { type: WATCH_GRADE, clearable: true, effects: WATCH_GRADE_EFFECTS },
  watchGradeMinRequests: { type: WATCH_GRADE, clearable: true, effects: WATCH_GRADE_EFFECTS },
  enableMachineSession: { type: BOOLEAN },
  machineSessionAllowedIps: { type: { kind: "ipAllowlist" }, clearable: true },
  // Carries push payloads and device tokens: https only.
  apnsRelayUrl: { type: { kind: "url", httpsOnly: true }, clearable: true },
  // Optional bearer key for the APNs relay. Sent as "Authorization: Bearer <key>"
  // on every relay POST when set; clearable so relay auth can be turned off.
  apnsRelayKey: { type: { kind: "relayKey" }, sensitive: true, clearable: true },
  // Soft-upgrade lever: iOS build number the operator recommends. Exposed via
  // /api/config/public so the app can show a dismissible update sheet. NOT the
  // hard 426 gate (that's MIN_CLIENT in src/lib/api-version.ts).
  recommendedIosBuild: { type: int(1, 1_000_000, "intRangeMillion"), clearable: true },
  trashSyncCustomFormats: { type: BOOLEAN },
  trashSyncCustomFormatGroups: { type: BOOLEAN },
  trashSyncQualityProfiles: { type: BOOLEAN },
  trashSyncNaming: { type: BOOLEAN },
  trashSyncQualitySizes: { type: BOOLEAN },
  trashGithubToken: { type: SECRET, sensitive: true, clearable: true },
  // trashLastRefreshAt / trashLastRefreshTruncatedAt are cron bookkeeping rows
  // written by trash.ts, not settings — an admin-typed value there read as NaN.
  // Plex watchlist auto-request through the server owner's token (guardrail
  // 34b, src/lib/plex-friends-watchlist.ts).
  plexWatchlistServerSource: { type: BOOLEAN, cooldownExempt: true },
  plexWatchlistServerAutoEnroll: { type: BOOLEAN, cooldownExempt: true },
} as const satisfies Record<string, SettingDef>;

// A feature flag is a switch the Features tab flips per click: exempt from the
// cooldown (a 429 inside it snaps the optimistic toggle back to the state the
// admin just left; spam protection is the form's trailing-edge coalescing plus
// the route's 10-per-minute limit). The legacy flags (motdEnabled,
// playHistoryEnabled, trashGuidesEnabled) reuse their pre-Features-tab rows.
const FEATURE_EFFECTS: Partial<Record<FeatureKey, readonly SettingEffect[]>> = {
  playHistoryEnabled: NEVER_WATCHED_AND_PLAY_HISTORY,
  // Whether a never-watched row can be "eligible" at all (guardrail 14d).
  "feature.admin.cleanup": ["neverWatchedReport"],
  "feature.admin.neverWatched": ["neverWatchedReport"],
};

function featureSwitch(key: FeatureKey): SettingDef {
  const effects = FEATURE_EFFECTS[key];
  return effects ? { type: BOOLEAN, cooldownExempt: true, effects } : { type: BOOLEAN, cooldownExempt: true };
}

export type SettingKey = keyof typeof BASE_SETTINGS | FeatureKey;

export const SETTINGS_REGISTRY: ReadonlyMap<SettingKey, SettingDef> = new Map<SettingKey, SettingDef>([
  ...(Object.entries(BASE_SETTINGS) as [keyof typeof BASE_SETTINGS, SettingDef][]),
  ...FEATURE_KEYS.map((key): [FeatureKey, SettingDef] => [key, featureSwitch(key)]),
]);

export const SETTING_KEYS: readonly SettingKey[] = [...SETTINGS_REGISTRY.keys()];

export function isSettingKey(key: string): key is SettingKey {
  return SETTINGS_REGISTRY.has(key as SettingKey);
}

function defOf(key: SettingKey): SettingDef {
  // Every SettingKey is in the map by construction.
  return SETTINGS_REGISTRY.get(key) as SettingDef;
}

export const isSensitiveSetting = (key: SettingKey): boolean => defOf(key).sensitive === true;
export const isClearableSetting = (key: SettingKey): boolean => defOf(key).clearable === true;
export const isCooldownExemptSetting = (key: SettingKey): boolean => defOf(key).cooldownExempt === true;
export const settingMaxLength = (key: SettingKey): number => defOf(key).maxLength ?? DEFAULT_MAX_LENGTH;

/** The effects a set of committed key changes asks for. */
export function settingEffects(keys: Iterable<SettingKey>): Set<SettingEffect> {
  const out = new Set<SettingEffect>();
  for (const key of keys) for (const effect of defOf(key).effects ?? []) out.add(effect);
  return out;
}

// ── consistency (checked at load; a mismatch throws) ─────────────────────────

const SECRET_KEY_SUFFIXES = ["ApiKey", "Secret", "Token"] as const;
const isSecretShapedKey = (k: string) => SECRET_KEY_SUFFIXES.some((suffix) => k.endsWith(suffix));

/**
 * What is wrong with a registry, or [] — run at module load below. A sensitive
 * flag that drifts from the encryption gate's list ships either plaintext at
 * rest or a cleartext secret in GET; a secret-shaped key without the credential
 * check would store a pasted control character.
 */
export function registryProblems(
  registry: ReadonlyMap<string, SettingDef>,
  sensitiveKeys: ReadonlySet<string>,
  featureKeys: readonly string[],
  baseKeys: readonly string[],
): string[] {
  const problems: string[] = [];
  for (const [key, def] of registry) {
    if (def.sensitive && !sensitiveKeys.has(key)) {
      problems.push(`'${key}' is sensitive in the settings registry but missing from SETTINGS_SENSITIVE_KEYS — encryption will not fire`);
    }
    if (isSecretShapedKey(key) !== (def.type.kind === "secret")) {
      problems.push(`'${key}' is ${isSecretShapedKey(key) ? "secret-shaped but not" : "not secret-shaped but"} of kind "secret"`);
    }
  }
  // A sensitive key the route does not expose at all (vapidPrivateKey —
  // generated by push.ts, never admin-typed) is fine: GET never returns it and
  // PATCH never writes it. The hole is one the route DOES expose as plaintext.
  for (const key of sensitiveKeys) {
    if (registry.has(key) && !registry.get(key)?.sensitive) {
      problems.push(`'${key}' is in SETTINGS_SENSITIVE_KEYS but not marked sensitive in the settings registry — GET would return it in cleartext`);
    }
  }
  const features = new Set(featureKeys);
  for (const key of baseKeys) {
    if (features.has(key)) problems.push(`'${key}' is a feature flag and must not be listed again outside features.ts`);
  }
  return problems;
}

(function assertRegistryConsistent() {
  const problems = registryProblems(SETTINGS_REGISTRY, SETTINGS_SENSITIVE_KEYS_SET, FEATURE_KEYS, Object.keys(BASE_SETTINGS));
  if (problems.length > 0) throw new Error(`[settings] ${problems.join("; ")}`);
})();

// ── reading and presenting ───────────────────────────────────────────────────

// GET sends this instead of a stored secret, and PATCH reads it back as "keep
// the saved value". Shared with the client forms (secret-mask.ts).
export const MASKED_VALUE = SECRET_MASK_SENTINEL;

/** A value as GET sends it: secrets masked, credentials stripped from URLs. */
export function presentSettingValue(key: string, value: string): string {
  const def = isSettingKey(key) ? defOf(key) : undefined;
  if (def?.sensitive) return value ? MASKED_VALUE : "";
  if (def?.type.kind === "url" && value) return stripUrlUserinfo(value);
  return value;
}

// ── checking a submitted value ───────────────────────────────────────────────

export interface SettingRejection {
  error: string;
  /** A machine-readable discriminator for API clients, where one exists. */
  code?: string;
}

export type SettingValueCheck = { ok: true; value: string } | { ok: false; rejection: SettingRejection };

export interface SettingCheckDeps {
  t: Translator;
  /** Whether Postgres can use a zone name (stats-time-zone-data.ts's databaseKnowsTimeZone). */
  knowsTimeZone: (zone: string) => Promise<boolean>;
}

const CONTROL_CHAR_RE = /[\x00-\x1f\x7f]/;
const LIBRARY_ID_RE = /^[A-Za-z0-9_-]+$/;
const ED25519_HEX_RE = /^[0-9a-f]{64}$/i;
const DIGITS_RE = /^\d+$/;

const reject = (error: string, code?: string): SettingValueCheck =>
  ({ ok: false, rejection: code ? { error, code } : { error } });
const accept = (value: string): SettingValueCheck => ({ ok: true, value });

/** Digits only (parseInt would read "1e3" as 1), inside [min, max]. */
export function isIntInRange(value: string, min: number, max: number): boolean {
  const n = DIGITS_RE.test(value) ? parseInt(value, 10) : NaN;
  return Number.isInteger(n) && n >= min && n <= max;
}

// Catalog keys written out whole, so the unused-key scan sees them.
const INT_MESSAGE_KEYS: Record<Exclude<IntMessage, "intRange">, string> = {
  intRange10000: "apiAdmin.settings.intRange10000",
  intRangeMillion: "apiAdmin.settings.intRangeMillion",
  positiveInt: "apiAdmin.settings.positiveInt",
  daysRange: "apiAdmin.settings.daysRange",
};

function intRejection(key: string, type: Extract<SettingType, { kind: "int" }>, t: Translator): SettingValueCheck {
  if (type.message === "intRange") {
    return reject(t("apiAdmin.settings.intRange", { key, min: type.min, max: type.max }));
  }
  return reject(t(INT_MESSAGE_KEYS[type.message], { key }));
}

// A donation link must be https, matching the renderer: /donate's safeUrl()
// drops anything else, so an http:// link saved cleanly and then rendered as
// dead text. safeUrl() stays the actual XSS boundary.
function isHttpsLink(value: string): boolean {
  try {
    return new URL(value).protocol === "https:";
  } catch {
    return false;
  }
}

async function checkType(key: SettingKey, value: string, type: SettingType, deps: SettingCheckDeps): Promise<SettingValueCheck> {
  const { t } = deps;
  switch (type.kind) {
    case "text":
      return type.noControlChars && CONTROL_CHAR_RE.test(value) ? reject(t("apiAdmin.settings.controlChars", { key })) : accept(value);
    case "secret":
      return CONTROL_CHAR_RE.test(value) ? reject(t("apiAdmin.settings.controlChars", { key })) : accept(value);
    case "url": {
      // Length is already enforced by the per-key cap.
      const urlErr = validateServerUrl(value, { httpsOnly: type.httpsOnly === true }, t);
      return urlErr ? reject(t("apiAdmin.settings.invalidUrl", { key, reason: urlErr })) : accept(value);
    }
    case "donation":
      // A handle stays as typed; anything URL-shaped is held to https.
      if ((type.linkOnly || value.includes("://")) && !isHttpsLink(value)) {
        return reject(t("apiAdmin.settings.donationHttps"), "invalid-url");
      }
      return accept(value);
    case "boolean":
      // Every reader compares against the literal ("=== \"true\"", or
      // "!== \"false\"" for the default-on ones), so any other string read as
      // one side while the audit still recorded a toggle.
      return value === "true" || value === "false" ? accept(value) : reject(t("apiAdmin.settings.trueFalse", { key }));
    case "int":
      return isIntInRange(value, type.min, type.max) ? accept(value) : intRejection(key, type, t);
    case "enum":
      if (type.values.includes(value)) return accept(value);
      return type.message === "oneOf"
        ? reject(t("apiAdmin.settings.oneOf", { key, values: type.values.join(", ") }))
        : reject(t("apiAdmin.settings.minimumAvailability", { key }));
    case "mdblistPlan":
      return isMdblistPlanSetting(value) ? accept(value) : reject(t("apiAdmin.settings.mdblistPlanInvalid", { key }));
    case "libraryIds": {
      // Readers split on "," and drop blanks, so blank items are tolerated.
      const ids = value.split(",").map((id) => id.trim()).filter(Boolean);
      return ids.every((id) => LIBRARY_ID_RE.test(id)) ? accept(value) : reject(t("apiAdmin.settings.libraryIds", { key }));
    }
    case "ipAllowlist": {
      const bad = parseIpAllowlist(value).find((token) => !isValidIpOrCidr(token));
      return bad ? reject(t("apiAdmin.settings.invalidIp", { key, value: String(bad) })) : accept(value);
    }
    case "relayKey":
      // Forwarded verbatim in an Authorization header: one printable-ASCII
      // token, long enough not to be a typo'd fragment. No commas — the relay
      // reads its keys from a comma-separated env list.
      return value.length < 8 || value.length > 200 || !/^[\x21-\x7e]+$/.test(value) || value.includes(",")
        ? reject(t("apiAdmin.settings.printableAscii", { key }))
        : accept(value);
    case "snowflake":
      return DISCORD_SNOWFLAKE_RE.test(value) ? accept(value) : reject(t("apiAdmin.settings.snowflake", { key }));
    case "ed25519PublicKey": {
      // A raw 32-byte Ed25519 key. /api/interactions decodes it inside a
      // try/catch that reads as "signature invalid", so a pasted key with a
      // stray newline saved fine and then EVERY interaction answered 401.
      // Trimmed (a trailing newline is the routine paste) and stored trimmed.
      const trimmed = value.trim();
      return ED25519_HEX_RE.test(trimmed) ? accept(trimmed) : reject(t("apiAdmin.settings.discordPublicKey", { key }));
    }
    case "timeZone": {
      // Bound into every hour/day bucket of the activity SQL: only a zone Intl
      // knows by name AND Postgres can use, in Intl's canonical spelling. A bare
      // offset is refused (Postgres reads "+05:00" with east and west swapped).
      const zone = normalizeTimeZone(value);
      return zone && (await deps.knowsTimeZone(zone)) ? accept(zone) : reject(t("apiAdmin.settings.timeZoneInvalid", { key }));
    }
    case "watchGrade": {
      const error = watchGradeSettingError(key, value, t);
      return error ? reject(error) : accept(value);
    }
  }
}

/**
 * Checks one NEW value of `key` (not empty, not the mask, not the stored value)
 * and returns the value to store — trimmed or canonicalized for the keys that
 * normalize — or the 400 to answer.
 */
export async function checkSettingValue(key: SettingKey, value: string, deps: SettingCheckDeps): Promise<SettingValueCheck> {
  const def = defOf(key);
  if (def.connectOnly) return reject(deps.t("apiAdmin.settings.plexConnectOnly", { key }));
  // A secret that still contains the mask's bullets is the mask with a key
  // pasted after it (the field held the placeholder as its value). Only the
  // exact mask means "keep"; anything else would be stored as the credential
  // and only fail later, upstream.
  if (def.sensitive && value.includes(MASKED_VALUE[0])) {
    return reject(deps.t("apiAdmin.settings.maskedPlaceholder", { key }));
  }
  return checkType(key, value, def.type, deps);
}

export type SubmissionCheck =
  | { ok: true; values: Map<SettingKey, string> }
  | { ok: false; rejection: SettingRejection };

/**
 * Every registry key a PATCH body names, checked in body order: the first
 * problem is the answer. A type or length violation is refused rather than
 * dropped — a dropped key was never written yet the route answered {ok:true},
 * so an over-cap MOTD looked Saved. Only a NEW value is held to the per-key
 * rules: a form resubmits its whole section, and a field saved before a rule
 * existed would otherwise 400 every later save with nothing saying which field
 * blocks it. The result holds every named key, with the new values normalized.
 */
export async function checkSubmittedSettings(
  body: Record<string, unknown>,
  stored: ReadonlyMap<string, string>,
  deps: SettingCheckDeps,
): Promise<SubmissionCheck> {
  const values = new Map<SettingKey, string>();
  for (const [key, value] of Object.entries(body)) {
    if (!isSettingKey(key)) continue;
    if (typeof value !== "string") {
      return { ok: false, rejection: { error: deps.t("apiAdmin.settings.mustBeString", { key }) } };
    }
    const maxLen = settingMaxLength(key);
    if (value.length > maxLen) {
      return { ok: false, rejection: { error: deps.t("apiAdmin.settings.tooLong", { key, max: maxLen }) } };
    }
    values.set(key, value);
    if (value === MASKED_VALUE || value.length === 0 || value === stored.get(key)) continue;
    const check = await checkSettingValue(key, value, deps);
    if (!check.ok) return check;
    values.set(key, check.value);
  }
  return { ok: true, values };
}

/**
 * What a checked body asks to store: the mask is "keep", a blank is stored only
 * for a clearable key, and user-facing copy is sanitized. A blank that can't be
 * stored but would have replaced a stored value is reported in `ignored` —
 * "Saved" was the only answer before, while the old value stayed.
 */
export function submittedSettings(
  values: ReadonlyMap<SettingKey, string>,
  stored: ReadonlyMap<string, string>,
): { submitted: Map<SettingKey, string>; ignored: SettingKey[] } {
  const submitted = new Map<SettingKey, string>();
  const ignored: SettingKey[] = [];
  for (const [key, value] of values) {
    if (value === MASKED_VALUE) continue;
    if (value.length === 0 && !isClearableSetting(key)) {
      if (stored.get(key)) ignored.push(key);
      continue;
    }
    submitted.set(key, defOf(key).sanitize ? sanitizeText(value) : value);
  }
  return { submitted, ignored };
}

/**
 * Only a real change is written. A missing row and an empty one read the same
 * everywhere, so clearing a key that holds nothing is no change either.
 */
export function changedSettings(
  submitted: ReadonlyMap<SettingKey, string>,
  stored: ReadonlyMap<string, string>,
): Array<[SettingKey, string]> {
  return [...submitted].filter(([key, value]) => (stored.get(key) ?? "") !== value);
}
