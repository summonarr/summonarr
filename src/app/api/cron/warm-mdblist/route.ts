import { NextRequest, NextResponse } from "next/server";
import { createHash, timingSafeEqual } from "node:crypto";
import { auth, isTokenExpired } from "@/lib/auth";
import { prewarmMdblistCache } from "@/lib/mdblist-prewarm";
import { logAudit } from "@/lib/audit";
import { withAdvisoryLock } from "@/lib/advisory-lock";
import { recordCronRun } from "@/lib/cron-auth";

function safeCompareStrings(a: string, b: string): boolean {
  const ha = createHash("sha256").update(a).digest();
  const hb = createHash("sha256").update(b).digest();
  return timingSafeEqual(ha, hb);
}

async function getAuthContext(request: NextRequest): Promise<{ userId: string; userName: string; trigger: "admin" | "cron" } | null> {
  const session = await auth();
  if (session?.user?.role === "ADMIN" && !isTokenExpired(session)) {
    return { userId: session.user.id, userName: session.user.name ?? "admin", trigger: "admin" };
  }

  const cronSecret = process.env.CRON_SECRET;
  if (cronSecret) {
    const authHeader = request.headers.get("authorization") ?? "";
    if (authHeader.startsWith("Bearer ") && safeCompareStrings(authHeader.slice(7), cronSecret)) {
      return { userId: "system", userName: "cron", trigger: "cron" };
    }
  }

  return null;
}

export async function POST(request: NextRequest) {
  const authCtx = await getAuthContext(request);
  if (!authCtx) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  return withAdvisoryLock(
    2005,
    async () => {
      const startTime = Date.now();
      const result = await prewarmMdblistCache();
      const durationMs = Date.now() - startTime;

      // `lastRunAt` observability — see warm-activity for rationale.
      await recordCronRun("mdblist", durationMs);

      if (authCtx.trigger !== "cron") {
        await logAudit({
          userId: authCtx.userId,
          userName: authCtx.userName,
          action: "CACHE_WARM",
          target: "mdblist",
          details: { ...result, durationMs, trigger: authCtx.trigger },
        });
      }

      return NextResponse.json({
        ok: true,
        ...result,
        timestamp: new Date().toISOString(),
      });
    },
    () => NextResponse.json({ skipped: true, reason: "already running" }),
  );
}
