import { NextRequest, NextResponse } from "next/server";
import { auth, isTokenExpired } from "@/lib/auth";
import { isCronAuthorized } from "@/lib/cron-auth";
import { logAudit } from "@/lib/audit";
import { withAdvisoryLock, TRASH_SYNC_LOCK_ID } from "@/lib/advisory-lock";
import { runTrashSync } from "@/lib/trash";

async function getAuthContext(request: NextRequest): Promise<
  { userId: string; userName: string; trigger: "admin" | "cron" } | null
> {
  if (!(await isCronAuthorized(request))) return null;

  const session = await auth();
  if (session?.user?.role === "ADMIN" && !isTokenExpired(session)) {
    return { userId: session.user.id, userName: session.user.name ?? "admin", trigger: "admin" };
  }
  return { userId: "system", userName: "cron", trigger: "cron" };
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
