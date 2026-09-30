import { NextResponse } from "next/server";
import { withAdmin } from "@/lib/api-auth";
import { withAdvisoryLock, WARM_LIBRARY_LOCK_ID } from "@/lib/advisory-lock";
import { prisma } from "@/lib/prisma";
import { prewarmLibraryCache } from "@/lib/tmdb-prewarm";
import { logAudit } from "@/lib/audit";

const COOLDOWN_MS = 5 * 60 * 1000;
const COOLDOWN_KEY = "lastLibraryWarmAt";

function busyResponse() {
  return NextResponse.json(
    { ok: false, error: "Library warm already running", retryAfter: 30 },
    { status: 409, headers: { "Retry-After": "30" } },
  );
}

export const POST = withAdmin(async (_req, _ctx, session) => {
  // Same advisory lock as /api/cron/warm-library (and the boot-time prewarm) —
  // an admin click while the cron walk is running must not start a second full
  // library walk beside it (guardrail 41). The cooldown CAS lives INSIDE the
  // lock so a lock-busy 409 can't consume the 5-minute cooldown for a warm that
  // never ran.
  return withAdvisoryLock(
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
          { error: `Cache warm triggered too recently — wait ${Math.ceil(remaining / 1000)}s` },
          { status: 429 }
        );
      }

      const startTime = Date.now();
      const result = await prewarmLibraryCache({ signal });
      const durationMs = Date.now() - startTime;

      await logAudit({
        userId: session.user.id,
        userName: session.user.name,
        action: "CACHE_WARM",
        target: "library",
        details: { ...(result as Record<string, unknown>), durationMs, trigger: "admin" },
      });

      return NextResponse.json(result);
    },
    busyResponse,
  );
});
