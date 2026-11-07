import { NextRequest, NextResponse } from "next/server";
import { cronSkippedResponse, isCronAuthorized, withCronRunRecording } from "@/lib/cron-auth";
import { prisma } from "@/lib/prisma";
import { logAudit } from "@/lib/audit";
import { withAdvisoryLock, PURGE_AUTH_SESSIONS_LOCK_ID } from "@/lib/advisory-lock";

// Each purge leg once, by the key it reports under in `deleted`: the failure
// log names that key, so an operator can tell which table failed.
type PurgeKey =
  | "authSessions" | "discordLinkTokens" | "discordMergeCodes" | "discordSearchCache"
  | "webhookReplays" | "plexTokensExpired" | "plexTokensLegacy" | "tmdbMediaCore"
  | "ipLookupCache" | "auditLogs";

export async function POST(request: NextRequest) {
  if (!(await isCronAuthorized(request))) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  return withCronRunRecording("auth-sessions:purge-expired", () => withAdvisoryLock(
    PURGE_AUTH_SESSIONS_LOCK_ID,
    async () => {
      const now = new Date();
      // IpLookupCache uses age-based eviction (no expiresAt). 90 days matches
      // typical RIR data freshness — beyond that, AS/org reassignments mean
      // a re-lookup is cheaper than serving stale geolocation.
      const ipLookupCutoff = new Date(now.getTime() - 90 * 24 * 60 * 60 * 1000);
      // PlexTokenCache: old rows written before the TTL column existed have a
      // null expiresAt, so they would never match the "expired" delete. We also
      // purge those null rows once they are older than 90 days.
      const plexTokenLegacyCutoff = new Date(now.getTime() - 90 * 24 * 60 * 60 * 1000);
      // AuditLog: PII is scrubbed at 90 days by scrub-audit-pii. Row deletion
      // at 365 days bounds unbounded table growth from per-tick LIBRARY_SYNC /
      // CACHE_WARM / SETTINGS_CHANGE entries. Long enough for any realistic
      // incident review window.
      const auditCutoff = new Date(now.getTime() - 365 * 24 * 60 * 60 * 1000);

      const legs: Array<{ key: PurgeKey; run: () => Promise<{ count: number }> }> = [
        { key: "authSessions", run: () => prisma.authSession.deleteMany({ where: { expiresAt: { lt: now } } }) },
        { key: "discordLinkTokens", run: () => prisma.discordLinkToken.deleteMany({ where: { expiresAt: { lt: now } } }) },
        { key: "discordMergeCodes", run: () => prisma.discordMergeCode.deleteMany({ where: { expiresAt: { lt: now } } }) },
        { key: "discordSearchCache", run: () => prisma.discordSearchCache.deleteMany({ where: { expiresAt: { lt: now } } }) },
        { key: "webhookReplays", run: () => prisma.webhookReplay.deleteMany({ where: { expiresAt: { lt: now } } }) },
        { key: "plexTokensExpired", run: () => prisma.plexTokenCache.deleteMany({ where: { expiresAt: { lt: now } } }) },
        {
          key: "plexTokensLegacy",
          run: () => prisma.plexTokenCache.deleteMany({
            where: { expiresAt: null, verifiedAt: { lt: plexTokenLegacyCutoff } },
          }),
        },
        { key: "tmdbMediaCore", run: () => prisma.tmdbMediaCore.deleteMany({ where: { expiresAt: { lt: now } } }) },
        { key: "ipLookupCache", run: () => prisma.ipLookupCache.deleteMany({ where: { fetchedAt: { lt: ipLookupCutoff } } }) },
        { key: "auditLogs", run: () => prisma.auditLog.deleteMany({ where: { createdAt: { lt: auditCutoff } } }) },
      ];

      // allSettled: one failing leg never stops the others.
      const results = await Promise.allSettled(legs.map((leg) => leg.run()));

      const deleted = {} as Record<PurgeKey, number>;
      let errorCount = 0;
      results.forEach((r, i) => {
        const { key } = legs[i];
        if (r.status === "fulfilled") {
          deleted[key] = r.value.count;
          return;
        }
        deleted[key] = 0;
        errorCount++;
        console.error(
          `[cron/purge-auth-sessions] ${key} delete failed:`,
          r.reason instanceof Error ? r.reason.message : String(r.reason),
        );
      });

      await logAudit({
        userId: "system",
        userName: "cron",
        action: "SETTINGS_CHANGE",
        target: "auth-sessions:purge-expired",
        details: { ...deleted, errorCount },
      });

      // Non-2xx on any failure so withCronRunRecording marks the run ok=false —
      // the body still ships the per-table counts that did succeed.
      const status = errorCount > 0 ? 500 : 200;
      return NextResponse.json({
        ok: errorCount === 0,
        deleted,
        errorCount,
        timestamp: new Date().toISOString(),
      }, { status });
    },
    () => cronSkippedResponse(),
  ));
}
