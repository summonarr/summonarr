// Watch sync, Plex ⇄ Jellyfin — the PURE half: which plays belong to a pair,
// and which items on the other server they mark. Zero runtime imports, so the
// unit suite pins every rule without a DB or a server. The data half is
// watch-sync-data.ts.
//
// What it does: an ADMIN pairs a Plex account (a MediaServerUser on one Plex
// server) with a Jellyfin user (a MediaServerUser on one Jellyfin server), and
// picks a direction ("both" by default):
//   - Plex → Jellyfin: every movie and episode Plex's own history COUNTED as
//     watched for that account (/status/sessions/history/all — Plex's "played"
//     threshold, never Summonarr's 80% one) is marked played in the Jellyfin
//     account, with Plex's viewedAt as the play date.
//   - Jellyfin → Plex: every item the Jellyfin user has PLAYED (Jellyfin's own
//     flag) is marked watched for the Plex account (/:/scrobble — no date can
//     be sent).
//
// Rules (guardrail 19e):
//   - ADD-ONLY in both directions. Nothing here ever marks an item unplayed:
//     neither server's record says "marked unwatched" reliably, and an unmark is
//     not recoverable.
//   - No echo. An item this sync marked on one side is never read back as a
//     source on that side (`skipItemKeys` / `skipItemIds`), and an item already
//     played on the target is recorded "already" without a write — so a mark
//     can't bounce back and forth or bump a play count.
//   - It never writes PlayHistory. A mark creates no session on either server,
//     so the play-history poller and SSE stream never see it (guardrail 19).
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

export type WatchSyncDirection = "both" | "toJellyfin" | "toPlex";
export const WATCH_SYNC_DIRECTIONS: readonly WatchSyncDirection[] = ["both", "toJellyfin", "toPlex"];

export function parseWatchSyncDirection(v: unknown): WatchSyncDirection | null {
  return typeof v === "string" && (WATCH_SYNC_DIRECTIONS as readonly string[]).includes(v) ? (v as WatchSyncDirection) : null;
}

// Does a pair stored with `direction` sync toward `target`? An unknown stored
// value syncs NOTHING (fail closed: a write into someone's account needs an
// explicit direction).
export function syncsToward(direction: string, target: "toJellyfin" | "toPlex"): boolean {
  return direction === "both" || direction === target;
}

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
  // Plex items THIS sync marked watched for the account (Jellyfin → Plex): their
  // history entries are our own echo, never a source.
  skipItemKeys: ReadonlySet<string> = new Set(),
): PairPlaysResult {
  const since = pair.historyReadTo === null ? null : pair.historyReadTo.getTime() - WATCH_SYNC_HISTORY_OVERLAP_MS;
  const plays: WatchSyncPlay[] = [];
  let unresolved = 0;
  for (const e of entries) {
    if (normalizePlexAccountId(e.accountId, ownerAccountId) !== pair.plexAccountId) continue;
    // An undated entry on an incremental run can't be placed in the window;
    // the first (full) run took it.
    if (since !== null && (e.viewedAt === null || e.viewedAt.getTime() < since)) continue;
    if (skipItemKeys.has(e.itemKey)) continue;
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

// ── Jellyfin → Plex ─────────────────────────────────────────────────────────

// One played item from the Jellyfin user's list (upstream-watch's parser).
export interface JellyfinPlayedInput {
  kind: "movie" | "episode";
  itemKey: string;
  showKey: string | null;
  seasonNumber: number | null;
  episodeNumber: number | null;
  lastPlayedAt: Date | null;
}

// Where a pair's Jellyfin played list must be read back to: undefined (all of
// it) on a first run, otherwise the read point minus the overlap.
export function jellyfinStopBefore(readTo: Date | null): Date | undefined {
  return readTo === null ? undefined : new Date(readTo.getTime() - WATCH_SYNC_HISTORY_OVERLAP_MS);
}

export function newestPlayedAt(items: readonly JellyfinPlayedInput[]): Date | null {
  let best: number | null = null;
  for (const it of items) {
    const t = it.lastPlayedAt?.getTime();
    if (t !== undefined && Number.isFinite(t) && (best === null || t > best)) best = t;
  }
  return best === null ? null : new Date(best);
}

// The Jellyfin user's played items as plays: a movie resolves by its own item
// id, an episode by its series id, through the Jellyfin library cache. Items
// THIS sync marked played (Plex → Jellyfin) are skipped — our own echo.
export function playsFromJellyfin(
  items: readonly JellyfinPlayedInput[],
  jellyfinTitleForId: (itemId: string) => PlexTitle | null,
  skipItemIds: ReadonlySet<string> = new Set(),
): PairPlaysResult {
  const plays: WatchSyncPlay[] = [];
  let unresolved = 0;
  for (const it of items) {
    if (skipItemIds.has(it.itemKey)) continue;
    if (it.kind === "movie") {
      const title = jellyfinTitleForId(it.itemKey);
      if (!title || title.mediaType !== "MOVIE") { unresolved++; continue; }
      plays.push({ tmdbId: title.tmdbId, mediaType: "MOVIE", seasonNumber: null, episodeNumber: null, viewedAt: it.lastPlayedAt });
      continue;
    }
    const title = it.showKey ? jellyfinTitleForId(it.showKey) : null;
    if (!title || title.mediaType !== "TV" || it.seasonNumber === null || it.episodeNumber === null) { unresolved++; continue; }
    plays.push({ tmdbId: title.tmdbId, mediaType: "TV", seasonNumber: it.seasonNumber, episodeNumber: it.episodeNumber, viewedAt: it.lastPlayedAt });
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

// The items a set of plays can mark on the TARGET server — Jellyfin item ids, or
// Plex ratingKeys. Every copy of a title is listed.
export interface MarkTargets {
  // tmdbId → every movie item id/key for it on the pair's target server.
  movies: ReadonlyMap<number, readonly string[]>;
  // tmdbId → (season:episode → episode item ids/keys) on the target server. A
  // TV title absent here is not on that server.
  episodes: ReadonlyMap<number, ReadonlyMap<string, readonly string[]>>;
}
export type JellyfinTargets = MarkTargets;

export interface PlannedMark {
  // A Jellyfin item id or a Plex ratingKey, per the direction.
  targetId: string;
  // The LATEST Plex viewedAt among the plays that map to this item.
  datePlayed: Date | null;
}

export interface PlanResult {
  marks: PlannedMark[];
  // Plays whose title or episode is not on the pair's Jellyfin server.
  unmatched: number;
}

export function planMarks(plays: readonly WatchSyncPlay[], targets: MarkTargets): PlanResult {
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
  return { marks: [...byItem].map(([targetId, datePlayed]) => ({ targetId, datePlayed })), unmatched };
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

// ── Resume positions (pair.syncProgress) ─────────────────────────────────────
//
// An in-progress item ("played 12 min") is copied to the other server as a
// resume point. The rules keep it from fighting the user or itself:
//   - Only a real resume point moves: at least WATCH_SYNC_PROGRESS_MIN_MS in and
//     short of WATCH_SYNC_PROGRESS_MAX_FRACTION of the runtime (past that the
//     item is watched, which the played-state sync handles).
//   - The NEWER side wins (Plex lastViewedAt vs Jellyfin LastPlayedDate). A
//     target that has seen activity since the source's never gets overwritten:
//     the user moved on there (finished it, restarted it).
//   - Within WATCH_SYNC_PROGRESS_TOLERANCE_MS nothing is written, so a copy can't
//     bounce back as a "change" on the next run.
//   - Watched beats in-progress: a target that is played with no resume point is
//     left alone, and nothing here ever clears a played flag.

export const WATCH_SYNC_PROGRESS_MIN_MS = 60_000;
export const WATCH_SYNC_PROGRESS_TOLERANCE_MS = 30_000;
export const WATCH_SYNC_PROGRESS_MAX_FRACTION = 0.95;
// Titles considered per pair per run.
export const WATCH_SYNC_PROGRESS_MAX_UNITS = 200;

export interface ProgressState {
  positionMs: number;
  durationMs: number | null;
  // The server's last-activity stamp for this user and item; null = unknown.
  lastActivity: Date | null;
  played: boolean;
}

export function isResumePoint(s: ProgressState | null): boolean {
  if (!s || !Number.isFinite(s.positionMs) || s.positionMs < WATCH_SYNC_PROGRESS_MIN_MS) return false;
  if (s.durationMs && s.durationMs > 0 && s.positionMs / s.durationMs >= WATCH_SYNC_PROGRESS_MAX_FRACTION) return false;
  return true;
}

export interface ProgressDecision {
  target: "toJellyfin" | "toPlex";
  positionMs: number;
}

// One title's state on each side → the write to make, if any. `direction` is
// the pair's; a side missing on a server (null) is never a target.
export function decideProgress(
  plex: ProgressState | null,
  jellyfin: ProgressState | null,
  direction: string,
): ProgressDecision | null {
  const plexResume = isResumePoint(plex);
  const jfResume = isResumePoint(jellyfin);
  if (!plex || !jellyfin || (!plexResume && !jfResume)) return null;
  const t = (s: ProgressState) => s.lastActivity?.getTime() ?? null;

  let source: "plex" | "jellyfin";
  if (plexResume && jfResume) {
    const a = t(plex);
    const b = t(jellyfin);
    if (a === null || b === null || a === b) return null; // can't tell which is newer: leave both
    source = a > b ? "plex" : "jellyfin";
  } else {
    source = plexResume ? "plex" : "jellyfin";
  }
  const src = source === "plex" ? plex : jellyfin;
  const dst = source === "plex" ? jellyfin : plex;
  const target = source === "plex" ? "toJellyfin" : "toPlex";
  if (!syncsToward(direction, target)) return null;
  if (Math.abs(src.positionMs - dst.positionMs) <= WATCH_SYNC_PROGRESS_TOLERANCE_MS) return null;
  // Watched beats in-progress.
  if (dst.played && !isResumePoint(dst)) return null;
  // The target saw activity at or after the source's: the user moved on there.
  const ts = t(src);
  const td = t(dst);
  if (td !== null && (ts === null || td >= ts)) return null;
  return { target, positionMs: Math.round(src.positionMs) };
}

// The progress unit a play belongs to: a movie, or one episode of a show.
export function progressUnitKey(p: Pick<WatchSyncPlay, "tmdbId" | "mediaType" | "seasonNumber" | "episodeNumber">): string | null {
  if (p.mediaType === "MOVIE") return `m:${p.tmdbId}`;
  if (p.seasonNumber === null || p.seasonNumber < 1 || p.episodeNumber === null) return null;
  return `e:${p.tmdbId}:${p.seasonNumber}:${p.episodeNumber}`;
}

// Several copies of one title on a server: the one the user touched last.
export function latestState(states: ReadonlyArray<ProgressState>): ProgressState | null {
  let best: ProgressState | null = null;
  for (const s of states) {
    if (!best) { best = s; continue; }
    const a = s.lastActivity?.getTime() ?? -Infinity;
    const b = best.lastActivity?.getTime() ?? -Infinity;
    if (a > b || (a === b && s.positionMs > best.positionMs)) best = s;
  }
  return best;
}

// Every copy of a play's title on the target, from resolved MarkTargets.
export function targetIdsFor(p: WatchSyncPlay, targets: MarkTargets): readonly string[] {
  if (p.mediaType === "MOVIE") return targets.movies.get(p.tmdbId) ?? [];
  if (p.seasonNumber === null || p.seasonNumber < 1 || p.episodeNumber === null) return [];
  return targets.episodes.get(p.tmdbId)?.get(`${p.seasonNumber}:${p.episodeNumber}`) ?? [];
}

// ── Run budget and checkpoints ───────────────────────────────────────────────
//
// A first run can be big (a whole history, an episode walk per show). It is
// planned OLDEST FIRST in chunks of WATCH_SYNC_PLAN_CHUNK plays, and the read
// point moves to each finished chunk's newest play — so everything at or
// before the read point is queued, and a run cut short resumes exactly where
// it stopped (the next read takes only plays after the read point, less the
// overlap; the ledger absorbs the overlap). The whole run gets
// WATCH_SYNC_RUN_BUDGET_MS, below the advisory lock's 30-minute timeout, so it
// stops on its own terms and records what it did.

export const WATCH_SYNC_PLAN_CHUNK = 200;
export const WATCH_SYNC_RUN_BUDGET_MS = 20 * 60 * 1000;
export const WATCH_SYNC_STOPPED_MESSAGE = "Stopped at the run time limit; continues on the next run";

// Oldest play first; undated plays first of all (they can't be placed after a
// read point, so a first run takes them before any dated chunk moves it).
export function oldestFirst<T extends { viewedAt: Date | null }>(plays: readonly T[]): T[] {
  return [...plays].sort((a, b) => (a.viewedAt?.getTime() ?? -Infinity) - (b.viewedAt?.getTime() ?? -Infinity));
}

// The newest dated play in a chunk — the read point once it is queued.
export function chunkReadTo(chunk: ReadonlyArray<{ viewedAt: Date | null }>): Date | null {
  let best: number | null = null;
  for (const p of chunk) {
    const t = p.viewedAt?.getTime();
    if (t !== undefined && Number.isFinite(t) && (best === null || t > best)) best = t;
  }
  return best === null ? null : new Date(best);
}

// ── admin page ordering ──────────────────────────────────────────────────────

// A–Z ignoring case and accents, numbers in natural order ("user2" < "user10").
const NAME_COLLATOR = new Intl.Collator("en", { sensitivity: "base", numeric: true });

export function compareNames(a: string, b: string): number {
  return NAME_COLLATOR.compare(a, b);
}

// Server accounts by user name, then server, then id — a total order, so the
// page never reshuffles between loads.
export function compareServerUsers(
  a: { username: string; serverInstance: string; id: string },
  b: { username: string; serverInstance: string; id: string },
): number {
  return compareNames(a.username, b.username) || compareNames(a.serverInstance, b.serverInstance) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
}
