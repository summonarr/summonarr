import { prisma } from "./prisma";
import { getPlexLibrarySections, refreshPlexSection } from "./plex";
import { refreshJellyfinLibrary } from "./jellyfin";
import {
  countRadarrQueue,
  countSonarrQueue,
  isMovieDownloadingInRadarr,
  isSeriesDownloadingInSonarr,
  type ArrVariant,
} from "./arr";
import { sanitizeForLog } from "./sanitize";

export type ScanMediaType = "movie" | "tv";

// Debounce prevents redundant back-to-back scan triggers from rapid webhook bursts (e.g. season grab)
const SCAN_DEBOUNCE_MS = 15_000;

// Debounce deadline: a sustained import burst (webhooks < 15s apart) would otherwise
// reset the timer forever and postpone the scan until the burst ends.
const SCAN_MAX_WAIT_MS = 2 * 60_000;

// After this many retries the scan fires anyway so a stalled Arr queue doesn't block library updates indefinitely
const MAX_QUEUE_WAIT_RETRIES = 4;

interface PendingScan {
  timer: NodeJS.Timeout;
  promise: Promise<void>;
  resolve: () => void;
  retries: number;
  firstScheduledAt: number;

  tmdbId?: number;
  // Which ARR instance's queue to gate on. A 4K-only grab lives in the 4K queue, so
  // checking HD (the default) reports "not downloading" and the rescan fires before
  // the file imports. undefined → "hd" via the helper defaults.
  variant?: ArrVariant;
}

const pending = new Map<ScanMediaType, PendingScan>();
// Track in-flight triggerLibraryScan calls so a new schedule arriving mid-scan awaits the running one
// instead of firing a parallel scan against the same backend.
const inFlight = new Map<ScanMediaType, Promise<void>>();

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
    // Queue-gate hint; last writer wins on coalesce (a best-effort timing optimisation).
    if (variant !== undefined) existing.variant = variant;

    if (tmdbId !== undefined && existing.tmdbId !== undefined && existing.tmdbId !== tmdbId) {
      // Two different titles coalesced into the same scan window — fall back to full queue check
      existing.tmdbId = undefined;
    } else if (tmdbId !== undefined && existing.tmdbId === undefined) {
      // Already a full-queue check; a single-title hint can't narrow it back down
    } else if (tmdbId !== undefined) {
      existing.tmdbId = tmdbId;
    }
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
    variant,
  };
  pending.set(mediaType, entry);
  return promise;
}

async function runScan(mediaType: ScanMediaType): Promise<void> {
  const entry = pending.get(mediaType);
  if (!entry) return;

  let stillInQueue: boolean;
  if (entry.tmdbId !== undefined) {
    const downloading = mediaType === "movie"
      ? await isMovieDownloadingInRadarr(entry.tmdbId, entry.variant)
      : await isSeriesDownloadingInSonarr(entry.tmdbId, entry.variant);
    // null = queue unreadable → treat as "still pending" so we defer + retry
    // rather than scan prematurely against a download that may be in flight.
    stillInQueue = downloading !== false;
  } else {
    const count = mediaType === "movie"
      ? await countRadarrQueue(entry.variant)
      : await countSonarrQueue(entry.variant);
    // null = couldn't read the queue → defer rather than scan prematurely.
    stillInQueue = count === null || count > 0;
  }

  if (stillInQueue) {
    if (entry.retries < MAX_QUEUE_WAIT_RETRIES) {
      entry.retries += 1;
      entry.timer = setTimeout(() => runScan(mediaType), SCAN_DEBOUNCE_MS);
      const scope = entry.tmdbId !== undefined ? `tmdbId=${entry.tmdbId}` : "total queue";
      console.warn(
        `[library-scan] ${sanitizeForLog(mediaType)} arr still pending (${sanitizeForLog(scope)}), retry ${entry.retries}/${MAX_QUEUE_WAIT_RETRIES} in ${SCAN_DEBOUNCE_MS}ms`,
      );
      return;
    }
    const scope = entry.tmdbId !== undefined ? `tmdbId=${entry.tmdbId}` : "total queue";
    console.warn(
      `[library-scan] ${sanitizeForLog(mediaType)} arr still pending (${sanitizeForLog(scope)}) after ${MAX_QUEUE_WAIT_RETRIES} retries, scanning anyway`,
    );
  }

  // Hold the pending entry until the scan finishes so a concurrent schedule sees inFlight and awaits;
  // delete pending only after we've registered the in-flight promise.
  const scanPromise = triggerLibraryScan(mediaType).finally(() => {
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

async function triggerLibraryScan(mediaType: ScanMediaType): Promise<void> {
  const [plexUrlRow, plexTokenRow, jellyfinUrlRow, jellyfinKeyRow] = await Promise.all([
    prisma.setting.findUnique({ where: { key: "plexServerUrl" } }),
    prisma.setting.findUnique({ where: { key: "plexAdminToken" } }),
    prisma.setting.findUnique({ where: { key: "jellyfinUrl" } }),
    prisma.setting.findUnique({ where: { key: "jellyfinApiKey" } }),
  ]);

  const plexConfigured = !!(plexUrlRow?.value && plexTokenRow?.value);
  const jellyfinConfigured = !!(jellyfinUrlRow?.value && jellyfinKeyRow?.value);

  if (!plexConfigured && !jellyfinConfigured) {
    console.warn(`[library-scan] ${mediaType}: no backends configured, skipping`);
    return;
  }

  const plexSectionType: "movie" | "show" = mediaType === "movie" ? "movie" : "show";

  const jobs: Promise<void>[] = [];

  if (plexConfigured) {
    const serverUrl = plexUrlRow!.value!.replace(/\/$/, "");
    const token = plexTokenRow!.value!;
    jobs.push(
      (async () => {
        const sections = await getPlexLibrarySections(serverUrl, token);
        const targets = sections.filter((s) => s.type === plexSectionType);
        if (targets.length === 0) {
          console.warn(`[library-scan] plex ${mediaType}: no ${plexSectionType} sections found`);
          return;
        }
        await Promise.all(targets.map((s) => refreshPlexSection(serverUrl, token, s.key)));
      })().catch((err) => console.error(`[library-scan] plex ${mediaType}:`, err)),
    );
  }

  if (jellyfinConfigured) {
    const baseUrl = jellyfinUrlRow!.value!;
    const apiKey = jellyfinKeyRow!.value!;
    jobs.push(
      refreshJellyfinLibrary(baseUrl, apiKey).catch((err) =>
        console.error(`[library-scan] jellyfin ${mediaType}:`, err),
      ),
    );
  }

  await Promise.all(jobs);
}
