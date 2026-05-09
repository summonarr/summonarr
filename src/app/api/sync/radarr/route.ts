import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { getRadarrWantedTmdbIds } from "@/lib/arr";
import { BATCH_TX_TIMEOUT, batchCreateMany, isCronAuthorized } from "@/lib/cron-auth";

export async function POST(req: NextRequest) {
  if (!(await isCronAuthorized(req))) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  let wanted = 0;
  let available = 0;
  try {
    const result = await getRadarrWantedTmdbIds();
    if (result === null) {
      console.warn("[sync/radarr] skipping cache update — ARR fetch failed");
      return NextResponse.json({ skipped: true, reason: "arr-unavailable" });
    }
    const wantedRows = Array.from(result.wanted).map((tmdbId) => ({ tmdbId }));
    const availableRows = Array.from(result.available).map((tmdbId) => ({ tmdbId }));
    // Advisory lock 1001,1 coordinates with the Radarr webhook handler and sync orchestrator
    await prisma.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(1001, 1)`;
      await tx.radarrWantedItem.deleteMany();
      await tx.radarrAvailableItem.deleteMany();
      if (wantedRows.length > 0) await batchCreateMany(tx.radarrWantedItem, wantedRows);
      if (availableRows.length > 0) await batchCreateMany(tx.radarrAvailableItem, availableRows);
    }, { timeout: BATCH_TX_TIMEOUT });
    wanted = wantedRows.length;
    available = availableRows.length;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error("[sync/radarr] failed:", msg);
    return NextResponse.json({ error: "Radarr sync failed" }, { status: 502 });
  }

  return NextResponse.json({ wanted, available });
}
