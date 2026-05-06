import { NextRequest, NextResponse } from "next/server";
import { createHash, timingSafeEqual } from "node:crypto";
import { auth, isTokenExpired } from "@/lib/auth";
import { logAudit } from "@/lib/audit";
import { withAdvisoryLock, TRASH_SYNC_LOCK_ID } from "@/lib/advisory-lock";
import { runTrashSync } from "@/lib/trash";

function safeCompareStrings(a: string, b: string): boolean {
  const ha = createHash("sha256").update(a).digest();
  const hb = createHash("sha256").update(b).digest();
  return timingSafeEqual(ha, hb);
}

async function getAuthContext(request: NextRequest): Promise<
  { userId: string; userName: string; trigger: "admin" | "cron" } | null
> {
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
    TRASH_SYNC_LOCK_ID,
    async () => {
      const startTime = Date.now();
      const result = await runTrashSync();
      const durationMs = Date.now() - startTime;

      const recreated = result.applied.filter((r) => r.recreated).length;
      await logAudit({
        userId: authCtx.userId,
        userName: authCtx.userName,
        action: "SETTINGS_CHANGE",
        target: "trash-sync",
        details: {
          refreshed: result.refreshed,
          applied: {
            count: result.applied.length,
            failures: result.applied.filter((r) => !r.ok).length,
            ...(recreated > 0 ? { recreated } : {}),
          },
          errors: result.errors,
          durationMs,
          trigger: authCtx.trigger,
        },
      });

      return NextResponse.json({
        ok: result.errors.length === 0,
        ...result,
        durationMs,
        timestamp: new Date().toISOString(),
      });
    },
    () => NextResponse.json({ skipped: true, reason: "already running" }),
  );
}
