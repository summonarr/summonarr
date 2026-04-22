import { NextResponse } from "next/server";
import { requireAuth } from "@/lib/api-auth";
import { prisma } from "@/lib/prisma";
import { prewarmLibraryCache } from "@/lib/tmdb-prewarm";
import { logAudit } from "@/lib/audit";

const COOLDOWN_MS = 5 * 60 * 1000;
const COOLDOWN_KEY = "lastLibraryWarmAt";

export async function POST() {
  const session = await requireAuth({ role: "ADMIN" });
  if (session instanceof NextResponse) return session;

  const now = Date.now();

  // Atomic upsert acts as a distributed CAS: only succeeds if the cooldown window has elapsed
  const claimed = await prisma.$executeRaw`
    INSERT INTO "Setting" (key, value, "updatedAt")
    VALUES (${COOLDOWN_KEY}, ${String(now)}, NOW())
    ON CONFLICT (key) DO UPDATE
      SET value = EXCLUDED.value, "updatedAt" = NOW()
    WHERE CAST("Setting".value AS BIGINT) + ${COOLDOWN_MS}::bigint <= ${now}::bigint
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
  const result = await prewarmLibraryCache();
  const durationMs = Date.now() - startTime;

  await logAudit({
    userId: session.user.id,
    userName: session.user.name,
    action: "CACHE_WARM",
    target: "library",
    details: { ...(result as Record<string, unknown>), durationMs, trigger: "admin" },
  });

  return NextResponse.json(result);
}
