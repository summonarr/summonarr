// "Why is this request stuck?" — the data half. Reads what the request's OWN
// Radarr/Sonarr instance (guardrail 32) reports for its title — the library
// resource, the queue, the DownloadFailed history — plus whether a Plex or
// Jellyfin library the requester can see holds it, and hands it all to the
// pure judge in request-arr-status.ts. Every upstream call goes through
// arrFetch (guardrail 5), quiet: a failed read is reported once here and
// becomes the `unreachable` verdict, not a 500. Nothing is cached and nothing
// is written.
//
// Reads are taken only where the verdict can need them: once nothing has to be
// downloaded (a movie's file or its library row, a COMPLETE series —
// guardrail 14a), the queue and history are never asked.
import { ArrResponseError, arrErrorKind, arrErrorMessage, arrFetch, type ArrCfg } from "./arr";
import { configuredArrCfg, type ArrService } from "./arr-admin";
import { historyEventQuery, projectHistoryRecords, type ArrHistoryEvent } from "./arr-history";
import { foldQueueRecords, type QueueItem } from "./arr-queue";
import { findTitle } from "./arr-title-data";
import { getVisibleServerInstancesForUserId } from "./media-visibility";
import { prisma } from "./prisma";
import {
  judgeRequestArrStatus,
  needsNoDownload,
  titleFacts,
  type ArrRead,
  type RequestArrStatus,
} from "./request-arr-status";
import { sanitizeForLog } from "./sanitize";

export type { RequestArrStatus };

// The status check runs on a click, but a dark instance must still answer
// "unreachable" well inside a reverse proxy's patience.
const READ_TIMEOUT_MS = 20_000;
// A title's queue is a handful of records (one per episode for a Sonarr pack);
// this only bounds what a pathological queue can cost the fold.
const MAX_QUEUE_RECORDS = 2_000;

export interface StatusTarget {
  service: ArrService;
  instance: string;
  tmdbId: number;
  mediaType: "MOVIE" | "TV";
  /** The requester — the library check counts only servers THEY can see, like the sync does. */
  requestedBy: string;
  /** The request's approval, else its creation: older download failures are history, not the reason. */
  since: Date;
}

function failed<T>(target: StatusTarget, what: string, err: unknown): ArrRead<T> {
  console.warn(
    `[request-arr-status] ${target.service} instance "${sanitizeForLog(target.instance)}" ${what} failed:`,
    sanitizeForLog(arrErrorMessage(err)),
  );
  return { ok: false, kind: arrErrorKind(err) };
}

// A record is the title's only when it names it: an arr version that ignored
// the query's filter would otherwise hand back the whole queue or history.
const namesTitle = (service: ArrService, arrId: number) => (x: unknown): boolean =>
  (x as Record<string, unknown> | null)?.[service === "radarr" ? "movieId" : "seriesId"] === arrId;

async function readResource(cfg: ArrCfg, service: ArrService, arrId: number): Promise<Record<string, unknown> | null> {
  try {
    const raw = await arrFetch<unknown>(cfg, `/api/v3/${service === "radarr" ? "movie" : "series"}/${arrId}`, { quietErrors: true, timeoutMs: READ_TIMEOUT_MS });
    return raw && typeof raw === "object" && !Array.isArray(raw) && (raw as { id?: unknown }).id === arrId ? (raw as Record<string, unknown>) : null;
  } catch (err) {
    // Removed between the lookup and this read.
    if (err instanceof ArrResponseError && err.status === 404) return null;
    throw err;
  }
}

// /api/v3/queue/details is the queue for ONE title (Radarr movieId, Sonarr
// seriesId), pending releases included, unpaged — both arrs have had it since
// v3. Sonarr reports one record per episode; foldQueueRecords folds a pack.
async function readQueue(cfg: ArrCfg, target: StatusTarget, arrId: number): Promise<QueueItem[]> {
  const path = target.service === "radarr"
    ? `/api/v3/queue/details?movieId=${arrId}&includeMovie=false`
    : `/api/v3/queue/details?seriesId=${arrId}&includeSeries=false&includeEpisode=true`;
  const raw = await arrFetch<unknown>(cfg, path, { quietErrors: true, timeoutMs: READ_TIMEOUT_MS });
  const own = Array.isArray(raw) ? raw.filter(namesTitle(target.service, arrId)).slice(0, MAX_QUEUE_RECORDS) : [];
  return foldQueueRecords(target.service, target.instance, own);
}

// The title's own history, DownloadFailed only (the event id differs per arr —
// historyEventQuery translates it).
async function readFailures(cfg: ArrCfg, target: StatusTarget, arrId: number): Promise<ArrHistoryEvent[]> {
  const path = target.service === "radarr"
    ? `/api/v3/history/movie?movieId=${arrId}&${historyEventQuery("radarr", "failed")}`
    : `/api/v3/history/series?seriesId=${arrId}&${historyEventQuery("sonarr", "failed")}`;
  const raw = await arrFetch<unknown>(cfg, path, { quietErrors: true, timeoutMs: READ_TIMEOUT_MS });
  const own = Array.isArray(raw) ? raw.filter(namesTitle(target.service, arrId)) : [];
  return projectHistoryRecords(target.service, target.instance, own).filter((e) => e.kind === "failed");
}

// A library row on a server the REQUESTER can see — the same gate the sync's
// marking pass applies (guardrail 35), so "it's on Plex" never names a
// restricted server the request can't be marked available from.
async function inVisibleLibrary(target: StatusTarget): Promise<boolean> {
  const visible = await getVisibleServerInstancesForUserId(target.requestedBy);
  const where = (instances: string[]) => ({ tmdbId: target.tmdbId, mediaType: target.mediaType, serverInstance: { in: instances } });
  const [plex, jellyfin] = await Promise.all([
    visible.plex.length > 0 ? prisma.plexLibraryItem.findFirst({ where: where(visible.plex), select: { tmdbId: true } }) : null,
    visible.jellyfin.length > 0 ? prisma.jellyfinLibraryItem.findFirst({ where: where(visible.jellyfin), select: { tmdbId: true } }) : null,
  ]);
  return plex !== null || jellyfin !== null;
}

/**
 * The verdict for one request. Throws ArrInstanceError (arr-admin.ts) when the
 * instance is not a configured one; every Radarr/Sonarr failure is folded into
 * the `unreachable` verdict instead.
 */
export async function loadRequestArrStatus(target: StatusTarget, now: Date = new Date()): Promise<RequestArrStatus> {
  const cfg = await configuredArrCfg(target.service, target.instance);
  const libraryCheck = inVisibleLibrary(target);
  // Settled now so a rejected library read can't go unhandled while the arr is read.
  libraryCheck.catch(() => {});

  let arrId: number | null = null;
  let resource: ArrRead<Record<string, unknown> | null>;
  try {
    const found = await findTitle(target.service, target.instance, target.tmdbId);
    arrId = found?.arrId ?? null;
    resource = { ok: true, value: found === null ? null : found.raw ?? (await readResource(cfg, target.service, found.arrId)) };
  } catch (err) {
    resource = failed(target, "title read", err);
  }

  const inLibrary = await libraryCheck;
  let queue: ArrRead<QueueItem[]> | null = null;
  let failures: ArrRead<ArrHistoryEvent[]> | null = null;
  const facts = resource.ok && resource.value !== null ? titleFacts(target.service, target.instance, resource.value, now.getTime()) : null;
  if (arrId !== null && facts && !needsNoDownload(target.service, facts, inLibrary)) {
    const id = arrId;
    [queue, failures] = await Promise.all([
      readQueue(cfg, target, id).then((value): ArrRead<QueueItem[]> => ({ ok: true, value }), (err) => failed<QueueItem[]>(target, "queue read", err)),
      readFailures(cfg, target, id).then((value): ArrRead<ArrHistoryEvent[]> => ({ ok: true, value }), (err) => failed<ArrHistoryEvent[]>(target, "history read", err)),
    ]);
  }

  return judgeRequestArrStatus({
    service: target.service,
    instance: target.instance,
    resource,
    queue,
    failures,
    inLibrary,
    sinceMs: target.since.getTime(),
    nowMs: now.getTime(),
  });
}
