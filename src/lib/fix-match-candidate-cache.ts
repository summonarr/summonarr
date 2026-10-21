import { processSingleton } from "@/lib/process-singleton";

// A short memory for the Plex picker's candidate list. Opening it fires five Plex
// agent searches (30s timeouts) plus a TMDB detail read per candidate, and a
// re-open, a second admin or a Fix-all run walking the same title paid that again
// every time. Display-only: the POST never reads it, and any fix-match run clears
// it — a remap changes what Plex would answer.
const TTL_MS = 3 * 60_000;
const MAX_ENTRIES = 50;

type Entry = { at: number; body: unknown };
const entries = processSingleton("fix-match-candidates:cache", () => new Map<string, Entry>());

export function candidateCacheKey(parts: { serverInstance: string; ratingKey: string; correctTmdbId: number; arrHint: number | null }): string {
  return `${parts.serverInstance}|${parts.ratingKey}|${parts.correctTmdbId}|${parts.arrHint ?? ""}`;
}

export function getCachedCandidates<T>(key: string, now: number = Date.now()): T | null {
  const hit = entries.get(key);
  if (!hit) return null;
  if (now - hit.at >= TTL_MS) { entries.delete(key); return null; }
  return hit.body as T;
}

export function setCachedCandidates(key: string, body: unknown, now: number = Date.now()): void {
  if (entries.size >= MAX_ENTRIES) {
    // Oldest first; Map iterates in insertion order.
    const oldest = entries.keys().next().value;
    if (oldest !== undefined) entries.delete(oldest);
  }
  entries.set(key, { at: now, body });
}

export function clearCandidateCache(): void {
  entries.clear();
}
