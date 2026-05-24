import { NextRequest, NextResponse } from "next/server";
import { isCronAuthorized, withCronRunRecording } from "@/lib/cron-auth";
import { prisma } from "@/lib/prisma";
import { logAudit } from "@/lib/audit";
import { withAdvisoryLock } from "@/lib/advisory-lock";

export async function POST(request: NextRequest) {
  if (!(await isCronAuthorized(request))) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  return withCronRunRecording("audit-log:pii-scrub", () => withAdvisoryLock(
    2002,
    async () => {
      const cutoff = new Date(Date.now() - 90 * 24 * 60 * 60 * 1000);

      // Match the admin DELETE /api/admin/audit-log handler so the cron actually
      // fulfills the documented 90-day PII promise (previously this only nulled
      // ipAddress/userAgent and left userName + login-event details intact
      // forever unless an admin clicked the manual scrub button).
      const piiResult = await prisma.auditLog.updateMany({
        where: {
          createdAt: { lt: cutoff },
          OR: [
            { ipAddress: { not: null } },
            { userAgent: { not: null } },
            { userName: { not: "[redacted]" } },
          ],
        },
        data: { ipAddress: null, userAgent: null, userName: "[redacted]" },
      });

      const detailsResult = await prisma.auditLog.updateMany({
        where: {
          createdAt: { lt: cutoff },
          action: { in: ["AUTH_LOGIN_FAILED", "AUTH_LOGIN", "AUTH_LOGOUT"] },
          details: { not: null },
        },
        data: { details: null },
      });

      await logAudit({
        userId: "system",
        userName: "cron",
        action: "SETTINGS_CHANGE",
        target: "audit-log:pii-scrub",
        details: {
          scrubbed: piiResult.count,
          authDetailsCleared: detailsResult.count,
          cutoff: cutoff.toISOString(),
        },
      });

      return NextResponse.json({
        ok: true,
        scrubbed: piiResult.count,
        authDetailsCleared: detailsResult.count,
        cutoff: cutoff.toISOString(),
        timestamp: new Date().toISOString(),
      });
    },
    () => NextResponse.json({ skipped: true, reason: "already running" }),
  ));
}
