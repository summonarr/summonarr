import { NextRequest, NextResponse } from "next/server";
import { createHash, timingSafeEqual } from "node:crypto";
import { auth, isTokenExpired } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { getSonarrWantedTmdbIds } from "@/lib/arr";
import { BATCH_TX_TIMEOUT } from "@/lib/cron-auth";

function safeCompareStrings(a: string, b: string): boolean {
  const ha = createHash("sha256").update(a).digest();
  const hb = createHash("sha256").update(b).digest();
  return timingSafeEqual(ha, hb);
}

async function isAuthorized(request: NextRequest): Promise<boolean> {
  const session = await auth();
  if (session?.user?.role === "ADMIN" && !isTokenExpired(session)) return true;

  const cronSecret = process.env.CRON_SECRET;
  if (cronSecret) {
    const authHeader = request.headers.get("authorization") ?? "";
    if (authHeader.startsWith("Bearer ") && safeCompareStrings(authHeader.slice(7), cronSecret)) return true;
  }

  return false;
}

export async function POST(request: NextRequest) {
  if (!(await isAuthorized(request))) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  let wanted = 0;
  let available = 0;
  try {
    const result = await getSonarrWantedTmdbIds();
    if (result === null) {
      console.warn("[sync/sonarr] skipping cache update — ARR fetch failed");
      return NextResponse.json({ skipped: true, reason: "arr-unavailable" });
    }
    const wantedRows = Array.from(result.wanted).map((tmdbId) => ({ tmdbId }));
    const availableRows = Array.from(result.available).map((tmdbId) => ({ tmdbId }));
    // Advisory lock 1001,2 coordinates with the Sonarr webhook handler and sync orchestrator
    await prisma.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(1001, 2)`;
      await tx.sonarrWantedItem.deleteMany();
      await tx.sonarrAvailableItem.deleteMany();
      if (wantedRows.length > 0) await tx.sonarrWantedItem.createMany({ data: wantedRows });
      if (availableRows.length > 0) await tx.sonarrAvailableItem.createMany({ data: availableRows });
    }, { timeout: BATCH_TX_TIMEOUT });
    wanted = wantedRows.length;
    available = availableRows.length;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error("[sync/sonarr] failed:", msg);
    return NextResponse.json({ error: "Sonarr sync failed" }, { status: 502 });
  }

  return NextResponse.json({ wanted, available });
}
