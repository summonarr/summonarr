// The Sonarr Download webhook's APPROVED → AVAILABLE flip (guardrail 14a: it
// runs only once Sonarr reports the series COMPLETE). Id-keyed: the tmdbId
// first, then the tvdbId (Sonarr omits tmdbId on some events). It runs from two
// places — synchronously on a confirmed-complete verdict, and from the after()
// task when the verdict was unverifiable and the deferred re-check confirms —
// so it lives apart from the route.
import { prisma } from "./prisma";
import { lockArrCacheInTx } from "./arr-cache-refresh";
import { resolveSingleTvdbToTmdb } from "./arr";
import { clearDeletionVotesForTmdbs } from "./notify-available";
import { sanitizeForLog } from "./sanitize";

export interface SonarrFlipResult {
  /** Requests flipped. */
  count: number;
  /** The id the flipped requests were found by — what the notify poll then keys on. */
  effectiveTmdbId: number | null;
  effectiveTvdbId: number | null;
}

/**
 * Flip the firing instance's APPROVED requests for the series and write its
 * cache rows as available. `libraryTmdbId` is the confirming verdict's: Sonarr's
 * own tmdbId for the series. Never touches notifiedAvailable: the CAS
 * elsewhere is the sole authority (guardrail 14).
 *
 * `ids.tmdbId` must be one Sonarr CONFIRMED for this series (the verdict's
 * `tmdbIdConfirmed`): requests are found by it. A caller holding only an
 * unconfirmed payload tmdbId passes null (`confirmedFlipIds`), and the flip
 * goes by the tvdbId, exactly as for a payload that carried none.
 */
export async function flipApprovedSonarrRequests(
  ids: { tmdbId: number | null; tvdbId: number | null },
  arrInstance: string,
  libraryTmdbId: number | null,
): Promise<SonarrFlipResult> {
  if (ids.tmdbId !== null) {
    const count = await flipByTmdbId(ids.tmdbId, ids.tvdbId, arrInstance);
    if (count > 0) {
      void clearDeletionVotesForTmdbs([{ tmdbId: ids.tmdbId, mediaType: "TV" }]);
      return { count, effectiveTmdbId: ids.tmdbId, effectiveTvdbId: null };
    }
  }
  if (ids.tvdbId !== null) return flipByTvdbId(ids.tvdbId, ids.tmdbId === null, arrInstance, libraryTmdbId);
  return { count: 0, effectiveTmdbId: null, effectiveTvdbId: null };
}

async function flipByTmdbId(tmdbId: number, tvdbId: number | null, arrInstance: string): Promise<number> {
  // Advisory lock 1001,2 keeps a concurrent Sonarr sync from overwriting the
  // wanted table mid-transaction.
  return prisma.$transaction(async (tx) => {
    await lockArrCacheInTx(tx, "sonarr");
    // One UPDATE covers both a fresh approval (availableAt null) and a re-push
    // of an already-available title. Clearing pendingNotifyAt stops the
    // approve-time 90s backstop firing a false "download pending" after a
    // later revert.
    const updated = await tx.mediaRequest.updateMany({
      where: { tmdbId, mediaType: "TV", arrInstance, status: "APPROVED" },
      data: { status: "AVAILABLE", availableAt: new Date(), pendingNotifyAt: null },
    });
    await tx.sonarrWantedItem.deleteMany({ where: { tmdbId, arrInstance } });
    // Sonarr CONFIRMED the series complete (this only runs then): the available
    // cache in the same tx, matching Radarr's Download path — or browse reads
    // "not in Sonarr" until the next sync though the request is AVAILABLE.
    await tx.sonarrAvailableItem.createMany({ data: [{ tmdbId, arrInstance }], skipDuplicates: true });
    // Backfill tvdbId on the matched request(s): a later Download for the same
    // series may carry only the tvdbId, and that path finds the request by it.
    // The firing instance's rows only: a stored tvdbId is read as "this
    // instance's Sonarr tied the two ids" (the SeriesDelete check, the tvdbId
    // flip), and one instance's answer says nothing about another's library.
    if (tvdbId !== null) {
      await tx.mediaRequest.updateMany({
        where: { tmdbId, mediaType: "TV", arrInstance, tvdbId: null },
        data: { tvdbId },
      });
    }
    return updated.count;
  }, { timeout: 30_000 });
}

async function flipByTvdbId(
  tvdbId: number,
  noPayloadTmdbId: boolean,
  arrInstance: string,
  libraryTmdbId: number | null,
): Promise<SonarrFlipResult> {
  // A request on this instance storing the tvdbId: its tvdbId is written only
  // from Sonarr-sourced answers, so it ties the two ids (guardrail 14a).
  const tied = await prisma.mediaRequest.findFirst({
    where: { tvdbId, mediaType: "TV", arrInstance },
    select: { tmdbId: true },
  });
  // The tmdbId this series' cache rows are keyed on, so a tvdb-only event
  // leaves the cache exactly as a tmdb-carrying one does — whether or not a
  // request flipped. The sync writer's order: Sonarr's own tmdbId, then (here)
  // the tied request's, then the tvdb→tmdb mapping. Resolved BEFORE the
  // transaction: the mapping may call TMDB. Skipped when the tmdbId path
  // already wrote this series' rows.
  const cacheTmdbId = noPayloadTmdbId
    ? libraryTmdbId ?? tied?.tmdbId ?? await resolveSingleTvdbToTmdb(tvdbId)
    : null;
  if (noPayloadTmdbId && cacheTmdbId === null) {
    console.warn(`[webhooks/sonarr] no tmdbId for tvdbId ${sanitizeForLog(tvdbId)}; its cache rows are left to the next sync`);
  }
  const count = await prisma.$transaction(async (tx) => {
    await lockArrCacheInTx(tx, "sonarr");
    // One UPDATE covers both availableAt branches, as on the tmdbId path.
    const updated = await tx.mediaRequest.updateMany({
      where: { tvdbId, mediaType: "TV", arrInstance, status: "APPROVED" },
      data: { status: "AVAILABLE", availableAt: new Date(), pendingNotifyAt: null },
    });
    if (cacheTmdbId !== null) {
      await tx.sonarrWantedItem.deleteMany({ where: { tmdbId: cacheTmdbId, arrInstance } });
      await tx.sonarrAvailableItem.createMany({ data: [{ tmdbId: cacheTmdbId, arrInstance }], skipDuplicates: true });
    }
    return updated.count;
  }, { timeout: 30_000 });
  if (count === 0) return { count, effectiveTmdbId: null, effectiveTvdbId: null };
  if (tied) void clearDeletionVotesForTmdbs([{ tmdbId: tied.tmdbId, mediaType: "TV" }]);
  return { count, effectiveTmdbId: null, effectiveTvdbId: tvdbId };
}

/**
 * The ids a Download's flip may key on. Sonarr verified the payload's tvdbId
 * (the library row was found by it), but the payload's tmdbId only when the
 * verdict says so: a pair nothing vouched for (a library row with no tmdbId and
 * a lookup that resolved nothing) must never find requests by that tmdbId, or a
 * caller holding the secret could pair a series Sonarr really completed with
 * any other title's tmdbId (guardrail 14a).
 */
export function confirmedFlipIds(
  ids: { tmdbId: number | null; tvdbId: number | null },
  tmdbIdConfirmed: boolean,
): { tmdbId: number | null; tvdbId: number | null } {
  return tmdbIdConfirmed ? ids : { tmdbId: null, tvdbId: ids.tvdbId };
}
