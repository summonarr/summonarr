// The Radarr/Sonarr wanted/available cache refresh, shared by the orchestrator's
// two arr arms and the per-service /api/sync/{radarr,sonarr} routes, plus the
// advisory lock every writer of those tables takes (the webhooks included).
//
// One copy on purpose: the three copies this replaced had already drifted (only
// the orchestrator reported a failed NAMED instance; guardrail 36).

import { prisma } from "./prisma";
import { getRadarrWantedTmdbIds, getSonarrWantedTmdbIds } from "./arr";
import { getSyncableArrInstances } from "./arr-instance-registry";
import { DEFAULT_ARR_INSTANCE, type ArrService } from "./arr-instances";
import { settleLimit } from "./concurrency";
import { BATCH_TX_TIMEOUT, batchCreateMany } from "./cron-auth";

// The extended client's type (the encryption extension in ./prisma), not the
// generated Prisma.TransactionClient, which the interactive-tx callback param
// is not assignable to (see cron-auth.ts LibraryTxClient).
type ArrCacheTxClient = Omit<typeof prisma, "$connect" | "$disconnect" | "$on" | "$transaction" | "$use" | "$extends">;

const FETCH_CONCURRENCY = 5;

/**
 * Advisory lock 1001,1 (Radarr) / 1001,2 (Sonarr): serializes every write to
 * that service's wanted/available cache — the sync refresh, the webhooks'
 * flips and evictions — so none sees a half-rewritten cache. Two LITERAL
 * templates, never an interpolated key: a fragment or bound number in a tagged
 * $executeRaw is guardrail 23a's trap, and a bound integer can resolve to the
 * one-bigint overload, i.e. a different lock.
 */
export async function lockArrCacheInTx(tx: Pick<ArrCacheTxClient, "$executeRaw">, service: ArrService): Promise<void> {
  if (service === "radarr") {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(1001, 1)`;
  } else {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(1001, 2)`;
  }
}

export type ArrCacheRefresh = {
  /** Every configured instance this refresh attempted. */
  configuredSlugs: string[];
  /** Configured instances whose fetch failed: their rows were left untouched. */
  failedSlugs: string[];
} & (
  /** The default instance's fetch failed: nothing was written (it is authoritative). */
  | { outcome: "default-failed" }
  /** The locked rewrite threw and rolled back: nothing was written. */
  | { outcome: "write-failed"; error: unknown }
  | { outcome: "written"; syncedSlugs: string[]; wanted: number; available: number }
);

/**
 * Fetch every configured instance's wanted/available sets (bounded, guardrail
 * 31) and rewrite the cache rows of the instances that answered, in ONE
 * transaction under the service's advisory lock (guardrail 4).
 *
 * - A null fetch result is a real failure (an unconfigured instance answers
 *   empty sets), and leaves THAT instance's rows intact (guardrail 13): every
 *   delete is scoped to an instance that answered.
 * - The default instance ("") is authoritative: if it failed, nothing is
 *   written, so a transient default outage can never mass-demote AVAILABLE
 *   requests off an emptied cache.
 * - An enabled-but-unconfigured service writes nothing and still reports
 *   "written" with no synced slugs — callers key the revert/re-push gates on
 *   `syncedSlugs`, never on the outcome alone.
 */
export async function refreshArrCache(service: ArrService): Promise<ArrCacheRefresh> {
  const instances = await getSyncableArrInstances(service);
  const fetchSets = service === "radarr" ? getRadarrWantedTmdbIds : getSonarrWantedTmdbIds;
  const settled = await settleLimit(instances, FETCH_CONCURRENCY, async (inst) => ({
    slug: inst.slug,
    result: await fetchSets(inst.slug),
  }));
  const fetched = settled.map((s, i) =>
    s.status === "fulfilled" ? s.value : { slug: instances[i].slug, result: null },
  );
  const configuredSlugs = instances.map((i) => i.slug);
  const failedSlugs = fetched.filter((f) => f.result === null).map((f) => f.slug);
  if (fetched.some((f) => f.slug === DEFAULT_ARR_INSTANCE && f.result === null)) {
    return { configuredSlugs, failedSlugs, outcome: "default-failed" };
  }

  const writable = fetched.flatMap((f) => (f.result ? [{ slug: f.slug, result: f.result }] : []));
  try {
    await prisma.$transaction(async (tx) => {
      await lockArrCacheInTx(tx, service);
      // Sequential awaits only: one connection runs one query at a time (guardrail 23c).
      for (const { slug, result } of writable) {
        const wantedRows    = Array.from(result.wanted).map((tmdbId) => ({ tmdbId, arrInstance: slug }));
        const availableRows = Array.from(result.available).map((tmdbId) => ({ tmdbId, arrInstance: slug }));
        if (service === "radarr") {
          await tx.radarrWantedItem.deleteMany({ where: { arrInstance: slug } });
          if (wantedRows.length > 0) await batchCreateMany(tx.radarrWantedItem, wantedRows);
          await tx.radarrAvailableItem.deleteMany({ where: { arrInstance: slug } });
          if (availableRows.length > 0) await batchCreateMany(tx.radarrAvailableItem, availableRows);
        } else {
          await tx.sonarrWantedItem.deleteMany({ where: { arrInstance: slug } });
          if (wantedRows.length > 0) await batchCreateMany(tx.sonarrWantedItem, wantedRows);
          await tx.sonarrAvailableItem.deleteMany({ where: { arrInstance: slug } });
          if (availableRows.length > 0) await batchCreateMany(tx.sonarrAvailableItem, availableRows);
        }
      }
    }, { timeout: BATCH_TX_TIMEOUT });
  } catch (error) {
    return { configuredSlugs, failedSlugs, outcome: "write-failed", error };
  }

  return {
    configuredSlugs,
    failedSlugs,
    outcome: "written",
    syncedSlugs: writable.map((w) => w.slug),
    wanted: writable.reduce((sum, { result }) => sum + result.wanted.size, 0),
    available: writable.reduce((sum, { result }) => sum + result.available.size, 0),
  };
}
