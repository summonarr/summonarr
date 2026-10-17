import { NextRequest, NextResponse } from "next/server";
import { cronSkippedResponse, isCronAuthorized, withCronRunRecording } from "@/lib/cron-auth";
import { prisma } from "@/lib/prisma";
import { logAudit, getAuditPiiRetentionDays } from "@/lib/audit";
import { withAdvisoryLock } from "@/lib/advisory-lock";
import { scrubTargetPiiFromAudit } from "@/lib/audit-scrub";

export async function POST(request: NextRequest) {
  if (!(await isCronAuthorized(request))) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  return withCronRunRecording("audit-log:pii-scrub", () => withAdvisoryLock(
    2002,
    async () => {
      const retentionDays = await getAuditPiiRetentionDays();
      const cutoff = new Date(Date.now() - retentionDays * 24 * 60 * 60 * 1000);

      // Scrubs the same fields as the admin DELETE /api/admin/audit-log handler:
      // IP address, user agent and user name on every old row, plus the details
      // of login/logout events and the target-user names in admin-action
      // details (below), once they pass the retention cutoff.
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

      // Admin-action rows name their TARGET user in details (targetUser /
      // legacy targetEmail) — audit-scrub.ts. Same cutoff, same promise.
      const adminDetailsScrubbed = await scrubTargetPiiFromAudit(prisma, { createdAt: { lt: cutoff } });

      await logAudit({
        userId: "system",
        userName: "cron",
        action: "SETTINGS_CHANGE",
        target: "audit-log:pii-scrub",
        details: {
          scrubbed: piiResult.count,
          authDetailsCleared: detailsResult.count,
          adminDetailsScrubbed,
          cutoff: cutoff.toISOString(),
          retentionDays,
        },
      });

      return NextResponse.json({
        ok: true,
        scrubbed: piiResult.count,
        authDetailsCleared: detailsResult.count,
        adminDetailsScrubbed,
        cutoff: cutoff.toISOString(),
        timestamp: new Date().toISOString(),
      });
    },
    () => cronSkippedResponse(),
  ));
}
