import { NextResponse } from "next/server";
import { withAdmin } from "@/lib/api-auth";
import { withAdvisoryLock, WARM_OMDB_LOCK_ID } from "@/lib/advisory-lock";
import { prisma } from "@/lib/prisma";
import { prewarmOmdbCache } from "@/lib/omdb-prewarm";
import { logAudit } from "@/lib/audit";

const COOLDOWN_MS = 5 * 60 * 1000;
const COOLDOWN_KEY = "lastOmdbWarmAt";

function busyResponse() {
  return NextResponse.json(
    { ok: false, error: "OMDB warm already running", retryAfter: 30 },
    { status: 409, headers: { "Retry-After": "30" } },
  );
}

export const POST = withAdmin(async (_req, _ctx, session) => {
  // Same advisory lock as /api/cron/warm-omdb — an admin click while the cron
  // warm is running must not double-burn the OMDB free-tier daily quota. The
  // cooldown CAS lives INSIDE the lock so a lock-busy 409 can't consume the
  // 5-minute cooldown for a warm that never ran.
  return withAdvisoryLock(
    WARM_OMDB_LOCK_ID,
    async () => {
      const now = Date.now();

      // Atomic upsert acts as a distributed CAS: only succeeds if the cooldown window has elapsed
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
          { error: `Triggered too recently — wait ${Math.ceil(remaining / 1000)}s` },
          { status: 429 }
        );
      }

      const startTime = Date.now();
      const result = await prewarmOmdbCache();
      const durationMs = Date.now() - startTime;

      await logAudit({
        userId: session.user.id,
        userName: session.user.name,
        action: "CACHE_WARM",
        target: "omdb",
        details: { ...result, durationMs, trigger: "admin" },
      });

      return NextResponse.json(result);
    },
    busyResponse,
  );
});
