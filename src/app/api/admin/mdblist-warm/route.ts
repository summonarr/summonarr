import { NextResponse } from "next/server";
import { requireAuth } from "@/lib/api-auth";
import { prisma } from "@/lib/prisma";
import { prewarmMdblistCache } from "@/lib/mdblist-prewarm";
import { logAudit } from "@/lib/audit";

const COOLDOWN_MS = 5 * 60 * 1000;
const COOLDOWN_KEY = "lastMdblistWarmAt";

export async function POST(req: Request) {
  const session = await requireAuth({ role: "ADMIN" });
  if (session instanceof NextResponse) return session;

  let force = false;
  try {
    const body = await req.json() as { force?: boolean };
    force = body.force === true;
  } catch { }

  const row = await prisma.setting.findUnique({ where: { key: COOLDOWN_KEY } });
  const lastMs = row ? parseInt(row.value, 10) || 0 : 0;
  const now = Date.now();
  const remaining = COOLDOWN_MS - (now - lastMs);

  if (!force && remaining > 0) {
    return NextResponse.json(
      { error: `Triggered too recently — wait ${Math.ceil(remaining / 1000)}s` },
      { status: 429 }
    );
  }

  await prisma.setting.upsert({
    where: { key: COOLDOWN_KEY },
    create: { key: COOLDOWN_KEY, value: String(now) },
    update: { value: String(now) },
  });

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
}
