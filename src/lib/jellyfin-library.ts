// The Jellyfin library: media folders, the title listing the sync writes from
// (one row per TMDB id, every copy's item id kept — guardrail 37), the
// library match check's listing, and the post-webhook availability probe.
import { safeFetchAdminConfigured } from "./safe-fetch";
import { trimServerBase } from "./server-url";
import { warnOnChange } from "./log-dedup";
import { mapLimit } from "./concurrency";
import { isTmdbIdInRange } from "./tmdb-id";
import { check, v, type Infer } from "./validate";
import type { ServerMatchEntry } from "./library-match";
import { loose, looseString, numberish, parseEach, stringRecord } from "./media-server-payload";
import { FETCH_TIMEOUT_MS, jellyfinHeaders, jellyfinItemsUrl, JELLYFIN_NO_COLLECTION_GROUPING, type ItemsParam } from "./jellyfin-http";
import { MAX_PARALLEL_PAGES, pageSlots, readJellyfinListing, type ListingCollector } from "./jellyfin-paging";

export interface JellyfinMediaFolder {
  id: string;
  name: string;
  collectionType: string;
}

// One listed Movie or Series. Fields are lenient (media-server-payload.ts): a
// wrong-typed field reads as absent, so one odd field never drops a title.
// ProviderIds keeps its string values only: a provider set to null must not
// cost the item its Tmdb id.
const JellyfinItemSchema = v.object({
  Id: looseString(),
  ProviderIds: loose(stringRecord),
  Path: looseString(),
  Name: looseString(),
  ProductionYear: loose(numberish),
  Overview: looseString(),
  OfficialRating: looseString(),
  CommunityRating: loose(v.number()),
  DateCreated: looseString(),
  Type: looseString(),
});
export type JellyfinItem = Infer<typeof JellyfinItemSchema>;

/** A provider id from an item's ProviderIds (Jellyfin spells the key both ways). */
export function providerId(item: Pick<JellyfinItem, "ProviderIds">, name: "Tmdb" | "Imdb" | "Tvdb"): string | null {
  const ids = item.ProviderIds;
  if (!ids) return null;
  const value = ids[name] ?? ids[name.toLowerCase()];
  return value ? value : null;
}

/**
 * A Tmdb provider id as the INT4 tmdbId column holds it: digits only, in
 * range. `parseInt` read "550abc" as 550, and one id past INT4 would fail the
 * sync's whole batched write.
 */
function parseJellyfinTmdbId(raw: string | null): number | null {
  const m = raw === null ? null : /^\s*(\d{1,10})\s*$/.exec(raw);
  if (!m) return null;
  const n = Number(m[1]);
  return isTmdbIdInRange(n) ? n : null;
}

/** A date string Jellyfin sent; null for anything that isn't a real date. */
export function parseJellyfinDate(raw: unknown): Date | null {
  if (typeof raw !== "string" || raw.length === 0) return null;
  const d = new Date(raw);
  return Number.isFinite(d.getTime()) ? d : null;
}

// "Is this title on Jellyfin yet?" — the post-webhook notify poll uses this to
// wait out library-scan propagation. Jellyfin has NO server-side provider-id
// equality filter: the Emby-style `AnyProviderIdEquals` param this used to send
// was never implemented (jellyfin/jellyfin#1990; ASP.NET model binding silently
// drops the unknown key), so that query degenerated to "is the library
// non-empty" and the poll notified ~30s after the webhook regardless of whether
// Jellyfin had scanned the import. Instead pull the most recently added items
// of the right type and match ProviderIds client-side — a fresh import is by
// definition among the newest additions. A miss (the import buried past the
// window by a huge simultaneous import) degrades safely: the poll exhausts
// un-notified and the sync orchestrator's library-backed pass notifies later.
const PROBE_RECENT_LIMIT = 200;

const ItemsEnvelope = v.object({ Items: v.optional(v.array(v.unknown())) });

export async function hasJellyfinItemByTmdbId(
  baseUrl: string,
  apiKey: string,
  tmdbId: number,
  mediaType: "movie" | "tv",
): Promise<boolean> {
  const url = jellyfinItemsUrl(baseUrl, [
    ["IncludeItemTypes", mediaType === "movie" ? "Movie" : "Series"],
    ["Recursive", "true"],
    ["Fields", "ProviderIds"],
    ["SortBy", "DateCreated"],
    ["SortOrder", "Descending"],
    ["Limit", PROBE_RECENT_LIMIT],
    ["EnableImages", "false"],
  ]);
  try {
    const res = await safeFetchAdminConfigured(url, {
      headers: jellyfinHeaders(apiKey),
      timeoutMs: FETCH_TIMEOUT_MS,
    });
    if (!res.ok) return false;
    const body = check(ItemsEnvelope, await res.json());
    if (!body.ok) return false;
    return parseEach(JellyfinItemSchema, body.value.Items ?? []).some(
      (item) => parseJellyfinTmdbId(providerId(item, "Tmdb")) === tmdbId,
    );
  } catch {
    return false;
  }
}

const MediaFolderSchema = v.object({ Id: v.string(), Name: looseString(), CollectionType: looseString() });

async function readMediaFolders(baseUrl: string, apiKey: string) {
  const url = `${trimServerBase(baseUrl)}/Library/MediaFolders`;
  const res = await safeFetchAdminConfigured(url, {
    headers: jellyfinHeaders(apiKey),
    timeoutMs: FETCH_TIMEOUT_MS,
  });
  if (!res.ok) throw new Error(`Jellyfin MediaFolders: ${res.status}`);
  const body = check(ItemsEnvelope, await res.json());
  if (!body.ok) throw new Error(`Jellyfin MediaFolders: unexpected response (${body.error})`);
  return parseEach(MediaFolderSchema, body.value.Items ?? []);
}

// A library the sync can read titles from: the movie and show libraries AND
// the mixed or untyped ones (no CollectionType, or "mixed"), which hold either
// and which a library with no selection reads too.
function holdsTitles(f: { CollectionType?: string | null }): boolean {
  return f.CollectionType === "movies" || f.CollectionType === "tvshows" || !f.CollectionType || f.CollectionType === "mixed";
}

/**
 * The libraries the pickers offer: every one the sync reads titles from, so
 * ticking some never drops a mixed library with no way to tick it back in.
 * A mixed or untyped library is listed as `collectionType: "mixed"`.
 */
export async function getJellyfinMediaFolders(baseUrl: string, apiKey: string): Promise<JellyfinMediaFolder[]> {
  return (await readMediaFolders(baseUrl, apiKey))
    .filter(holdsTitles)
    .map((f) => ({
      id: f.Id,
      name: f.Name ?? "",
      collectionType: f.CollectionType === "movies" || f.CollectionType === "tvshows" ? f.CollectionType : "mixed",
    }));
}

/**
 * Every library the sync can read titles from, for the sync's short-answer
 * hold (jellyfin-sync-guard.ts): the movie and show libraries AND the mixed or
 * untyped ones (no CollectionType, or "mixed"), which hold either and which a
 * library with no selection reads too. Music, books, photos and the like hold
 * no titles and are left out, so they never keep a hold alive.
 */
export async function getJellyfinSyncFolders(baseUrl: string, apiKey: string): Promise<Array<{ id: string; collectionType: string }>> {
  return (await readMediaFolders(baseUrl, apiKey))
    .filter(holdsTitles)
    .map((f) => ({ id: f.Id, collectionType: f.CollectionType ?? "" }));
}

export async function refreshJellyfinLibrary(baseUrl: string, apiKey: string): Promise<void> {
  const url = `${trimServerBase(baseUrl)}/Library/Refresh`;
  const res = await safeFetchAdminConfigured(url, {
    method: "POST",
    headers: jellyfinHeaders(apiKey),
    timeoutMs: FETCH_TIMEOUT_MS,
  });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(
      `Jellyfin /Library/Refresh status=${res.status}${body ? ` body=${body.slice(0, 200)}` : ""}`,
    );
  }
}

export interface JellyfinLibraryItemData {
  filePath:       string | null;
  itemId:         string | null;
  title:          string | null;
  year:           string | null;
  overview:       string | null;
  contentRating:  string | null;
  communityRating: number | null;
  addedAt:        Date | null;
  // Item ids of the OTHER copies of this title, when it sits in more than one
  // library (Anime vs TV, HD vs 4K, an accidental double-import). Sorted, and
  // empty for the overwhelmingly common single-copy case. JellyfinLibraryItem
  // keeps one row per title (@@id([tmdbId, mediaType, serverInstance])), with
  // `itemId` as its jellyfinItemId; these extra ids are stored alongside it in
  // jellyfinItemIds (see libraryItemIds, guardrail 37). They must also resolve
  // in-process, or every episode filed under them disappears — see
  // buildSeriesItemIdIndex.
  duplicateItemIds: string[];
}

// Which copy of a duplicated title becomes the stored row. Deliberately
// order-INDEPENDENT: the library-scoped walk fetches folders concurrently, so a
// plain last-write-wins let the winner flip between syncs and took the row's
// itemId, filePath, addedAt and ratings with it.
//
// Most recently added wins, ties broken on the item id. That is also what the
// unscoped single-query path already did by construction — it sorts
// DateCreated ascending and the last write won — so a server whose libraries
// aren't individually scoped sees no change at all.
function prefersCandidate(
  candidate: JellyfinLibraryItemData,
  incumbent: JellyfinLibraryItemData,
): boolean {
  const a = candidate.addedAt?.getTime() ?? null;
  const b = incumbent.addedAt?.getTime() ?? null;
  if (a !== b) {
    if (a === null) return false; // an undated copy never displaces a dated one
    if (b === null) return true;
    return a > b;
  }
  return (candidate.itemId ?? "") > (incumbent.itemId ?? "");
}

// The value for JellyfinLibraryItem.jellyfinItemIds: every id this title
// occupies, the stored `itemId` first. Reads OR this against `jellyfinItemId`
// (rows written before the column existed are `[]`), so the winner appearing in
// both is deliberate rather than redundant — it keeps the array a complete
// answer on its own once a full sync has rewritten the row.
export function libraryItemIds(data: JellyfinLibraryItemData): string[] {
  return data.itemId ? [data.itemId, ...data.duplicateItemIds] : [...data.duplicateItemIds];
}

// EVERY Jellyfin item id that resolves to a given series, not just the one whose
// row survives into JellyfinLibraryItem.
//
// A show sitting in two libraries has two item ids, and each of its episodes
// carries whichever SeriesId it was filed under. The episode walk skips a
// SeriesId it doesn't recognise, so a map built from the surviving id alone
// silently drops the losing copy's ENTIRE episode set from TVEpisodeCache — which
// then reads as "these seasons aren't in the library". Build the map from this,
// never from `data.itemId` alone.
export function buildSeriesItemIdIndex(
  seriesItems: Map<number, JellyfinLibraryItemData>,
): Map<string, number> {
  const index = new Map<string, number>();
  for (const [tmdbId, data] of seriesItems) {
    if (data.itemId) index.set(data.itemId, tmdbId);
    for (const duplicateId of data.duplicateItemIds) index.set(duplicateId, tmdbId);
  }
  return index;
}

// ── the title listing (library sync) ────────────────────────────────────────

// What one walk (or the union of several libraries' walks) found: one
// candidate row per tmdb id, every item id seen for an id that turned up more
// than once (populated only on a collision, so the single-copy case allocates
// nothing extra), and how many collections came back in place of their
// members — zero while JELLYFIN_NO_COLLECTION_GROUPING is honoured; anything
// else means titles are missing from the listing (guardrail 37d).
interface TitleAccumulator {
  items: Map<number, JellyfinLibraryItemData>;
  extraItemIds: Map<number, Set<string>>;
  collections: number;
}

function newTitleAccumulator(): TitleAccumulator {
  return { items: new Map(), extraItemIds: new Map(), collections: 0 };
}

function itemIdsFor(acc: TitleAccumulator, tmdbId: number): Set<string> {
  let ids = acc.extraItemIds.get(tmdbId);
  if (!ids) {
    ids = new Set<string>();
    acc.extraItemIds.set(tmdbId, ids);
  }
  return ids;
}

// The same title in two libraries keeps both ids addressable, then lets
// prefersCandidate — not arrival order — decide which row survives.
function addTitle(acc: TitleAccumulator, tmdbId: number, candidate: JellyfinLibraryItemData): void {
  const incumbent = acc.items.get(tmdbId);
  if (!incumbent) {
    acc.items.set(tmdbId, candidate);
    return;
  }
  const ids = itemIdsFor(acc, tmdbId);
  if (incumbent.itemId) ids.add(incumbent.itemId);
  if (candidate.itemId) ids.add(candidate.itemId);
  if (prefersCandidate(candidate, incumbent)) acc.items.set(tmdbId, candidate);
}

function libraryItemData(item: JellyfinItem): JellyfinLibraryItemData {
  return {
    filePath:        item.Path ?? null,
    itemId:          item.Id ?? null,
    title:           item.Name ?? null,
    year:            item.ProductionYear !== undefined ? String(item.ProductionYear) : null,
    overview:        item.Overview ?? null,
    contentRating:   item.OfficialRating ?? null,
    communityRating: item.CommunityRating ?? null,
    // An unparseable date is no date: an Invalid Date compared as NaN in
    // prefersCandidate and was written as addedAt.
    addedAt:         parseJellyfinDate(item.DateCreated),
    duplicateItemIds: [],
  };
}

function addListedItems(acc: TitleAccumulator, raw: unknown[]): void {
  for (const item of parseEach(JellyfinItemSchema, raw)) {
    if (item.Type === "BoxSet") {
      acc.collections++;
      continue;
    }
    // Items without a TMDB provider ID are skipped on purpose. For a Series
    // that also means its episodes are skipped: episode lookups use the
    // itemId→tmdbId map built from this listing.
    const tmdbId = parseJellyfinTmdbId(providerId(item, "Tmdb"));
    if (tmdbId !== null) addTitle(acc, tmdbId, libraryItemData(item));
  }
}

// One library's accepted walk joins the union by the same rule as two copies
// inside one walk.
function mergeTitles(into: TitleAccumulator, from: TitleAccumulator): void {
  into.collections += from.collections;
  for (const [tmdbId, winner] of from.items) {
    addTitle(into, tmdbId, winner);
    const extra = from.extraItemIds.get(tmdbId);
    if (extra) for (const id of extra) itemIdsFor(into, tmdbId).add(id);
  }
}

function titleCollector(): ListingCollector<TitleAccumulator> {
  const acc = newTitleAccumulator();
  return { add: (items) => addListedItems(acc, items), result: () => acc };
}

// Fold the collision bookkeeping into the surviving rows. Sorted so the list
// is as stable between syncs as the winner it hangs off. Counted HERE rather
// than at collision time so the same item served twice (an overlapping page
// during a library that changed mid-walk) doesn't report as a duplicate copy.
function finishTitles(acc: TitleAccumulator, itemType: "Movie" | "Series", baseUrl: string): Map<number, JellyfinLibraryItemData> {
  let duplicatedTmdbIds = 0;
  for (const [tmdbId, ids] of acc.extraItemIds) {
    const winner = acc.items.get(tmdbId);
    if (!winner) continue;
    if (winner.itemId) ids.delete(winner.itemId);
    if (ids.size === 0) continue;
    acc.items.set(tmdbId, { ...winner, duplicateItemIds: Array.from(ids).sort() });
    duplicatedTmdbIds++;
  }
  if (duplicatedTmdbIds > 0) {
    // Repeat-suppressed: this restates a stable property of the LIBRARY, not an
    // event, and the orchestrator re-derives it on every run — so at one run an
    // hour it is a daily reminder, and at one run a minute it is the flood that
    // hides everything else. Keyed per server + item type; the signature is the
    // count, so gaining or losing an overlapping copy re-logs immediately.
    warnOnChange(
      `jellyfin-dupes:${itemType}:${baseUrl}`,
      String(duplicatedTmdbIds),
      `[jellyfin] ${duplicatedTmdbIds} TMDB id(s) matched more than one ${itemType} across the scanned libraries; keeping the most recently added copy. The other copies stay resolvable ${itemType === "Series" ? "for episode mapping and play history" : "for play history"}, but only the winner's file path and ratings are stored.`,
    );
  }
  if (acc.collections > 0) {
    // A condition of the server, re-derived every run — repeat-suppressed for
    // the same reason as the duplicates line above (guardrail 7b).
    warnOnChange(
      `jellyfin-collections:${itemType}:${baseUrl}`,
      String(acc.collections),
      `[jellyfin] the ${itemType} listing returned ${acc.collections} collection(s) in place of their members, so those titles are missing from the library sync. The server ignored ${JELLYFIN_NO_COLLECTION_GROUPING}.`,
    );
  }
  return acc.items;
}

// Libraries read at once; their pages share one MAX_PARALLEL_PAGES budget.
const LIBRARY_CONCURRENCY = 3;

/**
 * Reads one listing per library (or one unscoped listing) through `collect`
 * and returns each accepted walk's result, in library order. The libraries
 * share one page budget, and the first to fail aborts the others: their
 * requests and retry sleeps stop instead of filling a result nobody reads.
 */
async function readPerLibrary<R>(
  libraryIds: Set<string> | undefined,
  query: (parent: ItemsParam) => string,
  apiKey: string,
  collect: () => ListingCollector<R>,
): Promise<R[]> {
  const slots = pageSlots(MAX_PARALLEL_PAGES);
  if (!libraryIds?.size) return [await readJellyfinListing(query(null), apiKey, collect, { slots })];
  const controller = new AbortController();
  return mapLimit(Array.from(libraryIds), LIBRARY_CONCURRENCY, async (parentId) => {
    try {
      return await readJellyfinListing(query(["ParentId", parentId]), apiKey, collect, { slots, signal: controller.signal });
    } catch (err) {
      controller.abort(err);
      throw err;
    }
  });
}

async function getJellyfinItemsByType(
  baseUrl: string,
  apiKey: string,
  itemType: "Movie" | "Series",
  libraryIds?: Set<string>,
  minDateLastSaved?: Date,
): Promise<Map<number, JellyfinLibraryItemData>> {
  // ONE query, scoped or not, so the two can never drift apart (guardrail 37d's
  // CollapseBoxSetItems=false above all, which jellyfinItemsUrl adds).
  // Scoping to each library's ParentId is faster and avoids returning BoxSet
  // children twice. EnableImages=false + ImageTypeLimit=0: nothing here
  // consumes ImageTags/ImageBlurHashes, and Jellyfin enriches them by default
  // (enableImages defaults true) — they were the bulk of >10 MB pages.
  const query = (parent: ItemsParam) => jellyfinItemsUrl(baseUrl, [
    parent,
    ["IncludeItemTypes", itemType],
    ["ExcludeItemTypes", "BoxSet"],
    ["Recursive", "true"],
    ["Fields", "ProviderIds,Path,Name,ProductionYear,Overview,OfficialRating,CommunityRating,DateCreated"],
    ["EnableImages", "false"],
    ["ImageTypeLimit", 0],
    ["SortBy", "DateCreated,SortName"],
    ["SortOrder", "Ascending"],
    minDateLastSaved && ["MinDateLastSaved", minDateLastSaved.toISOString()],
  ]);
  const perLibrary = await readPerLibrary(libraryIds, query, apiKey, titleCollector);
  const union = perLibrary.length === 1 ? perLibrary[0] : newTitleAccumulator();
  if (perLibrary.length > 1) for (const acc of perLibrary) mergeTitles(union, acc);
  return finishTitles(union, itemType, baseUrl);
}

export async function getJellyfinTmdbIds(
  baseUrl: string,
  apiKey: string,
  mediaType: "MOVIE" | "TV",
  libraryIds?: Set<string>,
  minDateLastSaved?: Date,
): Promise<Map<number, JellyfinLibraryItemData>> {
  return getJellyfinItemsByType(baseUrl, apiKey, mediaType === "MOVIE" ? "Movie" : "Series", libraryIds, minDateLastSaved);
}

/** The Series listing the episode walk maps SeriesIds through (every copy's id). */
export async function getJellyfinSeriesItemIndex(baseUrl: string, apiKey: string, libraryIds?: Set<string>): Promise<Map<string, number>> {
  return buildSeriesItemIdIndex(await getJellyfinItemsByType(baseUrl, apiKey, "Series", libraryIds));
}

// ── the library match check ─────────────────────────────────────────────────

function matchEntry(item: JellyfinItem & { Id: string }, serverInstance: string, mediaType: "MOVIE" | "TV"): ServerMatchEntry {
  const tmdb = parseJellyfinTmdbId(providerId(item, "Tmdb"));
  const tvdb = providerId(item, "Tvdb");
  return {
    server: "jellyfin",
    serverInstance,
    mediaType,
    itemKey: item.Id,
    title: item.Name ?? null,
    year: item.ProductionYear ?? null,
    path: item.Path ?? null,
    tmdbIds: tmdb !== null ? [tmdb] : [],
    imdbId: providerId(item, "Imdb"),
    tvdbId: tvdb !== null && /^\d+$/.test(tvdb) ? Number(tvdb) : null,
  };
}

/**
 * Every Movie or Series of the selected libraries as the library match check
 * judges it — each copy and each item with no TMDB id, which the sync's
 * one-row-per-TMDB-id map drops. A Series' path is its folder.
 */
export async function listJellyfinMatchEntries(
  baseUrl: string,
  apiKey: string,
  serverInstance: string,
  mediaType: "MOVIE" | "TV",
  libraryIds?: Set<string>,
): Promise<ServerMatchEntry[]> {
  const query = (parent: ItemsParam) => jellyfinItemsUrl(baseUrl, [
    parent,
    ["IncludeItemTypes", mediaType === "MOVIE" ? "Movie" : "Series"],
    ["ExcludeItemTypes", "BoxSet"],
    ["Recursive", "true"],
    ["Fields", "ProviderIds,Path,ProductionYear"],
    ["EnableImages", "false"],
    ["ImageTypeLimit", 0],
    ["SortBy", "SortName,Id"],
    ["SortOrder", "Ascending"],
  ]);
  // Per walk: item id → entry, so a page served twice lists an item once.
  const collect = (): ListingCollector<Map<string, ServerMatchEntry>> => {
    const entries = new Map<string, ServerMatchEntry>();
    return {
      add: (raw) => {
        for (const item of parseEach(JellyfinItemSchema, raw)) {
          if (item.Type === "BoxSet" || !item.Id || entries.has(item.Id)) continue;
          entries.set(item.Id, matchEntry({ ...item, Id: item.Id }, serverInstance, mediaType));
        }
      },
      result: () => entries,
    };
  };
  // The same item can sit under two selected libraries' parents: listed once,
  // where it first appears in library order.
  const out = new Map<string, ServerMatchEntry>();
  for (const entries of await readPerLibrary(libraryIds, query, apiKey, collect)) {
    for (const [id, entry] of entries) if (!out.has(id)) out.set(id, entry);
  }
  return Array.from(out.values());
}
