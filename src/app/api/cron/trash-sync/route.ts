import { NextRequest, NextResponse } from "next/server";
import { isCronAuthorized, withCronRunRecording } from "@/lib/cron-auth";
import { logAudit } from "@/lib/audit";
import { withAdvisoryLock, TRASH_SYNC_LOCK_ID } from "@/lib/advisory-lock";
import { runTrashSync } from "@/lib/trash";
import { readActiveSummonarrSessionFromRequest } from "@/lib/session-server";

async function getAuthContext(request: NextRequest): Promise<
  { userId: string; userName: string; trigger: "admin" | "cron" } | null
> {
  if (!(await isCronAuthorized(request))) return null;

  // Use the request-aware DB-checked reader (honors revocation/cutoffs) for attribution.
  // Falls back to "cron" label if no active admin session (pure scheduled run).
  const claims = await readActiveSummonarrSessionFromRequest(request);
  if (claims?.role === "ADMIN") {
    return { userId: claims.id, userName: claims.name ?? "admin", trigger: "admin" };
  }
  return { userId: "system", userName: "cron", trigger: "cron" };
}

export async function POST(request: NextRequest) {
  const authCtx = await getAuthContext(request);
  if (!authCtx) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  return withCronRunRecording("trash-sync", () => withAdvisoryLock(
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

      // Non-2xx on errors so withCronRunRecording marks ok=false.
      const status = result.errors.length > 0 ? 500 : 200;
      return NextResponse.json({
        ok: result.errors.length === 0,
        ...result,
        durationMs,
        timestamp: new Date().toISOString(),
      }, { status });
    },
    () => NextResponse.json({ skipped: true, reason: "already running" }),
  ));
}
