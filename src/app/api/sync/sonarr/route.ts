import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { getSonarrWantedTmdbIds } from "@/lib/arr";
import { getSyncableArrInstances } from "@/lib/arr-instance-registry";
import { DEFAULT_ARR_INSTANCE } from "@/lib/arr-instances";
import { settleLimit } from "@/lib/concurrency";
import { BATCH_TX_TIMEOUT, batchCreateMany, isCronAuthorized, withCronRunRecording } from "@/lib/cron-auth";

const FETCH_CONCURRENCY = 5;

export async function POST(req: NextRequest) {
  if (!(await isCronAuthorized(req))) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  return withCronRunRecording("sonarr-sync", async () => {
    let wanted = 0;
    let available = 0;
    try {
      // Fan out over every configured Sonarr instance; same contract as the Radarr resync.
      const instances = await getSyncableArrInstances("sonarr");
      const settled = await settleLimit(instances, FETCH_CONCURRENCY, async (inst) => ({
        slug: inst.slug,
        result: await getSonarrWantedTmdbIds(inst.slug),
      }));
      const fetched = settled.map((s, i) =>
        s.status === "fulfilled" ? s.value : { slug: instances[i].slug, result: null },
      );
      // The default instance ("") is authoritative: if its fetch failed, skip the whole run.
      if (fetched.some((f) => f.slug === DEFAULT_ARR_INSTANCE && f.result === null)) {
        console.warn("[sync/sonarr] skipping cache update — ARR fetch failed");
        // 502 (not 200) so withCronRunRecording marks this run failed — the cache
        // was NOT refreshed and pending badges may be stale. Unconfigured Sonarr
        // returns empty sets, so null only fires on a real fetch failure.
        return NextResponse.json({ skipped: true, reason: "arr-unavailable" }, { status: 502 });
      }
      // Only instances whose fetch succeeded get scoped-cleared + rewritten; a null result
      // leaves THAT instance's rows intact (G13) so one failure never empties another's cache.
      const writable = fetched.flatMap((f) => (f.result ? [{ slug: f.slug, result: f.result }] : []));
      // Advisory lock 1001,2 coordinates with the Sonarr webhook handler and sync orchestrator.
      // Per-instance scoped clears so one instance's fetch failure doesn't empty another's cache.
      await prisma.$transaction(async (tx) => {
        await tx.$executeRaw`SELECT pg_advisory_xact_lock(1001, 2)`;
        for (const { slug, result } of writable) {
          const wantedRows    = Array.from(result.wanted).map((tmdbId) => ({ tmdbId, arrInstance: slug }));
          const availableRows = Array.from(result.available).map((tmdbId) => ({ tmdbId, arrInstance: slug }));
          await tx.sonarrWantedItem.deleteMany({ where: { arrInstance: slug } });
          await tx.sonarrAvailableItem.deleteMany({ where: { arrInstance: slug } });
          if (wantedRows.length > 0) await batchCreateMany(tx.sonarrWantedItem, wantedRows);
          if (availableRows.length > 0) await batchCreateMany(tx.sonarrAvailableItem, availableRows);
        }
      }, { timeout: BATCH_TX_TIMEOUT });
      wanted    = writable.reduce((sum, { result }) => sum + result.wanted.size, 0);
      available = writable.reduce((sum, { result }) => sum + result.available.size, 0);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error("[sync/sonarr] failed:", msg);
      return NextResponse.json({ error: "Sonarr sync failed" }, { status: 502 });
    }

    return NextResponse.json({ wanted, available });
  });
}
