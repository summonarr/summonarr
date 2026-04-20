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
      const [authSessionResult, discordLinkTokenResult, discordMergeCodeResult, discordSearchCacheResult] =
        await Promise.allSettled([
          prisma.authSession.deleteMany({ where: { expiresAt: { lt: now } } }),
          prisma.discordLinkToken.deleteMany({ where: { expiresAt: { lt: now } } }),
          prisma.discordMergeCode.deleteMany({ where: { expiresAt: { lt: now } } }),
          prisma.discordSearchCache.deleteMany({ where: { expiresAt: { lt: now } } }),
        ]);

      const deleted = {
        authSessions: authSessionResult.status === "fulfilled" ? authSessionResult.value.count : 0,
        discordLinkTokens: discordLinkTokenResult.status === "fulfilled" ? discordLinkTokenResult.value.count : 0,
        discordMergeCodes: discordMergeCodeResult.status === "fulfilled" ? discordMergeCodeResult.value.count : 0,
        discordSearchCache: discordSearchCacheResult.status === "fulfilled" ? discordSearchCacheResult.value.count : 0,
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
