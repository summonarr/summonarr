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

// watchTitleKey back into its title, or null for a key it never made.
export function parseWatchTitleKey(key: string): WatchTitle | null {
  const m = /^([1-9][0-9]*):(MOVIE|TV)$/.exec(key);
  if (!m) return null;
  const tmdbId = Number(m[1]);
  return Number.isSafeInteger(tmdbId) ? { tmdbId, mediaType: m[2] === "MOVIE" ? "MOVIE" : "TV" } : null;
}

// How long a play whose item the library cache doesn't know yet HOLDS its
// identity's read point. Newly added media is often watched before the hourly
// library sync indexes it; without the hold the read point moved past that
// play and it was never imported. Past this the play is taken as never going
// to resolve (deleted, unmatched) so a dead item can't stall the import.
export const UNRESOLVED_HOLD_MS = 48 * 60 * 60 * 1000;

// What a fold may count: plays strictly after `readTo` (the stored read point)
// and, when `readUntil` is set, at or before it. `holdUnresolvedSince` asks for
// the oldest dated unresolved play at or after that time (see heldReadPoint).
export interface FoldBounds {
  readUntil?: Date | null;
  holdUnresolvedSince?: Date | null;
}

export interface FoldResult {
  deltas: Map<string, PlayDelta>;
  unresolved: number;
  // The oldest dated unresolved play at or after holdUnresolvedSince, if any.
  heldAt: Date | null;
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
function inWindow(at: Date | null, readTo: Date | null, readUntil: Date | null = null): boolean {
  if (readUntil !== null && (at === null || at.getTime() > readUntil.getTime())) return false;
  if (readTo === null) return true;
  return at !== null && at.getTime() > readTo.getTime();
}

function noteUnresolved(acc: { unresolved: number; heldAt: Date | null }, at: Date | null, holdSince: Date | null): void {
  acc.unresolved++;
  if (holdSince === null || at === null || at.getTime() < holdSince.getTime()) return;
  if (acc.heldAt === null || at.getTime() < acc.heldAt.getTime()) acc.heldAt = at;
}

/**
 * The read point a fold that found `heldAt` may move to: just before the held
 * play, so it is read again — and resolved — next run, never past `next` and
 * never back past `readTo`. Re-fold with this as `readUntil` so the plays
 * after it are counted next run, not now (once, never twice).
 */
export function heldReadPoint(next: Date | null, heldAt: Date, readTo: Date | null): Date {
  let point = new Date(heldAt.getTime() - 1);
  if (next !== null && next.getTime() < point.getTime()) point = next;
  if (readTo !== null && point.getTime() < readTo.getTime()) point = readTo;
  return point;
}

// Plex: the server-wide history split by account ONCE, with the owner's local
// id "1" rewritten to their plex.tv id (the watch-sync rule), so each identity
// folds only its own records instead of the whole walk.
export function groupPlexHistoryByAccount<R extends PlexHistoryRecord>(
  records: Iterable<R>,
  ownerAccountId: string | null,
): Map<string, R[]> {
  const out = new Map<string, R[]>();
  for (const r of records) {
    if (r.accountId === null) continue;
    const account = r.accountId === "1" && ownerAccountId ? ownerAccountId : r.accountId;
    const bucket = out.get(account);
    if (bucket) bucket.push(r);
    else out.set(account, [r]);
  }
  return out;
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
  bounds: FoldBounds = {},
): FoldResult {
  const deltas = new Map<string, PlayDelta>();
  const acc = { unresolved: 0, heldAt: null as Date | null };
  for (const r of records) {
    if (r.accountId === null) continue;
    const account = r.accountId === "1" && ownerAccountId ? ownerAccountId : r.accountId;
    if (account !== plexAccountId) continue;
    if (!inWindow(r.viewedAt, readTo, bounds.readUntil ?? null)) continue;
    const key = r.kind === "movie" ? r.itemKey : r.showKey;
    const title = key ? titleFor(key) : null;
    const want: MediaType = r.kind === "movie" ? "MOVIE" : "TV";
    if (!title || title.mediaType !== want) {
      noteUnresolved(acc, r.viewedAt, bounds.holdUnresolvedSince ?? null);
      continue;
    }
    addDelta(deltas, title, 1, r.viewedAt);
  }
  return { deltas, ...acc };
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
  bounds: FoldBounds = {},
): FoldResult {
  const deltas = new Map<string, PlayDelta>();
  const acc = { unresolved: 0, heldAt: null as Date | null };
  for (const it of items) {
    if (!inWindow(it.lastPlayedAt, readTo, bounds.readUntil ?? null)) continue;
    const key = it.kind === "movie" ? it.itemKey : it.showKey;
    const title = key ? titleFor(key) : null;
    const want: MediaType = it.kind === "movie" ? "MOVIE" : "TV";
    if (!title || title.mediaType !== want) {
      noteUnresolved(acc, it.lastPlayedAt, bounds.holdUnresolvedSince ?? null);
      continue;
    }
    const plays = readTo === null ? Math.max(1, Math.floor(it.playCount)) : 1;
    addDelta(deltas, title, plays, it.lastPlayedAt);
  }
  return { deltas, ...acc };
}

// The newest dated play in a read — the identity's next read point. Never moves
// a read point backwards.
export function nextReadTo(current: Date | null, plays: Iterable<Date | null>): Date | null {
  let out = current;
  for (const at of plays) out = later(out, at);
  return out;
}

// The stored name of a title the library cache has no name for (yet).
export function placeholderTitle(tmdbId: number): string {
  return `TMDB #${tmdbId}`;
}

// One identity's stored rows after a read: deltas ADD plays and keep the later
// date. `favorites` is the full favorite set read this run (null = not read,
// so every stored flag stands); a favorite with no plays is kept as a 0-play
// row, and a row with neither plays nor a favorite is dropped. Newest first,
// capped at MAX_SERVER_WATCHED_TITLES (favorites outrank undated rows).
//
// `titleOf` is the library cache's name for a title, null when it has none. A
// row this read touches (a play or a favorite) takes the cache's current name,
// so one first stored under the placeholder, or an outdated name, is corrected.
export function mergeServerWatchedRows(
  existing: readonly WatchedTitleRow[],
  deltas: ReadonlyMap<string, PlayDelta>,
  favorites: ReadonlySet<string> | null,
  titleOf: (t: WatchTitle) => string | null,
): WatchedTitleRow[] {
  const byKey = new Map<string, WatchedTitleRow>();
  for (const r of existing) byKey.set(watchTitleKey(r.tmdbId, r.mediaType), { ...r });
  const rename = (r: WatchedTitleRow) => {
    const known = titleOf(r);
    if (known !== null && known !== r.title) r.title = known;
  };
  const nameOf = (t: WatchTitle) => titleOf(t) ?? placeholderTitle(t.tmdbId);
  for (const [k, d] of deltas) {
    const prior = byKey.get(k);
    if (prior) {
      prior.plays += d.plays;
      prior.lastWatchedAt = later(prior.lastWatchedAt, d.lastWatchedAt);
      rename(prior);
    } else {
      byKey.set(k, { tmdbId: d.tmdbId, mediaType: d.mediaType, title: nameOf(d), plays: d.plays, lastWatchedAt: d.lastWatchedAt, favorite: false });
    }
  }
  if (favorites !== null) {
    for (const [k, r] of byKey) {
      r.favorite = favorites.has(k);
      if (r.favorite) rename(r);
    }
    for (const k of favorites) {
      if (byKey.has(k)) continue;
      // A key watchTitleKey never made can't name a title: dropped, not guessed.
      const t = parseWatchTitleKey(k);
      if (!t) continue;
      byKey.set(k, { ...t, title: nameOf(t), plays: 0, lastWatchedAt: null, favorite: true });
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
    if (o.title !== r.title || o.plays !== r.plays || o.favorite !== r.favorite || (o.lastWatchedAt?.getTime() ?? null) !== (r.lastWatchedAt?.getTime() ?? null)) return false;
  }
  return true;
}
