import { NextRequest, NextResponse } from "next/server";
import { isCronAuthorized } from "@/lib/cron-auth";
import { recordCronRun, resolveCronTrigger } from "@/lib/cron-run";
import { prisma } from "@/lib/prisma";
import { logAudit } from "@/lib/audit";
import { withAdvisoryLock } from "@/lib/advisory-lock";

export async function POST(request: NextRequest) {
  if (!(await isCronAuthorized(request))) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  return withAdvisoryLock(
    2002,
    async () => {
      const startTime = Date.now();
      const cutoff = new Date(Date.now() - 90 * 24 * 60 * 60 * 1000);

      const result = await prisma.auditLog.updateMany({
        where: {
          createdAt: { lt: cutoff },
          OR: [{ ipAddress: { not: null } }, { userAgent: { not: null } }],
        },
        data: { ipAddress: null, userAgent: null },
      });

      await logAudit({
        userId: "system",
        userName: "cron",
        action: "SETTINGS_CHANGE",
        target: "audit-log:pii-scrub",
        details: { scrubbed: result.count, cutoff: cutoff.toISOString() },
      });

      await recordCronRun({
        target: "audit-log:pii-scrub",
        status: "ok",
        durationMs: Date.now() - startTime,
        trigger: await resolveCronTrigger(),
        details: { scrubbed: result.count, cutoff: cutoff.toISOString() },
      });

      return NextResponse.json({
        ok: true,
        scrubbed: result.count,
        cutoff: cutoff.toISOString(),
        timestamp: new Date().toISOString(),
      });
    },
    () => NextResponse.json({ skipped: true, reason: "already running" }),
  );
}
