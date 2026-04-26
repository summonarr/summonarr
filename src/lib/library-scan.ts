import { prisma } from "./prisma";
import { getPlexLibrarySections, refreshPlexSection } from "./plex";
import { refreshJellyfinLibrary } from "./jellyfin";
import {
  countRadarrQueue,
  countSonarrQueue,
  isMovieDownloadingInRadarr,
  isSeriesDownloadingInSonarr,
} from "./arr";
import { sanitizeForLog } from "./sanitize";

export type ScanMediaType = "movie" | "tv";

// Debounce prevents redundant back-to-back scan triggers from rapid webhook bursts (e.g. season grab)
const SCAN_DEBOUNCE_MS = 15_000;

// After this many retries the scan fires anyway so a stalled Arr queue doesn't block library updates indefinitely
const MAX_QUEUE_WAIT_RETRIES = 4;

interface PendingScan {
  timer: NodeJS.Timeout;
  promise: Promise<void>;
  resolve: () => void;
  retries: number;

  tmdbId?: number;
}

const pending = new Map<ScanMediaType, PendingScan>();

export function scheduleLibraryScan(mediaType: ScanMediaType, tmdbId?: number): Promise<void> {
  const existing = pending.get(mediaType);
  if (existing) {
    clearTimeout(existing.timer);
    existing.timer = setTimeout(() => runScan(mediaType), SCAN_DEBOUNCE_MS);

    if (tmdbId !== undefined && existing.tmdbId !== undefined && existing.tmdbId !== tmdbId) {
      // Two different titles coalesced into the same scan window — fall back to full queue check
      existing.tmdbId = undefined;
    } else if (tmdbId !== undefined && existing.tmdbId === undefined) {
      // Already a full-queue check; a single-title hint can't narrow it back down
    } else if (tmdbId !== undefined) {
      existing.tmdbId = tmdbId;
    }
    console.warn(`[library-scan] ${mediaType} debounced, firing in ${SCAN_DEBOUNCE_MS}ms`);
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
    tmdbId,
  };
  pending.set(mediaType, entry);
  console.warn(`[library-scan] ${mediaType} scheduled, firing in ${SCAN_DEBOUNCE_MS}ms`);
  return promise;
}

async function runScan(mediaType: ScanMediaType): Promise<void> {
  const entry = pending.get(mediaType);
  if (!entry) return;

  let stillInQueue: boolean;
  if (entry.tmdbId !== undefined) {
    stillInQueue = mediaType === "movie"
      ? await isMovieDownloadingInRadarr(entry.tmdbId)
      : await isSeriesDownloadingInSonarr(entry.tmdbId);
  } else {
    const count = mediaType === "movie"
      ? await countRadarrQueue()
      : await countSonarrQueue();
    stillInQueue = count !== null && count > 0;
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

  pending.delete(mediaType);
  try {
    await triggerLibraryScan(mediaType);
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

  console.warn(
    `[library-scan] ${mediaType} start plex=${plexConfigured ? "yes" : "no"} jellyfin=${jellyfinConfigured ? "yes" : "no"}`,
  );

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
        console.warn(`[library-scan] plex ${mediaType} triggered sections=${targets.length}`);
      })().catch((err) => console.error(`[library-scan] plex ${mediaType}:`, err)),
    );
  }

  if (jellyfinConfigured) {
    const baseUrl = jellyfinUrlRow!.value!;
    const apiKey = jellyfinKeyRow!.value!;
    jobs.push(
      refreshJellyfinLibrary(baseUrl, apiKey)
        .then(() => console.warn(`[library-scan] jellyfin ${mediaType} triggered`))
        .catch((err) => console.error(`[library-scan] jellyfin ${mediaType}:`, err)),
    );
  }

  await Promise.all(jobs);
}
