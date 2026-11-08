import { prisma } from "@/lib/prisma";
import { posterUrl } from "@/lib/tmdb-types";
import { tmdbDetailsKey } from "@/lib/tmdb-cache";

// Resolve TMDB posters for activity views — `resolvePosterMap` returns a
// `posterPathKey`→url map, `resolvePosterPathMap` the same lookup as raw TMDB
// paths. A key is absent when the title is uncached/unmapped so callers fall
// back to the letter placeholder.
//
// Both are live lookups on purpose: the `PlayHistory.posterPath` snapshot taken
// at finalize time is null for every row whose `:details` cache row didn't
// exist yet, so it is only ever a fallback (authoritative beats heuristic).
//
// TmdbMediaCore first: it carries `posterPath` as a plain column, so the
// lookup avoids transferring and parsing the full `:details` JSON blob per id.
// Core rows expire and get purged, so ids missing from core fall back to the
// `TmdbCache` `:details` rows the sync layer already populates — the same
// source the overview's Now Playing cards use.
//
// Both MOVIE and TV rows (and both `movie:`/`tv:` fallback keys) are queried
// for every id because `mediaType` can be null or mismatched on unmapped rows;
// the first poster found per id wins.
export interface PosterLookupItem {
  tmdbId: number | null;
  mediaType?: string | null;
}

// The namespace key for one title. TMDB numbers movies and TV SEPARATELY, so id
// 1399 is a different title in each — keying a poster map on the bare number
// makes it first-writer-wins across the two, which already shipped as a live bug
// once (see the identical `posterKeysFor` in play-history.ts:
// "a session on TV id 1399 was served the poster cached for MOVIE id 1399").
// An unknown mediaType still resolves through the movie key, and the lookup
// below deliberately files such a row under BOTH keys so either spelling hits.
export function posterPathKey(tmdbId: number, mediaType?: string | null): string {
  return mediaType === "TV" ? `tv:${tmdbId}` : `movie:${tmdbId}`;
}

// The poster for one activity row: the live lookup's (authoritative, current)
// when resolvePosterMap found one, else the PlayHistory snapshot at w342, else
// null (the letter tile). One rule for every page that shows these rows.
export function posterSrcFor(
  posters: Record<string, string>,
  tmdbId: number | null,
  mediaType: string | null | undefined,
  snapshotPath: string | null | undefined,
): string | null {
  return (tmdbId != null ? posters[posterPathKey(tmdbId, mediaType)] : undefined) ?? (snapshotPath ? posterUrl(snapshotPath, "w342") : null);
}

function namespacesFor(mediaType?: string | null): ("movie" | "tv")[] {
  if (mediaType === "TV") return ["tv"];
  if (mediaType === "MOVIE") return ["movie"];
  return ["movie", "tv"]; // unknown/unmapped — consult both, first hit wins
}

// Keyed by `posterPathKey`, like `resolvePosterPathMap` — a bare numeric key
// cannot hold a movie and a TV title sharing one TMDB number, and most callers
// pass mixed movie+TV lists.
export async function resolvePosterMap(
  items: PosterLookupItem[],
): Promise<Record<string, string>> {
  const paths = await resolvePosterPathMap(items);
  const map: Record<string, string> = {};
  for (const item of items) {
    if (item.tmdbId == null) continue;
    const key = posterPathKey(item.tmdbId, item.mediaType);
    if (map[key]) continue;
    const path = paths[key];
    if (!path) continue;
    const url = posterUrl(path, "w342");
    if (url) map[key] = url;
  }
  return map;
}

// Same lookup, returning the raw TMDB path instead of a w342 URL. Native
// clients build their own image URLs (at their own size), so they want the
// path; `resolvePosterMap` is this map with `posterUrl` applied.
//
// Keyed by `posterPathKey` ("movie:<id>" / "tv:<id>"), NOT the bare numeric id —
// a caller ranking movies and TV side by side (getTopWatched partitions by
// mediaType, so both can rank the same number) would otherwise get one row's art
// on both.
export async function resolvePosterPathMap(
  items: PosterLookupItem[],
): Promise<Record<string, string>> {
  const { wanted, explicit } = collectWanted(items);
  if (wanted.size === 0) return {};

  const map: Record<string, string> = {};
  const coreRows = await prisma.tmdbMediaCore.findMany({
    where: { tmdbId: { in: [...wanted.keys()] } },
    select: { tmdbId: true, mediaType: true, posterPath: true },
  });
  fillFromCore(map, wanted, coreRows);

  const missing = detailsKeysToRead(map, wanted, explicit);
  if (missing.size === 0) return finalize(map, wanted, explicit);
  const rows = await prisma.tmdbCache.findMany({
    where: { key: { in: [...missing.keys()] } },
    select: { key: true, data: true },
  });
  fillFromDetails(map, missing, rows);
  return finalize(map, wanted, explicit);
}

type Namespace = "movie" | "tv";
type NamespacesById = Map<number, Set<Namespace>>;

// `wanted`: per numeric id, the namespaces any caller asked about (an unknown
// mediaType contributes both). `explicit`: the namespaces a caller NAMED.
// Tracked separately because `wanted` is a union across items: one untyped row
// (or a typed row of the OTHER medium) sharing the number would otherwise make
// the id look "unknown" and hand the typed row the wrong medium's art.
function collectWanted(items: PosterLookupItem[]): { wanted: NamespacesById; explicit: NamespacesById } {
  const wanted: NamespacesById = new Map();
  const explicit: NamespacesById = new Map();
  for (const item of items) {
    if (item.tmdbId == null) continue;
    const namespaces = namespacesFor(item.mediaType);
    const set = wanted.get(item.tmdbId) ?? new Set<Namespace>();
    for (const ns of namespaces) set.add(ns);
    wanted.set(item.tmdbId, set);
    if (namespaces.length === 1) {
      const named = explicit.get(item.tmdbId) ?? new Set<Namespace>();
      for (const ns of namespaces) named.add(ns);
      explicit.set(item.tmdbId, named);
    }
  }
  return { wanted, explicit };
}

// TmdbMediaCore rows into the map, first poster per `<ns>:<id>` wins. Gated on
// posterUrl so a malformed stored path falls through to the TmdbCache row
// rather than being handed out as a dead path.
function fillFromCore(
  map: Record<string, string>,
  wanted: NamespacesById,
  rows: ReadonlyArray<{ tmdbId: number; mediaType: string; posterPath: string | null }>,
): void {
  for (const row of rows) {
    const ns: Namespace = row.mediaType === "TV" ? "tv" : "movie";
    if (!wanted.get(row.tmdbId)?.has(ns)) continue;
    const key = `${ns}:${row.tmdbId}`;
    if (map[key]) continue;
    if (row.posterPath && posterUrl(row.posterPath, "w342")) map[key] = row.posterPath;
  }
}

// The `:details` cache keys still worth reading, each mapped to the
// `<ns>:<id>` key it fills.
function detailsKeysToRead(map: Record<string, string>, wanted: NamespacesById, explicit: NamespacesById): Map<string, string> {
  const missing = new Map<string, string>();
  for (const [id, namespaces] of wanted) {
    const named = explicit.get(id);
    for (const ns of namespaces) {
      if (map[`${ns}:${id}`]) continue;
      // A namespace the caller NAMED is always resolved on its own — the other
      // medium's hit is not an answer for it. Unknown mediaType ⇒ both
      // namespaces were requested, but either one answers the question
      // (finalize mirrors it), so one hit ends the search.
      if (!named?.has(ns) && (map[`movie:${id}`] || map[`tv:${id}`])) continue;
      missing.set(tmdbDetailsKey(ns, id), `${ns}:${id}`);
    }
  }
  return missing;
}

// The posterPath out of each `:details` row. A row whose JSON can't be parsed
// (or carries no usable path) just gives that id no poster.
function fillFromDetails(
  map: Record<string, string>,
  missing: Map<string, string>,
  rows: ReadonlyArray<{ key: string; data: string }>,
): void {
  for (const row of rows) {
    const key = missing.get(row.key);
    if (!key || map[key]) continue;
    let posterPath: unknown;
    try {
      posterPath = (JSON.parse(row.data) as { posterPath?: unknown } | null)?.posterPath;
    } catch {
      continue;
    }
    if (typeof posterPath === "string" && posterPath && posterUrl(posterPath, "w342")) map[key] = posterPath;
  }
}

// An id whose mediaType the caller did NOT know was looked up in both
// namespaces; mirror whichever one hit onto the other so a `posterPathKey(id,
// null)` lookup (which spells "movie:<id>") still resolves. A namespace some
// caller NAMED is never filled from the other one: `wanted` is a union per
// numeric id, so a single untyped row (or a typed row of the other medium)
// sharing the number would otherwise leak a movie's art onto the TV row —
// exactly the cross-namespace bug `posterPathKey` above documents.
function finalize(map: Record<string, string>, wanted: NamespacesById, explicit: NamespacesById): Record<string, string> {
  for (const [id, namespaces] of wanted) {
    if (namespaces.size < 2) continue;
    const named = explicit.get(id);
    const movie = map[`movie:${id}`];
    const tv = map[`tv:${id}`];
    if (movie && !tv && !named?.has("tv")) map[`tv:${id}`] = movie;
    else if (tv && !movie && !named?.has("movie")) map[`movie:${id}`] = tv;
  }
  return map;
}
