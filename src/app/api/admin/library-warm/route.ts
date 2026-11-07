import { NextResponse } from "next/server";
import { withAdmin } from "@/lib/api-auth";
import { WARM_LIBRARY_LOCK_ID } from "@/lib/advisory-lock";
import { prewarmLibraryCache } from "@/lib/tmdb-prewarm";
import { logAudit, auditContext } from "@/lib/audit";
import { translatorForRequest } from "@/lib/i18n/server-locale";
import { readJsonCappedOr } from "@/lib/body-size";
import { libraryJobResponse, startLibraryJob, wantsBackgroundRun } from "@/lib/library-sync-jobs";
import { runAdminWarm } from "@/lib/warm-cooldown";

const COOLDOWN_MS = 5 * 60 * 1000;
const COOLDOWN_KEY = "lastLibraryWarmAt";

// GET ?job= — a background warm's answer (library-sync-jobs.ts).
export const GET = withAdmin(async (req, _ctx, session) =>
  libraryJobResponse(session.user.id, req.nextUrl.searchParams.get("job") ?? "", translatorForRequest(req)));

export const POST = withAdmin(async (req, _ctx, session) => {
  const t = translatorForRequest(req);
  // No body (the synchronous default) or { async: true }: a cold warm of a
  // large library takes minutes, past a reverse proxy's hold, so the admin's
  // button runs it in the background and polls GET ?job=.
  const body = await readJsonCappedOr<unknown>(req, 1024, {});
  if (body instanceof NextResponse) return body;
  // Same advisory lock as /api/cron/warm-library (and the boot-time prewarm) —
  // an admin click while the cron walk is running must not start a second full
  // library walk beside it (guardrail 41). The cooldown claim, its release on
  // failure and the 409/429 answers live in runAdminWarm (warm-cooldown.ts).
  const run = () => runAdminWarm({
    lockId: WARM_LIBRARY_LOCK_ID,
    cooldownKey: COOLDOWN_KEY,
    cooldownMs: COOLDOWN_MS,
    busyMessage: t("apiAdmin.warm.libraryRunning"),
    cooldownMessage: (seconds) => t("apiAdmin.warm.libraryCooldown", { seconds }),
    failedMessage: t("apiAdmin.warm.failed"),
    scope: "[library-warm]",
    run: async (signal) => {
      const startTime = Date.now();
      const result = await prewarmLibraryCache({ signal });
      const durationMs = Date.now() - startTime;

      await logAudit({
        userId: session.user.id,
        userName: session.user.name ?? session.user.email,
        action: "CACHE_WARM",
        target: "library",
        details: { ...(result as Record<string, unknown>), durationMs, trigger: "admin" },
        ...auditContext(req, session),
      });

      return NextResponse.json(result);
    },
  });
  if (wantsBackgroundRun(body)) return startLibraryJob(session.user.id, "library-warm", run);
  return run();
});
