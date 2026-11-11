import { NextRequest, NextResponse, after } from "next/server";
import { safeCompareStrings } from "@/lib/safe-compare";
import { prisma } from "@/lib/prisma";
import { CLAIMABLE_GRAB_ISSUE } from "@/lib/issue-grab";
import { scheduleLibraryScan } from "@/lib/library-scan";
import { clearDeletionVotesForTmdbs } from "@/lib/notify-available";
import { arrErrorMessage, arrFetch, getArrCfg, isMovieDownloadedInRadarr } from "@/lib/arr";
import { sanitizeForLog } from "@/lib/sanitize";
import { claimCompletedGrabs, handleArrWebhook, retryUnverifiedGrabs, type ArrWebhookContext } from "@/lib/arr-webhook";
import {
  clearManualInteractionMarkers,
  manualInteractionMarkerKey,
  notifyAvailableAfterImport,
  notifyManualInteractionOnce,
} from "@/lib/arr-webhook-events";
import { readRadarrPayload, type RadarrWebhookView } from "@/lib/arr-webhook-payload";
import { evictArrCacheRows, lockArrCacheInTx } from "@/lib/arr-cache-refresh";
import { BATCH_TX_TIMEOUT } from "@/lib/batch-write";

// Only the top level is checked before the handler (arr-webhook.ts); every
// field is read through readRadarrPayload.
type RadarrWebhookPayload = { eventType?: unknown; movie?: unknown; deleteReason?: unknown };

// What Radarr itself says about a movie a delete event names, read before the
// cache follows the event. The secret alone doesn't prove the delete happened
// (the Download path's reasoning), so the payload's tmdbId only says WHICH
// movie to ask about. `fileOnly` (MovieFileDelete) also asks whether a file is
// still there. null = can't tell: instance not configured, Radarr unreachable,
// or an answer of the wrong shape.
async function radarrDeleteState(
  tmdbId: number,
  arrInstance: string,
  fileOnly: boolean,
): Promise<"absent" | "noFile" | "present" | null> {
  const cfg = await getArrCfg("radarr", arrInstance);
  if (!cfg) return null;
  try {
    const movies = await arrFetch<unknown>(cfg, `/api/v3/movie?tmdbId=${tmdbId}`);
    if (!Array.isArray(movies)) return null;
    const movie = (movies as ({ id?: unknown; tmdbId?: unknown } | null)[]).find((m) => m?.tmdbId === tmdbId);
    if (!movie) return "absent";
    if (!fileOnly) return "present";
    const arrId = movie.id;
    if (typeof arrId !== "number" || !Number.isInteger(arrId) || arrId <= 0) return null;
    // The file rows, not the movie's hasFile: Radarr deletes the file row
    // BEFORE it sends the event, but clears the movie's file id (what hasFile
    // reads) in another handler that can run after the webhook went out.
    const files = await arrFetch<unknown>(cfg, `/api/v3/moviefile?movieId=${arrId}`);
    if (!Array.isArray(files)) return null;
    return (files as ({ movieId?: unknown } | null)[]).some((f) => f?.movieId === arrId) ? "present" : "noFile";
  } catch (err) {
    console.warn("[webhook/radarr] delete check failed:", arrErrorMessage(err));
    return null;
  }
}

export async function POST(req: NextRequest) {
  // Auth, instance, body caps, Test/Health and the replay digest (rolled back
  // only when the handler throws) are shared with the Sonarr twin (arr-webhook.ts).
  // Guardrail 2: the presented token is compared as SHA-256 digests with
  // timingSafeEqual (safeCompareStrings). Called here, in the handler, so the
  // route audit sees every webhook handler perform it.
  return handleArrWebhook<RadarrWebhookPayload>(req, "radarr", (presented, secret) => safeCompareStrings(presented, secret), handleRadarrEvent);
}

async function handleRadarrEvent({ payload, arrInstance, instances }: ArrWebhookContext<RadarrWebhookPayload>): Promise<NextResponse> {
  const event = readRadarrPayload(payload);
  // Radarr fires ManualInteractionRequired when a grabbed release can't be imported
  // automatically (mismatch, sample, etc.) and is parked in the queue. There's nothing to
  // mark available — alert admins (best-effort, once per stuck movie) so they can
  // resolve it in Radarr's queue. No usable tmdbId → fail closed (no notify).
  if (event.eventType === "ManualInteractionRequired") {
    const tmdbId = event.movie?.tmdbId ?? null;
    await notifyManualInteractionOnce({
      service: "radarr",
      arrInstance,
      instances,
      markerKey: tmdbId !== null ? manualInteractionMarkerKey("radarr", arrInstance, tmdbId) : null,
      title: event.movie?.title ?? "A movie",
    });
    return NextResponse.json({ ok: true, manualInteraction: true });
  }
  if (event.eventType === "MovieDelete" || event.eventType === "MovieFileDelete") {
    return handleMovieDelete(event, event.eventType === "MovieFileDelete", arrInstance);
  }
  if (event.eventType !== "Download" || !event.movie?.rawTmdbId) {
    return NextResponse.json({ ok: true, skipped: true });
  }
  if (event.movie.tmdbId === null) {
    console.warn("[webhook/radarr] 400 invalid tmdbId");
    // Bad payload from Radarr: a retry won't help, so the digest stays recorded.
    return NextResponse.json({ error: "Invalid tmdbId" }, { status: 400 });
  }
  return handleMovieDownload(event.movie.tmdbId, arrInstance);
}

// Radarr removed the movie (MovieDelete) or its file (MovieFileDelete): the
// wanted/available cache rows describing it are stale until the next full
// sync (up to SYNC_INTERVAL), and during that window a re-request of the
// title is swallowed as { alreadyAvailable: true } with no request row
// created. Evict the cache rows now, under the same advisory lock the sync
// writer takes. MediaRequest.status and notifiedAvailable stay untouched —
// the orchestrator's CAS remains the sole authority (guardrail 14).
//
// A file delete leaves the movie IN Radarr, without a file — exactly what the
// sync records as wanted (`!hasFile`). So it moves the row to wanted rather
// than dropping it: with neither row the synced cache says this instance
// doesn't hold the movie, and the detail page offers "Add to" and the Issues
// row loses its Manage icon until the next sync — right after an issue's
// Replace file, when the admin is following the replacement.
//
// Radarr is asked first, as on the Download path: the cache records what
// Radarr reports (gone → neither row; still there without a file → wanted),
// never what the payload claims. Anything else — the movie or its file still
// there, or no answer — leaves the cache to the next sync.
async function handleMovieDelete(event: RadarrWebhookView, fileDelete: boolean, arrInstance: string): Promise<NextResponse> {
  const delId = event.movie?.tmdbId ?? null;
  // A file deleted FOR AN UPGRADE is transient — the replacement import is
  // already underway; evicting availability would just flicker the badge.
  const isUpgrade = fileDelete && event.deleteReason === "upgrade";
  if (delId === null || isUpgrade) {
    return NextResponse.json({ ok: true, evicted: false });
  }
  const state = await radarrDeleteState(delId, arrInstance, fileDelete);
  if (state !== "absent" && !(fileDelete && state === "noFile")) {
    if (state !== null) {
      console.warn("[webhook/radarr] %s for tmdbId=%s not confirmed by Radarr; cache left to the next sync.", fileDelete ? "MovieFileDelete" : "MovieDelete", sanitizeForLog(delId));
    }
    return NextResponse.json({ ok: true, evicted: false, reason: state === null ? "unverified" : "not_deleted" });
  }
  await evictArrCacheRows("radarr", delId, arrInstance, { requeueWanted: state === "noFile" });
  return NextResponse.json({ ok: true, evicted: true });
}

async function handleMovieDownload(tmdbId: number, arrInstance: string): Promise<NextResponse> {
  // Never trust the payload's tmdbId on its own. The webhook secret authenticates
  // the request but does NOT prove the named title was actually downloaded: anyone
  // who learns the secret (or any process that can replay a captured request) could
  // POST a forged Download event for an arbitrary tmdbId and flip an APPROVED
  // request straight to AVAILABLE for a movie Radarr never grabbed. To close that,
  // verify the title against Radarr's own authoritative API before changing any
  // status. Tri-state result: `false` = Radarr is reachable and confirms there is
  // NO file, so we SKIP the flip (this is the forgery case we reject); `true` =
  // confirmed downloaded, proceed; `null` = we couldn't determine it (the firing
  // instance isn't configured, or Radarr is unreachable) so we proceed optimistically
  // and let the periodic library sync reconcile availability later. Proceeding on
  // null is safe against forgery because an attacker cannot force a null result
  // without first breaking the operator's own Radarr connectivity.
  const downloaded = await isMovieDownloadedInRadarr(tmdbId, arrInstance);
  if (downloaded === false) {
    console.warn("[webhook/radarr] Download event for tmdbId=%s not confirmed downloaded in Radarr; skipping status flip.", sanitizeForLog(tmdbId));
    return NextResponse.json({ ok: true, skipped: true, reason: "not_downloaded" });
  }

  // Advisory lock 1001,1 prevents a concurrent Radarr sync from overwriting the wanted table mid-transaction
  const marked = await prisma.$transaction(async (tx) => {
    await lockArrCacheInTx(tx, "radarr");
    // Do NOT touch notifiedAvailable here; the orchestrator's CAS (guardrail #14) is the sole authority.
    // One UPDATE covers both a fresh approval (availableAt null) and a re-push of
    // an already-available title — the two used to differ only in a
    // notifiedAvailable write that guardrail 14 removed.
    const updated = await tx.mediaRequest.updateMany({
      where: { tmdbId, mediaType: "MOVIE", arrInstance, status: "APPROVED" },
      // Clear the approve-time 90s backstop: the item is downloaded, so a stale
      // timer would fire a false "download pending" if a later sync revert flips
      // this back to APPROVED.
      data: { status: "AVAILABLE", availableAt: new Date(), pendingNotifyAt: null },
    });
    await tx.radarrWantedItem.deleteMany({ where: { tmdbId, arrInstance } });
    // Radarr CONFIRMED the file (never on the unverifiable null path — a forged
    // payload would otherwise make re-requests of the title read "already
    // available"): the movie is available on this instance now, not absent from
    // both caches until the next sync.
    if (downloaded === true) {
      await tx.radarrAvailableItem.createMany({ data: [{ tmdbId, arrInstance }], skipDuplicates: true });
    }
    return updated.count;
  }, { timeout: BATCH_TX_TIMEOUT });

  if (marked > 0) {
    void clearDeletionVotesForTmdbs([{ tmdbId, mediaType: "MOVIE" }]);
  }

  // Placed after the downloaded===false early return so a refuted forgery never
  // clears the manual-interaction marker.
  clearManualInteractionMarkers([manualInteractionMarkerKey("radarr", arrInstance, tmdbId)]);

  // arrInstance-scoped: one instance's Download must not claim (and notify off)
  // a grab that was fired at a sibling instance. A RESOLVED issue's grab is never
  // claimed: a replacement that found nothing would otherwise be announced by an
  // unrelated import months later (CLAIMABLE_GRAB_ISSUE). The claim itself (and
  // its push retry) is shared with the Sonarr twin, and it asks Radarr for a
  // file newer than the grab first — on the unverifiable verdict too, where
  // the flip above went ahead: an unanswered check claims nothing, and those
  // grabs are tried once more after the library scan.
  const candidateGrabs = await prisma.issueGrab.findMany({
    where: { tmdbId, mediaType: "MOVIE", arrInstance, issue: CLAIMABLE_GRAB_ISSUE },
  });
  const unverifiedGrabs = await claimCompletedGrabs(candidateGrabs, "radarr", { arrInstance });

  // Deferred work runs after the response is sent; library scan and notification can be slow
  after(async () => {
    await scheduleLibraryScan("movie", tmdbId, arrInstance);
    await retryUnverifiedGrabs(unverifiedGrabs, "radarr", { arrInstance });
    await notifyAvailableAfterImport({
      where: { tmdbId, mediaType: "MOVIE", arrInstance },
      kind: "movie",
      tmdbIdForCheck: tmdbId,
      logScope: "webhook/radarr",
    });
  });

  return NextResponse.json({ ok: true, marked });
}
