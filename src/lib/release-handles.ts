// Opaque handles for interactive-search results. A Radarr/Sonarr release's
// `guid` is the INDEXER's identifier, and some indexers (and Prowlarr's
// proxied feeds) build it from the download link — apikey included. The
// request "Pick release" list goes to MANAGE_REQUESTS delegates, so the guid
// never leaves the server there: each release is handed out under a random
// handle bound to the search it came from, and the grab redeems the handle.
//
// In memory, per process (Summonarr is one long-lived Node server — the same
// assumption guardrail 17 rests on). A handle outlives Radarr/Sonarr's own
// release cache (30 minutes), after which the grab would fail upstream anyway;
// a restart drops every handle and the admin searches again.
import { randomBytes } from "node:crypto";
import { processSingleton } from "./process-singleton";

export const RELEASE_HANDLE_TTL_MS = 30 * 60_000;
const MAX_HANDLES = 20_000;

type Entry = { scope: string; guid: string; indexerId: number; expiresAt: number };

const handles = processSingleton("release-handles", () => new Map<string, Entry>());

function sweep(now: number): void {
  for (const [k, e] of handles) if (e.expiresAt <= now) handles.delete(k);
  // Still full of live entries: drop the oldest (insertion order) rather than
  // refuse the newcomer — the admin searching now is the one who will grab.
  while (handles.size >= MAX_HANDLES) handles.delete(handles.keys().next().value as string);
}

/**
 * Copies of `releases` with `guid` replaced by a fresh handle for `scope` (the
 * request, instance and season the search was for). Nothing else changes.
 */
export function issueReleaseHandles<T extends { guid: string; indexerId: number }>(
  scope: string,
  releases: readonly T[],
  now: number = Date.now(),
): T[] {
  if (handles.size + releases.length >= MAX_HANDLES) sweep(now);
  return releases.map((r) => {
    const handle = randomBytes(16).toString("hex");
    handles.set(handle, { scope, guid: r.guid, indexerId: r.indexerId, expiresAt: now + RELEASE_HANDLE_TTL_MS });
    return { ...r, guid: handle };
  });
}

/** The release behind a handle, or null when unknown, expired, or issued for a different search. */
export function redeemReleaseHandle(scope: string, handle: string, now: number = Date.now()): { guid: string; indexerId: number } | null {
  const e = handles.get(handle);
  if (!e) return null;
  if (e.expiresAt <= now) {
    handles.delete(handle);
    return null;
  }
  if (e.scope !== scope) return null;
  return { guid: e.guid, indexerId: e.indexerId };
}

/** Test seam. */
export function _resetReleaseHandlesForTests(): void {
  handles.clear();
}
