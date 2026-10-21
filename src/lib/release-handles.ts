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
/** The whole map's bound (every user together). */
export const MAX_RELEASE_HANDLES = 20_000;
/**
 * One user's share of it: past this, a new search of theirs drops THEIR
 * oldest handles first, so one person's run of big searches can't evict
 * everybody else's still-valid ones (a 410 "search again" for them).
 */
export const MAX_RELEASE_HANDLES_PER_OWNER = 5_000;

type Entry = { scope: string; owner: string; guid: string; indexerId: number; title: string; expiresAt: number; claimed: boolean };

const handles = processSingleton("release-handles", () => new Map<string, Entry>());

function sweep(now: number): void {
  for (const [k, e] of handles) if (e.expiresAt <= now) handles.delete(k);
  // Still full of live entries: drop the oldest (insertion order) rather than
  // refuse the newcomer — the admin searching now is the one who will grab.
  while (handles.size >= MAX_RELEASE_HANDLES) handles.delete(handles.keys().next().value as string);
}

// Make room for `incoming` new handles of `owner` within their share: their
// own oldest go first (insertion order), never anyone else's. A single list
// larger than the share still goes in whole — the owner is searching anew.
function trimOwner(owner: string, incoming: number, now: number): void {
  let own = 0;
  for (const e of handles.values()) if (e.owner === owner && e.expiresAt > now) own++;
  let excess = own + incoming - MAX_RELEASE_HANDLES_PER_OWNER;
  if (excess <= 0) return;
  for (const [k, e] of handles) {
    if (excess <= 0) break;
    if (e.owner !== owner) continue;
    handles.delete(k);
    if (e.expiresAt > now) excess--;
  }
}

/**
 * Copies of `releases` with `guid` replaced by a fresh handle for `scope` (the
 * request, instance and season the search was for), issued to `owner` (the
 * user searching — what the per-user share counts). Nothing else changes.
 */
export function issueReleaseHandles<T extends { guid: string; indexerId: number; title?: string }>(
  scope: string,
  releases: readonly T[],
  opts: { owner: string; now?: number },
): T[] {
  const now = opts.now ?? Date.now();
  trimOwner(opts.owner, releases.length, now);
  if (handles.size + releases.length >= MAX_RELEASE_HANDLES) sweep(now);
  return releases.map((r) => {
    const handle = randomBytes(16).toString("hex");
    handles.set(handle, { scope, owner: opts.owner, guid: r.guid, indexerId: r.indexerId, title: (r.title ?? "").slice(0, 300), expiresAt: now + RELEASE_HANDLE_TTL_MS, claimed: false });
    return { ...r, guid: handle };
  });
}

/**
 * The release behind a handle, or null when unknown, expired, or issued for a
 * different search. `title` is the release name, for the audit (never the guid).
 */
export function redeemReleaseHandle(scope: string, handle: string, now: number = Date.now()): { guid: string; indexerId: number; title: string } | null {
  const e = handles.get(handle);
  if (!e) return null;
  if (e.expiresAt <= now) {
    handles.delete(handle);
    return null;
  }
  if (e.scope !== scope) return null;
  return { guid: e.guid, indexerId: e.indexerId, title: e.title };
}

export type ReleaseClaim = { guid: string; indexerId: number; title: string } | "unknown" | "busy";

/**
 * Claim a handle for ONE grab: the check-and-set is synchronous, so of two
 * requests racing with the same handle (a double submit, a replay) exactly one
 * gets the release and the other `"busy"` — they would otherwise both send it
 * and the download client fetches it twice. `"unknown"` is redeemReleaseHandle's
 * null. The caller then spends it (`forgetReleaseHandle`) once the arr took the
 * grab, or hands it back (`releaseReleaseHandle`) when the arr definitely
 * refused it.
 */
export function claimReleaseHandle(scope: string, handle: string, now: number = Date.now()): ReleaseClaim {
  const picked = redeemReleaseHandle(scope, handle, now);
  if (!picked) return "unknown";
  const e = handles.get(handle) as Entry;
  if (e.claimed) return "busy";
  e.claimed = true;
  return picked;
}

/** Hand a claimed handle back: the arr refused the grab, so the release may be tried again. */
export function releaseReleaseHandle(handle: string): void {
  const e = handles.get(handle);
  if (e) e.claimed = false;
}

/**
 * Spend a handle once its grab was accepted — or once its outcome is unknown
 * (a timeout: the arr may well have taken it) — so the same release is never
 * sent to the arr twice.
 */
export function forgetReleaseHandle(handle: string): void {
  handles.delete(handle);
}

/** Test seam. */
export function _resetReleaseHandlesForTests(): void {
  handles.clear();
}
