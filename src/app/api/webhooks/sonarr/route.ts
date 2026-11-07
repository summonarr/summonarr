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
import { sanitizeForLog } from "@/lib/sanitize";
import { isSeriesDownloadedInSonarr, resolveSingleTvdbToTmdb } from "@/lib/arr";
import { claimCompletedGrabs, handleArrWebhook, type ArrWebhookContext } from "@/lib/arr-webhook";
import { lockArrCacheInTx } from "@/lib/arr-cache-refresh";

interface SonarrWebhookPayload {
  eventType: string;
  series?: {
    tvdbId: number;
    tmdbId?: number;
    title: string;
  };
  episodes?: unknown;
}

type SonarrEpisodeRef = { seasonNumber?: unknown; episodeNumber?: unknown };

// The ManualInteractionRequired one-shot marker. The `manualInteractionNotified:`
// prefix is what the 30-day prune (both webhooks) matches; markers written
// before the id type was tagged simply age out through it.
type SeriesMarkerId = `tvdb:${number}` | `tmdb:${number}`;
function manualMarkerKey(arrInstance: string, seriesId: SeriesMarkerId): string {
  return `manualInteractionNotified:sonarr:${arrInstance}:${seriesId}`;
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
  // only when the handler throws) are shared with the Radarr twin (arr-webhook.ts).
  return handleArrWebhook<SonarrWebhookPayload>(req, "sonarr", safeCompare, handleSonarrEvent);
}

async function handleSonarrEvent({ payload, arrInstance, instances }: ArrWebhookContext<SonarrWebhookPayload>): Promise<NextResponse> {
  // Only the top level is shape-checked before this point, and the payload is
  // attacker-shaped (secret-only auth): `episodes: [null]` or a non-array would
  // throw below — a 500 that rolls the replay digest back. A derived copy, never
  // a rewrite of `payload`: the digest is recorded (and cleared) over that object.
  const episodes = Array.isArray(payload.episodes)
    ? payload.episodes.filter((e): e is SonarrEpisodeRef => e !== null && typeof e === "object")
    : [];

  // Sonarr fires ManualInteractionRequired when a grabbed release can't be imported
  // automatically and is parked in the queue. There's nothing to mark available — alert admins
  // (best-effort) so they can resolve it in Sonarr's queue.
  if (payload.eventType === "ManualInteractionRequired") {
    const seriesTitle = payload.series?.title ?? "A series";
    const eps = episodes;
    let scope = "";
    if (eps.length === 1 && eps[0].seasonNumber != null && eps[0].episodeNumber != null) {
      scope = ` S${String(eps[0].seasonNumber).padStart(2, "0")}E${String(eps[0].episodeNumber).padStart(2, "0")}`;
    } else if (eps.length > 1) {
      scope = ` (${eps.length} episodes)`;
    }
    const title = `${seriesTitle}${scope}`;
    // Don't interpolate the payload-supplied series title into the log line. It's a
    // remote-controlled string, and logging it verbatim is a log-injection vector:
    // an attacker could embed newlines/control characters to forge or corrupt log
    // entries. The title still reaches admins through the structured push below,
    // which doesn't share the log's plain-text framing.
    console.warn("[webhook/sonarr] manual interaction required — resolve it in Sonarr's queue");
    // Per-item one-shot gate (same idempotent pattern as the deletion-vote
    // threshold in /api/votes): Sonarr re-emits ManualInteractionRequired for the
    // same parked release on every queue tick (changing queue id / progress), and
    // the replay digest hashes the full payload so each one passes — push exactly
    // once per stuck series. Key on the STABLE series id (tvdbId, falling back to
    // tmdbId) + service, never the volatile queue id/progress. ISO value lets the
    // marker be pruned later. The id TYPE is in the key: the two id spaces
    // overlap, so an untagged key let one series' tmdbId clear (or suppress)
    // another series' tvdbId-keyed marker.
    // No usable tvdbId/tmdbId → fail closed (no notify). A shouldNotify=true
    // fallback re-fires on every queue tick: replay hashes the whole payload,
    // and these events change queue id/progress each time.
    const stableSeriesId: SeriesMarkerId | null =
      Number.isInteger(payload.series?.tvdbId) && (payload.series!.tvdbId as number) > 0
        ? `tvdb:${payload.series!.tvdbId}`
        : Number.isInteger(payload.series?.tmdbId) && (payload.series!.tmdbId as number) > 0
        ? `tmdb:${payload.series!.tmdbId as number}`
        : null;
    let shouldNotify = false;
    if (stableSeriesId !== null) {
      const manualKey = manualMarkerKey(arrInstance, stableSeriesId);
      const claim = await prisma.setting.createMany({
        data: [{ key: manualKey, value: new Date().toISOString() }],
        skipDuplicates: true,
      });
      shouldNotify = claim.count === 1;
    }
    if (shouldNotify) {
      after(() => {
        emitNotificationEvent({ event: "arr.manual_interaction", text: `Sonarr: ${title}`, request: { instance: arrInstance } });
        return notifyAdminsManualInteractionRequiredPush({ service: "Sonarr", title, instanceName: instances.find((i) => i.slug === arrInstance)?.name })
          .catch((err) => console.warn("[webhook/sonarr] manual-interaction alert failed:", err));
      });
      // Bound the one-shot marker table: a Setting row is inserted per distinct
      // stuck series and never removed. Prune markers older than 30 days — ISO-8601
      // values sort lexically = chronologically. A series still stuck past the
      // window simply re-notifies, which is acceptable. Runs only on a fresh claim
      // (when the table actually grew), so it stays naturally infrequent.
      after(() =>
        prisma.setting
          .deleteMany({
            where: {
              key: { startsWith: "manualInteractionNotified:" },
              value: { lt: new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString() },
            },
          })
          .catch((err) => console.warn("[webhook/sonarr] manual-interaction marker prune failed:", err)),
      );
    }
    return NextResponse.json({ ok: true, manualInteraction: true });
  }

  // Sonarr removed the series entirely: evict its wanted/available cache rows
  // now instead of leaving them stale until the next full sync (up to
  // SYNC_INTERVAL), during which a re-request was swallowed as
  // { alreadyAvailable: true } with no request row. EpisodeFileDelete is left
  // to the periodic sync — per-episode granularity doesn't map onto the
  // series-level cache rows. MediaRequest.status and notifiedAvailable stay
  // untouched (the orchestrator's CAS is the sole authority — guardrail 14).
  //
  // Sonarr is asked first, as on the Download path: the rows go only when
  // Sonarr reports the series ABSENT from its library. Still there, or no
  // answer, leaves the cache to the next sync. The check must cover the
  // tmdbId being evicted. The payload tvdbId (Sonarr's own key, a cheap
  // filtered read) covers it only when SONARR-sourced data ties the two: a
  // request on this instance storing both ids (its tvdbId is written only
  // from Sonarr's own answers). Never the tvdb→tmdb cache or TMDB's
  // cross-reference — user-edited data, so a forged pair (an absent tvdbId
  // beside a held tmdbId) could be made to look tied (guardrail 14a).
  // Otherwise the tmdbId is checked through Sonarr's tmdb lookup, which lags
  // new shows and can land on another series, so a "still there" from it is
  // no evidence of forgery and is not logged.
  if (payload.eventType === "SeriesDelete" && payload.series) {
    const rawTvdb = payload.series.tvdbId;
    const rawTmdb = payload.series.tmdbId;
    const delTvdbId = Number.isInteger(rawTvdb) && rawTvdb > 0 ? rawTvdb : null;
    const payloadTmdbId = typeof rawTmdb === "number" && isTmdbIdInRange(rawTmdb) ? rawTmdb : null;
    // With no payload tmdbId the mapping only NAMES the candidate; it is
    // confirmed like any other below.
    const delTmdbId = payloadTmdbId ?? (delTvdbId !== null ? await resolveSingleTvdbToTmdb(delTvdbId) : null);
    if (delTmdbId === null) {
      return NextResponse.json({ ok: true, evicted: false });
    }
    const byTvdb = delTvdbId !== null && (await prisma.mediaRequest.findFirst({
      where: { tmdbId: delTmdbId, mediaType: "TV", arrInstance, tvdbId: delTvdbId },
      select: { id: true },
    })) !== null;
    const verdict = await isSeriesDownloadedInSonarr(
      byTvdb ? { tvdbId: delTvdbId } : { tmdbId: delTmdbId },
      arrInstance,
    );
    if (verdict === null || verdict.downloaded || verdict.reason !== "absent") {
      if (verdict !== null && byTvdb) {
        console.warn("[webhook/sonarr] SeriesDelete for tmdbId=%s not confirmed by Sonarr; cache left to the next sync.", sanitizeForLog(delTmdbId));
      }
      const reason = verdict === null ? "unverified" : byTvdb ? "not_deleted" : "unconfirmed";
      return NextResponse.json({ ok: true, evicted: false, reason });
    }
    const evictTmdbId = delTmdbId;
    await prisma.$transaction(async (tx) => {
      await lockArrCacheInTx(tx, "sonarr");
      await tx.sonarrWantedItem.deleteMany({ where: { tmdbId: evictTmdbId, arrInstance } });
      await tx.sonarrAvailableItem.deleteMany({ where: { tmdbId: evictTmdbId, arrInstance } });
    }, { timeout: 30_000 });
    return NextResponse.json({ ok: true, evicted: true });
  }

  if (payload.eventType !== "Download" || !payload.series) {
    return NextResponse.json({ ok: true, skipped: true });
  }

  const { tvdbId, tmdbId } = payload.series;

  const safeVdbId = Number.isInteger(tvdbId) && tvdbId > 0 ? tvdbId : null;
  const safeMdbId = typeof tmdbId === "number" && isTmdbIdInRange(tmdbId) ? tmdbId : null;

  // Never trust the payload's ids on their own. The webhook secret authenticates
  // the request but does NOT prove the named series was actually downloaded: anyone
  // who learns the secret (or replays a captured request) could POST a forged
  // Download event for arbitrary tvdbId/tmdbId and flip an APPROVED request straight
  // to AVAILABLE for a series Sonarr never grabbed. Verify against Sonarr's own
  // authoritative API before changing any status.
  //
  // The verdict decides more than forgery now (guardrail 14a): a TV request is
  // "ready" only once Sonarr reports the series COMPLETE — every aired,
  // monitored, regular-season episode on disk, specials excluded — and Sonarr
  // fires one Download event per EPISODE, so most deliveries of a season-pack
  // import arrive while the series is still incomplete.
  //   • downloaded        → confirmed complete: flip + notify now.
  //   • "incomplete"      → the normal mid-import state. Skip the flip, but STILL
  //                         schedule the library scan so Plex/Jellyfin pick up the
  //                         new episodes; a later event (or the periodic sync's
  //                         wanted/available refresh) flips it once complete.
  //   • "absent"/"ids-disagree" → the forgery shapes the guard exists to refuse.
  //   • null              → unverifiable (instance unconfigured, or Sonarr
  //                         unreachable — it 503s under import load). This used
  //                         to flip OPTIMISTICALLY, which under a per-episode
  //                         event stream means a 503 on episode 1 of 24 announced
  //                         the whole series as ready. Now it DEFERS: the after()
  //                         task re-verifies once the library scan has settled
  //                         (that wait already spans Sonarr's queue draining) and
  //                         flips then; failing that, the periodic sync — whose
  //                         wanted/available refresh reads the same statistics —
  //                         reconciles. Nothing here ever needs the optimistic
  //                         path: an attacker still cannot induce null without
  //                         breaking the operator's own Sonarr connectivity, and
  //                         a null now produces no REQUEST transition here.
  //                         The issue-grab claim below still runs on null
  //                         (only the refused shapes return first), so it can
  //                         auto-resolve an issue: that asks whether the
  //                         grabbed release was imported, not whether the
  //                         series is complete.
  const verdict = await isSeriesDownloadedInSonarr(
    { tvdbId: safeVdbId, tmdbId: safeMdbId },
    arrInstance,
  );
  if (verdict !== null && !verdict.downloaded && verdict.reason !== "incomplete") {
    console.warn("[webhook/sonarr] Download event for tvdbId=%s tmdbId=%s not confirmed downloaded in Sonarr (%s); skipping status flip.", sanitizeForLog(safeVdbId ?? "?"), sanitizeForLog(safeMdbId ?? "?"), verdict.reason);
    return NextResponse.json({ ok: true, skipped: true, reason: "not_downloaded" });
  }
  const seriesComplete = verdict?.downloaded === true;
  const deferVerify = verdict === null;

  type FlipResult = { count: number; effectiveMdbId: number | null; effectiveVdbId: number | null };
  // The APPROVED→AVAILABLE flip, id-keyed: tmdbId first, then the tvdbId fallback
  // (Sonarr omits tmdbId on some events). Factored out because it runs from two
  // places — synchronously on a confirmed-complete verdict, and from the after()
  // task when the verdict was unverifiable and the deferred re-check confirms.
  // `libraryTmdbId` is the confirming verdict's: Sonarr's own tmdbId for the series.
  const flipApprovedRequests = async (libraryTmdbId: number | null): Promise<FlipResult> => {
    let updated: Awaited<ReturnType<typeof prisma.mediaRequest.updateMany>> = { count: 0 };
    let effectiveMdbId: number | null = null;
    let effectiveVdbId: number | null = null;

    if (safeMdbId) {
      // Advisory lock 1001,2 prevents a concurrent Sonarr sync from overwriting the wanted table mid-transaction
      await prisma.$transaction(async (tx) => {
        await lockArrCacheInTx(tx, "sonarr");
        // Do NOT touch notifiedAvailable here; the orchestrator's CAS (guardrail #14) is the sole authority.
        // One UPDATE covers both a fresh approval (availableAt null) and a re-push
        // of an already-available title — the two used to differ only in a
        // notifiedAvailable write that guardrail 14 removed.
        updated = await tx.mediaRequest.updateMany({
          where: { tmdbId: safeMdbId, mediaType: "TV", arrInstance, status: "APPROVED" },
          // Clear the approve-time 90s backstop so a stale timer can't fire a
          // false "download pending" after a later revert.
          data: { status: "AVAILABLE", availableAt: new Date(), pendingNotifyAt: null },
        });
        await tx.sonarrWantedItem.deleteMany({ where: { tmdbId: safeMdbId, arrInstance } });
        // Sonarr CONFIRMED the series is complete (flipApprovedRequests only
        // runs then): write the available cache in the same tx, matching Radarr's
        // Download path. Without this, browse/arrHasInstance read "not in Sonarr"
        // until the next sync even though the request is already AVAILABLE.
        await tx.sonarrAvailableItem.createMany({ data: [{ tmdbId: safeMdbId, arrInstance }], skipDuplicates: true });
        // Backfill tvdbId on the matched request(s). A later Download webhook for the same
        // series may arrive with only tvdbId (Sonarr omits tmdbId on some events); without
        // this, that tvdbId-only path can't find the request to evict its wanted-cache row.
        if (safeVdbId) {
          await tx.mediaRequest.updateMany({
            where: { tmdbId: safeMdbId, mediaType: "TV", tvdbId: null },
            data: { tvdbId: safeVdbId },
          });
        }
      }, { timeout: 30_000 });
      if (updated.count > 0) {
        effectiveMdbId = safeMdbId;
        void clearDeletionVotesForTmdbs([{ tmdbId: safeMdbId, mediaType: "TV" }]);
      }
    }

    if (updated.count === 0 && safeVdbId) {
      // A request on this instance storing the tvdbId: its tvdbId is written only
      // from Sonarr-sourced answers, so it ties the two ids (guardrail 14a).
      const tied = await prisma.mediaRequest.findFirst({
        where: { tvdbId: safeVdbId, mediaType: "TV", arrInstance },
        select: { tmdbId: true },
      });
      // The tmdbId this series' cache rows are keyed on, so a tvdb-only event
      // leaves the cache exactly as a tmdb-carrying one does — whether or not a
      // request flipped. The sync writer's order: Sonarr's own tmdbId, then
      // (here) the tied request's, then the tvdb→tmdb mapping. Resolved BEFORE
      // the transaction: the mapping may call TMDB. Skipped when the tmdbId
      // path above already wrote this series' rows.
      const cacheTmdbId = safeMdbId !== null
        ? null
        : libraryTmdbId ?? tied?.tmdbId ?? await resolveSingleTvdbToTmdb(safeVdbId);
      if (safeMdbId === null && cacheTmdbId === null) {
        console.warn(`[webhooks/sonarr] no tmdbId for tvdbId ${sanitizeForLog(safeVdbId)}; its cache rows are left to the next sync`);
      }
      await prisma.$transaction(async (tx) => {
        await lockArrCacheInTx(tx, "sonarr");
        // Do NOT touch notifiedAvailable here (guardrail #14); one UPDATE covers
        // both availableAt branches, same as the tmdbId path above.
        updated = await tx.mediaRequest.updateMany({
          where: { tvdbId: safeVdbId!, mediaType: "TV", arrInstance, status: "APPROVED" },
          // Clear the approve-time 90s backstop so a stale timer can't fire a
          // false "download pending" after a later revert.
          data: { status: "AVAILABLE", availableAt: new Date(), pendingNotifyAt: null },
        });
        if (cacheTmdbId !== null) {
          await tx.sonarrWantedItem.deleteMany({ where: { tmdbId: cacheTmdbId, arrInstance } });
          await tx.sonarrAvailableItem.createMany({ data: [{ tmdbId: cacheTmdbId, arrInstance }], skipDuplicates: true });
        }
      }, { timeout: 30_000 });
      if (updated.count > 0) {
        effectiveVdbId = safeVdbId;
        if (tied) void clearDeletionVotesForTmdbs([{ tmdbId: tied.tmdbId, mediaType: "TV" }]);
      }
    }
    return { count: updated.count, effectiveMdbId, effectiveVdbId };
  };

  const flip: FlipResult = verdict?.downloaded === true
    ? await flipApprovedRequests(verdict.tmdbId)
    : { count: 0, effectiveMdbId: null, effectiveVdbId: null };

  // A completed import ends the "stuck" episode the ManualInteractionRequired
  // marker one-shots — clear it so a future re-park of the same series can
  // alert again. The marker's stable key prefers tvdbId and falls back to
  // tmdbId, so clear both candidates. Post-commit fire-and-forget, idempotent;
  // the not-confirmed/skipped paths return before reaching here. An INCOMPLETE
  // series still imported an episode, so the marker clears on that path too.
  const manualMarkerKeys = [
    ...(safeVdbId !== null ? [manualMarkerKey(arrInstance, `tvdb:${safeVdbId}`)] : []),
    ...(safeMdbId !== null ? [manualMarkerKey(arrInstance, `tmdb:${safeMdbId}`)] : []),
  ];
  if (manualMarkerKeys.length > 0) {
    void prisma.setting.deleteMany({ where: { key: { in: manualMarkerKeys } } }).catch(() => {});
  }

  // Deferred work runs after the response is sent; library scan and notification can be slow
  after(async () => {
    // Scheduled on every confirmed, incomplete, or unverifiable import — an
    // episode landed either way, and the library should show it even while
    // the request stays APPROVED waiting for the rest of the series.
    await scheduleLibraryScan("tv", safeMdbId ?? undefined, arrInstance);

    let { effectiveMdbId, effectiveVdbId } = flip;
    if (deferVerify) {
      // The scan above already waited for Sonarr's queue to drain (or gave up
      // after its retries), so a transient 503 has had a real window to clear.
      // One re-check; still not confirmed complete → leave it to the periodic
      // sync rather than retrying here indefinitely.
      let late: FlipResult | null = null;
      try {
        const recheck = await isSeriesDownloadedInSonarr({ tvdbId: safeVdbId, tmdbId: safeMdbId }, arrInstance);
        if (recheck?.downloaded !== true) return;
        late = await flipApprovedRequests(recheck.tmdbId);
      } catch (err) {
        console.warn("[webhooks/sonarr] deferred verification failed:", err instanceof Error ? err.message : err);
        return;
      }
      effectiveMdbId = late.effectiveMdbId;
      effectiveVdbId = late.effectiveVdbId;
    }

    // Scope by arrInstance to the instance that fired this webhook: one instance's
    // Download must not sweep in a sibling instance's request and notify it off the
    // wrong grab.
    const whereNotify = effectiveMdbId
      ? { tmdbId: effectiveMdbId, mediaType: "TV" as const, arrInstance, status: "AVAILABLE" as const, notifiedAvailable: false }
      : effectiveVdbId
      ? { tvdbId: effectiveVdbId, mediaType: "TV" as const, arrInstance, status: "AVAILABLE" as const, notifiedAvailable: false }
      : null;
    if (!whereNotify) return;

    // `arrInstance` is selected so the outbound `request.available` event names
    // the firing instance off each winner row (guardrail 32).
    const pending = await prisma.mediaRequest.findMany({
      where: whereNotify,
      select: { id: true, tmdbId: true, requestedBy: true, title: true, mediaType: true, posterPath: true, arrInstance: true, user: { select: { mediaServer: true } } },
    });
    if (pending.length === 0) return;

    const tmdbIdForCheck = effectiveMdbId ?? pending[0].tmdbId;
    if (!tmdbIdForCheck) return;

    const [plexConfig, jellyfinConfig] = await Promise.all([
      getPlexConfig(),
      getJellyfinConfig(),
    ]);

    await pollAndNotifyAvailable(
      pending,
      plexConfig.url && plexConfig.token
        ? () => hasPlexItemByTmdbId(plexConfig.url!, plexConfig.token!, tmdbIdForCheck, "tv")
        : null,
      jellyfinConfig.url && jellyfinConfig.apiKey
        ? () => hasJellyfinItemByTmdbId(jellyfinConfig.url!, jellyfinConfig.apiKey!, tmdbIdForCheck, "tv")
        : null,
      "webhook/sonarr",
    ).catch((err) => { console.warn("[webhooks/sonarr] notification failed after marking AVAILABLE:", err); });
  });

  // arrInstance-scoped: one instance's Download must not claim (and notify off)
  // a grab that was fired at a sibling instance.
  // Match on EITHER id the payload carries, not tmdbId-first: a grab is recorded with
  // the issue's tmdbId (+ tvdbId when known), and Sonarr's Download payload can carry
  // a stale/mismapped tmdbId alongside the correct tvdbId — exactly the case the
  // request flip above falls back to. A tmdbId-only lookup then misses the grab, and
  // since notifiedAt is written nowhere else the completion push is lost permanently.
  const grabIdFilters = [
    ...(safeMdbId ? [{ tmdbId: safeMdbId }] : []),
    ...(safeVdbId ? [{ tvdbId: safeVdbId }] : []),
  ];
  // A RESOLVED issue's grab is never claimed (CLAIMABLE_GRAB_ISSUE — the Radarr twin).
  const grabWhere = grabIdFilters.length > 0
    ? { OR: grabIdFilters, mediaType: "TV" as const, arrInstance, issue: CLAIMABLE_GRAB_ISSUE }
    : null;
  if (grabWhere) {
    const candidateGrabs = await prisma.issueGrab.findMany({ where: grabWhere });
    // Scope the claim to WHAT this event delivered, BEFORE the CAS. Sonarr fires
    // one Download per EPISODE (guardrail 14a), and the id-keyed WHERE above
    // matches every pending grab for the series — so without this, tonight's
    // S03E02 import claimed an EPISODE grab fired for S01E05 (or a SEASON grab
    // for S01): the admin was pushed "grab completed" for a file that had not
    // landed, and when it finally did there was no notification left to send
    // (notifiedAt is the emit claim and is never reset; a failed push retries
    // via a grabPushRetry Setting). EPISODE needs a delivered
    // episode matching season AND episode; SEASON needs a matching season; FULL
    // matches any delivery. A grab with no season/episode to match on (not a
    // shape the releases route writes) keeps the old any-delivery behaviour
    // rather than being stranded. The Radarr twin needs none of this — one
    // file per movie.
    const delivered = episodes.filter(
      (e): e is { seasonNumber: number; episodeNumber?: unknown } => Number.isInteger(e.seasonNumber),
    );
    const matchesDelivery = (grab: { scope: string; seasonNumber: number | null; episodeNumber: number | null }): boolean => {
      if (grab.scope === "EPISODE" && grab.seasonNumber != null && grab.episodeNumber != null) {
        return delivered.some((e) => e.seasonNumber === grab.seasonNumber && e.episodeNumber === grab.episodeNumber);
      }
      if (grab.scope === "SEASON" && grab.seasonNumber != null) {
        return delivered.some((e) => e.seasonNumber === grab.seasonNumber);
      }
      return true;
    };
    // The claim itself (and its push retry) is shared with the Radarr twin.
    await claimCompletedGrabs(candidateGrabs.filter(matchesDelivery), "sonarr");
  }

  if (seriesComplete) return NextResponse.json({ ok: true, marked: flip.count });
  if (deferVerify) return NextResponse.json({ ok: true, deferred: true, reason: "unverified" });
  // Incomplete: no transition, and deliberately no log line — this is the
  // expected state of every episode but the last of an import, and per-event
  // warnings here only bury the anomalies (guardrail 7). The counts travel in
  // the response and in GET /api/admin/debug/arr-state for anyone asking why a
  // request has not flipped.
  const incomplete = verdict as Extract<NonNullable<typeof verdict>, { reason: "incomplete" }>;
  return NextResponse.json({
    ok: true,
    skipped: true,
    reason: "incomplete",
    episodeFileCount: incomplete.episodeFileCount,
    episodeCount: incomplete.episodeCount,
  });
}
