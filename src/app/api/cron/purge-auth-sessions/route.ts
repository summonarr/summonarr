import { prisma } from "@/lib/prisma";
import { logAudit } from "@/lib/audit";
import { PURGE_AUTH_SESSIONS_LOCK_ID } from "@/lib/advisory-lock";
import { defineCronRoute } from "@/lib/cron-route";

const DAY_MS = 24 * 60 * 60 * 1000;

// IpLookupCache has no expiresAt: age-based eviction. 90 days matches typical
// RIR data freshness — beyond that, AS/org reassignments mean a re-lookup is
// cheaper than serving stale geolocation.
const IP_LOOKUP_RETENTION_DAYS = 90;
// PlexTokenCache rows written before the TTL column existed have a null
// expiresAt, so the "expired" sweep never matches them; they go once this old.
const PLEX_TOKEN_LEGACY_RETENTION_DAYS = 90;
// AuditLog rows are deleted at a year, which bounds the growth from per-tick
// LIBRARY_SYNC / CACHE_WARM / SETTINGS_CHANGE entries and is long enough for
// any realistic incident review. Their PII is scrubbed far earlier, by the
// scrub-audit-pii cron (auditPiiRetentionDays, default 90).
const AUDIT_LOG_RETENTION_DAYS = 365;

// Each purge leg once, by the key it reports under in `deleted`: the failure
// log names that key, so an operator can tell which table failed.
type PurgeKey =
  | "authSessions" | "discordLinkTokens" | "discordMergeCodes" | "discordSearchCache"
  | "webhookReplays" | "plexTokensExpired" | "plexTokensLegacy" | "tmdbMediaCore"
  | "ipLookupCache" | "auditLogs";

interface PurgeLeg {
  key: PurgeKey;
  run: () => Promise<{ count: number }>;
}

// Every delete is bounded by a date: an expiry that passed, or an age. The
// AuthSession sweep is `expiresAt < now` ONLY — the one housekeeping allowed to
// delete a session row (guardrail 6c), and never one with the native
// never-expires sentinel.
function purgeLegs(now: Date): PurgeLeg[] {
  const ago = (days: number) => new Date(now.getTime() - days * DAY_MS);
  const expired = { expiresAt: { lt: now } };
  return [
    { key: "authSessions", run: () => prisma.authSession.deleteMany({ where: expired }) },
    { key: "discordLinkTokens", run: () => prisma.discordLinkToken.deleteMany({ where: expired }) },
    { key: "discordMergeCodes", run: () => prisma.discordMergeCode.deleteMany({ where: expired }) },
    { key: "discordSearchCache", run: () => prisma.discordSearchCache.deleteMany({ where: expired }) },
    { key: "webhookReplays", run: () => prisma.webhookReplay.deleteMany({ where: expired }) },
    { key: "plexTokensExpired", run: () => prisma.plexTokenCache.deleteMany({ where: expired }) },
    {
      key: "plexTokensLegacy",
      run: () => prisma.plexTokenCache.deleteMany({
        where: { expiresAt: null, verifiedAt: { lt: ago(PLEX_TOKEN_LEGACY_RETENTION_DAYS) } },
      }),
    },
    { key: "tmdbMediaCore", run: () => prisma.tmdbMediaCore.deleteMany({ where: expired }) },
    { key: "ipLookupCache", run: () => prisma.ipLookupCache.deleteMany({ where: { fetchedAt: { lt: ago(IP_LOOKUP_RETENTION_DAYS) } } }) },
    { key: "auditLogs", run: () => prisma.auditLog.deleteMany({ where: { createdAt: { lt: ago(AUDIT_LOG_RETENTION_DAYS) } } }) },
  ];
}

// One leg at a time: ten deletes at once would take every connection of the
// five-connection Prisma pool for the length of the slowest. Each leg is one
// statement on an indexed date column, and a daily run keeps each to about a
// day's rows. A failing leg never stops the others; an abort stops before the
// next one (guardrail 41), leaving the rest to the next run.
async function runPurgeLegs(legs: PurgeLeg[], signal: AbortSignal) {
  const deleted = Object.fromEntries(legs.map((leg) => [leg.key, 0])) as Record<PurgeKey, number>;
  let errorCount = 0;
  for (const leg of legs) {
    if (signal.aborted) return { deleted, errorCount, aborted: true };
    try {
      deleted[leg.key] = (await leg.run()).count;
    } catch (err) {
      errorCount++;
      console.error(
        `[cron/purge-auth-sessions] ${leg.key} delete failed:`,
        err instanceof Error ? err.message : String(err),
      );
    }
  }
  return { deleted, errorCount, aborted: false };
}

export const POST = defineCronRoute({
  target: "auth-sessions:purge-expired",
  lockId: PURGE_AUTH_SESSIONS_LOCK_ID,
  async run({ signal }) {
    const { deleted, errorCount, aborted } = await runPurgeLegs(purgeLegs(new Date()), signal);

    await logAudit({
      userId: "system",
      userName: "cron",
      action: "SETTINGS_CHANGE",
      target: "auth-sessions:purge-expired",
      details: { ...deleted, errorCount, ...(aborted ? { aborted } : {}) },
    });

    // A failed table answers 200 + X-Cron-Degraded like every other cron: the
    // run is still recorded as failed, the body still carries the counts that
    // did succeed, and the daily job is not re-run every 300s (the entrypoint's
    // fast retry on a non-2xx).
    return {
      body: { deleted, errorCount, aborted },
      problems: errorCount + (aborted ? 1 : 0),
      error: aborted ? "the run was stopped before it finished" : `${errorCount} table purge(s) failed`,
    };
  },
});
