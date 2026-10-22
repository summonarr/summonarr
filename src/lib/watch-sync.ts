// Watch sync, Plex → Jellyfin — the PURE half: which Plex plays belong to a
// pair, and which Jellyfin items they mark. Zero runtime imports, so the unit
// suite pins every rule without a DB or a server. The data half is
// watch-sync-data.ts.
//
// What it does: an ADMIN pairs a Plex account (a MediaServerUser on one Plex
// server) with a Jellyfin user (a MediaServerUser on one Jellyfin server). Every
// movie and episode Plex's own history COUNTED as watched for that account
// (/status/sessions/history/all — Plex's "played" threshold, never Summonarr's
// 80% one) is marked played in that Jellyfin account, with Plex's viewedAt as
// the play date.
//
// Rules (guardrail 19e):
//   - One-way and ADD-ONLY. Nothing here ever marks an item unplayed: Plex's
//     history can't say "marked unwatched", and an unmark is not recoverable.
//   - It never writes PlayHistory. A mark creates no Jellyfin session, so the
//     5s poller (the sole Jellyfin PlayHistory writer, guardrail 19) never sees it.
//   - Nothing is paired automatically. A Plex account and a Jellyfin user linked
//     to the same Summonarr user are only SUGGESTED to the admin.
//   - A title is matched by TMDB id through each server's library cache; an
//     episode by (season, episode) inside the matched series. Season 0 (specials)
//     is never matched — the two servers number specials independently, and a
//     wrong mark is worse than a missing one. Every Jellyfin copy of a title
//     (guardrail 37) is marked.

import type { PlexHistoryEntry } from "./upstream-watch";

// Plex history is re-read this far behind where the last read reached, so an
// entry Plex wrote late (a play finalized after a later one) is not skipped.
// The per-pair ledger makes the re-read free: a re-planned item is a duplicate.
export const WATCH_SYNC_HISTORY_OVERLAP_MS = 2 * 60 * 60 * 1000;
// Marks applied per pair per run. A first run (the whole history) queues
// everything at once and drains over the following runs.
export const WATCH_SYNC_BATCH = 500;
// A failed mark is retried on later runs until it has failed this many times.
export const WATCH_SYNC_MAX_ATTEMPTS = 5;
// A multi-episode file claims at most this many episode numbers (a hostile
// IndexNumberEnd can't make the index unbounded).
export const WATCH_SYNC_MAX_EPISODE_SPAN = 50;

export type WatchSyncMediaType = "MOVIE" | "TV";

export interface WatchSyncPairInput {
  id: string;
  // The Plex MediaServerUser's sourceUserId: the plex.tv account id.
  plexAccountId: string;
  // Where this pair's history was last read to; null = never (full backfill).
  historyReadTo: Date | null;
}

// A Plex play that belongs to a pair, resolved to a TMDB title.
export interface WatchSyncPlay {
  tmdbId: number;
  mediaType: WatchSyncMediaType;
  // Episodes only.
  seasonNumber: number | null;
  episodeNumber: number | null;
  viewedAt: Date | null;
}

export interface PlexTitle {
  tmdbId: number;
  mediaType: WatchSyncMediaType;
}

// Plex reports the SERVER OWNER's plays under the local account id "1", never
// their plex.tv id (the play-history poller rewrites it the same way). Every
// MediaServerUser row is keyed by the plex.tv id, so the owner's history only
// matches a pair once "1" is rewritten. Unknown owner id ⇒ left as "1", which
// matches no pair.
export function normalizePlexAccountId(accountId: string | null, ownerAccountId: string | null): string | null {
  if (accountId === null) return null;
  return accountId === "1" && ownerAccountId ? ownerAccountId : accountId;
}

// Where one Plex server's history must be read back to for this run: undefined
// (the whole history) when any enabled pair has never been read, otherwise the
// OLDEST pair's read point minus the overlap.
export function historyStopBefore(pairs: readonly WatchSyncPairInput[]): Date | undefined {
  let oldest: number | null = null;
  for (const p of pairs) {
    if (p.historyReadTo === null) return undefined;
    const t = p.historyReadTo.getTime();
    if (oldest === null || t < oldest) oldest = t;
  }
  return oldest === null ? undefined : new Date(oldest - WATCH_SYNC_HISTORY_OVERLAP_MS);
}

// The newest viewedAt in a read — what every pair on that server has now been
// read to. null when the read had no dated entry (keep the previous mark).
export function newestViewedAt(entries: readonly PlexHistoryEntry[]): Date | null {
  let best: number | null = null;
  for (const e of entries) {
    const t = e.viewedAt?.getTime();
    if (t !== undefined && Number.isFinite(t) && (best === null || t > best)) best = t;
  }
  return best === null ? null : new Date(best);
}

export interface PairPlaysResult {
  plays: WatchSyncPlay[];
  // This account's plays whose title is not in the Plex library cache (or that
  // carry no usable key/episode numbers) — counted, never guessed at.
  unresolved: number;
}

// The plays in one Plex server's history read that belong to `pair`: its
// account (owner id rewritten), on or after its read point minus the overlap
// (all of them on a first run), resolved to a TMDB title through the Plex
// library cache. A movie resolves by its own ratingKey, an episode by its
// show's.
export function playsForPair(
  entries: readonly PlexHistoryEntry[],
  pair: WatchSyncPairInput,
  ownerAccountId: string | null,
  plexTitleForKey: (ratingKey: string) => PlexTitle | null,
): PairPlaysResult {
  const since = pair.historyReadTo === null ? null : pair.historyReadTo.getTime() - WATCH_SYNC_HISTORY_OVERLAP_MS;
  const plays: WatchSyncPlay[] = [];
  let unresolved = 0;
  for (const e of entries) {
    if (normalizePlexAccountId(e.accountId, ownerAccountId) !== pair.plexAccountId) continue;
    // An undated entry on an incremental run can't be placed in the window;
    // the first (full) run took it.
    if (since !== null && (e.viewedAt === null || e.viewedAt.getTime() < since)) continue;
    if (e.kind === "movie") {
      const title = plexTitleForKey(e.itemKey);
      if (!title || title.mediaType !== "MOVIE") { unresolved++; continue; }
      plays.push({ tmdbId: title.tmdbId, mediaType: "MOVIE", seasonNumber: null, episodeNumber: null, viewedAt: e.viewedAt });
      continue;
    }
    const title = e.showKey ? plexTitleForKey(e.showKey) : null;
    if (!title || title.mediaType !== "TV" || e.seasonNumber === null || e.episodeNumber === null) { unresolved++; continue; }
    plays.push({ tmdbId: title.tmdbId, mediaType: "TV", seasonNumber: e.seasonNumber, episodeNumber: e.episodeNumber, viewedAt: e.viewedAt });
  }
  return { plays, unresolved };
}

// The TV titles a set of plays needs episode lists for (specials excluded —
// they are never matched).
export function seriesNeeded(plays: readonly WatchSyncPlay[]): number[] {
  const out = new Set<number>();
  for (const p of plays) if (p.mediaType === "TV" && p.seasonNumber !== null && p.seasonNumber > 0) out.add(p.tmdbId);
  return [...out];
}

export interface EpisodeIdRow {
  seasonNumber: number;
  episodeNumber: number;
  episodeNumberEnd: number | null;
  itemId: string;
}

// (season, episode) → every Jellyfin episode item that holds it, across every
// copy of the series. A multi-episode file answers for each number it spans.
export function indexEpisodes(rows: Iterable<EpisodeIdRow>): Map<string, string[]> {
  const out = new Map<string, string[]>();
  for (const r of rows) {
    const last = r.episodeNumberEnd !== null
      ? Math.min(r.episodeNumberEnd, r.episodeNumber + WATCH_SYNC_MAX_EPISODE_SPAN - 1)
      : r.episodeNumber;
    for (let n = r.episodeNumber; n <= last; n++) {
      const k = `${r.seasonNumber}:${n}`;
      const ids = out.get(k);
      if (!ids) out.set(k, [r.itemId]);
      else if (!ids.includes(r.itemId)) ids.push(r.itemId);
    }
  }
  return out;
}

export interface JellyfinTargets {
  // tmdbId → every Jellyfin movie item id for it on the pair's server.
  movies: ReadonlyMap<number, readonly string[]>;
  // tmdbId → (season:episode → episode item ids) on the pair's server. A TV
  // title absent here is not on that Jellyfin server.
  episodes: ReadonlyMap<number, ReadonlyMap<string, readonly string[]>>;
}

export interface PlannedMark {
  jellyfinItemId: string;
  // The LATEST Plex viewedAt among the plays that map to this item.
  datePlayed: Date | null;
}

export interface PlanResult {
  marks: PlannedMark[];
  // Plays whose title or episode is not on the pair's Jellyfin server.
  unmatched: number;
}

export function planMarks(plays: readonly WatchSyncPlay[], targets: JellyfinTargets): PlanResult {
  const byItem = new Map<string, Date | null>();
  let unmatched = 0;
  const add = (id: string, at: Date | null) => {
    if (!byItem.has(id)) { byItem.set(id, at); return; }
    const prev = byItem.get(id) ?? null;
    if (at && (!prev || at > prev)) byItem.set(id, at);
  };
  for (const p of plays) {
    let ids: readonly string[] | undefined;
    if (p.mediaType === "MOVIE") {
      ids = targets.movies.get(p.tmdbId);
    } else if (p.seasonNumber !== null && p.seasonNumber > 0 && p.episodeNumber !== null) {
      ids = targets.episodes.get(p.tmdbId)?.get(`${p.seasonNumber}:${p.episodeNumber}`);
    }
    if (!ids || ids.length === 0) { unmatched++; continue; }
    for (const id of ids) add(id, p.viewedAt);
  }
  return { marks: [...byItem].map(([jellyfinItemId, datePlayed]) => ({ jellyfinItemId, datePlayed })), unmatched };
}

export type WatchSyncMarkStatus = "pending" | "marked" | "already" | "missing" | "failed";

// Bounded, single-line error text for the ledger and the admin page — never a
// URL (an admin-configured server address) or a token.
export function safeWatchSyncError(err: unknown): string {
  const raw = err instanceof Error ? err.message : String(err);
  return raw
    .replace(/https?:\/\/\S+/gi, "<url>")
    .replace(/(token|api_key|apikey)=\S+/gi, "$1=<redacted>")
    .replace(/\s+/g, " ")
    .slice(0, 300);
}
