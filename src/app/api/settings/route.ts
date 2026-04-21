import { NextRequest, NextResponse } from "next/server";
import { auth, isTokenExpired, invalidateSessionDurationsCache } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { testRadarrConnection, testSonarrConnection } from "@/lib/arr";
import { pingPlexToken } from "@/lib/plex";
import { checkRateLimit } from "@/lib/rate-limit";
import { sendTestEmail } from "@/lib/email";
import { invalidatePublicKeyCache } from "@/app/api/interactions/route";
import { getClientIp } from "@/lib/rate-limit";
import { sanitizeText } from "@/lib/sanitize";
import { encryptToken } from "@/lib/token-crypto";

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
  ["donationPaypal",                false],
  ["donationVenmo",                 false],
  ["donationZelle",                 false],
  ["donationAmazon",                false],
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
  ["playHistoryPollingInterval",     false],
  ["playHistoryRetentionDays",       false],
  ["enableMachineSession",           false],
  ["trashGuidesEnabled",              false],
  ["trashSyncCustomFormats",          false],
  ["trashSyncQualityProfiles",        false],
  ["trashSyncNaming",                 false],
  ["trashSyncQualitySizes",           false],
  ["trashGithubToken",                true ],
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

// Per-key write cooldown prevents rapid settings toggling (e.g. maintenanceEnabled spam)
const KEY_COOLDOWN_MS = 10_000;
const lastKeyWriteAt = new Map<string, number>();
setInterval(() => {
  const cutoff = Date.now() - KEY_COOLDOWN_MS;
  for (const [key, ts] of lastKeyWriteAt) {
    if (ts < cutoff) lastKeyWriteAt.delete(key);
  }
}, 60_000).unref();

export async function GET() {
  const session = await auth();
  if (!session || isTokenExpired(session) || session.user.role !== "ADMIN") {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const rows = await prisma.setting.findMany({
    where: { key: { in: [...ALLOWED_KEYS] } },
  });

  const settings = Object.fromEntries(
    rows.map((r) => [r.key, SENSITIVE_KEYS.has(r.key) ? (r.value ? "••••••••" : "") : r.value])
  ) as Partial<Record<AllowedKey, string>>;

  return NextResponse.json(settings);
}

export async function PATCH(req: NextRequest) {
  const session = await auth();
  if (!session || isTokenExpired(session) || session.user.role !== "ADMIN") {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  if (!checkRateLimit(`admin-settings:${session.user.id}`, 10, 60 * 1000)) {
    return NextResponse.json({ error: "Too many requests — try again later" }, { status: 429 });
  }

  let body: Record<string, string>;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  const now = Date.now();
  for (const key of Object.keys(body)) {
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

  const entries = Object.entries(body)
    .filter(([k, v]) => {
      if (!(ALLOWED_KEYS as readonly string[]).includes(k)) return false;
      // Skip entries that are still the masked placeholder — client didn't change the value
      if (v === MASKED_VALUE) return false;
      const max = MAX_LENGTHS[k as AllowedKey] ?? DEFAULT_MAX_LENGTH;
      return typeof v === "string" && v.length > 0 && v.length <= max;
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
        entries.map(([key, value]) => {
          // Sensitive keys are encrypted at rest; plaintext is never written to the Setting table
          const stored = SENSITIVE_KEYS.has(key) ? encryptToken(value) : value;
          return tx.setting.upsert({
            where: { key },
            update: { value: stored },
            create: { key, value: stored },
          });
        })
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
        const res = await fetch(url, {
          method: "PUT",
          headers: { Authorization: `Bot ${cfg.discordBotToken}`, "Content-Type": "application/json" },
          body: JSON.stringify(SLASH_COMMANDS),
          signal: AbortSignal.timeout(15_000),
        });
        if (res.ok) {
          console.log(`[discord] Commands re-registered after settings update`);
        } else {
          console.error(`[discord] Command re-registration failed: ${res.status} ${await res.text()}`);
        }
      } catch (err) {
        console.error("[discord] Command re-registration error:", err);
      }
    })();
  }

  if (updated.smtpHost || updated.smtpPassword) {
    const adminEmail = session.user.email;
    if (adminEmail) {
      try {
        await sendTestEmail(adminEmail);
        testResults.smtpTested = true;
      } catch {
        testResults.smtpError = "SMTP connection failed. Check your SMTP settings.";
        testFailed = true;
      }
    }
  }

  return NextResponse.json(
    { ok: !testFailed, ...testResults },
    testFailed ? { status: 422 } : undefined,
  );
}
