// The media servers' OWN watch records — the PURE half: parsers, aggregation and
// the agreement self-check. Zero runtime imports, so the unit suite pins every
// rule without a DB, and plex.ts/jellyfin.ts (both DB-free) can parse while they
// page instead of holding hundreds of thousands of raw records in memory.
//
// What this is for: the never-watched report (guardrail 14d) and the cleanup
// rules are used to DELETE media, so a false "never watched" is the failure that
// matters. Plex keeps an all-account watch history and Jellyfin a per-user
// played/resumable flag that cover plays Summonarr never saw — before it was
// installed, while it was down, while tracking was off. Those records are read
// here as READ-ONLY evidence that a title WAS watched. They never write
// PlayHistory (guardrail 19) and never make anything look LESS watched.
//
// The two sources do not see the same plays. Plex's history lists only views
// Plex COUNTED as watched (past the server's "video played" threshold), so a
// Plex view started and abandoned before Summonarr was installed leaves no
// upstream evidence; Jellyfin's IsResumable list does carry a started-but-
// unfinished item, and it counts here as one use. Accepted, not a bug: such a
// Plex title reads "no plays in recorded history since <date>" — an honest
// claim over its stated window. Closing it would need per-account On Deck /
// viewOffset reads (managed users' own tokens), which is a feature.
//
// The join keys the report uses (never-watched-data.ts, step 5):
//   - a MOVIE row's itemKey is the movie's own Plex ratingKey / Jellyfin item Id,
//     seasonNumber -1;
//   - a TV row's itemKey is the SHOW's Plex ratingKey / Jellyfin SeriesId, and
//     seasonNumber is the episode's season (-1 when unknown).
//
// UNVERIFIED upstream shapes (checked against public documentation and client
// code, NOT against a live server — confirm before trusting a change here):
//   - Plex GET /status/sessions/history/all returns MediaContainer.Metadata[]
//     entries, one per recorded (i.e. COUNTED-as-watched) view — not every
//     started play — carrying `type` ("movie" | "episode" | …),
//     `ratingKey`, `key` ("/library/metadata/<id>"), `grandparentKey`
//     ("/library/metadata/<showId>"), sometimes `grandparentRatingKey`,
//     `parentIndex` (season), `index` (episode), `viewedAt` (epoch SECONDS) and
//     `accountID`. With the server owner's token it covers every account.
//   - Jellyfin GET /Users/{id}/Items?Filters=IsPlayed|IsResumable returns Items[]
//     with `Type` ("Movie" | "Episode"), `Id`, `SeriesId`, `ParentIndexNumber`,
//     and `UserData.{PlayCount, LastPlayedDate}` (ISO string).
// Every parser below is defensive about those shapes: numbers or numeric
// strings, absent fields, foreign types. A record it can't place is dropped,
// never guessed at — and the data layer's self-check (matched / agreement) is
// what turns "the shape changed" into a loud failure instead of silence.

import type { NwMediaType } from "./never-watched";

export type UpstreamKind = "movie" | "episode";

export interface PlexHistoryEntry {
  kind: UpstreamKind;
  // The item's OWN ratingKey (the movie, or the episode).
  itemKey: string;
  // The show's ratingKey for an episode; null for a movie or when unknown.
  showKey: string | null;
  // Plex parentIndex for an episode (0 = specials); null when unknown.
  seasonNumber: number | null;
  viewedAt: Date | null;
  accountId: string | null;
}

export interface JellyfinPlayedItem {
  kind: UpstreamKind;
  // The item's OWN Id (the movie, or the episode).
  itemKey: string;
  // SeriesId for an episode; null for a movie or when unknown.
  showKey: string | null;
  // ParentIndexNumber for an episode; null when unknown.
  seasonNumber: number | null;
  lastPlayedAt: Date | null;
  // UserData.PlayCount, at least 1: a resumable item with PlayCount 0 was still
  // started, which is one use.
  playCount: number;
}

// One UpstreamWatchEvidence row before its (source, serverInstance, fetchedAt).
export interface UpstreamEvidenceRow {
  itemKey: string;
  // -1 = the whole item: a movie, or an episode whose season is unknown.
  seasonNumber: number;
  mediaType: NwMediaType;
  playCount: number;
  lastPlayedAt: Date | null;
}

// Anything aggregateUpstream accepts: both parsers' outputs fit.
export interface UpstreamPlay {
  kind: UpstreamKind;
  itemKey: string;
  showKey: string | null;
  seasonNumber: number | null;
  playCount?: number;
  viewedAt?: Date | null;
  lastPlayedAt?: Date | null;
}

// The agreement self-check compares against plays Summonarr itself recorded in
// this window (further bounded by how far back the fetched history reaches).
export const UPSTREAM_AGREEMENT_WINDOW_MS = 90 * 86_400_000;

// The PK column is VarChar(256); a longer "key" is garbage, not an id.
const MAX_KEY_LENGTH = 256;

function asRecord(raw: unknown): Record<string, unknown> | null {
  return raw && typeof raw === "object" && !Array.isArray(raw) ? (raw as Record<string, unknown>) : null;
}

// A Plex ratingKey: a non-negative integer, as a number or a numeric string.
function plexKey(v: unknown): string | null {
  if (typeof v === "number") return Number.isSafeInteger(v) && v >= 0 ? String(v) : null;
  if (typeof v !== "string") return null;
  const s = v.trim();
  return /^\d+$/.test(s) && s.length <= MAX_KEY_LENGTH ? s : null;
}

// The id inside a Plex metadata path: "/library/metadata/123" (optionally
// followed by "/children" etc.).
function plexKeyFromPath(v: unknown): string | null {
  if (typeof v !== "string") return null;
  const m = /\/library\/metadata\/(\d+)(?:[/?#]|$)/.exec(v);
  return m && m[1].length <= MAX_KEY_LENGTH ? m[1] : null;
}

// A Jellyfin item id (a 32-hex GUID in practice). Any non-empty, bounded,
// whitespace-free string is accepted — the join decides whether it is real.
function jellyfinKey(v: unknown): string | null {
  if (typeof v !== "string") return null;
  const s = v.trim();
  return s.length > 0 && s.length <= MAX_KEY_LENGTH && !/\s/.test(s) ? s : null;
}

// A season / count style integer >= 0, as a number or a numeric string.
function nonNegativeInt(v: unknown): number | null {
  const n = typeof v === "number" ? v : typeof v === "string" && /^\s*\d+\s*$/.test(v) ? Number(v) : NaN;
  return Number.isSafeInteger(n) && n >= 0 ? n : null;
}

function epochSecondsToDate(v: unknown): Date | null {
  const n = typeof v === "number" ? v : typeof v === "string" && /^\s*\d+(\.\d+)?\s*$/.test(v) ? Number(v) : NaN;
  if (!Number.isFinite(n) || n <= 0) return null;
  const d = new Date(n * 1000);
  return Number.isFinite(d.getTime()) ? d : null;
}

function isoToDate(v: unknown): Date | null {
  if (typeof v !== "string" || v.length === 0) return null;
  const d = new Date(v);
  // Jellyfin writes DateTime.MinValue ("0001-01-01T00:00:00Z") for "never".
  return Number.isFinite(d.getTime()) && d.getTime() > 0 ? d : null;
}

function kindOf(v: unknown): UpstreamKind | null {
  if (typeof v !== "string") return null;
  const t = v.trim().toLowerCase();
  return t === "movie" || t === "episode" ? t : null;
}

export function parsePlexHistoryItem(raw: unknown): PlexHistoryEntry | null {
  const o = asRecord(raw);
  if (!o) return null;
  const kind = kindOf(o.type);
  if (!kind) return null;
  const itemKey = plexKey(o.ratingKey) ?? plexKeyFromPath(o.key);
  if (!itemKey) return null;
  const accountId = typeof o.accountID === "number" || typeof o.accountID === "string" ? String(o.accountID).trim() || null : null;
  return {
    kind,
    itemKey,
    showKey: kind === "episode" ? plexKey(o.grandparentRatingKey) ?? plexKeyFromPath(o.grandparentKey) : null,
    seasonNumber: kind === "episode" ? nonNegativeInt(o.parentIndex) : null,
    viewedAt: epochSecondsToDate(o.viewedAt),
    accountId,
  };
}

// Plex history also records music, photos and extras. Those are not library
// titles, so they don't count as watch records: a music-only history must not
// read as "the server returned records and none matched" (a broken parser).
// Everything else — movies, episodes, and any type this list doesn't know —
// counts, so a renamed or reshaped video record still surfaces as a mismatch.
const PLEX_NON_TITLE_TYPES = new Set(["track", "album", "artist", "photo", "photoalbum", "picture", "clip", "trailer", "playlist"]);

export function countsAsPlexWatchRecord(raw: unknown): boolean {
  const o = asRecord(raw);
  if (!o) return false;
  return !(typeof o.type === "string" && PLEX_NON_TITLE_TYPES.has(o.type.trim().toLowerCase()));
}

export function parseJellyfinPlayedItem(raw: unknown): JellyfinPlayedItem | null {
  const o = asRecord(raw);
  if (!o) return null;
  const kind = kindOf(o.Type);
  if (!kind) return null;
  const itemKey = jellyfinKey(o.Id);
  if (!itemKey) return null;
  const userData = asRecord(o.UserData);
  const playCount = nonNegativeInt(userData?.PlayCount) ?? 0;
  return {
    kind,
    itemKey,
    showKey: kind === "episode" ? jellyfinKey(o.SeriesId) : null,
    seasonNumber: kind === "episode" ? nonNegativeInt(o.ParentIndexNumber) : null,
    lastPlayedAt: isoToDate(userData?.LastPlayedDate),
    playCount: Math.max(1, playCount),
  };
}

export function defaultUpstreamMediaType(kind: UpstreamKind): NwMediaType {
  return kind === "movie" ? "MOVIE" : "TV";
}

// Fold individual plays into evidence rows: one per movie (season -1), one per
// (show, season) for episodes (-1 when the season is unknown). Play counts sum;
// the date is the LATEST dated play — an undated play never overwrites a real
// date, and a group made only of undated plays keeps null (the report reads
// that as "watched, date unknown"). An episode with no show key can't be placed
// on a title and is skipped here (it still counts toward the agreement check,
// and the data layer counts it as an unplaced episode BEFORE aggregating — most
// episodes unplaced is a "failed" snapshot, upstreamEpisodesUnplaced).
// Grouping is by (itemKey, season) — the table's primary key within a server.
export function aggregateUpstream(
  items: Iterable<UpstreamPlay>,
  mediaTypeFor: (kind: UpstreamKind) => NwMediaType = defaultUpstreamMediaType,
): UpstreamEvidenceRow[] {
  const groups = new Map<string, UpstreamEvidenceRow>();
  for (const it of items) {
    const key = it.kind === "movie" ? it.itemKey : it.showKey;
    if (!key) continue;
    const season = it.kind === "movie" || it.seasonNumber == null || it.seasonNumber < 0 ? -1 : it.seasonNumber;
    const count = typeof it.playCount === "number" && Number.isFinite(it.playCount) && it.playCount >= 1 ? Math.floor(it.playCount) : 1;
    const at = it.viewedAt ?? it.lastPlayedAt ?? null;
    const gk = `${key}\u0000${season}`;
    const g = groups.get(gk);
    if (!g) {
      groups.set(gk, { itemKey: key, seasonNumber: season, mediaType: mediaTypeFor(it.kind), playCount: count, lastPlayedAt: at });
      continue;
    }
    g.playCount += count;
    if (at && (!g.lastPlayedAt || at > g.lastPlayedAt)) g.lastPlayedAt = at;
  }
  return [...groups.values()];
}

// Of the items Summonarr itself recorded as fully watched, how many the server
// also reports. A parser that misreads the keys agrees with nothing.
export function computeAgreement(
  recordedItemKeys: ReadonlySet<string>,
  upstreamRawItemKeys: ReadonlySet<string>,
): { samples: number; agreed: number } {
  let agreed = 0;
  for (const k of recordedItemKeys) if (upstreamRawItemKeys.has(k)) agreed++;
  return { samples: recordedItemKeys.size, agreed };
}

// The earliest DATED view among the fetched records — how far back the server's
// history reaches (Plex may retain less than Summonarr recorded, or the fetch
// may stop at its cap). Null when nothing is dated.
export function earliestViewed(items: Iterable<{ viewedAt?: Date | null; lastPlayedAt?: Date | null }>): Date | null {
  let best: Date | null = null;
  for (const it of items) {
    const at = it.viewedAt ?? it.lastPlayedAt ?? null;
    if (at && (!best || at < best)) best = at;
  }
  return best;
}

// Start of the agreement window: the last UPSTREAM_AGREEMENT_WINDOW_MS, but never
// before the earliest record the fetch reached (`floor`). With no floor (Jellyfin
// keeps flags, not a dated log; or the history came back empty) the whole window
// is used, so an empty answer from a server Summonarr saw plenty of plays on
// reads as disagreement — not as "nothing to compare".
export function agreementSince(now: Date, floor: Date | null): Date {
  const windowStart = new Date(now.getTime() - UPSTREAM_AGREEMENT_WINDOW_MS);
  return floor && floor > windowStart ? floor : windowStart;
}

// Why a refresh failed, as a closed vocabulary. The status row stores the
// English text (log lines and older readers print it); the page translates the
// CODE (upstreamErrorCode) through a literal key map, never the stored words —
// so this table is the ONE place each phrase is spelled, for writer and reader.
export type UpstreamErrorCode =
  | "timeout" | "unreachable" | "blocked" | "tooLarge" | "redirect"
  | "http" | "noUsers" | "shape" | "noRecords" | "other";

export const UPSTREAM_ERROR_TEXT = {
  timeout: "timed out",
  unreachable: "unreachable",
  blocked: "blocked by the outbound network policy",
  tooLarge: "response too large",
  redirect: "unexpected redirect",
  noUsers: "the server returned no users",
  shape: "unexpected response shape",
  noRecords: "the server returned no watch records",
  other: "request failed",
} as const satisfies Record<Exclude<UpstreamErrorCode, "http">, string>;

const UPSTREAM_HTTP_TEXT = /^HTTP (\d{3})$/;

// A stored failure text → its code (and the HTTP status for "HTTP 401"). Any
// text outside the vocabulary — a row written by a build that worded it
// differently — is "other", never dropped: the page still says the check failed.
export function upstreamErrorCode(error: string | null | undefined): { code: UpstreamErrorCode; httpStatus: number | null } | null {
  if (!error) return null;
  const http = UPSTREAM_HTTP_TEXT.exec(error);
  if (http) return { code: "http", httpStatus: Number(http[1]) };
  for (const [code, text] of Object.entries(UPSTREAM_ERROR_TEXT) as Array<[Exclude<UpstreamErrorCode, "http">, string]>) {
    if (text === error) return { code, httpStatus: null };
  }
  return { code: "other", httpStatus: null };
}

// A short, client-safe description of a failed fetch: never the URL, never a
// token, never upstream body text. Duck-typed on SafeFetchError (`reason`) so
// this module stays import-free.
export function safeUpstreamError(err: unknown): string {
  const reason = (err as { name?: unknown; reason?: unknown } | null)?.name === "SafeFetchError"
    ? (err as { reason?: unknown }).reason
    : null;
  switch (reason) {
    case "timeout": return UPSTREAM_ERROR_TEXT.timeout;
    case "network": return UPSTREAM_ERROR_TEXT.unreachable;
    case "ssrf-blocked": return UPSTREAM_ERROR_TEXT.blocked;
    case "size": return UPSTREAM_ERROR_TEXT.tooLarge;
    case "redirect": return UPSTREAM_ERROR_TEXT.redirect;
  }
  const msg = err instanceof Error ? err.message : typeof err === "string" ? err : "";
  const status = /(?:failed|users|status)[^\d]{0,4}(\d{3})\b/i.exec(msg);
  if (status) return `HTTP ${status[1]}`;
  if (/no users/i.test(msg)) return UPSTREAM_ERROR_TEXT.noUsers;
  if (/MediaContainer/.test(msg)) return UPSTREAM_ERROR_TEXT.shape;
  return UPSTREAM_ERROR_TEXT.other;
}
