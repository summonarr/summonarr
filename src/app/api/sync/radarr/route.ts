import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { getRadarrWantedTmdbIds } from "@/lib/arr";
import { BATCH_TX_TIMEOUT, batchCreateMany, isCronAuthorized, withCronRunRecording } from "@/lib/cron-auth";

export async function POST(req: NextRequest) {
  if (!(await isCronAuthorized(req))) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  return withCronRunRecording("radarr-sync", async () => {
    let wanted = 0;
    let available = 0;
    try {
      // 4K helper returns empty sets when unconfigured, so HD-only deployments are unaffected.
      const [result, result4k] = await Promise.all([
        getRadarrWantedTmdbIds("hd"),
        getRadarrWantedTmdbIds("4k"),
      ]);
      if (result === null) {
        console.warn("[sync/radarr] skipping cache update — ARR fetch failed");
        // 502 (not 200) so withCronRunRecording marks this run failed — the cache
        // was NOT refreshed and pending badges may be stale. Unconfigured Radarr
        // returns empty sets, so null only fires on a real fetch failure.
        return NextResponse.json({ skipped: true, reason: "arr-unavailable" }, { status: 502 });
      }
      const wantedHd    = Array.from(result.wanted).map((tmdbId) => ({ tmdbId, is4k: false }));
      const availableHd = Array.from(result.available).map((tmdbId) => ({ tmdbId, is4k: false }));
      const wanted4k    = result4k ? Array.from(result4k.wanted).map((tmdbId) => ({ tmdbId, is4k: true })) : null;
      const available4k = result4k ? Array.from(result4k.available).map((tmdbId) => ({ tmdbId, is4k: true })) : null;
      // Advisory lock 1001,1 coordinates with the Radarr webhook handler and sync orchestrator.
      // Per-variant scoped clears so a 4K fetch failure doesn't empty the HD cache.
      await prisma.$transaction(async (tx) => {
        await tx.$executeRaw`SELECT pg_advisory_xact_lock(1001, 1)`;
        await tx.radarrWantedItem.deleteMany({ where: { is4k: false } });
        await tx.radarrAvailableItem.deleteMany({ where: { is4k: false } });
        if (wantedHd.length > 0) await batchCreateMany(tx.radarrWantedItem, wantedHd);
        if (availableHd.length > 0) await batchCreateMany(tx.radarrAvailableItem, availableHd);
        if (wanted4k && available4k) {
          await tx.radarrWantedItem.deleteMany({ where: { is4k: true } });
          await tx.radarrAvailableItem.deleteMany({ where: { is4k: true } });
          if (wanted4k.length > 0) await batchCreateMany(tx.radarrWantedItem, wanted4k);
          if (available4k.length > 0) await batchCreateMany(tx.radarrAvailableItem, available4k);
        }
      }, { timeout: BATCH_TX_TIMEOUT });
      wanted = wantedHd.length + (wanted4k?.length ?? 0);
      available = availableHd.length + (available4k?.length ?? 0);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error("[sync/radarr] failed:", msg);
      return NextResponse.json({ error: "Radarr sync failed" }, { status: 502 });
    }

    return NextResponse.json({ wanted, available });
  });
}
