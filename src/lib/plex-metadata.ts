// One Plex library item as the client reads it, and the id readers built on
// it: the tmdb:// guid (modern agents), the legacy single-guid string, and the
// imdb/tvdb ids the library match check compares. Pure — no I/O.
import { isTmdbIdInRange } from "./tmdb-id";
import { v, type Infer } from "./validate";
import { idKey, loose, looseList, looseString, numberish } from "./media-server-payload";

const PlexGuidEntry = v.object({ id: loose(v.string()) });
const PlexPart = v.object({ file: looseString() });
const PlexMedia = v.object({ Part: looseList(PlexPart) });

/**
 * A movie, show or episode entry of a library listing. Every field is
 * lenient (media-server-payload.ts): a wrong-typed field reads as absent, so
 * one odd field never drops a title from the sync.
 */
export const PlexMetadataItemSchema = v.object({
  // The legacy single-guid string (pre-2020 agents) and the modern Guid[] array.
  guid: looseString(),
  Guid: looseList(PlexGuidEntry),
  Media: looseList(PlexMedia),
  ratingKey: loose(idKey),
  type: looseString(),
  title: looseString(),
  year: loose(v.union(v.number(), v.string())),
  summary: looseString(),
  contentRating: looseString(),
  addedAt: loose(numberish),
  // A show's folder(s) on disk; read only by the library match check.
  Location: looseList(v.object({ path: looseString() })),
});

export type PlexMetadataItem = Infer<typeof PlexMetadataItemSchema>;

/** The first part's file of the first media version, the item's on-disk path. */
export function firstPartFile(item: { Media?: Array<{ Part?: Array<{ file?: string }> }> }): string | null {
  return item.Media?.[0]?.Part?.[0]?.file ?? null;
}

/**
 * The tmdb id in ONE modern Guid entry's id (`tmdb://603`); null for another
 * provider, a malformed id (`tmdb://12abc`), an id outside TMDB's positive
 * INT4 range (`tmdb://0`, one past 2147483647: a tmdbId column is INT4, and one
 * corrupt guid would fail the sync's whole batched write), or a value that is
 * not a string — the server's JSON is not trusted for shape. Every tmdb:// guid
 * reader builds on this one.
 */
export function parseTmdbGuid(id: unknown): number | null {
  if (typeof id !== "string") return null;
  const m = /^tmdb:\/\/(\d{1,10})$/.exec(id);
  return m ? tmdbIdFromDigits(m[1]) : null;
}

function tmdbIdFromDigits(digits: string): number | null {
  const n = Number(digits);
  return isTmdbIdInRange(n) ? n : null;
}

function guidEntries(guids: unknown): unknown[] {
  return Array.isArray(guids) ? guids : [];
}

function guidId(entry: unknown): unknown {
  return typeof entry === "object" && entry !== null ? (entry as { id?: unknown }).id : undefined;
}

// Plex exposes two GUID shapes: modern items use the Guid[] array; older library agents use a single guid string.
// Returns EVERY tmdb id on the item — a merged show carries one per merged entry, and both the availability
// and the episode-cache paths must agree on the full set (a first-match-only twin left merged ids episode-less).
export function extractAllTmdbIds(item: Pick<PlexMetadataItem, "Guid" | "guid">): number[] {
  const ids: number[] = [];
  for (const g of guidEntries(item.Guid)) {
    const n = parseTmdbGuid(guidId(g));
    if (n !== null) ids.push(n);
  }
  if (ids.length === 0 && typeof item.guid === "string") {
    // The same bound as the modern guid: the legacy string's id lands in the
    // same INT4 column.
    const m = /themoviedb:\/\/(\d{1,10})(?!\d)/.exec(item.guid);
    const n = m ? tmdbIdFromDigits(m[1]) : null;
    if (n !== null) ids.push(n);
  }
  return ids;
}

export function extractTmdbIdFromGuids(guids?: ReadonlyArray<{ id?: unknown }> | null): number | null {
  for (const g of guidEntries(guids)) {
    const n = parseTmdbGuid(guidId(g));
    if (n !== null) return n;
  }
  return null;
}

/**
 * The legacy agent's external id of an item whose guid scheme carries NO tmdb
 * id at all: com.plexapp.agents.thetvdb://<id> (the pre-2020 default TV agent)
 * and com.plexapp.agents.imdb://tt<id> (the pre-2020 movie agent). Only the
 * legacy single-guid string counts — a modern Guid[] array without a tmdb
 * entry stays excluded (pinned deliberate in tests/plex).
 */
export function extractLegacyExternalId(item: Pick<PlexMetadataItem, "Guid" | "guid">): { tvdbId?: number; imdbId?: string } | null {
  if (item.Guid?.length || typeof item.guid !== "string" || !item.guid) return null;
  const tv = item.guid.match(/thetvdb:\/\/(\d+)/);
  if (tv) {
    const n = parseInt(tv[1], 10);
    if (!isNaN(n)) return { tvdbId: n };
  }
  const im = item.guid.match(/imdb:\/\/(tt\d+)/);
  if (im) return { imdbId: im[1] };
  return null;
}

/** An item's imdb or tvdb id, from its Guid array or else its legacy guid string. */
export function guidValue(item: Pick<PlexMetadataItem, "Guid" | "guid">, scheme: "imdb" | "tvdb"): string | null {
  for (const g of guidEntries(item.Guid)) {
    const id = guidId(g);
    if (typeof id === "string" && id.startsWith(`${scheme}://`) && id.length > scheme.length + 3) return id.slice(scheme.length + 3);
  }
  const guid = typeof item.guid === "string" ? item.guid : "";
  const legacy = scheme === "imdb" ? /imdb:\/\/(tt\d+)/.exec(guid) : /thetvdb:\/\/(\d+)/.exec(guid);
  return legacy?.[1] ?? null;
}

/**
 * A ratingKey sent as a string or a number, as the decimal string watch sync
 * addresses items by; null for anything else.
 */
export function numericRatingKey(value: unknown): string | null {
  const s = typeof value === "number" ? String(value) : typeof value === "string" ? value : "";
  return /^\d{1,20}$/.test(s) ? s : null;
}
