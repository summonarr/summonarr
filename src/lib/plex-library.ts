// The Plex library: sections, the per-section title walk the sync writes from,
// the library match check's listing, and the post-webhook availability probe.
import { check, v, type Schema } from "./validate";
import type { ServerMatchEntry } from "./library-match";
import { idKey, looseString, parseEach, type PageControl, STOP_PAGING } from "./media-server-payload";
import {
  FETCH_TIMEOUT_MS,
  noRetry,
  plexFetch,
  plexFetchAllPages,
  plexUrl,
  readPlexContainer,
  tagNoRetryOn4xx,
  withPlexRetry,
} from "./plex-http";
import {
  extractAllTmdbIds,
  extractLegacyExternalId,
  firstPartFile,
  guidValue,
  PlexMetadataItemSchema,
  type PlexMetadataItem,
} from "./plex-metadata";

export interface PlexSection {
  key: string;
  title: string;
  type: "movie" | "show";
}

const SectionsEnvelope = v.object({
  MediaContainer: v.object({ Directory: v.optional(v.array(v.unknown())) }),
});
// A section with no usable key can't be addressed; a missing title is only a label.
const SectionDirectory = v.object({ key: idKey, title: looseString(), type: looseString() });

export async function getPlexLibrarySections(
  serverUrl: string,
  token: string,
  signal?: AbortSignal,
): Promise<PlexSection[]> {
  const directories = await withPlexRetry("/library/sections", async () => {
    const res = await plexFetch(plexUrl(serverUrl, "/library/sections"), token, FETCH_TIMEOUT_MS, signal);
    if (!res.ok) throw tagNoRetryOn4xx(new Error(`Plex sections: ${res.status}`), res.status);
    // Checked inside the retry so a 200 without a MediaContainer (a proxy's
    // page) is a clear, unretried failure rather than a TypeError later.
    const parsed = check(SectionsEnvelope, await res.json());
    if (!parsed.ok) throw noRetry(new Error("Plex sections: no MediaContainer"));
    return parseEach(SectionDirectory, parsed.value.MediaContainer.Directory ?? []);
  }, signal);
  return directories
    .filter((d) => d.type === "movie" || d.type === "show")
    .map((d) => ({ key: d.key, title: d.title ?? "", type: d.type as "movie" | "show" }));
}

export async function refreshPlexSection(
  serverUrl: string,
  token: string,
  sectionKey: string,
): Promise<void> {
  const res = await plexFetch(plexUrl(serverUrl, `/library/sections/${encodeURIComponent(sectionKey)}/refresh`), token);
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(
      `Plex section=${sectionKey} refresh status=${res.status}${body ? ` body=${body.slice(0, 200)}` : ""}`,
    );
  }
  await res.body?.cancel().catch(() => {});
}

// One paged listing of a section: /all (the full walk) or /recentlyAdded
// (addedAt-desc), of one Plex type (1 movie, 2 show, 4 episode). The single
// place these URLs are built.
interface SectionListing {
  sectionKey: string;
  plexType: 1 | 2 | 4;
  recentlyAdded?: boolean;
  includeGuids?: boolean;
}

/** Walks one section listing, handing each page's entries that pass `item` to `onItems`. */
export async function walkPlexSection<T>(
  serverUrl: string,
  token: string,
  listing: SectionListing,
  item: Schema<T>,
  onItems: (items: T[]) => PageControl,
  signal?: AbortSignal,
): Promise<void> {
  const path = `/library/sections/${encodeURIComponent(listing.sectionKey)}/${listing.recentlyAdded ? "recentlyAdded" : "all"}`;
  const query = `?type=${listing.plexType}${listing.includeGuids ? "&includeGuids=1" : ""}`;
  await plexFetchAllPages(plexUrl(serverUrl, `${path}${query}`), token, (raw) => onItems(parseEach(item, raw)), signal);
}

// Legacy-agent items whose guid scheme carries NO tmdb id at all (see
// extractLegacyExternalId). These items were entirely invisible to
// availability and the episode cache. The library walk collects them as a
// secondary channel for the SYNC layer to batch-resolve to tmdb ids via TMDB
// /find (best-effort — the Plex client itself stays DB-free).
export interface PlexLegacyGuidRef {
  ratingKey: string;
  tvdbId?: number;
  imdbId?: string;
  data: PlexLibraryItemData;
}

export interface PlexLibraryItemData {
  filePath:      string | null;
  ratingKey:     string | null;
  title:         string | null;
  year:          string | null;
  overview:      string | null;
  contentRating: string | null;
  addedAt:       Date | null;
  // The ratingKeys of every OTHER Plex item that carries this tmdb id on the
  // server (a second section, a split duplicate) — the copies whose row lost to
  // `ratingKey`. Written to PlexLibraryItem.plexRatingKeys via
  // plexLibraryRatingKeys(); guardrail 37c. Absent = none.
  duplicateRatingKeys?: string[];
}

// The value for PlexLibraryItem.plexRatingKeys: every ratingKey this title
// occupies, the stored `ratingKey` first. Reads OR this against plexRatingKey
// (rows written before the column existed are `[]`), so the winner appearing in
// both is deliberate — the array is a complete answer once a full sync has
// rewritten the row. Twin of jellyfin.ts libraryItemIds (guardrail 37c).
export function plexLibraryRatingKeys(data: Pick<PlexLibraryItemData, "ratingKey" | "duplicateRatingKeys">): string[] {
  const keys = data.ratingKey ? [data.ratingKey] : [];
  const seen = new Set(keys);
  for (const k of data.duplicateRatingKeys ?? []) {
    if (seen.has(k)) continue;
    seen.add(k);
    keys.push(k);
  }
  return keys;
}

// A copy of `existing` that also answers to every key in `keys` — the bulk form
// of withDuplicateRatingKeys. Callers folding many copies of one title collect
// the losers' keys and call this ONCE: folding pair by pair rebuilt the
// winner's growing list per copy, cubic in copies of one tmdb id, so a Plex
// server listing a few thousand items with one tmdb guid froze the event loop
// for minutes in an unattended sync. Never mutates, for the reason below.
export function foldDuplicateRatingKeys(existing: PlexLibraryItemData, keys: Iterable<string>): PlexLibraryItemData {
  const have = new Set(existing.duplicateRatingKeys ?? []);
  const extra: string[] = [];
  for (const k of keys) {
    if (k === existing.ratingKey || have.has(k)) continue;
    have.add(k);
    extra.push(k);
  }
  if (extra.length === 0) return existing;
  return { ...existing, duplicateRatingKeys: [...(existing.duplicateRatingKeys ?? []), ...extra].sort() };
}

// A copy of `existing` that also answers to `other`'s ratingKeys. Never mutates:
// one entry object is shared by every tmdb id a conflated Plex item claims, so
// an in-place push would hand the duplicate key to titles it isn't a copy of.
export function withDuplicateRatingKeys(existing: PlexLibraryItemData, other: PlexLibraryItemData): PlexLibraryItemData {
  return foldDuplicateRatingKeys(existing, plexLibraryRatingKeys(other));
}

// Compares two ratingKeys as the integers they are (Plex ratingKeys are
// decimal ids), falling back to string order for anything else.
function compareRatingKeys(a: string, b: string): number {
  if (/^\d+$/.test(a) && /^\d+$/.test(b) && a.length !== b.length) return a.length - b.length;
  return a < b ? -1 : a > b ? 1 : 0;
}

// Which copy of a duplicated title becomes the stored row — the Plex twin of
// Jellyfin's prefersCandidate (guardrail 37): the most recently added copy,
// ties broken on the greater ratingKey. A total order, never arrival order:
// the row's ratingKey, filePath and addedAt used to depend on Plex's page
// order inside a section and on section order across sections, and the two
// merges even disagreed (last-seen won inside a section, first-seen across).
// An exact tie keeps the incumbent.
export function prefersPlexCopy(candidate: PlexLibraryItemData, incumbent: PlexLibraryItemData): boolean {
  const a = candidate.addedAt?.getTime() ?? null;
  const b = incumbent.addedAt?.getTime() ?? null;
  if (a !== b) {
    if (a === null) return false; // an undated copy never displaces a dated one
    if (b === null) return true;
    return a > b;
  }
  return compareRatingKeys(candidate.ratingKey ?? "", incumbent.ratingKey ?? "") > 0;
}

// Copies of one tmdb id → the stored row: the preferred copy, answering to
// every other copy's keys too (folded once — guardrail 37c).
function resolveCopies(copies: readonly PlexLibraryItemData[]): PlexLibraryItemData {
  let winner = copies[0];
  for (let i = 1; i < copies.length; i++) {
    if (prefersPlexCopy(copies[i], winner)) winner = copies[i];
  }
  const keys: string[] = [];
  for (const copy of copies) {
    if (copy !== winner) for (const k of plexLibraryRatingKeys(copy)) keys.push(k);
  }
  return foldDuplicateRatingKeys(winner, keys);
}

/** How one section is walked (getPlexSectionTmdbIds) — every field optional, every default the full walk's. */
export interface PlexSectionWalkOptions {
  // The incremental walk: /recentlyAdded instead of /all (guardrail 13 — the
  // two modes stay distinct). Default false.
  recentOnly?: boolean;
  // Accumulates every show's ratingKey → tmdb ids across sections so the
  // episode walk can reuse this type=2 listing instead of re-paging it.
  // Accumulated HERE (per section, where each section's rows still exist)
  // rather than inverted from the merged map — the merge keeps one entry per
  // tmdbId, which would drop a duplicated show's other ratingKey and lose that
  // copy's exclusive episodes.
  ratingKeyToTmdbOut?: Map<string, number[]>;
  // Secondary channel for legacy-agent items with no tmdb id (see
  // PlexLegacyGuidRef). Keyed by ratingKey.
  legacyOut?: Map<string, PlexLegacyGuidRef>;
  // recentOnly window cutoff (epoch seconds). /recentlyAdded is addedAt-desc,
  // so once an ENTIRE page predates this the walk stops — without it the
  // "incremental" sync paged the whole section every run. Trade, stated
  // plainly: the unbounded walk incidentally backfilled arbitrarily old gaps;
  // the windowed walk does not (Jellyfin's MinDateLastSaved already accepts
  // this — a full Resync covers backfill).
  recentSinceEpochSec?: number;
  // Ends the walk (and its retry sleeps) when the caller gives up. An aborted
  // walk REJECTS — never a partial library a full sync would write.
  signal?: AbortSignal;
}

function libraryItemData(item: PlexMetadataItem): PlexLibraryItemData {
  return {
    filePath:      firstPartFile(item),
    ratingKey:     item.ratingKey ?? null,
    title:         item.title ?? null,
    year:          item.year !== undefined ? String(item.year) : null,
    overview:      item.summary ?? null,
    contentRating: item.contentRating ?? null,
    addedAt:       item.addedAt !== undefined ? new Date(item.addedAt * 1000) : null,
  };
}

// recentOnly early stop: every item on this page is KNOWN older than the
// window (an unknown addedAt keeps paging — age can't be assumed).
function pagePredates(batch: readonly PlexMetadataItem[], sinceEpochSec: number | undefined): boolean {
  return (
    sinceEpochSec !== undefined &&
    batch.length > 0 &&
    batch.every((i) => i.addedAt !== undefined && i.addedAt < sinceEpochSec)
  );
}

// One section's titles, one row per tmdb id. A show's filePath is always null
// here: a show item carries no file. The sync reads it from the type=4 episode
// listing it walks anyway (getPlexTVEpisodes' episodeFilePathsOut) and patches
// it onto the written rows (patchPlexShowFilePaths) — one paged listing per
// section instead of the one request per show this walk used to send.
export async function getPlexSectionTmdbIds(
  serverUrl: string,
  token: string,
  sectionKey: string,
  sectionType: "movie" | "show",
  opts: PlexSectionWalkOptions = {},
): Promise<Map<number, PlexLibraryItemData>> {
  const { recentOnly = false, ratingKeyToTmdbOut, legacyOut, recentSinceEpochSec, signal } = opts;
  // Every copy seen per tmdb id; resolved to one row once the walk is done.
  const copies = new Map<number, PlexLibraryItemData[]>();
  await walkPlexSection(
    serverUrl,
    token,
    { sectionKey, plexType: sectionType === "movie" ? 1 : 2, recentlyAdded: recentOnly, includeGuids: true },
    PlexMetadataItemSchema,
    (batch) => {
      for (const item of batch) {
        if (item.type === "collection") continue;
        const ids = extractAllTmdbIds(item);
        // ONE entry object per item, shared by every tmdb id a conflated item
        // claims (folding never mutates it — see withDuplicateRatingKeys).
        const entry = libraryItemData(item);
        if (ids.length === 0) {
          collectLegacyItem(item, entry, legacyOut);
          continue;
        }
        if (sectionType === "show" && ratingKeyToTmdbOut && item.ratingKey) {
          ratingKeyToTmdbOut.set(item.ratingKey, ids);
        }
        for (const id of ids) {
          const list = copies.get(id);
          if (list) list.push(entry);
          else copies.set(id, [entry]);
        }
      }
      return pagePredates(batch, recentSinceEpochSec) ? STOP_PAGING : undefined;
    },
    signal,
  );
  const items = new Map<number, PlexLibraryItemData>();
  for (const [id, list] of copies) items.set(id, list.length === 1 ? list[0] : resolveCopies(list));
  return items;
}

function collectLegacyItem(item: PlexMetadataItem, entry: PlexLibraryItemData, legacyOut: Map<string, PlexLegacyGuidRef> | undefined): void {
  if (!legacyOut || !item.ratingKey) return;
  const legacy = extractLegacyExternalId(item);
  if (legacy) legacyOut.set(item.ratingKey, { ratingKey: item.ratingKey, ...legacy, data: entry });
}

/** getPlexTmdbIds' options: the per-section walk's, plus which sections to walk. */
export interface PlexTmdbIdsOptions extends PlexSectionWalkOptions {
  // Only these section keys (empty or absent = every section of the type).
  selectedKeys?: Set<string>;
  // The server's sections when the caller already listed them (skips the listing).
  sections?: PlexSection[];
}

export async function getPlexTmdbIds(
  serverUrl: string,
  token: string,
  mediaType: "MOVIE" | "TV",
  opts: PlexTmdbIdsOptions = {},
): Promise<Map<number, PlexLibraryItemData>> {
  const { selectedKeys, sections, ...walk } = opts;
  const sectionType = mediaType === "MOVIE" ? "movie" : "show";
  const allSections = sections ?? await getPlexLibrarySections(serverUrl, token, walk.signal);
  const matching = allSections.filter((s) => s.type === sectionType && (!selectedKeys?.size || selectedKeys.has(s.key)));
  const results = await Promise.all(
    matching.map((s) => getPlexSectionTmdbIds(serverUrl, token, s.key, sectionType, walk))
  );
  // A tmdb id in several sections (a "4K Movies" twin, an "Anime" library) is
  // resolved by the same rule as a duplicate inside one section, and the
  // losing copies' ratingKeys stay addressable (guardrail 37c) — folded once
  // per id, never per section (see foldDuplicateRatingKeys).
  const copies = new Map<number, PlexLibraryItemData[]>();
  for (const map of results) {
    for (const [id, data] of map) {
      const list = copies.get(id);
      if (list) list.push(data);
      else copies.set(id, [data]);
    }
  }
  const combined = new Map<number, PlexLibraryItemData>();
  for (const [id, list] of copies) combined.set(id, list.length === 1 ? list[0] : resolveCopies(list));
  return combined;
}

/**
 * Every item of the selected sections as the library match check judges it —
 * each copy and each unmatched item, not the one-row-per-TMDB-id map the sync
 * builds. A show's path is its folder (`Location`); one the server doesn't
 * report is left null, and that show is simply not judged.
 */
export async function listPlexMatchEntries(
  serverUrl: string,
  token: string,
  serverInstance: string,
  mediaType: "MOVIE" | "TV",
  selectedKeys?: Set<string>,
  opts: { signal?: AbortSignal } = {},
): Promise<ServerMatchEntry[]> {
  const sectionType = mediaType === "MOVIE" ? "movie" : "show";
  const sections = (await getPlexLibrarySections(serverUrl, token, opts.signal))
    .filter((s) => s.type === sectionType && (!selectedKeys?.size || selectedKeys.has(s.key)));
  const out: ServerMatchEntry[] = [];
  for (const section of sections) {
    await walkPlexSection(
      serverUrl,
      token,
      { sectionKey: section.key, plexType: mediaType === "MOVIE" ? 1 : 2, includeGuids: true },
      PlexMetadataItemSchema,
      (batch) => {
        for (const item of batch) {
          if (item.type === "collection" || !item.ratingKey) continue;
          out.push(matchEntry(item, item.ratingKey, serverInstance, mediaType));
        }
      },
      opts.signal,
    );
  }
  return out;
}

function matchEntry(item: PlexMetadataItem, itemKey: string, serverInstance: string, mediaType: "MOVIE" | "TV"): ServerMatchEntry {
  const tmdbIds = extractAllTmdbIds(item);
  const tvdb = guidValue(item, "tvdb");
  return {
    server: "plex",
    serverInstance,
    mediaType,
    itemKey,
    title: item.title ?? null,
    year: typeof item.year === "number" ? item.year : null,
    path: mediaType === "MOVIE"
      ? firstPartFile(item)
      : (item.Location?.find((l) => l.path)?.path ?? null),
    tmdbIds,
    imdbId: guidValue(item, "imdb"),
    tvdbId: tvdb !== null && /^\d+$/.test(tvdb) ? Number(tvdb) : null,
    legacyPlaced: tmdbIds.length === 0 && extractLegacyExternalId(item) !== null,
  };
}

// "Is this title on Plex yet?" — the post-webhook notify poll. Two reads, and a
// failure of either reads as "not yet", never a throw:
//   1. the `guid=tmdb://<id>` filter on each section. UNVERIFIED that PMS
//      matches an EXTERNAL guid there: python-plexapi resolves tmdb:// to the
//      item's plex:// guid (via /matches) before it searches by guid, which
//      suggests the modern agents match only the plex:// one — so this read
//      alone may never see the import;
//   2. so each section that answered a clean miss is also checked the way the
//      Jellyfin twin (hasJellyfinItemByTmdbId) does it: its newest additions
//      (/recentlyAdded, the listing the recentOnly sync walks), matched here on
//      every tmdb guid. A fresh import is by definition among them. A miss past
//      the window degrades safely: the poll gives up and the sync's
//      library-backed pass notifies later.
const PLEX_PROBE_RECENT_LIMIT = 200;

export async function hasPlexItemByTmdbId(
  serverUrl: string,
  token: string,
  tmdbId: number,
  mediaType: "movie" | "tv",
  sections?: PlexSection[],
): Promise<boolean> {
  const plexType = mediaType === "movie" ? 1 : 2;
  const sectionType = mediaType === "movie" ? "movie" : "show";
  const allSections = sections ?? await getPlexLibrarySections(serverUrl, token).catch(() => [] as PlexSection[]);
  const matching = allSections.filter((s) => s.type === sectionType);
  // Sections whose guid read answered "none": the ones worth a second look. A
  // section that failed outright would fail the second read too.
  const missed: PlexSection[] = [];
  for (const section of matching) {
    const container = await probeContainer(
      serverUrl,
      token,
      `/library/sections/${encodeURIComponent(section.key)}/all?type=${plexType}&includeGuids=1&guid=tmdb://${tmdbId}&X-Plex-Container-Start=0&X-Plex-Container-Size=1`,
    );
    if (!container) continue;
    if ((container.totalSize ?? container.size ?? 0) > 0) return true;
    missed.push(section);
  }
  for (const section of missed) {
    const container = await probeContainer(
      serverUrl,
      token,
      `/library/sections/${encodeURIComponent(section.key)}/recentlyAdded?type=${plexType}&includeGuids=1&X-Plex-Container-Start=0&X-Plex-Container-Size=${PLEX_PROBE_RECENT_LIMIT}`,
    );
    if (!container) continue;
    const items = parseEach(PlexMetadataItemSchema, container.items.slice(0, PLEX_PROBE_RECENT_LIMIT));
    if (items.some((item) => item.type !== "collection" && extractAllTmdbIds(item).includes(tmdbId))) return true;
  }
  return false;
}

// One best-effort read for the probe: the MediaContainer, or null on any
// failure (non-2xx, network, an answer without a container).
async function probeContainer(serverUrl: string, token: string, path: string) {
  try {
    const res = await plexFetch(plexUrl(serverUrl, path), token);
    if (!res.ok) {
      await res.body?.cancel().catch(() => {});
      return null;
    }
    return readPlexContainer(await res.json());
  } catch {
    return null;
  }
}
