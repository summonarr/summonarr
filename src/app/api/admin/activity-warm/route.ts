import { NextResponse } from "next/server";
import { auth, isTokenExpired } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { warmActivityCache } from "@/lib/play-history";
import { logAudit } from "@/lib/audit";

const COOLDOWN_MS = 2 * 60 * 1000;
const COOLDOWN_KEY = "lastActivityWarmAt";

export async function POST() {
  const session = await auth();
  if (!session || isTokenExpired(session) || session.user.role !== "ADMIN") {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

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
      {
        error: `Activity cache warm triggered too recently — wait ${Math.ceil(remaining / 1000)}s`,
        retryAfter: Math.ceil(remaining / 1000),
      },
      { status: 429 }
    );
  }

  const startTime = Date.now();
  const { warmed } = await warmActivityCache();
  const durationMs = Date.now() - startTime;

  await logAudit({
    userId: session.user.id,
    userName: session.user.name,
    action: "CACHE_WARM",
    target: "activity",
    details: { warmed, durationMs, trigger: "admin" },
  });

  return NextResponse.json({
    ok: true,
    warmed,
    lastWarmAt: new Date(now).toISOString(),
  });
}
