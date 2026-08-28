import "server-only";
import { prisma } from "./prisma";
import {
  getMovieReleaseInfo,
  getSeriesFirstAired,
  isMovieDownloadingInRadarr,
  isSeriesDownloadingInSonarr,
  type ArrVariant,
} from "./arr";
import { notifyUserAwaitingRelease, notifyUserDownloadPending } from "./discord-notify";
import { scheduleDelayed } from "./delayed-jobs";
import { mapLimit } from "./concurrency";

// The "did the approval actually start downloading?" follow-up.
//
// Every approval path arms `MediaRequest.pendingNotifyAt = now + 90s`, which the
// sync orchestrator (/api/sync) treats as a periodic BACKSTOP: on each tick it
// sweeps APPROVED rows whose stamp has elapsed and runs this same check. The
// scheduled job below is the PROMPT path — it fires at ~90s instead of "whenever
// the next sync tick lands" — so a path that arms the field without scheduling
// still notifies, just late. That is exactly the state the Discord admin-approve
// button shipped in.
//
// This module exists because the body was duplicated across the web PATCH path
// and the Discord /request auto-approve path, and the two copies had already
// drifted: only the PATCH copy cleared pendingNotifyAt and honored guardrail 33.
// Adding a third copy for the admin button would have widened that drift, so the
// union of the two behaviors lives here once.
export const DOWNLOAD_CHECK_DELAY_MS = 90_000;

// Matches the delayed-job pool's own default worker count, so ONE batched job
// spends the same upstream budget the per-row scheduling it replaces would have.
const DOWNLOAD_CHECK_CONCURRENCY = 4;

export interface DownloadCheckTarget {
  requestId: string;
  tmdbId: number;
  mediaType: "MOVIE" | "TV";
  /** The request's `arrInstance` slug — the Radarr/Sonarr instance it was pushed to (guardrail 32). */
  arrInstance: ArrVariant;
  requestedBy: string;
  title: string;
}

/**
 * Re-check an approved request ~90s after the ARR push and tell the requester
 * whether it is stuck (`notifyUserDownloadPending`) or simply not out yet
 * (`notifyUserAwaitingRelease`). Throws on DB/upstream failure — callers going
 * through `scheduleDownloadCheck` get that logged and swallowed.
 */
export async function runDownloadCheck(target: DownloadCheckTarget): Promise<void> {
  const { requestId, tmdbId, mediaType, arrInstance, requestedBy, title } = target;

  const current = await prisma.mediaRequest.findUnique({
    where: { id: requestId },
    select: { status: true },
  });
  if (current?.status !== "APPROVED") return;

  const downloading = mediaType === "MOVIE"
    ? await isMovieDownloadingInRadarr(tmdbId, arrInstance)
    : await isSeriesDownloadingInSonarr(tmdbId, arrInstance);
  // Skip on true (downloading) and null (queue unreadable) — only a confirmed
  // "not downloading" fires the pending notify. Returning leaves pendingNotifyAt
  // set so the orchestrator backstop retries.
  if (downloading !== false) return;

  const now = new Date();
  let released = true;
  let soonestReleaseDate: string | null = null;

  if (mediaType === "MOVIE") {
    const info = await getMovieReleaseInfo(tmdbId);
    if (info) {
      const futureDates = [info.digitalRelease, info.physicalRelease]
        .filter((d): d is string => !!d && new Date(d) > now);
      const pastDates = [info.digitalRelease, info.physicalRelease]
        .filter((d): d is string => !!d && new Date(d) <= now);

      if (pastDates.length === 0 && futureDates.length > 0) {
        released = false;
        // Sort CHRONOLOGICALLY, not lexicographically. A bare .sort() is
        // string-ordering: it agrees with date order only while every value
        // is the same ISO-8601 shape in the same zone. Radarr returning one
        // date with an offset (…T02:00:00+02:00) and one in Z would pick the
        // later release as "soonest" and tell the user the wrong date.
        // Matches the comparator the sync orchestrator uses on this exact data.
        soonestReleaseDate = futureDates.sort((a, b) => new Date(a).getTime() - new Date(b).getTime())[0];
      }
    }
  } else {
    const firstAired = await getSeriesFirstAired(tmdbId, arrInstance);
    if (firstAired && new Date(firstAired) > now) {
      released = false;
      soonestReleaseDate = firstAired;
    }
  }

  const requester = await prisma.user.findUnique({
    where: { id: requestedBy },
    select: { deactivatedAt: true },
  });
  // Clearing pendingNotifyAt is what stops the orchestrator backstop firing a
  // SECOND, duplicate "download pending" DM on the next sync tick for a request
  // this job already notified about.
  // updateMany, not update: an admin can delete the request during the awaited
  // Radarr/Sonarr queue polls above, and a bare update would throw P2025 on a
  // normal race (same convention as this module's callers). count === 0 means
  // the row is gone — abort so we don't DM the requester about a download that
  // no longer exists (the bare update's P2025 throw used to abort here for free).
  const cleared = await prisma.mediaRequest.updateMany({ where: { id: requestId }, data: { pendingNotifyAt: null } });
  if (cleared.count === 0) return;
  // Guardrail 33: a disabled account keeps a live Discord link. CONSUME the backstop
  // rather than defer it (pendingNotifyAt cleared above, DM dropped) so re-enabling
  // an account doesn't replay a stale "download pending" backlog — same reasoning as
  // the orchestrator's disabledRequesters short-circuit in /api/sync.
  if (requester?.deactivatedAt) return;

  if (!released) {
    await notifyUserAwaitingRelease(requestedBy, title, mediaType, soonestReleaseDate);
  } else {
    await notifyUserDownloadPending(requestedBy, title, mediaType);
  }
}

/**
 * Queue `runDownloadCheck` for every target as ONE ~90s job in the bounded
 * delayed-job pool.
 *
 * One job, not one per row: the bulk (50) and batch (100) approve paths would
 * otherwise fill the pool's whole 100-slot run queue from a single admin click,
 * and the next path to schedule would have its jobs dropped at fire time. The
 * targets are swept with a bounded fan-out instead, and each self-catches so one
 * bad row can neither abort the sweep nor reject into the pool.
 *
 * Best-effort throughout: returns false for an empty list or when the pending
 * cap dropped the job, and anything dropped or failed still self-heals on the
 * orchestrator's backstop sweep. `opts.name` stays per-callsite so a drop names
 * the path that queued it.
 */
export function scheduleDownloadChecks(targets: readonly DownloadCheckTarget[], opts: { name: string }): boolean {
  if (targets.length === 0) return false;
  return scheduleDelayed(DOWNLOAD_CHECK_DELAY_MS, async () => {
    // mapLimit (not settleLimit) is correct because every task self-catches —
    // guardrail 31's stated rule. Nothing here can reject.
    await mapLimit(targets, DOWNLOAD_CHECK_CONCURRENCY, async (target) => {
      try {
        await runDownloadCheck(target);
      } catch (err) {
        console.error("[download-check] 90s status check failed:", err);
      }
    });
  }, opts);
}

/** Single-target convenience wrapper over {@link scheduleDownloadChecks}. */
export function scheduleDownloadCheck(target: DownloadCheckTarget, opts: { name: string }): boolean {
  return scheduleDownloadChecks([target], opts);
}
