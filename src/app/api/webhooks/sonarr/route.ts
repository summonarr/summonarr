import { NextRequest, NextResponse, after } from "next/server";
import { safeCompareStrings } from "@/lib/safe-compare";
import { prisma } from "@/lib/prisma";
import type { IssueGrab } from "@/generated/prisma";
import { CLAIMABLE_GRAB_ISSUE } from "@/lib/issue-grab";
import { scheduleLibraryScan } from "@/lib/library-scan";
import { sanitizeForLog } from "@/lib/sanitize";
import { isSeriesDownloadedInSonarr, resolveSingleTvdbToTmdb, type SeriesDownloadVerdict } from "@/lib/arr";
import { claimCompletedGrabs, handleArrWebhook, retryUnverifiedGrabs, type ArrWebhookContext } from "@/lib/arr-webhook";
import {
  clearManualInteractionMarkers,
  manualInteractionMarkerKey,
  notifyAvailableAfterImport,
  notifyManualInteractionOnce,
} from "@/lib/arr-webhook-events";
import { grabMatchesDelivery, readSonarrPayload, sonarrEpisodeScope, type SonarrWebhookView } from "@/lib/arr-webhook-payload";
import { confirmedFlipIds, flipApprovedSonarrRequests, type SonarrFlipResult } from "@/lib/sonarr-webhook-flip";
import { evictArrCacheRows } from "@/lib/arr-cache-refresh";

// Only the top level is checked before the handler (arr-webhook.ts); every
// field is read through readSonarrPayload.
type SonarrWebhookPayload = { eventType?: unknown; series?: unknown; episodes?: unknown };

// A series' manual-interaction marker id, with the id TYPE in it: the two id
// spaces overlap, so an untagged key let one series' tmdbId clear (or suppress)
// another series' tvdbId-keyed marker. Markers written before the type was
// tagged simply age out through the prune.
type SeriesMarkerId = `tvdb:${number}` | `tmdb:${number}`;
const markerKey = (arrInstance: string, id: SeriesMarkerId) => manualInteractionMarkerKey("sonarr", arrInstance, id);

export async function POST(req: NextRequest) {
  // Auth, instance, body caps, Test/Health and the replay digest (rolled back
  // only when the handler throws) are shared with the Radarr twin (arr-webhook.ts).
  // Guardrail 2: the presented token is compared as SHA-256 digests with
  // timingSafeEqual (safeCompareStrings). Called here, in the handler, so the
  // route audit sees every webhook handler perform it.
  return handleArrWebhook<SonarrWebhookPayload>(req, "sonarr", (presented, secret) => safeCompareStrings(presented, secret), handleSonarrEvent);
}

async function handleSonarrEvent({ payload, arrInstance, instances }: ArrWebhookContext<SonarrWebhookPayload>): Promise<NextResponse> {
  // The payload is attacker-shaped (secret-only auth) and only its top level is
  // checked before this point: `episodes: [null]` or a non-array would have
  // thrown below — a 500 that rolls the replay digest back. A derived view,
  // never a rewrite of `payload`: the digest is recorded (and cleared) over it.
  const event = readSonarrPayload(payload);
  if (event.eventType === "ManualInteractionRequired") {
    await handleManualInteraction(event, arrInstance, instances);
    return NextResponse.json({ ok: true, manualInteraction: true });
  }
  if (event.eventType === "SeriesDelete" && event.series) return handleSeriesDelete(event.series, arrInstance);
  if (event.eventType !== "Download" || !event.series) {
    return NextResponse.json({ ok: true, skipped: true });
  }
  return handleSeriesDownload(event, arrInstance);
}

// Sonarr fires ManualInteractionRequired when a grabbed release can't be imported
// automatically and is parked in the queue. There's nothing to mark available —
// alert admins (best-effort, once per stuck series) so they can resolve it in
// Sonarr's queue. The stable key prefers the tvdbId and falls back to the tmdbId;
// with neither, fail closed (no notify).
async function handleManualInteraction(event: SonarrWebhookView, arrInstance: string, instances: ArrWebhookContext<unknown>["instances"]): Promise<void> {
  const series = event.series;
  const stableId: SeriesMarkerId | null =
    series?.tvdbId != null ? `tvdb:${series.tvdbId}` : series?.tmdbIdKey != null ? `tmdb:${series.tmdbIdKey}` : null;
  await notifyManualInteractionOnce({
    service: "sonarr",
    arrInstance,
    instances,
    markerKey: stableId !== null ? markerKey(arrInstance, stableId) : null,
    title: `${series?.title ?? "A series"}${sonarrEpisodeScope(event.episodes)}`,
  });
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
async function handleSeriesDelete(series: NonNullable<SonarrWebhookView["series"]>, arrInstance: string): Promise<NextResponse> {
  const delTvdbId = series.tvdbId;
  // With no payload tmdbId the mapping only NAMES the candidate; it is
  // confirmed like any other below.
  const delTmdbId = series.tmdbId ?? (delTvdbId !== null ? await resolveSingleTvdbToTmdb(delTvdbId) : null);
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
  const refusal = seriesDeleteRefusal(verdict, byTvdb);
  if (refusal !== null) {
    // Every non-eviction is logged the same way, except an untied tmdb lookup
    // that still finds the series: that lags and can land on another show, so it
    // is no evidence of forgery and stays quiet.
    if (refusal.reason !== "unconfirmed") {
      console.warn("[webhook/sonarr] SeriesDelete for tmdbId=%s not confirmed by Sonarr; cache left to the next sync.", sanitizeForLog(delTmdbId));
    }
    return NextResponse.json({ ok: true, evicted: false, reason: refusal.reason });
  }
  await evictArrCacheRows("sonarr", delTmdbId, arrInstance);
  return NextResponse.json({ ok: true, evicted: true });
}

// Why a SeriesDelete must NOT evict, or null when Sonarr confirmed the series
// absent. `byTvdb` says which key the check used: a "still there" under the
// tvdb key contradicts the event ("not_deleted"), under the tmdb lookup it is
// merely unconfirmed.
type SeriesDeleteRefusal = { reason: "unverified" | "not_deleted" | "unconfirmed" };
function seriesDeleteRefusal(verdict: SeriesDownloadVerdict | null, byTvdb: boolean): SeriesDeleteRefusal | null {
  if (verdict === null) return { reason: "unverified" };
  if (!verdict.downloaded && verdict.reason === "absent") return null;
  return { reason: byTvdb ? "not_deleted" : "unconfirmed" };
}

async function handleSeriesDownload(event: SonarrWebhookView, arrInstance: string): Promise<NextResponse> {
  const ids = { tvdbId: event.series?.tvdbId ?? null, tmdbId: event.series?.tmdbId ?? null };

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
  //                         (only the refused shapes return first): that asks
  //                         whether the grabbed release was imported, not
  //                         whether the series is complete — and it asks
  //                         Sonarr itself (a file in the grab's scope newer
  //                         than the grab) before it claims, so an unanswered
  //                         check claims nothing here either.
  const verdict = await isSeriesDownloadedInSonarr(ids, arrInstance);
  const outcome = downloadOutcome(verdict);
  if (outcome.kind === "refused") {
    console.warn("[webhook/sonarr] Download event for tvdbId=%s tmdbId=%s not confirmed downloaded in Sonarr (%s); skipping status flip.", sanitizeForLog(ids.tvdbId ?? "?"), sanitizeForLog(ids.tmdbId ?? "?"), outcome.refusal);
    return NextResponse.json({ ok: true, skipped: true, reason: "not_downloaded" });
  }

  const flip: SonarrFlipResult = outcome.kind === "complete"
    // Keyed on the payload's tmdbId only when Sonarr confirmed it for this
    // series; otherwise by the tvdbId alone (confirmedFlipIds).
    ? await flipApprovedSonarrRequests(confirmedFlipIds(ids, outcome.tmdbIdConfirmed), arrInstance, outcome.libraryTmdbId)
    : { count: 0, effectiveTmdbId: null, effectiveTvdbId: null };

  // A completed import ends the "stuck" episode the manual-interaction marker
  // one-shots — clear both candidate keys (tvdb- and tmdb-keyed). The refused
  // paths returned above; an INCOMPLETE series still imported an episode, so
  // the marker clears on that path too. The tmdb key is the same one the set
  // side builds (tmdbIdKey, any positive integer), so a tmdbId outside the
  // lookup range clears the marker it set.
  const tmdbKey = event.series?.tmdbIdKey ?? null;
  clearManualInteractionMarkers([
    ...(ids.tvdbId !== null ? [markerKey(arrInstance, `tvdb:${ids.tvdbId}`)] : []),
    ...(tmdbKey !== null ? [markerKey(arrInstance, `tmdb:${tmdbKey}`)] : []),
  ]);

  const unverifiedGrabs = await claimDeliveredGrabs(ids, event.episodes, arrInstance);

  // Deferred work runs after the response is sent; library scan and notification can be slow
  after(() => afterSeriesImport(ids, arrInstance, flip, outcome.kind === "unverified", unverifiedGrabs));

  if (outcome.kind === "complete") return NextResponse.json({ ok: true, marked: flip.count });
  if (outcome.kind === "unverified") return NextResponse.json({ ok: true, deferred: true, reason: "unverified" });
  // Incomplete: no transition, and deliberately no log line — this is the
  // expected state of every episode but the last of an import, and per-event
  // warnings here only bury the anomalies (guardrail 7). The counts travel in
  // the response and in GET /api/admin/debug/arr-state for anyone asking why a
  // request has not flipped.
  return NextResponse.json({
    ok: true,
    skipped: true,
    reason: "incomplete",
    episodeFileCount: outcome.episodeFileCount,
    episodeCount: outcome.episodeCount,
  });
}

type DownloadOutcome =
  | { kind: "complete"; libraryTmdbId: number | null; tmdbIdConfirmed: boolean }
  | { kind: "incomplete"; episodeFileCount: number; episodeCount: number }
  | { kind: "unverified" }
  // A forgery shape the guard refuses (its own field name: `reason` is the wire's).
  | { kind: "refused"; refusal: "absent" | "ids-disagree" };

// What a Download's verdict means for this event (see the table above).
function downloadOutcome(verdict: SeriesDownloadVerdict | null): DownloadOutcome {
  if (verdict === null) return { kind: "unverified" };
  if (verdict.downloaded) return { kind: "complete", libraryTmdbId: verdict.tmdbId, tmdbIdConfirmed: verdict.tmdbIdConfirmed };
  if (verdict.reason === "incomplete") {
    return { kind: "incomplete", episodeFileCount: verdict.episodeFileCount, episodeCount: verdict.episodeCount };
  }
  return { kind: "refused", refusal: verdict.reason };
}

// The after() work of a Download: the library scan, the deferred re-check of an
// unverifiable verdict, then the "now available" poll for what flipped.
async function afterSeriesImport(
  ids: { tvdbId: number | null; tmdbId: number | null },
  arrInstance: string,
  flip: SonarrFlipResult,
  deferVerify: boolean,
  unverifiedGrabs: IssueGrab[],
): Promise<void> {
  // Scheduled on every confirmed, incomplete, or unverifiable import — an
  // episode landed either way, and the library should show it even while
  // the request stays APPROVED waiting for the rest of the series.
  await scheduleLibraryScan("tv", ids.tmdbId ?? undefined, arrInstance);
  // The grabs Sonarr gave no answer for, once more now the scan has waited
  // out its queue.
  await retryUnverifiedGrabs(unverifiedGrabs, "sonarr", { arrInstance, tvdbId: ids.tvdbId });

  let { effectiveTmdbId, effectiveTvdbId } = flip;
  if (deferVerify) {
    // The scan above already waited for Sonarr's queue to drain (or gave up
    // after its retries), so a transient 503 has had a real window to clear.
    // One re-check; still not confirmed complete → leave it to the periodic
    // sync rather than retrying here indefinitely.
    try {
      const recheck = await isSeriesDownloadedInSonarr(ids, arrInstance);
      if (recheck?.downloaded !== true) return;
      ({ effectiveTmdbId, effectiveTvdbId } = await flipApprovedSonarrRequests(confirmedFlipIds(ids, recheck.tmdbIdConfirmed), arrInstance, recheck.tmdbId));
    } catch (err) {
      console.warn("[webhook/sonarr] deferred verification failed:", err instanceof Error ? err.message : err);
      return;
    }
  }

  const byId = effectiveTmdbId !== null
    ? { tmdbId: effectiveTmdbId }
    : effectiveTvdbId !== null
      ? { tvdbId: effectiveTvdbId }
      : null;
  if (!byId) return;
  await notifyAvailableAfterImport({
    where: { ...byId, mediaType: "TV", arrInstance },
    kind: "tv",
    tmdbIdForCheck: effectiveTmdbId,
    logScope: "webhook/sonarr",
  });
}

// Claim the issue grabs this delivery completed, on the firing instance only (a
// sibling instance's grab is never claimed or notified off this one). Matched on
// EITHER id the payload carries, not tmdbId-first: a grab is recorded with the
// issue's tmdbId (+ tvdbId when known), and Sonarr's Download payload can carry a
// stale/mismapped tmdbId alongside the correct tvdbId — exactly the case the
// request flip falls back to. A RESOLVED issue's grab is never claimed
// (CLAIMABLE_GRAB_ISSUE — the Radarr twin). Scoped to WHAT this event delivered
// BEFORE the CAS (grabMatchesDelivery): without it tonight's S03E02 import
// claimed an EPISODE grab fired for S01E05, and when that file finally landed
// there was no notification left to send (notifiedAt is the emit claim and is
// never reset). The Radarr twin needs none of this — one file per movie.
// The payload's ids and episodes only pick CANDIDATES: the claim itself waits
// for Sonarr to report a file in the grab's scope newer than the grab
// (claimCompletedGrabs). Returns the grabs Sonarr gave no answer for.
async function claimDeliveredGrabs(
  ids: { tvdbId: number | null; tmdbId: number | null },
  episodes: SonarrWebhookView["episodes"],
  arrInstance: string,
): Promise<IssueGrab[]> {
  const idFilters = [
    ...(ids.tmdbId !== null ? [{ tmdbId: ids.tmdbId }] : []),
    ...(ids.tvdbId !== null ? [{ tvdbId: ids.tvdbId }] : []),
  ];
  if (idFilters.length === 0) return [];
  const candidateGrabs = await prisma.issueGrab.findMany({
    where: { OR: idFilters, mediaType: "TV", arrInstance, issue: CLAIMABLE_GRAB_ISSUE },
  });
  // The claim itself (and its push retry) is shared with the Radarr twin.
  return claimCompletedGrabs(
    candidateGrabs.filter((grab) => grabMatchesDelivery(grab, episodes)),
    "sonarr",
    { arrInstance, tvdbId: ids.tvdbId },
  );
}
