import { NextResponse } from "next/server";
import { readJsonCapped } from "@/lib/body-size";
import { withAdmin } from "@/lib/api-auth";
import { invalidateSessionDurationsCache } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { testRadarrConnection, testSonarrConnection } from "@/lib/arr";
import { pingPlexToken } from "@/lib/plex";
import { checkRateLimit } from "@/lib/rate-limit";
import { sendTestEmail } from "@/lib/email";
import { invalidatePublicKeyCache } from "@/app/api/interactions/route";
import { getClientIp } from "@/lib/rate-limit";
import { sanitizeText } from "@/lib/sanitize";
import { FEATURE_KEYS } from "@/lib/features";
import { safeFetchTrusted } from "@/lib/safe-fetch";
import { SETTINGS_SENSITIVE_KEYS_SET } from "@/lib/settings-sensitive-keys";
import { parseIpAllowlist, isValidIpOrCidr } from "@/lib/ip-allowlist";

const SETTINGS_SCHEMA = [
  ["siteTitle",                     false],
  ["siteUrl",                       false],
  ["radarrUrl",                     false],
  ["radarrApiKey",                  true ],
  ["radarrRootFolder",              false],
  ["radarrQualityProfileId",        false],
  ["sonarrUrl",                     false],
  ["sonarrApiKey",                  true ],
  ["sonarrRootFolder",              false],
  ["sonarrQualityProfileId",        false],
  ["webhookSecret",                 true ],
  ["sonarrWebhookSecret",           true ],
  ["radarrWebhookSecret",           true ],
  // Optional 4K instances (second Radarr/Sonarr). Sensitive keys must also be
  // listed in SETTINGS_SENSITIVE_KEYS (boot alignment check enforces it).
  ["radarr4kUrl",                   false],
  ["radarr4kApiKey",                true ],
  ["radarr4kRootFolder",            false],
  ["radarr4kQualityProfileId",      false],
  ["radarr4kWebhookSecret",         true ],
  ["sonarr4kUrl",                   false],
  ["sonarr4kApiKey",                true ],
  ["sonarr4kRootFolder",            false],
  ["sonarr4kQualityProfileId",      false],
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
  ["traktClientId",                 true ],
  ["ipinfoToken",                   true ],
  ["vapidPrivateKey",               true ],
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
  ["disableLocalLogin",              false],
  ["playHistoryEnabled",             false],
  ["playHistoryPlexEnabled",         false],
  ["playHistoryJellyfinEnabled",     false],
  ["playHistoryWatchedThreshold",    false],
  ["playHistoryCompletionThreshold", false],
  ["playHistoryArcGapDays",          false],
  ["playHistoryPollingInterval",     false],
  ["playHistoryRetentionDays",       false],
  ["enableMachineSession",           false],
  ["machineSessionAllowedIps",       false],
  ["apnsRelayUrl",                    false],
  ["trashGuidesEnabled",              false],
  ["trashSyncCustomFormats",          false],
  ["trashSyncCustomFormatGroups",     false],
  ["trashSyncQualityProfiles",        false],
  ["trashSyncNaming",                 false],
  ["trashSyncQualitySizes",           false],
  ["trashGithubToken",                true ],
  ["trashLastRefreshTruncatedAt",     false],
  ["trashLastRefreshAt",              false],
  // Feature toggles — see src/lib/features.ts for the registry. All stored as "true"|"false".
  ["feature.page.top",                false],
  ["feature.page.popular",            false],
  ["feature.page.upcoming",           false],
  ["feature.page.issues",             false],
  ["feature.page.votes",              false],
  ["feature.page.donate",             false],
  ["feature.behavior.activeSessions", false],
  ["feature.behavior.activityCalendar", false],
  ["feature.integration.plex",        false],
  ["feature.integration.jellyfin",    false],
  ["feature.integration.radarr",      false],
  ["feature.integration.sonarr",      false],
  ["feature.integration.discord",     false],
  ["feature.integration.email",       false],
  ["feature.integration.push",        false],
  ["feature.admin.stats",             false],
  ["feature.admin.activity",          false],
  ["feature.admin.auditLog",          false],
  ["feature.admin.backup",            false],
] as const satisfies ReadonlyArray<readonly [string, boolean]>;

type AllowedKey = (typeof SETTINGS_SCHEMA)[number][0];
const ALLOWED_KEYS = SETTINGS_SCHEMA.map(([k]) => k) as unknown as readonly AllowedKey[];
const SENSITIVE_KEYS = new Set<string>(
  SETTINGS_SCHEMA.filter(([, sensitive]) => sensitive).map(([k]) => k)
);

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
  for (const k of SETTINGS_SENSITIVE_KEYS_SET) {
    if (!SENSITIVE_KEYS.has(k)) {
      throw new Error(
        `[settings] '${k}' is in SETTINGS_SENSITIVE_KEYS but not marked sensitive in SETTINGS_SCHEMA — encryption gate is dead-coded`,
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

function stripUrlUserinfo(value: string): string {
  try {
    const u = new URL(value);
    if (u.username || u.password) {
      u.username = "";
      u.password = "";
      return u.toString();
    }
  } catch {
    // Not a parseable URL — let it through unchanged.
  }
  return value;
}

// Per-key write cooldown prevents rapid settings toggling (e.g. maintenanceEnabled spam)
const KEY_COOLDOWN_MS = 10_000;
const lastKeyWriteAt = new Map<string, number>();
// Feature-flag keys are exempt from the cooldown. The Features admin tab is a
// rapid-toggle UI by design — a 10s cooldown makes the second click of an
// accidental double-click look "stuck" (PATCH returns 429 → client rolls back
// the optimistic flip). Spam protection for this tab is handled client-side
// via trailing-edge coalescing in features-form.tsx plus the general
// admin-settings rate limit (10 PATCHes / minute).
const COOLDOWN_EXEMPT = new Set<string>(FEATURE_KEYS);
setInterval(() => {
  const cutoff = Date.now() - KEY_COOLDOWN_MS;
  for (const [key, ts] of lastKeyWriteAt) {
    if (ts < cutoff) lastKeyWriteAt.delete(key);
  }
}, 60_000).unref();

export const GET = withAdmin(async (_req, _ctx, _session) => {
  const rows = await prisma.setting.findMany({
    where: { key: { in: [...ALLOWED_KEYS] } },
  });

  const settings = Object.fromEntries(
    rows.map((r) => {
      if (SENSITIVE_KEYS.has(r.key)) return [r.key, r.value ? "••••••••" : ""];
      if (URL_KEYS.has(r.key) && r.value) return [r.key, stripUrlUserinfo(r.value)];
      return [r.key, r.value];
    })
  ) as Partial<Record<AllowedKey, string>>;

  return NextResponse.json(settings);
});

export const PATCH = withAdmin(async (req, _ctx, session) => {
  if (!checkRateLimit(`admin-settings:${session.user.id}`, 10, 60 * 1000)) {
    return NextResponse.json({ error: "Too many requests — try again later" }, { status: 429 });
  }

  const parsed = await readJsonCapped<Record<string, string>>(req, 65536);
  if (parsed instanceof NextResponse) return parsed;
  const body = parsed;

  const now = Date.now();
  for (const key of Object.keys(body)) {
    if (COOLDOWN_EXEMPT.has(key)) continue;
    const last = lastKeyWriteAt.get(key);
    if (last !== undefined && now - last < KEY_COOLDOWN_MS) {
      const retryAfterMs = KEY_COOLDOWN_MS - (now - last);
      return NextResponse.json(
        { error: `Setting "${key}" was modified too recently — wait ${Math.ceil(retryAfterMs / 1000)}s`, retryAfterMs },
        { status: 429 }
      );
    }
  }

  const MASKED_VALUE = "••••••••";
  const MAX_LENGTHS: Partial<Record<AllowedKey, number>> = { motdBody: 5000 };
  const DEFAULT_MAX_LENGTH = 2000;

  const USER_FACING_KEYS = new Set(["motdTitle", "motdBody", "siteTitle", "maintenanceMessage"]);

  // URL_KEYS hoisted to module scope so GET masks userinfo too — see top of file.

  // Donation keys accept either a full http(s) URL or a plain handle (e.g. "@alice").
  // We must reject dangerous schemes (javascript:, data:, vbscript:, ftp:) on the URL form
  // so the donate page can render <a href={value}> safely. donationAmazon must be a URL
  // (no username form), so it falls into the strict URL_KEYS check above conceptually,
  // but for consistency we apply the same scheme guard here for any value containing ":".
  const DONATION_URL_KEYS = new Set<string>([
    "donationPaypal",
    "donationVenmo",
    "donationZelle",
    "donationAmazon",
    "donationPatreon",
    "donationBuyMeACoffee",
  ]);

  const SECRET_KEY_SUFFIXES = ["ApiKey", "Secret", "Token"] as const;
  const isSecretShapedKey = (k: string) =>
    SECRET_KEY_SUFFIXES.some((suffix) => k.endsWith(suffix));

  const CONTROL_CHAR_RE = /[\x00-\x1f\x7f]/;

  for (const [key, value] of Object.entries(body)) {
    if (typeof value !== "string" || value === MASKED_VALUE || value.length === 0) continue;
    if (!(ALLOWED_KEYS as readonly string[]).includes(key)) continue;

    if (URL_KEYS.has(key)) {
      try {
        const parsed = new URL(value);
        if (HTTPS_ONLY_URL_KEYS.has(key)) {
          if (parsed.protocol !== "https:") {
            return NextResponse.json(
              { error: `Setting "${key}" must be an https:// URL` },
              { status: 400 },
            );
          }
        } else if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
          return NextResponse.json(
            { error: `Setting "${key}" must be an http(s) URL` },
            { status: 400 },
          );
        }
        // Reject embedded credentials (user:pass@host) — the URL parser accepts
        // them silently and the credential ships out as part of every safeFetch
        // call (Plex/Jellyfin/Radarr/Sonarr server URLs). Operators should set
        // credentials via the dedicated apiKey field instead.
        if (parsed.username || parsed.password) {
          return NextResponse.json(
            { error: `Setting "${key}" must not contain embedded credentials` },
            { status: 400 },
          );
        }
      } catch {
        return NextResponse.json(
          { error: `Setting "${key}" must be a valid URL` },
          { status: 400 },
        );
      }
    }

    if (DONATION_URL_KEYS.has(key)) {
      // donationAmazon must always be a full URL; the others may be a plain handle
      // (e.g. "@alice"). Apply scheme guard when value looks URL-shaped (contains "://").
      const looksLikeUrl = value.includes("://");
      const requireUrl = key === "donationAmazon";
      if (looksLikeUrl || requireUrl) {
        try {
          const parsed = new URL(value);
          if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
            return NextResponse.json(
              {
                error: "invalid-url",
                message: "Donation URL must be http:// or https://",
              },
              { status: 400 },
            );
          }
        } catch {
          return NextResponse.json(
            {
              error: "invalid-url",
              message: "Donation URL must be http:// or https://",
            },
            { status: 400 },
          );
        }
      }
    }

    if (isSecretShapedKey(key) && CONTROL_CHAR_RE.test(value)) {
      return NextResponse.json(
        { error: `Setting "${key}" contains invalid control characters` },
        { status: 400 },
      );
    }

    if (key === "machineSessionAllowedIps") {
      const bad = parseIpAllowlist(value).find((t) => !isValidIpOrCidr(t));
      if (bad) {
        return NextResponse.json(
          { error: `Setting "${key}" has an invalid IP or CIDR: "${bad}"` },
          { status: 400 },
        );
      }
    }

    // Rate-limit caps must be a positive integer. "0" (or any non-integer)
    // silently disables throttling in checkRateLimit, which treats a limit of
    // 0 as "always allowed" — an admin must never be able to turn off a limiter
    // by typo.
    if (key.startsWith("rateLimit")) {
      const n = parseInt(value, 10);
      if (!Number.isFinite(n) || n < 1 || n > 10_000) {
        return NextResponse.json(
          { error: `"${key}" must be an integer between 1 and 10000` },
          { status: 400 },
        );
      }
    }
  }

  // Never enable the machine-session API while its IP allowlist is empty. The
  // machine-session route enforces the allowlist ONLY when it is non-empty (an empty
  // allowlist is treated as "no IP restriction"), so turning the feature on with an
  // empty allowlist means ANY caller in possession of CRON_SECRET could mint a fully
  // privileged admin session cookie from ANY source IP — a privilege-escalation hole.
  // Guard against that misconfiguration at write time: require the allowlist to be
  // already persisted non-empty, OR to be set non-empty in this same PATCH, before
  // flipping enableMachineSession on.
  if (body.enableMachineSession === "true") {
    const incomingAllowlist =
      typeof body.machineSessionAllowedIps === "string"
        ? body.machineSessionAllowedIps
        : undefined;
    let allowlistNonEmpty: boolean;
    if (incomingAllowlist !== undefined) {
      // Being set in this PATCH — empty string clears it.
      allowlistNonEmpty = parseIpAllowlist(incomingAllowlist).length > 0;
    } else {
      const allowRow = await prisma.setting.findUnique({
        where: { key: "machineSessionAllowedIps" },
      });
      allowlistNonEmpty = parseIpAllowlist(allowRow?.value).length > 0;
    }
    if (!allowlistNonEmpty) {
      return NextResponse.json(
        {
          error:
            "Cannot enable the machine-session API without a non-empty IP allowlist. " +
            "Set machineSessionAllowedIps first (or in the same request) so any holder " +
            "of CRON_SECRET cannot mint an admin session from any IP.",
        },
        { status: 400 },
      );
    }
  }

  // Keys that may be written empty to clear them. Most keys skip empty writes so
  // the client can echo back unchanged/masked values without wiping them; the IP
  // allowlist must be clearable to lift the restriction.
  const CLEARABLE_KEYS = new Set<string>(["machineSessionAllowedIps"]);

  const entries = Object.entries(body)
    .filter(([k, v]) => {
      if (!(ALLOWED_KEYS as readonly string[]).includes(k)) return false;
      // Skip entries that are still the masked placeholder — client didn't change the value
      if (v === MASKED_VALUE) return false;
      const max = MAX_LENGTHS[k as AllowedKey] ?? DEFAULT_MAX_LENGTH;
      if (typeof v !== "string" || v.length > max) return false;
      if (v.length === 0) return CLEARABLE_KEYS.has(k);
      return true;
    })
    .map(([k, v]) => [k, USER_FACING_KEYS.has(k) ? sanitizeText(v) : v] as [string, string]);

  const MAX_SESSION_SECONDS = 7_776_000;
  for (const entry of entries) {
    if (entry[0] === "sessionDefaultDuration" || entry[0] === "sessionMobileDuration" || entry[0] === "sessionMaxDuration") {
      const n = parseInt(entry[1], 10);
      if (isNaN(n) || n < 60) entry[1] = "3600";
      else if (n > MAX_SESSION_SECONDS) entry[1] = String(MAX_SESSION_SECONDS);
    }
  }

  const changedKeys = entries.map(([k]) => k);
  const oldRows = await prisma.setting.findMany({ where: { key: { in: changedKeys } } });
  const oldValues: Record<string, string> = Object.fromEntries(oldRows.map((r) => [r.key, SENSITIVE_KEYS.has(r.key) ? "[redacted]" : r.value]));
  const newValues: Record<string, string> = Object.fromEntries(entries.map(([k, v]) => [k, SENSITIVE_KEYS.has(k) ? "[redacted]" : v]));

  const auditIp = getClientIp(req.headers as Headers);
  const auditUa = req.headers.get("user-agent")?.slice(0, 512) ?? null;
  try {
    await prisma.$transaction(async (tx) => {
      await Promise.all(
        entries.map(([key, value]) =>
          // Sensitive keys are encrypted at rest by the Prisma extension in src/lib/prisma.ts.
          // Do NOT pre-encrypt here — that produced double-encrypted rows (enc:v1:<enc:v1:…>)
          // which decrypted on read into the inner ciphertext, breaking Jellyfin/Radarr/etc auth.
          tx.setting.upsert({
            where: { key },
            update: { value },
            create: { key, value },
          })
        )
      );
      await tx.auditLog.create({
        data: {
          userId: session.user.id,
          userName: sanitizeText(session.user.name ?? session.user.email ?? "unknown"),
          action: changedKeys.includes("maintenanceEnabled") ? "MAINTENANCE_TOGGLE" : "SETTINGS_CHANGE",
          target: "settings",
          details: JSON.stringify({ keys: changedKeys, before: oldValues, after: newValues }),
          ipAddress: auditIp,
          userAgent: auditUa,
          provider: session.user.provider ?? null,
        },
      });
    });
  } catch (err) {
    console.error("[audit] Settings transaction failed:", err);
    return NextResponse.json({ error: "Audit logging failed" }, { status: 500 });
  }

  const writeTs = Date.now();
  for (const [key] of entries) {
    if (COOLDOWN_EXEMPT.has(key)) continue;
    lastKeyWriteAt.set(key, writeTs);
  }

  if (changedKeys.some((k) => k === "sessionDefaultDuration" || k === "sessionMobileDuration" || k === "sessionMaxDuration")) {
    invalidateSessionDurationsCache();
  }

  const updated = Object.fromEntries(entries);
  const testResults: Record<string, unknown> = {};
  let testFailed = false;

  if (updated.plexAdminToken) {
    const tokenRow = await prisma.setting.findUnique({ where: { key: "plexAdminToken" } });
    if (tokenRow?.value) {
      const valid = await pingPlexToken(tokenRow.value).catch(() => false);
      if (!valid) {
        testResults.plexError = "Plex token is invalid or could not be reached";
        testFailed = true;
      } else {
        testResults.plexTested = true;
      }
    }
  }

  if (updated.radarrUrl || updated.radarrApiKey) {
    const rows = await prisma.setting.findMany({
      where: { key: { in: ["radarrUrl", "radarrApiKey"] } },
    });
    const map = Object.fromEntries(rows.map((r) => [r.key, r.value]));
    if (map.radarrUrl && map.radarrApiKey) {
      try {
        testResults.radarrVersion = await testRadarrConnection(map.radarrUrl, map.radarrApiKey);
      } catch {
        testResults.radarrError = "Radarr connection failed";
        testFailed = true;
      }
    }
  }

  if (updated.sonarrUrl || updated.sonarrApiKey) {
    const rows = await prisma.setting.findMany({
      where: { key: { in: ["sonarrUrl", "sonarrApiKey"] } },
    });
    const map = Object.fromEntries(rows.map((r) => [r.key, r.value]));
    if (map.sonarrUrl && map.sonarrApiKey) {
      try {
        testResults.sonarrVersion = await testSonarrConnection(map.sonarrUrl, map.sonarrApiKey);
      } catch {
        testResults.sonarrError = "Sonarr connection failed";
        testFailed = true;
      }
    }
  }

  if (updated.radarr4kUrl || updated.radarr4kApiKey) {
    const rows = await prisma.setting.findMany({ where: { key: { in: ["radarr4kUrl", "radarr4kApiKey"] } } });
    const map = Object.fromEntries(rows.map((r) => [r.key, r.value]));
    if (map.radarr4kUrl && map.radarr4kApiKey) {
      try {
        testResults.radarr4kVersion = await testRadarrConnection(map.radarr4kUrl, map.radarr4kApiKey);
      } catch {
        testResults.radarr4kError = "Radarr 4K connection failed";
        testFailed = true;
      }
    }
  }

  if (updated.sonarr4kUrl || updated.sonarr4kApiKey) {
    const rows = await prisma.setting.findMany({ where: { key: { in: ["sonarr4kUrl", "sonarr4kApiKey"] } } });
    const map = Object.fromEntries(rows.map((r) => [r.key, r.value]));
    if (map.sonarr4kUrl && map.sonarr4kApiKey) {
      try {
        testResults.sonarr4kVersion = await testSonarrConnection(map.sonarr4kUrl, map.sonarr4kApiKey);
      } catch {
        testResults.sonarr4kError = "Sonarr 4K connection failed";
        testFailed = true;
      }
    }
  }

  if (updated.discordBotToken || updated.discordClientId || updated.discordGuildId || updated.discordPublicKey) {
    invalidatePublicKeyCache();

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

        const DISCORD_API = "https://discord.com/api/v10";
        const SLASH_COMMANDS = [
          { name: "request", description: "Request a movie or TV show to be added to the library", options: [
            { name: "type", description: "Movie or TV show", type: 3, required: true, choices: [{ name: "Movie", value: "movie" }, { name: "TV Show", value: "tv" }] },
            { name: "query", description: "Title to search for", type: 3, required: true, min_length: 1, max_length: 200 },
          ]},
          { name: "status", description: "Check the status of your recent media requests" },
          { name: "link", description: "Link your Discord account to your Summonarr account", options: [
            { name: "token", description: "Link token from your Profile page", type: 3, required: true, min_length: 1, max_length: 20 },
          ]},
        ];
        const url = cfg.discordGuildId
          ? `${DISCORD_API}/applications/${cfg.discordClientId}/guilds/${cfg.discordGuildId}/commands`
          : `${DISCORD_API}/applications/${cfg.discordClientId}/commands`;
        const res = await safeFetchTrusted(url, {
          method: "PUT",
          headers: { Authorization: `Bot ${cfg.discordBotToken}`, "Content-Type": "application/json" },
          body: JSON.stringify(SLASH_COMMANDS),
          allowedHosts: ["discord.com"],
          timeoutMs: 15_000,
        });
        if (!res.ok) {
          console.error(`[discord] Command re-registration failed: ${res.status} ${await res.text()}`);
        }
      } catch (err) {
        console.error("[discord] Command re-registration error:", err);
      }
    })();
  }

  if (updated.smtpHost || updated.smtpPassword || updated.resendApiKey || updated.emailBackend) {
    const adminEmail = session.user.email;
    if (adminEmail) {
      try {
        await sendTestEmail(adminEmail);
        testResults.smtpTested = true;
      } catch (err) {
        testResults.smtpError = err instanceof Error ? err.message : "Email test failed. Check your email settings.";
        testFailed = true;
      }
    }
  }

  // Roll back the DB write when any connectivity test failed — otherwise the
  // settings panel shows "save failed" 422 to the admin while the bad values
  // remain durably persisted on disk. Restore the pre-write values for keys
  // that existed before, delete keys we created.
  if (testFailed) {
    const preWriteByKey = new Map(oldRows.map((r) => [r.key, r.value]));
    try {
      await prisma.$transaction(async (tx) => {
        for (const [key] of entries) {
          const prior = preWriteByKey.get(key);
          if (prior === undefined) {
            await tx.setting.deleteMany({ where: { key } });
          } else {
            // upsert (not update): if the row was concurrently deleted between
            // the oldRows read and now, update() throws RecordNotFound and the
            // outer catch swallows it — leaving the bad value durably persisted
            // while the admin sees a 422 implying rollback. upsert is idempotent.
            await tx.setting.upsert({
              where: { key },
              update: { value: prior },
              create: { key, value: prior },
            });
          }
        }
        await tx.auditLog.create({
          data: {
            userId: session.user.id,
            userName: sanitizeText(session.user.name ?? session.user.email ?? "unknown"),
            action: "SETTINGS_CHANGE",
            target: "settings:rollback",
            details: JSON.stringify({ keys: changedKeys, reason: "connectivity test failed", testResults }),
            ipAddress: auditIp,
            userAgent: auditUa,
            provider: session.user.provider ?? null,
          },
        });
      });
    } catch (err) {
      console.error("[settings] rollback after test failure failed:", err);
      // Best-effort: surface the test failure even when rollback didn't apply
      // cleanly. The admin sees the 422 either way and can re-save manually.
    }
  }

  return NextResponse.json(
    { ok: !testFailed, ...testResults },
    testFailed ? { status: 422 } : undefined,
  );
});
