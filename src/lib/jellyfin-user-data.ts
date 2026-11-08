// One Jellyfin user's own data: what they played (the never-watched report's
// evidence and watch sync's source), their resume points and favorites, and
// the two watch-sync writes (mark played, set position). Every read is the
// same /Items handler with a userId (see getJellyfinUserPlayedItems), and
// every write is user data only — never a playback session (guardrail 19).
import { safeFetchAdminConfigured } from "./safe-fetch";
import { trimServerBase } from "./server-url";
import { warnOnChange } from "./log-dedup";
import { check, v } from "./validate";
import { parseJellyfinPlayedItem, type JellyfinPlayedItem } from "./upstream-watch";
import { asRecord, STOP_PAGING } from "./media-server-payload";
import { FETCH_TIMEOUT_MS, jellyfinHeaders, jellyfinItemsUrl, type ItemsParam } from "./jellyfin-http";
import { forgetShortfall, isKnownShortfall, rememberShortfall, walkJellyfinSequential } from "./jellyfin-paging";

// A user's movies and episodes under one Filters value, as watch-sync and the
// never-watched report read them. The IsPlayed/IsResumable filter already stops
// collection grouping; jellyfinItemsUrl sends the flag anyway, so a missed
// movie here can't read as never watched.
function userItemsQuery(baseUrl: string, userId: string, types: string, filter: string, extra: readonly ItemsParam[]): string {
  return jellyfinItemsUrl(baseUrl, [
    ["userId", userId],
    ["Recursive", "true"],
    ["IncludeItemTypes", types],
    ["Filters", filter],
    ...extra,
  ]);
}

export type JellyfinMarkPlayedResult = "marked" | "missing";

// A user-data write: the 10.9+ route first, then the legacy one on a 404/405
// ("no such route" on ≤10.8, or "no such user/item"). A 404 on the legacy
// route too is "missing" (the item or user is gone — terminal, not an error).
async function postUserData(currentUrl: string, legacyUrl: string, apiKey: string, label: string, body?: string): Promise<"marked" | "missing"> {
  const attempt = async (url: string): Promise<number> => {
    const res = await safeFetchAdminConfigured(url, { method: "POST", headers: jellyfinHeaders(apiKey), ...(body !== undefined ? { body } : {}), timeoutMs: FETCH_TIMEOUT_MS });
    // The answer (a UserItemDataDto) is not needed; drain it.
    await res.text().catch(() => "");
    return res.status;
  };
  const current = await attempt(currentUrl);
  if (current >= 200 && current < 300) return "marked";
  if (current !== 404 && current !== 405) throw new Error(`Jellyfin ${label} status=${current}`);
  const legacy = await attempt(legacyUrl);
  if (legacy >= 200 && legacy < 300) return "marked";
  if (legacy === 404) return "missing";
  throw new Error(`Jellyfin ${label} status=${legacy}`);
}

// Mark one item played for one user (watch sync). The API key is an admin key,
// so it may act for any user. Routes, read from Jellyfin's PlaystateController:
//   - POST Users/{userId}/PlayedItems/{itemId} — the only route through 10.8,
//     still on master as an [Obsolete] wrapper around the one below;
//   - POST UserPlayedItems/{itemId}?userId= — 10.9+.
// `datePlayed` makes Jellyfin INCREMENT PlayCount (BaseItem.MarkPlayed), so the
// caller must only mark items the user has not already played. The call also
// resets the item's saved resume position.
export async function markJellyfinPlayed(
  baseUrl: string,
  apiKey: string,
  userId: string,
  itemId: string,
  datePlayed: Date | null,
): Promise<JellyfinMarkPlayedResult> {
  const base = trimServerBase(baseUrl);
  const date = datePlayed ? `datePlayed=${encodeURIComponent(datePlayed.toISOString())}` : "";
  const uid = encodeURIComponent(userId);
  const iid = encodeURIComponent(itemId);
  return postUserData(
    `${base}/UserPlayedItems/${iid}?userId=${uid}${date ? `&${date}` : ""}`,
    `${base}/Users/${uid}/PlayedItems/${iid}${date ? `?${date}` : ""}`,
    apiKey,
    "mark played",
  );
}

// One user's played (or started-but-unfinished) movies and episodes — READ-ONLY
// evidence for the never-watched report (src/lib/upstream-watch.ts explains the
// use and lists the UNVERIFIED response-shape assumptions). Sequential paging
// (one user's list can be large and slow to build); parsed while paging.
export interface JellyfinUserPlayedItems {
  // Every item the parser could place.
  items: JellyfinPlayedItem[];
  // Items the server returned, including any the parser could NOT place — the
  // count that makes a changed response shape visible (upstream-watch-data.ts).
  records: number;
}

export async function getJellyfinUserPlayedItems(
  baseUrl: string,
  apiKey: string,
  userId: string,
  filter: "IsPlayed" | "IsResumable",
  opts: { signal?: AbortSignal } = {},
): Promise<JellyfinUserPlayedItems> {
  if (opts.signal?.aborted) return { items: [], records: 0 };
  // `GET /Items?userId=` is the SAME handler as the [Obsolete] (10.9+)
  // `/Users/{userId}/Items`, on every release, read from Jellyfin's source
  // (Jellyfin.Api/Controllers/ItemsController.cs): the legacy action's body is
  // `GetItems(userId, …)`, forwarding every parameter (10.10+ adds indexNumber,
  // master audio/subtitleLanguages, passed as null/[] — none of which we send)
  // — v10.8.13 L679, v10.9.11 L711, v10.10.7 L714, v10.11.11 L716, master L811.
  // GetItems has bound userId FROM THE QUERY since 10.7 (v10.8.13 L155, v10.11.11
  // L163), and 10.6's ServiceStack served both paths from one request DTO. With
  // an API key (role Administrator) RequestHelpers.GetUserId returns the given
  // id, so the Filters, the paging and the UserData are that user's either way.
  const query = userItemsQuery(baseUrl, userId, "Movie,Episode", filter, [
    ["Fields", "SeriesId,ParentIndexNumber"],
    ["EnableUserData", "true"],
    ["EnableImages", "false"],
    ["SortBy", "DateCreated,SortName"],
    ["SortOrder", "Ascending"],
  ]);
  return readUntilSettled(
    () => readPlayedList(query, apiKey, opts.signal),
    opts.signal,
    `jellyfin-played-shortfall:${trimServerBase(baseUrl)}:${userId}:${filter}`,
    { filter, userId },
  );
}

interface PlayedListRead {
  out: JellyfinUserPlayedItems;
  // Page 0's TotalRecordCount; null when the server sent none.
  total: number | null;
}

// One sequential read of a user's list, parsed while paging.
async function readPlayedList(query: string, apiKey: string, signal: AbortSignal | undefined): Promise<PlayedListRead> {
  const out: JellyfinUserPlayedItems = { items: [], records: 0 };
  const total = await walkJellyfinSequential(query, apiKey, (batch) => {
    out.records += batch.length;
    for (const raw of batch) {
      const item = parseJellyfinPlayedItem(raw);
      if (item) out.items.push(item);
    }
    // Stop paging on abort (guardrail 41); the caller discards the result.
    return signal?.aborted === true ? STOP_PAGING : undefined;
  });
  return { out, total };
}

// The list is paged by OFFSET over a filter that can SHRINK mid-walk (a
// resumable item finished, an item marked unplayed, a library scan replacing
// one): every later item shifts down one and the item at the next page
// boundary is never read, while the walk still ends on a short page and reads
// healthy. For the never-watched report that one missing record can be a
// title's only evidence (14d), so a read that returned fewer than page 0
// promised is read again — a growth (records > total) is harmless, the caller
// merges by item key.
async function readUntilSettled(
  read: () => Promise<PlayedListRead>,
  signal: AbortSignal | undefined,
  key: string,
  list: { filter: string; userId: string },
): Promise<JellyfinUserPlayedItems> {
  const complete = (r: PlayedListRead) => signal?.aborted === true || r.total === null || r.out.records >= r.total;
  const first = await read();
  if (complete(first)) {
    forgetShortfall(key);
    return first.out;
  }
  // The same shortfall the last read of this list settled on (below): a
  // server that counts more than it serves. Read it once, not twice, per run.
  if (first.total !== null && isKnownShortfall(key, first.total, first.out.records)) return first.out;
  const second = await read();
  if (complete(second) || second.total === null) {
    forgetShortfall(key);
    return second.out;
  }
  // Short twice with a MOVED count: the list is changing under the read.
  // Throwing fails this server's refresh, which keeps the previous snapshot and
  // holds watch-rule candidates back (`upstreamUnchecked`) — fail-safe.
  if (second.total !== first.total) {
    throw new Error(`Jellyfin ${list.filter} list changed while it was read`);
  }
  // Short twice by the SAME count: a server that counts more than it serves
  // (items hidden from the user, say), not a live change. Throwing would fail
  // every refresh forever; read it as served and say so once (guardrail 7b).
  rememberShortfall(key, second.total, second.out.records);
  warnOnChange(
    key,
    `${second.out.records}/${second.total}`,
    `[jellyfin] ${list.filter} list for user ${list.userId} reports ${second.total} item(s) but serves ${second.out.records}; read as served`,
  );
  return second.out;
}

// Newest play first: watch sync's incremental read and the resume points.
const NEWEST_PLAY_FIRST: readonly ItemsParam[] = [
  ["Fields", "SeriesId,ParentIndexNumber"],
  ["EnableUserData", "true"],
  ["EnableImages", "false"],
  ["SortBy", "DatePlayed,SortName"],
  ["SortOrder", "Descending"],
];

// Watch sync, Jellyfin → Plex (watch-sync.ts): one user's PLAYED items, newest
// play first. With `since`, the walk ends at the first DATED item played before
// it — nothing older is kept — so a routine run reads one page. Undated items
// never end the walk (the Plex history reader is the same): a null
// LastPlayedDate in the page, first or last, is skipped on an incremental read
// and taken only by a full read (no `since`). Treating null as "before the
// bound" stopped the walk at the first undated row, so a page that led with
// one dropped every newer dated play behind it. Same query as
// getJellyfinUserPlayedItems apart from the sort (IndexNumber, the episode
// number, is a default field).
export async function getJellyfinPlayedSince(
  baseUrl: string,
  apiKey: string,
  userId: string,
  opts: { since?: Date; signal?: AbortSignal } = {},
): Promise<JellyfinPlayedItem[]> {
  if (opts.signal?.aborted) return [];
  const query = userItemsQuery(baseUrl, userId, "Movie,Episode", "IsPlayed", NEWEST_PLAY_FIRST);
  const out: JellyfinPlayedItem[] = [];
  const bound = opts.since?.getTime();
  await walkJellyfinSequential(query, apiKey, (batch) => {
    for (const raw of batch) {
      const item = parseJellyfinPlayedItem(raw);
      if (!item) continue;
      if (bound !== undefined) {
        // Undated: cannot be placed in the window. Skip on an incremental run;
        // never treat as "older than bound" or a leading null ends the walk.
        if (item.lastPlayedAt === null) continue;
        if (item.lastPlayedAt.getTime() < bound) return STOP_PAGING;
      }
      out.push(item);
    }
    return opts.signal?.aborted === true ? STOP_PAGING : undefined;
  });
  return out;
}

// ── Watch sync resume positions (watch-sync.ts, guardrail 19e) ───────────────
// Read and written as USER DATA only — never through the Sessions/Playing
// endpoints, which would create a playback session the play-history poller
// records (guardrail 19). Read from Jellyfin's source:
//   POST UserItems/{itemId}/UserData?userId= (10.9+; body UpdateUserItemDataDto)
//   → UserDataManager.SaveUserData, which writes the row and raises
//   UserDataSaved; it holds no session manager. The legacy
//   Users/{userId}/Items/{itemId}/UserData is an [Obsolete] wrapper on master.
// 1 tick = 100 ns, so ms × 10,000.

const TICKS_PER_MS = 10_000;

export interface JellyfinItemProgress {
  kind: "movie" | "episode";
  itemId: string;
  showKey: string | null;
  seasonNumber: number | null;
  episodeNumber: number | null;
  positionMs: number;
  durationMs: number | null;
  lastPlayedAt: Date | null;
  played: boolean;
}

function parseJellyfinItemProgress(raw: unknown): JellyfinItemProgress | null {
  const o = asRecord(raw);
  if (!o) return null;
  const kind = o.Type === "Movie" ? "movie" : o.Type === "Episode" ? "episode" : null;
  if (!kind || typeof o.Id !== "string" || o.Id.length === 0 || o.Id.length > 256) return null;
  const ud = asRecord(o.UserData) ?? {};
  const ticks = typeof ud.PlaybackPositionTicks === "number" && ud.PlaybackPositionTicks > 0 ? ud.PlaybackPositionTicks : 0;
  const run = typeof o.RunTimeTicks === "number" && o.RunTimeTicks > 0 ? o.RunTimeTicks : 0;
  const last = typeof ud.LastPlayedDate === "string" ? new Date(ud.LastPlayedDate) : null;
  const int = (value: unknown) => (typeof value === "number" && Number.isInteger(value) && value >= 0 ? value : null);
  return {
    kind,
    itemId: o.Id,
    showKey: kind === "episode" && typeof o.SeriesId === "string" && o.SeriesId ? o.SeriesId : null,
    seasonNumber: kind === "episode" ? int(o.ParentIndexNumber) : null,
    episodeNumber: kind === "episode" ? int(o.IndexNumber) : null,
    positionMs: Math.floor(ticks / TICKS_PER_MS),
    durationMs: run > 0 ? Math.floor(run / TICKS_PER_MS) : null,
    lastPlayedAt: last && Number.isFinite(last.getTime()) && last.getTime() > 0 ? last : null,
    played: ud.Played === true,
  };
}

const JELLYFIN_PROGRESS_MAX = 500;

/** One user's resumable (in-progress) movies and episodes, newest play first. */
export async function getJellyfinInProgress(baseUrl: string, apiKey: string, userId: string): Promise<JellyfinItemProgress[]> {
  const out: JellyfinItemProgress[] = [];
  await walkJellyfinSequential(
    userItemsQuery(baseUrl, userId, "Movie,Episode", "IsResumable", NEWEST_PLAY_FIRST),
    apiKey,
    (batch) => {
      for (const raw of batch) {
        if (out.length >= JELLYFIN_PROGRESS_MAX) return STOP_PAGING;
        const p = parseJellyfinItemProgress(raw);
        if (p) out.push(p);
      }
      return out.length >= JELLYFIN_PROGRESS_MAX ? STOP_PAGING : undefined;
    },
  );
  return out;
}

// ── Favorites (For You taste, server-watch-history-data.ts) ─────────────────
// One user's favorited movies and SERIES (the heart in Jellyfin's UI) — read
// only, for "For You" seeds. A series is favorited on the series item, never an
// episode, so episodes are not listed. CollapseBoxSetItems=false like every
// /Items query that can list a Movie or a Series (guardrail 37d): with an API
// key a favorited film inside a collection would otherwise come back as its
// BoxSet and be lost.

export interface JellyfinFavorite {
  kind: "movie" | "series";
  itemId: string;
}

export const JELLYFIN_FAVORITES_MAX = 2_000;

export function parseJellyfinFavorite(raw: unknown): JellyfinFavorite | null {
  const o = asRecord(raw);
  if (!o) return null;
  const kind = o.Type === "Movie" ? "movie" : o.Type === "Series" ? "series" : null;
  if (!kind || typeof o.Id !== "string" || o.Id.length === 0 || o.Id.length > 256) return null;
  // Belt and braces: the filter already asks for favorites only, but a server
  // that ignored it must not turn its whole library into "loved".
  const ud = asRecord(o.UserData);
  if (ud && ud.IsFavorite === false) return null;
  return { kind, itemId: o.Id };
}

export async function getJellyfinFavorites(
  baseUrl: string,
  apiKey: string,
  userId: string,
  opts: { signal?: AbortSignal } = {},
): Promise<JellyfinFavorite[]> {
  if (opts.signal?.aborted) return [];
  const out: JellyfinFavorite[] = [];
  await walkJellyfinSequential(
    userItemsQuery(baseUrl, userId, "Movie,Series", "IsFavorite", [
      ["EnableUserData", "true"],
      ["EnableImages", "false"],
      ["SortBy", "SortName"],
      ["SortOrder", "Ascending"],
    ]),
    apiKey,
    (batch) => {
      for (const raw of batch) {
        if (out.length >= JELLYFIN_FAVORITES_MAX) return STOP_PAGING;
        const f = parseJellyfinFavorite(raw);
        if (f) out.push(f);
      }
      return out.length >= JELLYFIN_FAVORITES_MAX || opts.signal?.aborted === true ? STOP_PAGING : undefined;
    },
  );
  return out;
}

const JELLYFIN_IDS_CHUNK = 100;
// Items is required: a reply without it would read as "every item is gone".
const ItemsEnvelope = v.object({ Items: v.array(v.unknown()) });

/**
 * itemId → that item's progress AS SEEN BY the user; absent = gone. An answer
 * that isn't a QueryResult is a failed read, never "every item is gone".
 */
export async function getJellyfinUserStates(baseUrl: string, apiKey: string, userId: string, ids: readonly string[]): Promise<Map<string, JellyfinItemProgress>> {
  const valid = [...new Set(ids.filter((id) => /^[A-Za-z0-9-]{1,64}$/.test(id)))];
  const out = new Map<string, JellyfinItemProgress>();
  for (let i = 0; i < valid.length; i += JELLYFIN_IDS_CHUNK) {
    const chunk = valid.slice(i, i + JELLYFIN_IDS_CHUNK);
    const res = await safeFetchAdminConfigured(
      jellyfinItemsUrl(baseUrl, [
        ["userId", userId],
        ["Ids", chunk.join(",")],
        ["Fields", "SeriesId,ParentIndexNumber"],
        ["EnableUserData", "true"],
        ["EnableImages", "false"],
      ]),
      { headers: jellyfinHeaders(apiKey), timeoutMs: FETCH_TIMEOUT_MS },
    );
    if (!res.ok) throw new Error(`Jellyfin item read failed: ${res.status}`);
    const body = check(ItemsEnvelope, await res.json());
    if (!body.ok) throw new Error(`Jellyfin item read failed: unexpected response (${body.error})`);
    const wanted = new Set(chunk);
    for (const raw of body.value.Items) {
      const p = parseJellyfinItemProgress(raw);
      if (p && wanted.has(p.itemId)) out.set(p.itemId, p);
    }
  }
  return out;
}

/** Set one item's resume position for a user (user data only — no session). 404 on both routes = gone. */
export async function setJellyfinPosition(baseUrl: string, apiKey: string, userId: string, itemId: string, positionMs: number): Promise<"marked" | "missing"> {
  if (!Number.isFinite(positionMs) || positionMs <= 0) return "missing";
  const base = trimServerBase(baseUrl);
  const uid = encodeURIComponent(userId);
  const iid = encodeURIComponent(itemId);
  return postUserData(
    `${base}/UserItems/${iid}/UserData?userId=${uid}`,
    `${base}/Users/${uid}/Items/${iid}/UserData`,
    apiKey,
    "set position",
    JSON.stringify({ PlaybackPositionTicks: Math.round(positionMs) * TICKS_PER_MS }),
  );
}
