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
  await prisma.mediaRequest.update({ where: { id: requestId }, data: { pendingNotifyAt: null } });
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
 * Queue `runDownloadCheck` to run in ~90s via the bounded delayed-job pool.
 * Best-effort: returns false when the pending-timer cap dropped the job, and a
 * dropped or failed job still self-heals on the orchestrator's backstop sweep.
 * `opts.name` stays per-callsite so a drop names the path that queued it.
 */
export function scheduleDownloadCheck(target: DownloadCheckTarget, opts: { name: string }): boolean {
  return scheduleDelayed(DOWNLOAD_CHECK_DELAY_MS, async () => {
    try {
      await runDownloadCheck(target);
    } catch (err) {
      console.error("[download-check] 90s status check failed:", err);
    }
  }, opts);
}
