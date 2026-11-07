import { NextResponse } from "next/server";
import { withAdmin } from "@/lib/api-auth";
import { withAdvisoryLock, WARM_LIBRARY_LOCK_ID } from "@/lib/advisory-lock";
import { prisma } from "@/lib/prisma";
import { prewarmLibraryCache } from "@/lib/tmdb-prewarm";
import { logAudit, auditContext } from "@/lib/audit";
import { translatorForRequest } from "@/lib/i18n/server-locale";
import { lockBusyResponse } from "@/lib/lock-http";
import { readJsonCappedOr } from "@/lib/body-size";
import { libraryJobResponse, startLibraryJob, wantsBackgroundRun } from "@/lib/library-sync-jobs";

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
  // library walk beside it (guardrail 41). The cooldown CAS lives INSIDE the
  // lock so a lock-busy 409 can't consume the 5-minute cooldown for a warm that
  // never ran.
  const run = () => withAdvisoryLock(
    WARM_LIBRARY_LOCK_ID,
    async (signal) => {
      const now = Date.now();

      // One atomic SQL statement claims the cooldown (a compare-and-swap): it only
      // writes — and returns 1 row — when the last warm is 5+ minutes old, so two
      // clicks at the same moment can't both start a warm.
      const claimed = await prisma.$executeRaw`
        INSERT INTO "Setting" (key, value, "updatedAt")
        VALUES (${COOLDOWN_KEY}, ${String(now)}, NOW())
        ON CONFLICT (key) DO UPDATE
          SET value = EXCLUDED.value, "updatedAt" = NOW()
        WHERE "Setting".value !~ '^[0-9]+$'
           OR CAST("Setting".value AS BIGINT) + ${COOLDOWN_MS}::bigint <= ${now}::bigint
      `;
      if (claimed === 0) {
        const row = await prisma.setting.findUnique({ where: { key: COOLDOWN_KEY } });
        const lastMs = row ? parseInt(row.value, 10) || 0 : 0;
        const remaining = COOLDOWN_MS - (now - lastMs);
        return NextResponse.json(
          { error: t("apiAdmin.warm.libraryCooldown", { seconds: Math.ceil(remaining / 1000) }) },
          { status: 429 }
        );
      }

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
    () => lockBusyResponse(t("apiAdmin.warm.libraryRunning")),
  );
  if (wantsBackgroundRun(body)) return startLibraryJob(session.user.id, "library-warm", run);
  return run();
});
