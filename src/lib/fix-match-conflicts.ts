import { processSingleton } from "./process-singleton";
import { getFixMatchJob } from "./fix-match-jobs";

// Two fix-match jobs that rewrite the SAME server item must not run side by
// side. The job registry joins only an identical remap (same item, same
// target): "A→B" and then "A→C" — an admin correcting a wrong pick while the
// first job is still polling — got two jobs that unmatched and re-matched one
// Plex ratingKey / Jellyfin item against each other, and could leave one key on
// two library rows until the next resync. The second is refused instead; it
// can be sent again once the first has finished.

/** What a fix-match job rewrites on the media server. */
export type FixMatchScope = {
  server: "plex" | "jellyfin";
  serverInstance: string;
  mediaType: "MOVIE" | "TV";
  // The title's current id; 0 for an unmatched item (item mode).
  tmdbId: number;
  // Item mode: the one item it remaps. Absent: every copy holding `tmdbId`.
  itemKey?: string;
};

/**
 * Whether two jobs would rewrite the same server item: the same item, or a
 * title-mode job and any job on that title (a title-mode job remaps every copy
 * holding the id). Two item-mode jobs on different items of one title don't
 * overlap — each moves only its own item, under the library lock.
 */
export function fixMatchScopesOverlap(a: FixMatchScope, b: FixMatchScope): boolean {
  if (a.server !== b.server || a.serverInstance !== b.serverInstance) return false;
  if (a.itemKey !== undefined && b.itemKey !== undefined) return a.itemKey === b.itemKey;
  return a.mediaType === b.mediaType && a.tmdbId > 0 && a.tmdbId === b.tmdbId;
}

// Process-wide like the job registry itself (27a): the job id → its key and scope,
// for every job still running or queued.
const active = processSingleton("fix-match:active-scopes", () => new Map<string, { key: string; scope: FixMatchScope }>());

function stillActive(jobId: string): boolean {
  const status = getFixMatchJob(jobId)?.status;
  return status === "running" || status === "queued";
}

/**
 * A running or queued job under ANOTHER key that overlaps `scope`, or null. A
 * job under the same key is not a conflict — the registry joins it. Call it
 * synchronously right before startFixMatchJob, then noteFixMatchScope, so no
 * other request can start in between.
 */
export function findOverlappingFixMatchJob(key: string, scope: FixMatchScope): string | null {
  for (const [jobId, entry] of active) {
    if (!stillActive(jobId)) {
      active.delete(jobId);
      continue;
    }
    if (entry.key !== key && fixMatchScopesOverlap(entry.scope, scope)) return jobId;
  }
  return null;
}

export function noteFixMatchScope(jobId: string, key: string, scope: FixMatchScope): void {
  active.set(jobId, { key, scope });
}
