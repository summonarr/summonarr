import { processSingleton } from "@/lib/process-singleton";

// A short memory for the Plex picker's candidate list. Opening it fires five Plex
// agent searches (30s timeouts) plus a TMDB detail read per candidate, and a
// re-open, a second admin or a Fix-all run walking the same title paid that again
// every time. Display-only: the POST never reads it, and a fix-match run drops
// the lists it made stale — a remap changes what Plex would answer, and a
// Jellyfin remap changes the Jellyfin path a list shows.
const TTL_MS = 3 * 60_000;
const MAX_ENTRIES = 50;

type Entry = { at: number; body: unknown };
const entries = processSingleton("fix-match-candidates:cache", () => new Map<string, Entry>());

// The listed title (mediaType + tmdbId) is part of the key because a Plex
// list also carries that title's Jellyfin path: a Jellyfin remap of it makes
// the list stale without touching any Plex item (dropCandidatesForTitles).
export function candidateCacheKey(parts: {
  serverInstance: string; ratingKey: string; correctTmdbId: number; arrHint: number | null;
  mediaType: "MOVIE" | "TV"; tmdbId: number;
}): string {
  return `${parts.serverInstance}|${parts.ratingKey}|${parts.correctTmdbId}|${parts.arrHint ?? ""}|${parts.mediaType}:${parts.tmdbId}`;
}

/**
 * Drops every cached list for these Plex items on one server — what a remap of
 * them makes stale — and keeps every other title's. Reads the server and item
 * back out of candidateCacheKey's format (an instance slug never holds a "|").
 */
export function dropCandidatesFor(serverInstance: string, ratingKeys: readonly string[]): void {
  if (ratingKeys.length === 0) return;
  const items = new Set(ratingKeys);
  for (const key of [...entries.keys()]) {
    const [instance, ratingKey] = key.split("|");
    if (instance === serverInstance && ratingKey !== undefined && items.has(ratingKey)) entries.delete(key);
  }
}

/**
 * Drops every cached list (on any Plex server) for these titles — what a
 * Jellyfin remap of them makes stale, since each list shows its title's
 * Jellyfin path — and keeps every other title's.
 */
export function dropCandidatesForTitles(mediaType: "MOVIE" | "TV", tmdbIds: readonly number[]): void {
  const titles = new Set(tmdbIds.filter((id) => id > 0).map((id) => `${mediaType}:${id}`));
  if (titles.size === 0) return;
  for (const key of [...entries.keys()]) {
    const title = key.slice(key.lastIndexOf("|") + 1);
    if (titles.has(title)) entries.delete(key);
  }
}

// `T` is the one body type the candidates route stores (CandidatesResponse);
// the cache is that route's alone, so the read hands back what it wrote.
export function getCachedCandidates<T>(key: string, now: number = Date.now()): T | null {
  const hit = entries.get(key);
  if (!hit) return null;
  if (now - hit.at >= TTL_MS) { entries.delete(key); return null; }
  // A read refreshes the entry's place (least recently USED goes first), not
  // its age: the TTL still counts from when the list was built.
  entries.delete(key);
  entries.set(key, hit);
  return hit.body as T;
}

export function setCachedCandidates(key: string, body: unknown, now: number = Date.now()): void {
  // Re-setting a key moves it to the newest slot (Map keeps a key's original
  // insertion position on set) and never evicts an unrelated entry for it.
  entries.delete(key);
  if (entries.size >= MAX_ENTRIES) {
    // Least recently used first; Map iterates in insertion order, and a read
    // re-inserts its entry.
    const oldest = entries.keys().next().value;
    if (oldest !== undefined) entries.delete(oldest);
  }
  entries.set(key, { at: now, body });
}

export function clearCandidateCache(): void {
  entries.clear();
}
