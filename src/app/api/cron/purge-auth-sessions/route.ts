import { NextRequest, NextResponse } from "next/server";
import { isCronAuthorized } from "@/lib/cron-auth";
import { prisma } from "@/lib/prisma";
import { logAudit } from "@/lib/audit";
import { withAdvisoryLock } from "@/lib/advisory-lock";

export async function POST(request: NextRequest) {
  if (!(await isCronAuthorized(request))) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  return withAdvisoryLock(
    2001,
    async () => {
      const now = new Date();
      // IpLookupCache uses age-based eviction (no expiresAt). 90 days matches
      // typical RIR data freshness — beyond that, AS/org reassignments mean
      // a re-lookup is cheaper than serving stale geolocation.
      const ipLookupCutoff = new Date(now.getTime() - 90 * 24 * 60 * 60 * 1000);
      // PlexTokenCache: legacy rows (pre-TTL migration) have null expiresAt.
      // Purge both expired rows AND null rows older than 90 days, per the
      // model comment. Sweeper was promised in maintenance.ts but never landed.
      const plexTokenLegacyCutoff = new Date(now.getTime() - 90 * 24 * 60 * 60 * 1000);
      // AuditLog: PII is scrubbed at 90 days by scrub-audit-pii. Row deletion
      // at 365 days bounds unbounded table growth from per-tick LIBRARY_SYNC /
      // CACHE_WARM / SETTINGS_CHANGE entries. Long enough for any realistic
      // incident review window.
      const auditCutoff = new Date(now.getTime() - 365 * 24 * 60 * 60 * 1000);

      const [
        authSessionResult,
        discordLinkTokenResult,
        discordMergeCodeResult,
        discordSearchCacheResult,
        webhookReplayResult,
        plexTokenExpiredResult,
        plexTokenLegacyResult,
        tmdbMediaCoreResult,
        ipLookupResult,
        auditLogResult,
      ] = await Promise.allSettled([
        prisma.authSession.deleteMany({ where: { expiresAt: { lt: now } } }),
        prisma.discordLinkToken.deleteMany({ where: { expiresAt: { lt: now } } }),
        prisma.discordMergeCode.deleteMany({ where: { expiresAt: { lt: now } } }),
        prisma.discordSearchCache.deleteMany({ where: { expiresAt: { lt: now } } }),
        prisma.webhookReplay.deleteMany({ where: { expiresAt: { lt: now } } }),
        prisma.plexTokenCache.deleteMany({ where: { expiresAt: { lt: now } } }),
        prisma.plexTokenCache.deleteMany({
          where: { expiresAt: null, verifiedAt: { lt: plexTokenLegacyCutoff } },
        }),
        prisma.tmdbMediaCore.deleteMany({ where: { expiresAt: { lt: now } } }),
        prisma.ipLookupCache.deleteMany({ where: { fetchedAt: { lt: ipLookupCutoff } } }),
        prisma.auditLog.deleteMany({ where: { createdAt: { lt: auditCutoff } } }),
      ]);

      const deleted = {
        authSessions: authSessionResult.status === "fulfilled" ? authSessionResult.value.count : 0,
        discordLinkTokens: discordLinkTokenResult.status === "fulfilled" ? discordLinkTokenResult.value.count : 0,
        discordMergeCodes: discordMergeCodeResult.status === "fulfilled" ? discordMergeCodeResult.value.count : 0,
        discordSearchCache: discordSearchCacheResult.status === "fulfilled" ? discordSearchCacheResult.value.count : 0,
        webhookReplays: webhookReplayResult.status === "fulfilled" ? webhookReplayResult.value.count : 0,
        plexTokensExpired: plexTokenExpiredResult.status === "fulfilled" ? plexTokenExpiredResult.value.count : 0,
        plexTokensLegacy: plexTokenLegacyResult.status === "fulfilled" ? plexTokenLegacyResult.value.count : 0,
        tmdbMediaCore: tmdbMediaCoreResult.status === "fulfilled" ? tmdbMediaCoreResult.value.count : 0,
        ipLookupCache: ipLookupResult.status === "fulfilled" ? ipLookupResult.value.count : 0,
        auditLogs: auditLogResult.status === "fulfilled" ? auditLogResult.value.count : 0,
      };

      await logAudit({
        userId: "system",
        userName: "cron",
        action: "SETTINGS_CHANGE",
        target: "auth-sessions:purge-expired",
        details: deleted,
      });

      return NextResponse.json({
        ok: true,
        deleted,
        timestamp: new Date().toISOString(),
      });
    },
    () => NextResponse.json({ skipped: true, reason: "already running" }),
  );
}
