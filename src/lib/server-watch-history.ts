// Pure rules for importing each person's watch history from the media servers'
// OWN records into ServerWatchedTitle, for "For You" only (guardrail 40c). The
// run that reads the servers lives in server-watch-history-data.ts.
//
// Why it exists: PlayHistory is the live poller's log (guardrail 19), so it
// starts the day Summonarr was installed. Plex keeps every account's history and
// Jellyfin keeps every user's played flags, going back years. Without them, For
// You seeds from a sliver of someone's taste and happily recommends films they
// watched before the install.
//
// What it is NOT: a play. Nothing here writes PlayHistory, and no stat, activity
// page or play count reads ServerWatchedTitle — those numbers stay exactly what
// guardrail 19 says they are.
//
// Counting is INCREMENTAL so the servers are read lightly: Plex's history is
// walked only back to the oldest identity's read point, and each Jellyfin user
// is asked only for what they played since theirs. An identity's rows and its
// read point commit together, so a failed write never makes plays count twice.
// No imports beyond types: everything below is unit-tested directly.

import type { MediaType } from "@/generated/prisma";

export interface WatchTitle {
  tmdbId: number;
  mediaType: MediaType;
}

export interface PlayDelta extends WatchTitle {
  plays: number;
  lastWatchedAt: Date | null;
}

export interface WatchedTitleRow extends WatchTitle {
  title: string;
  plays: number;
  lastWatchedAt: Date | null;
  favorite: boolean;
}

// Rows kept per server identity. A heavy viewer's whole history is a few
// thousand titles; this only bounds a hostile or runaway server. Newest kept.
export const MAX_SERVER_WATCHED_TITLES = 20_000;

export function watchTitleKey(tmdbId: number, mediaType: MediaType): string {
  return `${tmdbId}:${mediaType}`;
}

function later(a: Date | null, b: Date | null): Date | null {
  if (!a) return b;
  if (!b) return a;
  return b.getTime() > a.getTime() ? b : a;
}

function addDelta(out: Map<string, PlayDelta>, title: WatchTitle, plays: number, at: Date | null): void {
  const k = watchTitleKey(title.tmdbId, title.mediaType);
  const prior = out.get(k);
  if (prior) {
    prior.plays += plays;
    prior.lastWatchedAt = later(prior.lastWatchedAt, at);
  } else {
    out.set(k, { tmdbId: title.tmdbId, mediaType: title.mediaType, plays, lastWatchedAt: at });
  }
}

// Whether a dated play falls in the unread window. With a read point, an
// undated play can't be placed and is skipped (the full first read took it);
// a play AT the read point was already counted (strictly after, never at).
function inWindow(at: Date | null, readTo: Date | null): boolean {
  if (readTo === null) return true;
  return at !== null && at.getTime() > readTo.getTime();
}

export interface PlexHistoryRecord {
  kind: "movie" | "episode";
  itemKey: string;
  showKey: string | null;
  viewedAt: Date | null;
  // Plex's LOCAL account id: "1" is the owner, everyone else is their plex.tv id.
  accountId: string | null;
}

// Plex: one identity's plays out of a server-wide history walk. `plexAccountId`
// is the identity's plex.tv id (MediaServerUser.sourceUserId); the owner's plays
// are recorded under the local id "1", which is rewritten to `ownerAccountId`
// (the watch-sync rule). A movie resolves by its own ratingKey, an episode by
// its show's. One record is one play.
export function foldPlexHistory(
  records: Iterable<PlexHistoryRecord>,
  plexAccountId: string,
  ownerAccountId: string | null,
  readTo: Date | null,
  titleFor: (ratingKey: string) => WatchTitle | null,
): { deltas: Map<string, PlayDelta>; unresolved: number } {
  const deltas = new Map<string, PlayDelta>();
  let unresolved = 0;
  for (const r of records) {
    if (r.accountId === null) continue;
    const account = r.accountId === "1" && ownerAccountId ? ownerAccountId : r.accountId;
    if (account !== plexAccountId) continue;
    if (!inWindow(r.viewedAt, readTo)) continue;
    const key = r.kind === "movie" ? r.itemKey : r.showKey;
    const title = key ? titleFor(key) : null;
    const want: MediaType = r.kind === "movie" ? "MOVIE" : "TV";
    if (!title || title.mediaType !== want) {
      unresolved++;
      continue;
    }
    addDelta(deltas, title, 1, r.viewedAt);
  }
  return { deltas, unresolved };
}

export interface JellyfinPlayedRecord {
  kind: "movie" | "episode";
  itemKey: string;
  showKey: string | null;
  lastPlayedAt: Date | null;
  playCount: number;
}

// Jellyfin: one user's played items. A FULL read (no read point) counts each
// item's own PlayCount — Jellyfin's lifetime tally. An incremental read counts
// ONE play per item played since the read point: PlayCount is a lifetime total,
// so adding it again would recount every earlier play of a rewatched item.
export function foldJellyfinPlayed(
  items: Iterable<JellyfinPlayedRecord>,
  readTo: Date | null,
  titleFor: (itemId: string) => WatchTitle | null,
): { deltas: Map<string, PlayDelta>; unresolved: number } {
  const deltas = new Map<string, PlayDelta>();
  let unresolved = 0;
  for (const it of items) {
    if (!inWindow(it.lastPlayedAt, readTo)) continue;
    const key = it.kind === "movie" ? it.itemKey : it.showKey;
    const title = key ? titleFor(key) : null;
    const want: MediaType = it.kind === "movie" ? "MOVIE" : "TV";
    if (!title || title.mediaType !== want) {
      unresolved++;
      continue;
    }
    const plays = readTo === null ? Math.max(1, Math.floor(it.playCount)) : 1;
    addDelta(deltas, title, plays, it.lastPlayedAt);
  }
  return { deltas, unresolved };
}

// The newest dated play in a read — the identity's next read point. Never moves
// a read point backwards.
export function nextReadTo(current: Date | null, plays: Iterable<Date | null>): Date | null {
  let out = current;
  for (const at of plays) out = later(out, at);
  return out;
}

// One identity's stored rows after a read: deltas ADD plays and keep the later
// date. `favorites` is the full favorite set read this run (null = not read,
// so every stored flag stands); a favorite with no plays is kept as a 0-play
// row, and a row with neither plays nor a favorite is dropped. Newest first,
// capped at MAX_SERVER_WATCHED_TITLES (favorites outrank undated rows).
export function mergeServerWatchedRows(
  existing: readonly WatchedTitleRow[],
  deltas: ReadonlyMap<string, PlayDelta>,
  favorites: ReadonlySet<string> | null,
  titleOf: (t: WatchTitle) => string,
): WatchedTitleRow[] {
  const byKey = new Map<string, WatchedTitleRow>();
  for (const r of existing) byKey.set(watchTitleKey(r.tmdbId, r.mediaType), { ...r });
  for (const [k, d] of deltas) {
    const prior = byKey.get(k);
    if (prior) {
      prior.plays += d.plays;
      prior.lastWatchedAt = later(prior.lastWatchedAt, d.lastWatchedAt);
    } else {
      byKey.set(k, { tmdbId: d.tmdbId, mediaType: d.mediaType, title: titleOf(d), plays: d.plays, lastWatchedAt: d.lastWatchedAt, favorite: false });
    }
  }
  if (favorites !== null) {
    for (const [k, r] of byKey) r.favorite = favorites.has(k);
    for (const k of favorites) {
      if (byKey.has(k)) continue;
      const [id, type] = k.split(":");
      const t: WatchTitle = { tmdbId: Number(id), mediaType: type as MediaType };
      byKey.set(k, { ...t, title: titleOf(t), plays: 0, lastWatchedAt: null, favorite: true });
    }
  }
  return [...byKey.values()]
    .filter((r) => r.plays > 0 || r.favorite)
    .sort(
      (a, b) =>
        (b.lastWatchedAt?.getTime() ?? -Infinity) - (a.lastWatchedAt?.getTime() ?? -Infinity) ||
        Number(b.favorite) - Number(a.favorite) ||
        a.tmdbId - b.tmdbId,
    )
    .slice(0, MAX_SERVER_WATCHED_TITLES);
}

// Whether two row lists are the same stored state, so an identity with nothing
// new is not rewritten every run.
export function sameServerWatchedRows(a: readonly WatchedTitleRow[], b: readonly WatchedTitleRow[]): boolean {
  if (a.length !== b.length) return false;
  const byKey = new Map(a.map((r) => [watchTitleKey(r.tmdbId, r.mediaType), r]));
  for (const r of b) {
    const o = byKey.get(watchTitleKey(r.tmdbId, r.mediaType));
    if (!o) return false;
    if (o.plays !== r.plays || o.favorite !== r.favorite || (o.lastWatchedAt?.getTime() ?? null) !== (r.lastWatchedAt?.getTime() ?? null)) return false;
  }
  return true;
}
