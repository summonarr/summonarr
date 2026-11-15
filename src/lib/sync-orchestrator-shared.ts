// Sync orchestrator (sync-orchestrator.ts): what every phase shares — the run's
// feature flags, the run-start request snapshot and the small keyed helpers.
import { prisma } from "./prisma";
import { arrRowKey } from "./arr-availability";
import { isFeatureEnabled } from "./features";

const CONCURRENCY_LIMIT = 5;

export async function runConcurrent<T>(
  items: T[],
  fn: (item: T) => Promise<void>
): Promise<void> {
  for (let i = 0; i < items.length; i += CONCURRENCY_LIMIT) {
    await Promise.all(items.slice(i, i + CONCURRENCY_LIMIT).map(fn));
  }
}

// ARR cache + requests are keyed by (tmdbId, arrInstance slug) so each configured
// instance stays independent. Library marking stays instance-agnostic (keyed by
// tmdbId) — a Plex/Jellyfin hit marks every instance's request for that title AVAILABLE.
export const vkey = arrRowKey;

// Per-instance presence accumulator: tmdbId → the set of server slugs that hold it.
// The union maps below answer "is this title anywhere", which is no longer a
// sufficient answer once a restricted instance's library counts as availability
// ONLY for the users granted `view` on it — a per-requester decision has to know
// WHICH server holds the title. Populated from the same per-instance fetch
// results as the union, so it can never disagree with it and costs no extra query.
export const addPresence = (m: Map<number, Set<string>>, tmdbId: number, slug: string): void => {
  const existing = m.get(tmdbId);
  if (existing) existing.add(slug);
  else m.set(tmdbId, new Set([slug]));
};

// Inverse of addPresence, for ids the ratingKey dedupe dropped from an
// instance's written rows: remove that instance's contribution and, when no
// other instance still holds the id, the union entry itself. Without this the
// marking pass reads ids the written rows don't contain — flipping requests
// AVAILABLE (and notifying) for titles every badge reader calls missing, and
// permanently so, since conflations are stable properties of the library.
export const removePresence = <V>(
  slugs: Map<number, Set<string>>,
  ids: Map<number, V>,
  tmdbId: number,
  slug: string,
): void => {
  const holders = slugs.get(tmdbId);
  holders?.delete(slug);
  if (!holders || holders.size === 0) {
    slugs.delete(tmdbId);
    ids.delete(tmdbId);
  }
};

// tmdbIds present in `input` but absent from `kept` (both carry one row per tmdbId).
export const droppedTmdbIds = <T extends { tmdbId: number }>(input: T[], kept: T[]): number[] => {
  if (kept.length === input.length) return [];
  const keptSet = new Set(kept.map((r) => r.tmdbId));
  return input.filter((r) => !keptSet.has(r.tmdbId)).map((r) => r.tmdbId);
};

export type SyncFlags = { plexEnabled: boolean; jellyfinEnabled: boolean; radarrEnabled: boolean; sonarrEnabled: boolean };
export type WindDown = (arm: string) => boolean;

export async function readSyncFlags(): Promise<SyncFlags> {
  const [plexEnabled, jellyfinEnabled, radarrEnabled, sonarrEnabled] = await Promise.all([
    isFeatureEnabled("feature.integration.plex"),
    isFeatureEnabled("feature.integration.jellyfin"),
    isFeatureEnabled("feature.integration.radarr"),
    isFeatureEnabled("feature.integration.sonarr"),
  ]);
  return { plexEnabled, jellyfinEnabled, radarrEnabled, sonarrEnabled };
}

// The run-start snapshots every phase reads (never re-read: a phase that needs
// the live state queries it itself).
export function readSnapshot() {
  return Promise.all([
    prisma.mediaRequest.findMany({
      where: { status: "APPROVED" },
      select: { id: true, tmdbId: true, mediaType: true, arrInstance: true, requestedBy: true, title: true, posterPath: true, pendingNotifyAt: true, notifiedAvailable: true },
    }),
    prisma.mediaRequest.findMany({
      where: { status: "AVAILABLE" },
      select: { id: true, tmdbId: true, mediaType: true, arrInstance: true, requestedBy: true, title: true, posterPath: true, notifiedAvailable: true },
    }),
  ]);
}
type Snapshot = Awaited<ReturnType<typeof readSnapshot>>;
export type ApprovedRow = Snapshot[0][number];
export type AvailableRow = Snapshot[1][number];
