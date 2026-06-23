import { NextResponse } from "next/server";
import { readJsonCappedOr } from "@/lib/body-size";
import { withAdmin } from "@/lib/api-auth";
import { prisma } from "@/lib/prisma";
import { prewarmMdblistCache } from "@/lib/mdblist-prewarm";
import { logAudit } from "@/lib/audit";

const COOLDOWN_MS = 5 * 60 * 1000;
const COOLDOWN_KEY = "lastMdblistWarmAt";

export const POST = withAdmin(async (req, _ctx, session) => {
  const body = await readJsonCappedOr<{ force?: boolean }>(req, 8192, {});
  if (body instanceof NextResponse) return body;
  const force = body.force === true;

  const now = Date.now();

  if (force) {
    // Force bypasses the cooldown — write timestamp unconditionally so the next
    // non-force click still gets a fresh 5-minute window.
    await prisma.setting.upsert({
      where: { key: COOLDOWN_KEY },
      create: { key: COOLDOWN_KEY, value: String(now) },
      update: { value: String(now) },
    });
  } else {
    // Atomic CAS: only succeeds if the cooldown window has elapsed. Matches the
    // sibling activity-warm / omdb-warm / library-warm pattern — the previous
    // check-then-update shape let two simultaneous admin clicks both pass the
    // cooldown read and double the API quota burn.
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
  }

  const startTime = Date.now();
  const result = await prewarmMdblistCache({ force });
  const durationMs = Date.now() - startTime;

  await logAudit({
    userId: session.user.id,
    userName: session.user.name,
    action: "CACHE_WARM",
    target: "mdblist",
    details: { ...result, durationMs, trigger: force ? "admin-force" : "admin" },
  });

  return NextResponse.json(result);
});
