import { getPlexLibrarySections, refreshPlexSection } from "./plex";
import { getPlexConfig } from "./plex-config";
import { refreshJellyfinLibrary } from "./jellyfin";
import { getJellyfinConfig } from "./jellyfin-config";
import {
  countRadarrQueue,
  countSonarrQueue,
  isMovieDownloadingInRadarr,
  isSeriesDownloadingInSonarr,
  type ArrVariant,
} from "./arr";
import { sanitizeForLog } from "./sanitize";
import { processSingleton } from "./process-singleton";
import { getSyncableMediaInstances } from "./media-instance-registry";
import { DEFAULT_MEDIA_INSTANCE } from "./media-instances";

export type ScanMediaType = "movie" | "tv";

// Debounce: wait for a quiet gap before scanning, so a burst of webhooks (e.g. a
// season grab) triggers one scan instead of many back-to-back ones.
const SCAN_DEBOUNCE_MS = 15_000;

// Debounce deadline: a sustained import burst (webhooks < 15s apart) would otherwise
// keep resetting the timer and postpone the scan until the burst ends.
const SCAN_MAX_WAIT_MS = 2 * 60_000;

// After this many retries the scan fires anyway, so a stalled Radarr/Sonarr queue
// can't block library updates forever.
const MAX_QUEUE_WAIT_RETRIES = 4;

interface PendingScan {
  timer: NodeJS.Timeout;
  promise: Promise<void>;
  resolve: () => void;
  retries: number;
  firstScheduledAt: number;

  tmdbId?: number;
  // Every Radarr/Sonarr instance whose queue the scan waits on (guardrail 32).
  // A 4K-only grab lives in the 4K queue, so checking the default instance would
  // report "not downloading" and the rescan would fire before the file imports;
  // and when a default and a 4K import merge into one window, both queues must
  // be idle. A call with no variant waits on the default instance ("").
  variants: Set<ArrVariant>;
}

// Process-wide (guardrail 27a): the webhook routes, the cleanup delete and the
// title manager's remove each carry their own copy of this module, and a
// per-copy map let a cleanup and an import webhook each scan the same backend.
const pending = processSingleton("library-scan:pending", () => new Map<ScanMediaType, PendingScan>());
// Scans currently running. A new schedule arriving mid-scan waits on the running
// one instead of firing a parallel scan against the same backend: the scan is
// only the refresh CALL, and the server's own scan it starts picks up the file.
const inFlight = processSingleton("library-scan:inFlight", () => new Map<ScanMediaType, Promise<void>>());

/**
 * Fold a new call into the pending scan's queue hint. A hint-less call means
 * "check the whole queue" and widens a single-title hint; two different titles
 * in one window widen to the whole queue too. The same title, or an already
 * whole-queue check, stays as it is.
 */
function mergeTitleHint(existing: number | undefined, incoming: number | undefined): number | undefined {
  if (incoming === undefined) return undefined;
  return existing === incoming ? existing : undefined;
}

export function scheduleLibraryScan(mediaType: ScanMediaType, tmdbId?: number, variant?: ArrVariant): Promise<void> {
  const running = inFlight.get(mediaType);
  if (running) {
    return running;
  }

  const existing = pending.get(mediaType);
  if (existing) {
    // Reset the debounce only within the max-wait window; past it, leave the
    // running timer so the scan fires despite a continuing webhook burst.
    if (Date.now() - existing.firstScheduledAt < SCAN_MAX_WAIT_MS) {
      clearTimeout(existing.timer);
      existing.timer = setTimeout(() => runScan(mediaType), SCAN_DEBOUNCE_MS);
    }
    existing.variants.add(variant ?? "");
    existing.tmdbId = mergeTitleHint(existing.tmdbId, tmdbId);
    return existing.promise;
  }

  let resolve!: () => void;
  const promise = new Promise<void>((r) => {
    resolve = r;
  });
  const entry: PendingScan = {
    timer: setTimeout(() => runScan(mediaType), SCAN_DEBOUNCE_MS),
    promise,
    resolve,
    retries: 0,
    firstScheduledAt: Date.now(),
    tmdbId,
    variants: new Set([variant ?? ""]),
  };
  pending.set(mediaType, entry);
  return promise;
}

/**
 * Is the title (or, with no hint, anything) still in this instance's queue?
 * An unreadable queue (null from the helpers) counts as still pending, so the
 * scan defers and retries rather than firing against a download in flight.
 */
async function queueStillBusy(mediaType: ScanMediaType, tmdbId: number | undefined, variant: ArrVariant): Promise<boolean> {
  if (tmdbId !== undefined) {
    const downloading = mediaType === "movie"
      ? await isMovieDownloadingInRadarr(tmdbId, variant)
      : await isSeriesDownloadingInSonarr(tmdbId, variant);
    return downloading !== false;
  }
  const count = mediaType === "movie" ? await countRadarrQueue(variant) : await countSonarrQueue(variant);
  return count === null || count > 0;
}

// An UNREADABLE queue is already modelled — both helpers return null and the
// scan defers + retries rather than scan prematurely. A THROW was not: arrFetch
// raises on a timeout, a non-2xx, or an unreachable host, and that escaped
// runScan entirely. `pending` is cleared only after the scan is registered
// in-flight, so the entry survived forever and every later scheduleLibraryScan
// short-circuited on it — scans for that media type never ran again until a
// restart. Fold a throw into the same "can't read it, assume pending" answer.
async function anyQueueStillBusy(mediaType: ScanMediaType, entry: PendingScan): Promise<boolean> {
  try {
    for (const variant of entry.variants) {
      if (await queueStillBusy(mediaType, entry.tmdbId, variant)) return true;
    }
    return false;
  } catch (err) {
    console.warn(
      `[library-scan] ${sanitizeForLog(mediaType)} arr queue check failed, treating as pending:`,
      err instanceof Error ? err.message : String(err),
    );
    return true;
  }
}

const queueScope = (entry: PendingScan) => sanitizeForLog(entry.tmdbId !== undefined ? `tmdbId=${entry.tmdbId}` : "total queue");

/** Re-arm the debounce for another queue check; false once the retries are spent. */
function deferForQueue(mediaType: ScanMediaType, entry: PendingScan): boolean {
  if (entry.retries >= MAX_QUEUE_WAIT_RETRIES) {
    console.warn(
      `[library-scan] ${sanitizeForLog(mediaType)} arr still pending (${queueScope(entry)}) after ${MAX_QUEUE_WAIT_RETRIES} retries, scanning anyway`,
    );
    return false;
  }
  entry.retries += 1;
  // Clear before overwriting: a concurrent schedule may have armed a live
  // timer on this entry, and dropping the handle leaks it — it would fire
  // later against an unrelated entry and cut its debounce short.
  clearTimeout(entry.timer);
  entry.timer = setTimeout(() => runScan(mediaType), SCAN_DEBOUNCE_MS);
  console.warn(
    `[library-scan] ${sanitizeForLog(mediaType)} arr still pending (${queueScope(entry)}), retry ${entry.retries}/${MAX_QUEUE_WAIT_RETRIES} in ${SCAN_DEBOUNCE_MS}ms`,
  );
  return true;
}

async function runScan(mediaType: ScanMediaType): Promise<void> {
  const entry = pending.get(mediaType);
  if (!entry) return;

  // The handle whose firing brought us here, compared again after the awaits
  // below to detect a concurrent re-arm. See the ownership re-check.
  const myTimer = entry.timer;

  const stillInQueue = await anyQueueStillBusy(mediaType, entry);

  // Ownership re-check, on the TIMER not the entry: scheduleLibraryScan mutates
  // the existing entry rather than replacing it, so the entry identity is
  // unchanged in the race this guards.
  //
  // During the queue-check await a webhook can call scheduleLibraryScan. Its
  // clearTimeout(existing.timer) no-ops on the handle that already fired to get
  // us here, so it arms a SECOND live timer on this same entry. Both timers then
  // call runScan, both find the still-present pending entry, and both can reach
  // the scan tail — a duplicate scan against the same backend. inFlight is armed
  // only further down, too late to cover this window.
  //
  // A changed handle means a newer schedule owns the next run, so this
  // invocation stands down; the shared entry.resolve still settles every waiter
  // when that run completes. A missing entry means the scan already ran.
  const current = pending.get(mediaType);
  if (current !== entry || current.timer !== myTimer) return;

  if (stillInQueue && deferForQueue(mediaType, entry)) return;

  // Register the scan in inFlight BEFORE deleting the pending entry, so a
  // schedule arriving in between sees inFlight and waits on it.
  // The .catch() matters for the same reason as the queue-check try/catch
  // above: without it a failed scan would be an unhandled rejection in the
  // setTimeout that called us, AND would reject for every caller waiting on
  // inFlight, making their `await scheduleLibraryScan(...)` skip the work that
  // follows it.
  const scanPromise = triggerLibraryScan(mediaType)
    .catch((err) =>
      console.error(
        `[library-scan] ${sanitizeForLog(mediaType)} scan failed:`,
        err instanceof Error ? err.message : String(err),
      ),
    )
    .finally(() => {
      inFlight.delete(mediaType);
    });
  inFlight.set(mediaType, scanPromise);
  pending.delete(mediaType);
  try {
    await scanPromise;
  } finally {
    entry.resolve();
  }
}

// Every configured server of both services is refreshed (guardrail 35): a
// title imported for a named instance lands on whichever server holds the file,
// and availability is a union, so a default-only scan left a named server's
// library stale until the next full sync. The registry read is best-effort: if
// it fails, the default instance (the pre-multi-server behaviour) is scanned.
async function configuredInstances(service: "plex" | "jellyfin"): Promise<string[]> {
  try {
    return (await getSyncableMediaInstances(service)).map((i) => i.slug);
  } catch (err) {
    console.error(`[library-scan] ${service} instance list failed, scanning the default only:`, err instanceof Error ? err.message : String(err));
    return [DEFAULT_MEDIA_INSTANCE];
  }
}

// A named server's log lines carry its slug; the default's stay as before.
function scanLabel(service: string, mediaType: ScanMediaType, instance: string): string {
  return instance === DEFAULT_MEDIA_INSTANCE ? `${service} ${mediaType}` : `${service}[${sanitizeForLog(instance)}] ${mediaType}`;
}

async function triggerLibraryScan(mediaType: ScanMediaType): Promise<void> {
  const [plexSlugs, jellyfinSlugs] = await Promise.all([
    configuredInstances("plex"),
    configuredInstances("jellyfin"),
  ]);
  const plexConfigs = await Promise.all(plexSlugs.map(async (instance) => ({ instance, config: await getPlexConfig(instance) })));
  const jellyfinConfigs = await Promise.all(jellyfinSlugs.map(async (instance) => ({ instance, config: await getJellyfinConfig(instance) })));

  const plexTargets = plexConfigs.filter((c) => c.config.url && c.config.token);
  const jellyfinTargets = jellyfinConfigs.filter((c) => c.config.url && c.config.apiKey);

  if (plexTargets.length === 0 && jellyfinTargets.length === 0) {
    console.warn(`[library-scan] ${mediaType}: no backends configured, skipping`);
    return;
  }

  const plexSectionType: "movie" | "show" = mediaType === "movie" ? "movie" : "show";

  const jobs: Promise<void>[] = [];

  for (const { instance, config } of plexTargets) {
    const serverUrl = config.url!.replace(/\/$/, "");
    const token = config.token!;
    const label = scanLabel("plex", mediaType, instance);
    jobs.push(
      (async () => {
        const sections = await getPlexLibrarySections(serverUrl, token);
        const targets = sections.filter((s) => s.type === plexSectionType);
        if (targets.length === 0) {
          console.warn(`[library-scan] ${label}: no ${plexSectionType} sections found`);
          return;
        }
        await Promise.all(targets.map((s) => refreshPlexSection(serverUrl, token, s.key)));
      })().catch((err) => console.error(`[library-scan] ${label}:`, err)),
    );
  }

  for (const { instance, config } of jellyfinTargets) {
    const label = scanLabel("jellyfin", mediaType, instance);
    jobs.push(
      refreshJellyfinLibrary(config.url!, config.apiKey!).catch((err) =>
        console.error(`[library-scan] ${label}:`, err),
      ),
    );
  }

  await Promise.all(jobs);
}
