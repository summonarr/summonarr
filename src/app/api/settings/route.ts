import { NextResponse, type NextRequest } from "next/server";
import { readJsonCapped } from "@/lib/body-size";
import { withAdmin, type SummonarrSession } from "@/lib/api-auth";
import { invalidateSessionDurationsCache } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { arrErrorMessage, testRadarrConnection, testSonarrConnection } from "@/lib/arr";
import { getJellyfinMediaFolders } from "@/lib/jellyfin";
import { checkRateLimit, getClientIp } from "@/lib/rate-limit";
import { EMAIL_TRANSPORT_KEYS, sendTestEmail, type EmailTransportOverrides } from "@/lib/email";
import { logAuditTx } from "@/lib/audit";
import { localeForRequest, translatorForRequest } from "@/lib/i18n/server-locale";
import { invalidatePublicKeyCache } from "@/lib/discord-interactions/signature";
import { putDiscordCommands, recordDiscordSchemaHash } from "@/lib/discord-register";
import { invalidateFeatureFlagCache } from "@/lib/features";
import { invalidateApnsRelayCache } from "@/lib/push";
import { parseIpAllowlist } from "@/lib/ip-allowlist";
import { WATCH_GRADE_SETTING_KEYS, watchGradeCrossFieldError } from "@/lib/watch-grade";
import { invalidateWatchGradeSettings, mergedWatchGradeSettings } from "@/lib/watch-grade-data";
import type { Translator } from "@/lib/i18n/translate";
import { processSingleton } from "@/lib/process-singleton";
import { trackingStampsFor } from "@/lib/never-watched";
import { invalidateNeverWatchedReport } from "@/lib/never-watched-report";
import { clearArrSnapshots, isArrConfigKey } from "@/lib/arr-snapshot";
import { invalidateMdblistPlanCache } from "@/lib/mdblist";
import { getSyncableMediaInstances } from "@/lib/media-instance-registry";
import { isOidcConfigured } from "@/lib/oidc";
import { databaseKnowsTimeZone, invalidateStatsTimeZone } from "@/lib/stats-time-zone-data";
import { invalidatePlayHistorySettings } from "@/lib/play-history";
import { invalidateShow4kVisibilityCache } from "@/lib/four-k-visibility";
import {
  DISCORD_SNOWFLAKE_RE,
  MASKED_VALUE,
  SETTING_KEYS,
  changedSettings,
  checkSubmittedSettings,
  isCooldownExemptSetting,
  isSensitiveSetting,
  isSettingKey,
  presentSettingValue,
  settingEffects,
  submittedSettings,
  type SettingKey,
  type SettingRejection,
} from "@/lib/settings-registry";

// Every key's rules — type, secrecy, clearability, cooldown, side effects —
// live in the registry (settings-registry.ts). This route reads the body,
// checks it against the registry and the cross-field rules, tests the
// connections it names, writes and audits in one transaction, then drops the
// caches the change affects.

// Per-key write cooldown prevents rapid settings toggling (e.g. maintenanceEnabled
// spam). The registry marks the per-click switches exempt.
const KEY_COOLDOWN_MS = 10_000;
const lastKeyWriteAt = processSingleton("settings:lastKeyWriteAt", () => new Map<string, number>());
processSingleton("settings:lastKeyWriteSweep", () =>
  setInterval(() => {
    const cutoff = Date.now() - KEY_COOLDOWN_MS;
    for (const [key, ts] of lastKeyWriteAt) {
      if (ts < cutoff) lastKeyWriteAt.delete(key);
    }
  }, 60_000).unref(),
);

// Connection tests, run against the config a PATCH is about to save (submitted
// values over the stored rows) BEFORE anything is written: approvals, crons
// and webhooks never see an unverified URL or key, and a failure leaves nothing
// to roll back. A probe runs when either half of its pair is submitted,
// changed or not — re-pressing "Save & Test" re-tests. The messages stay in
// English for TEST_RESULT_MESSAGE_KEYS; the result keys are what the forms
// (arr-form, jellyfin-sync-form) and the iOS app read.
interface ConnectionProbe {
  urlKey: SettingKey;
  keyKey: SettingKey;
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

// The keys a change to which re-registers the Discord slash commands.
const DISCORD_REGISTRATION_KEYS = ["discordBotToken", "discordClientId", "discordGuildId"] as const;

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

const rejectionResponse = (rejection: SettingRejection) => NextResponse.json(rejection, { status: 400 });

/**
 * The stored value of every key this PATCH names, plus what its probes and the
 * machine-session rule need (sensitive ones come back decrypted from the Prisma
 * extension and are only ever compared, never echoed). Resending a stored value
 * is not a change: past the type and length checks it is not validated,
 * written, audited or cooldown-checked. Forms resend whole sections, and
 * treating those as edits audited untouched keys, flushed caches and 429'd the
 * next save on a key nobody changed.
 */
async function readStoredSettings(
  body: Record<string, unknown>,
  probes: readonly ConnectionProbe[],
): Promise<Map<string, string>> {
  const readKeys = new Set<string>(Object.keys(body).filter(isSettingKey));
  for (const p of probes) {
    readKeys.add(p.urlKey);
    readKeys.add(p.keyKey);
  }
  if (readKeys.has("enableMachineSession") || readKeys.has("machineSessionAllowedIps")) {
    readKeys.add("enableMachineSession");
    readKeys.add("machineSessionAllowedIps");
  }
  if (readKeys.size === 0) return new Map();
  const rows = await prisma.setting.findMany({ where: { key: { in: [...readKeys] } } });
  return new Map(rows.map((r) => [r.key, r.value]));
}

// Never leave the machine-session API enabled with an empty IP allowlist. The
// machine-session route treats an empty allowlist as "no IP restriction", so
// that combination would let anyone holding CRON_SECRET mint a full admin
// session from any IP — a privilege-escalation hole. Checked against the
// EFFECTIVE state after this PATCH (incoming values over the stored rows), so it
// catches both "turn the feature on with no allowlist" and "clear the allowlist
// while the feature stays on". An empty enableMachineSession means "unchanged",
// not "off": it is not clearable, so the write filter drops it and the stored
// row survives — reading "" as "off" would let an empty toggle + empty
// allowlist slip past. For the allowlist an empty string IS a clearing write.
function machineSessionError(
  values: ReadonlyMap<SettingKey, string>,
  stored: ReadonlyMap<string, string>,
  t: Translator,
): string | null {
  const enable = values.get("enableMachineSession") || undefined;
  const allowlist = values.get("machineSessionAllowedIps");
  if (enable === undefined && allowlist === undefined) return null;
  const effectiveEnabled = (enable ?? stored.get("enableMachineSession")) === "true";
  const effectiveAllowlist = allowlist ?? stored.get("machineSessionAllowedIps");
  return effectiveEnabled && parseIpAllowlist(effectiveAllowlist).length === 0
    ? t("apiAdmin.settings.machineSessionAllowlist")
    : null;
}

// Switching local login OFF refuses every password sign-in, registration and
// two-factor completion. With no other way in, the instance is locked to the
// sessions that already exist, and once the admin's ends, recovery is a
// database edit. So turning it on needs at least one external sign-in that
// works — the same predicates the login page uses to show those tabs. Turning
// it off ("false") is always allowed, and so is resending a stored "true"
// (nothing is written).
async function disableLocalLoginError(
  values: ReadonlyMap<SettingKey, string>,
  stored: ReadonlyMap<string, string>,
  t: Translator,
): Promise<string | null> {
  if (values.get("disableLocalLogin") !== "true" || stored.get("disableLocalLogin") === "true") return null;
  const [plexInstances, jellyfinInstances] = await Promise.all([
    getSyncableMediaInstances("plex"),
    getSyncableMediaInstances("jellyfin"),
  ]);
  return !isOidcConfigured() && plexInstances.length === 0 && jellyfinInstances.length === 0
    ? t("apiAdmin.settings.disableLocalLoginNeedsProvider")
    : null;
}

// Watch-grade rules that span fields (window vs grace, cutoffs in descending
// order). The per-key bounds can't see them, and a broken combination doesn't
// fail loudly: a window inside the grace period scores nothing, and
// out-of-order cutoffs hand out the wrong letters. Checked against the merged
// stored + incoming values, so a PATCH of one key that breaks another is caught.
async function watchGradeError(values: ReadonlyMap<SettingKey, string>, t: Translator): Promise<string | null> {
  const touches = Object.values(WATCH_GRADE_SETTING_KEYS).some((key) => values.has(key));
  return touches ? watchGradeCrossFieldError(await mergedWatchGradeSettings(Object.fromEntries(values)), t) : null;
}

/** The first rule spanning several keys that this PATCH would break, in order. */
async function crossFieldError(
  values: ReadonlyMap<SettingKey, string>,
  stored: ReadonlyMap<string, string>,
  t: Translator,
): Promise<string | null> {
  return (
    machineSessionError(values, stored, t) ??
    (await disableLocalLoginError(values, stored, t)) ??
    (await watchGradeError(values, t))
  );
}

/** The 429 for the first changed key still inside its cooldown, if any. */
function cooldownResponse(changedKeys: readonly SettingKey[], now: number, t: Translator): NextResponse | null {
  for (const key of changedKeys) {
    if (isCooldownExemptSetting(key)) continue;
    const last = lastKeyWriteAt.get(key);
    if (last !== undefined && now - last < KEY_COOLDOWN_MS) {
      const retryAfterMs = KEY_COOLDOWN_MS - (now - last);
      return NextResponse.json(
        { error: t("apiAdmin.settings.cooldown", { key, seconds: Math.ceil(retryAfterMs / 1000) }), retryAfterMs },
        { status: 429 },
      );
    }
  }
  return null;
}

// Claimed before the probes (which can take up to ~30s), so a second save of
// the same key can't start while this one is in flight. The returned release
// undoes the claim when nothing gets written.
function claimCooldown(changedKeys: readonly SettingKey[], claimedAt: number): () => void {
  const claimed = changedKeys.filter((k) => !isCooldownExemptSetting(k));
  for (const key of claimed) lastKeyWriteAt.set(key, claimedAt);
  return () => {
    for (const key of claimed) {
      if (lastKeyWriteAt.get(key) === claimedAt) lastKeyWriteAt.delete(key);
    }
  };
}

/** Runs the connection and email tests side by side; `failed` when any did. */
async function runProbes(
  probes: readonly ConnectionProbe[],
  emailProbe: boolean,
  candidate: (key: SettingKey) => string | undefined,
  submitted: ReadonlyMap<SettingKey, string>,
  req: NextRequest,
  adminEmail: string | null | undefined,
): Promise<{ testResults: Record<string, unknown>; failed: boolean }> {
  const testResults: Record<string, unknown> = {};
  const runs: Promise<boolean>[] = [];
  for (const p of probes) {
    const url = candidate(p.urlKey);
    const apiKey = candidate(p.keyKey);
    if (!url || !apiKey) continue;
    runs.push(
      p.run(url, apiKey).then(
        (ok) => { testResults[p.okKey] = ok; return true; },
        (err: unknown) => {
          // The admin sees the fixed message; the log keeps the cause (TLS, 401,
          // DNS, timeout). arrErrorMessage never prints an upstream body (5e).
          console.warn(`[settings] ${p.message}: ${arrErrorMessage(err)}`);
          testResults[p.errorKey] = p.message;
          return false;
        },
      ),
    );
  }
  if (emailProbe && adminEmail) {
    const overrides: EmailTransportOverrides = {};
    for (const k of EMAIL_TRANSPORT_KEYS) {
      const v = submitted.get(k);
      if (v !== undefined) overrides[k] = v;
    }
    runs.push(
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
  const failed = (await Promise.all(runs)).includes(false);
  return { testResults, failed };
}

/** The settings rows, the tracking stamps and the audit row, in one transaction. */
async function persistSettings(
  entries: ReadonlyArray<[SettingKey, string]>,
  stored: ReadonlyMap<string, string>,
  session: SummonarrSession,
  req: NextRequest,
): Promise<void> {
  const changedKeys = entries.map(([k]) => k);
  const oldValues: Record<string, string> = {};
  for (const key of changedKeys) {
    const prior = stored.get(key);
    if (prior !== undefined) oldValues[key] = isSensitiveSetting(key) ? "[redacted]" : prior;
  }
  const newValues: Record<string, string> = Object.fromEntries(
    entries.map(([k, v]) => [k, isSensitiveSetting(k) ? "[redacted]" : v]),
  );
  // A play while a tracking switch was off was never recorded, so the
  // never-watched verdict trusts recording only from the moment a switch last
  // came back on (guardrail 14d). Stamped in the same transaction as the flip.
  const stampEntries = trackingStampsFor(entries, stored, new Date());
  await prisma.$transaction(async (tx) => {
    // Sequential, not Promise.all: an interactive tx runs on one pinned
    // connection (guardrail 23c). Entries are bounded by the registry.
    for (const [key, value] of entries) {
      // Sensitive keys are encrypted at rest by the Prisma extension in src/lib/prisma.ts.
      // Do NOT pre-encrypt here — that produced double-encrypted rows (enc:v1:<enc:v1:…>)
      // which decrypted on read into the inner ciphertext, breaking Jellyfin/Radarr/etc auth.
      await tx.setting.upsert({ where: { key }, update: { value }, create: { key, value } });
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
      ipAddress: getClientIp(req.headers),
      userAgent: req.headers.get("user-agent")?.slice(0, 512) ?? null,
      provider: session.user.provider ?? null,
    });
  });
}

/** Drops what a committed change makes stale; runs only after the commit. */
function invalidateCaches(changedKeys: readonly SettingKey[]): void {
  const effects = settingEffects(changedKeys);
  // Feature flags are memoized (features.ts); drop the memo so a toggle in this
  // write is visible on the very next check instead of after the TTL.
  invalidateFeatureFlagCache();
  // The 4K settings are held 10 s too (four-k-visibility.ts); a saved 4K
  // instance or request4kAll toggle shows on the very next page.
  invalidateShow4kVisibilityCache();
  // The never-watched report is cached ~2 minutes; a tracking switch, retention
  // or the cleanup/never-watched flags change its verdicts (guardrail 14d).
  if (effects.has("neverWatchedReport")) invalidateNeverWatchedReport();
  // A Radarr/Sonarr connection or integration switch changed: the admin arr
  // pages' snapshots may name an instance that is gone or switched off (5h).
  const arrConfigChanged = changedKeys.some(isArrConfigKey);
  if (arrConfigChanged) clearArrSnapshots();
  // Same for the APNs relay config, which push.ts memoizes for 30s. The admin
  // flow is "save the relay key, then press Send test notification", so a stale
  // read lands on exactly the interaction used to verify the change.
  invalidateApnsRelayCache();
  // The MDBList plan is memoized for 30s too (mdblist.ts); a new plan applies now.
  if (effects.has("mdblistPlan")) invalidateMdblistPlanCache();
  // A new statistics zone applies on the next request: the zone is part of every
  // bucketed aggregate's cache key, so dropping the zone memo is enough.
  if (effects.has("statsTimeZone")) invalidateStatsTimeZone();
  // Thresholds, retention and the tracking switches apply at once instead of
  // after play-history's 15s settings memo.
  if (effects.has("playHistorySettings")) invalidatePlayHistorySettings();
  // The grade settings are held 15s (watch-grade-data.ts); a save grades with them at once.
  if (effects.has("watchGradeSettings")) invalidateWatchGradeSettings();
  if (effects.has("sessionDurations")) invalidateSessionDurationsCache();
  if (effects.has("discordPublicKey")) invalidatePublicKeyCache();
}

// Re-registers the slash commands from the STORED config (the write is durable
// by now). Fire-and-forget: the save has already succeeded, and a failure is
// logged for the admin's "Register commands" button to retry.
async function reregisterDiscordCommands(): Promise<void> {
  try {
    const rows = await prisma.setting.findMany({ where: { key: { in: [...DISCORD_REGISTRATION_KEYS] } } });
    const cfg = Object.fromEntries(rows.map((r) => [r.key, r.value]));
    if (!cfg.discordBotToken || !cfg.discordClientId) return;
    // The PATCH's own check, for a row written some other way.
    if (!DISCORD_SNOWFLAKE_RE.test(cfg.discordClientId)) {
      console.error("[discord] Invalid discordClientId — must be a numeric snowflake");
      return;
    }
    if (cfg.discordGuildId && !DISCORD_SNOWFLAKE_RE.test(cfg.discordGuildId)) {
      console.error("[discord] Invalid discordGuildId — must be a numeric snowflake");
      return;
    }
    // A blank guild id registers GLOBAL commands.
    const guildId = cfg.discordGuildId || null;
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
}

export const GET = withAdmin(async (_req, _ctx, _session) => {
  const rows = await prisma.setting.findMany({
    where: { key: { in: [...SETTING_KEYS] } },
  });
  const settings: Record<string, string> = Object.fromEntries(
    rows.map((r) => [r.key, presentSettingValue(r.key, r.value)]),
  );
  return NextResponse.json(settings);
});

export const PATCH = withAdmin(async (req, _ctx, session) => {
  const t = translatorForRequest(req);
  if (!checkRateLimit(`admin-settings:${session.user.id}`, 10, 60 * 1000)) {
    return NextResponse.json({ error: t("apiAdmin.common.tooManyRequestsLater") }, { status: 429 });
  }

  const parsed = await readJsonCapped<Record<string, unknown>>(req, 65536);
  if (parsed instanceof NextResponse) return parsed;
  const body = parsed;

  // The connection probes this body asks for: a real value for either half of a
  // pair. Their stored halves are read with the submitted keys, so each probe
  // can test the candidate config.
  const probes = CONNECTION_PROBES.filter((p) => isRealValue(body[p.urlKey]) || isRealValue(body[p.keyKey]));
  const emailProbe = EMAIL_PROBE_TRIGGERS.some((k) => isRealValue(body[k]));
  const stored = await readStoredSettings(body, probes);

  const checked = await checkSubmittedSettings(body, stored, { t, knowsTimeZone: databaseKnowsTimeZone });
  if (!checked.ok) return rejectionResponse(checked.rejection);
  const conflict = await crossFieldError(checked.values, stored, t);
  if (conflict) return NextResponse.json({ error: conflict }, { status: 400 });

  const { submitted, ignored } = submittedSettings(checked.values, stored);
  const entries = changedSettings(submitted, stored);
  const changedKeys = entries.map(([k]) => k);

  // A cooldown-exempt switch and a resent unchanged value never wait.
  const now = Date.now();
  const cooldown = cooldownResponse(changedKeys, now, t);
  if (cooldown) return cooldown;

  const extra = ignored.length > 0 ? { ignored } : {};
  if (entries.length === 0 && probes.length === 0 && !emailProbe) {
    return NextResponse.json({ ok: true, ...extra });
  }

  const releaseCooldown = claimCooldown(changedKeys, now);
  // Test the candidate config before anything is written — see CONNECTION_PROBES.
  const { testResults, failed: testFailed } = await runProbes(
    probes,
    emailProbe,
    (key) => submitted.get(key) || stored.get(key),
    submitted,
    req,
    session.user.email,
  );
  if (testFailed) {
    releaseCooldown();
    return NextResponse.json({ ok: false, ...localizeTestResults(testResults, t), ...extra }, { status: 422 });
  }
  if (entries.length === 0) {
    releaseCooldown();
    return NextResponse.json({ ok: true, ...localizeTestResults(testResults, t), ...extra });
  }

  try {
    await persistSettings(entries, stored, session, req);
  } catch (err) {
    releaseCooldown();
    console.error("[audit] Settings transaction failed:", err);
    return NextResponse.json({ error: t("apiAdmin.settings.auditFailed") }, { status: 500 });
  }
  invalidateCaches(changedKeys);
  // Only on a real CHANGE to the registration inputs: the Discord form posts
  // every field on every save, and a presence gate fired this bulk-overwrite PUT
  // on a Channels/Roles-tab save that touched neither.
  if (settingEffects(changedKeys).has("discordCommands")) void reregisterDiscordCommands();

  return NextResponse.json({ ok: true, ...localizeTestResults(testResults, t), ...extra });
});
