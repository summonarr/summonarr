import { NextRequest, NextResponse } from "next/server";
import { createHash, timingSafeEqual } from "node:crypto";
import { auth, isTokenExpired } from "@/lib/auth";
import { clearActivityCache, warmActivityCache } from "@/lib/play-history";
import { logAudit } from "@/lib/audit";
import { withAdvisoryLock } from "@/lib/advisory-lock";
import { recordCronRun } from "@/lib/cron-auth";

function safeCompareStrings(a: string, b: string): boolean {
  const ha = createHash("sha256").update(a).digest();
  const hb = createHash("sha256").update(b).digest();
  return timingSafeEqual(ha, hb);
}

async function getAuthContext(request: NextRequest): Promise<{ userId: string; userName: string; trigger: "admin" | "cron" } | null> {
  const session = await auth();
  if (session?.user?.role === "ADMIN" && !isTokenExpired(session)) {
    return { userId: session.user.id, userName: session.user.name ?? "admin", trigger: "admin" };
  }

  const cronSecret = process.env.CRON_SECRET;
  if (cronSecret) {
    const authHeader = request.headers.get("authorization") ?? "";
    if (authHeader.startsWith("Bearer ") && safeCompareStrings(authHeader.slice(7), cronSecret)) {
      return { userId: "system", userName: "cron", trigger: "cron" };
    }
  }

  return null;
}

export async function POST(request: NextRequest) {
  const authCtx = await getAuthContext(request);
  if (!authCtx) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  return withAdvisoryLock(
    2003,
    async () => {
      clearActivityCache();
      const startTime = Date.now();
      const { warmed } = await warmActivityCache();
      const durationMs = Date.now() - startTime;

      // `lastRunAt` observability — written for both admin and cron triggers
      // (cf. /settings?tab=system). Stored in Setting, not AuditLog, so cron
      // runs don't flood the audit table.
      await recordCronRun("activity", durationMs);

      // Skip audit log for automated cron runs to avoid flooding the audit table
      if (authCtx.trigger !== "cron") {
        await logAudit({
          userId: authCtx.userId,
          userName: authCtx.userName,
          action: "CACHE_WARM",
          target: "activity",
          details: { warmed, durationMs, trigger: authCtx.trigger },
        });
      }

      return NextResponse.json({
        ok: true,
        warmed,
        timestamp: new Date().toISOString(),
      });
    },
    () => NextResponse.json({ skipped: true, reason: "already running" }),
  );
}
