import { NextRequest, NextResponse, after } from "next/server";
import { isTmdbIdInRange } from "@/lib/tmdb-id";
import { emitNotificationEvent } from "@/lib/notify-agents";
import { createHash, timingSafeEqual } from "node:crypto";
import { prisma } from "@/lib/prisma";
import { CLAIMABLE_GRAB_ISSUE } from "@/lib/issue-grab";
import { notifyAdminsManualInteractionRequiredPush } from "@/lib/push";
import { scheduleLibraryScan } from "@/lib/library-scan";
import { hasPlexItemByTmdbId } from "@/lib/plex";
import { getPlexConfig } from "@/lib/plex-config";
import { hasJellyfinItemByTmdbId } from "@/lib/jellyfin";
import { getJellyfinConfig } from "@/lib/jellyfin-config";
import { pollAndNotifyAvailable } from "@/lib/request-notifications";
import { clearDeletionVotesForTmdbs } from "@/lib/notify-available";
import { arrErrorMessage, arrFetch, getArrCfg, isMovieDownloadedInRadarr } from "@/lib/arr";
import { sanitizeForLog } from "@/lib/sanitize";
import { claimCompletedGrabs, handleArrWebhook, type ArrWebhookContext } from "@/lib/arr-webhook";
import { lockArrCacheInTx } from "@/lib/arr-cache-refresh";

interface RadarrWebhookPayload {
  eventType: string;
  movie?: {
    tmdbId: number;
    title: string;
  };
  // MovieFileDelete only — Radarr's DeleteMediaFileReason, camelCased by its
  // serializer ("upgrade" when the file is being replaced by a better one).
  deleteReason?: string;
}

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

// Guardrail 2: the presented token is compared as SHA-256 digests with
// timingSafeEqual. Defined here, not in the shared module, so the route audit
// sees this route perform it.
function safeCompare(a: string, b: string): boolean {
  const ha = createHash("sha256").update(a).digest();
  const hb = createHash("sha256").update(b).digest();
  return timingSafeEqual(ha, hb);
}

export async function POST(req: NextRequest) {
  // Auth, instance, body caps, Test/Health and the replay digest (rolled back
  // only when the handler throws) are shared with the Sonarr twin (arr-webhook.ts).
  return handleArrWebhook<RadarrWebhookPayload>(req, "radarr", safeCompare, handleRadarrEvent);
}

async function handleRadarrEvent({ payload, arrInstance, instances }: ArrWebhookContext<RadarrWebhookPayload>): Promise<NextResponse> {
  // Radarr fires ManualInteractionRequired when a grabbed release can't be imported
  // automatically (mismatch, sample, etc.) and is parked in the queue. There's nothing to
  // mark available — alert admins (best-effort) so they can resolve it in Radarr's queue.
  if (payload.eventType === "ManualInteractionRequired") {
    const title = payload.movie?.title ?? "A movie";
    // Don't interpolate the payload-supplied title into the log line. It's a
    // remote-controlled string, and logging it verbatim is a log-injection vector:
    // an attacker could embed newlines/control characters to forge or corrupt log
    // entries. The title still reaches admins through the structured push below,
    // which doesn't share the log's plain-text framing.
    console.warn("[webhook/radarr] manual interaction required — resolve it in Radarr's queue");
    // Per-item one-shot gate (same idempotent pattern as the deletion-vote
    // threshold in /api/votes): Radarr re-emits ManualInteractionRequired for the
    // same parked release on every queue tick (changing queue id / progress), and
    // the replay digest hashes the full payload so each one passes — push exactly
    // once per stuck item. Key on the STABLE tmdbId + service, never the volatile
    // queue id/progress. ISO value lets the marker be pruned later.
    // No usable tmdbId → fail closed (no notify). A shouldNotify=true fallback
    // re-fires on every queue tick: replay hashes the whole payload, and these
    // events change queue id/progress each time.
    const stableTmdbId = payload.movie?.tmdbId;
    let shouldNotify = false;
    if (isTmdbIdInRange(stableTmdbId as number)) {
      const manualKey = `manualInteractionNotified:radarr:${arrInstance}:${stableTmdbId}`;
      const claim = await prisma.setting.createMany({
        data: [{ key: manualKey, value: new Date().toISOString() }],
        skipDuplicates: true,
      });
      shouldNotify = claim.count === 1;
    }
    if (shouldNotify) {
      after(async () => {
        emitNotificationEvent({ event: "arr.manual_interaction", text: `Radarr: ${title}`, request: { instance: arrInstance } });
        await notifyAdminsManualInteractionRequiredPush({ service: "Radarr", title, instanceName: instances.find((i) => i.slug === arrInstance)?.name })
          .catch((err) => console.warn("[webhook/radarr] manual-interaction alert failed:", err));
        // Bound the one-shot marker table: a Setting row is inserted per distinct stuck
        // movie and never removed. The identical prune lives in the Sonarr twin, but it
        // only runs on a Sonarr fresh claim — a Radarr-only deployment (or one whose
        // Sonarr never parks an import) never fires it, so these rows grew for the life
        // of the install. Prefix-scoped, so whichever service is deployed cleans both.
        // ISO-8601 values sort lexically = chronologically; an item still stuck past the
        // 30d window simply re-notifies. Chained onto the push's task rather than a second
        // after() so a fresh claim still schedules exactly one deferred unit of work.
        await prisma.setting
          .deleteMany({
            where: {
              key: { startsWith: "manualInteractionNotified:" },
              value: { lt: new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString() },
            },
          })
          .catch((err) => console.warn("[webhook/radarr] manual-interaction marker prune failed:", err));
      });
    }
    return NextResponse.json({ ok: true, manualInteraction: true });
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
  if (payload.eventType === "MovieDelete" || payload.eventType === "MovieFileDelete") {
    const delTmdbId = payload.movie?.tmdbId;
    const fileDelete = payload.eventType === "MovieFileDelete";
    // A file deleted FOR AN UPGRADE is transient — the replacement import is
    // already underway; evicting availability would just flicker the badge.
    const isUpgrade = fileDelete && payload.deleteReason === "upgrade";
    if (!isTmdbIdInRange(delTmdbId as number) || isUpgrade) {
      return NextResponse.json({ ok: true, evicted: false });
    }
    const delId = delTmdbId as number;
    const state = await radarrDeleteState(delId, arrInstance, fileDelete);
    if (state !== "absent" && !(fileDelete && state === "noFile")) {
      if (state !== null) {
        console.warn("[webhook/radarr] %s for tmdbId=%s not confirmed by Radarr; cache left to the next sync.", fileDelete ? "MovieFileDelete" : "MovieDelete", sanitizeForLog(delId));
      }
      return NextResponse.json({ ok: true, evicted: false, reason: state === null ? "unverified" : "not_deleted" });
    }
    await prisma.$transaction(async (tx) => {
      await lockArrCacheInTx(tx, "radarr");
      if (state === "absent") {
        await tx.radarrWantedItem.deleteMany({ where: { tmdbId: delId, arrInstance } });
      }
      await tx.radarrAvailableItem.deleteMany({ where: { tmdbId: delId, arrInstance } });
      if (state === "noFile") {
        // skipDuplicates: a row already there is no error, so nothing aborts this tx (guardrail 23).
        await tx.radarrWantedItem.createMany({ data: [{ tmdbId: delId, arrInstance }], skipDuplicates: true });
      }
    }, { timeout: 30_000 });
    return NextResponse.json({ ok: true, evicted: true });
  }

  if (payload.eventType !== "Download" || !payload.movie?.tmdbId) {
    return NextResponse.json({ ok: true, skipped: true });
  }

  const { tmdbId } = payload.movie;
  if (!isTmdbIdInRange(tmdbId)) {
    console.warn("[webhook/radarr] 400 invalid tmdbId");
    // Bad payload from Radarr: a retry won't help, so the digest stays recorded.
    return NextResponse.json({ error: "Invalid tmdbId" }, { status: 400 });
  }

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
  let updated: Awaited<ReturnType<typeof prisma.mediaRequest.updateMany>> = { count: 0 };
  await prisma.$transaction(async (tx) => {
    await lockArrCacheInTx(tx, "radarr");
    // Do NOT touch notifiedAvailable here; the orchestrator's CAS (guardrail #14) is the sole authority.
    // One UPDATE covers both a fresh approval (availableAt null) and a re-push of
    // an already-available title — the two used to differ only in a
    // notifiedAvailable write that guardrail 14 removed.
    updated = await tx.mediaRequest.updateMany({
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
  }, { timeout: 30_000 });

  if (updated.count > 0) {
    void clearDeletionVotesForTmdbs([{ tmdbId, mediaType: "MOVIE" }]);
  }

  // A completed import ends the "stuck" episode the ManualInteractionRequired
  // marker one-shots — clear it so a FUTURE re-park of the same title can alert
  // again (the marker otherwise only ages out via the 30-day prune).
  // Post-commit fire-and-forget, idempotent; placed after the
  // downloaded===false early return so a refuted forgery never clears it.
  void prisma.setting.deleteMany({
    where: { key: { in: [`manualInteractionNotified:radarr:${arrInstance}:${tmdbId}`] } },
  }).catch(() => {});

  // Deferred work runs after the response is sent; library scan and notification can be slow
  after(async () => {
    await scheduleLibraryScan("movie", tmdbId, arrInstance);

    // Scope by arrInstance to the instance that fired this webhook: one instance's
    // Download must not sweep in a sibling instance's request and notify it off the
    // wrong grab.
    // `arrInstance` is selected, not taken from the handler's scope: the rows ARE
    // the instance's own (the where scopes them), and the outbound event reads
    // the slug off each winner row (guardrail 32).
    const pending = await prisma.mediaRequest.findMany({
      where: { tmdbId, mediaType: "MOVIE", arrInstance, status: "AVAILABLE", notifiedAvailable: false },
      select: { id: true, requestedBy: true, title: true, mediaType: true, posterPath: true, tmdbId: true, arrInstance: true, user: { select: { mediaServer: true } } },
    });
    if (pending.length === 0) return;

    const [plexConfig, jellyfinConfig] = await Promise.all([
      getPlexConfig(),
      getJellyfinConfig(),
    ]);

    await pollAndNotifyAvailable(
      pending,
      plexConfig.url && plexConfig.token
        ? () => hasPlexItemByTmdbId(plexConfig.url!, plexConfig.token!, tmdbId, "movie")
        : null,
      jellyfinConfig.url && jellyfinConfig.apiKey
        ? () => hasJellyfinItemByTmdbId(jellyfinConfig.url!, jellyfinConfig.apiKey!, tmdbId, "movie")
        : null,
      "webhook/radarr",
    ).catch((err) => { console.warn("[webhooks/radarr] notification failed after marking AVAILABLE:", err); });
  });

  // arrInstance-scoped: one instance's Download must not claim (and notify off)
  // a grab that was fired at a sibling instance. A RESOLVED issue's grab is never
  // claimed: a replacement that found nothing would otherwise be announced by an
  // unrelated import months later (CLAIMABLE_GRAB_ISSUE). The claim itself (and
  // its push retry) is shared with the Sonarr twin.
  const candidateGrabs = await prisma.issueGrab.findMany({
    where: { tmdbId, mediaType: "MOVIE", arrInstance, issue: CLAIMABLE_GRAB_ISSUE },
  });
  await claimCompletedGrabs(candidateGrabs, "radarr");

  return NextResponse.json({ ok: true, marked: updated.count });
}
