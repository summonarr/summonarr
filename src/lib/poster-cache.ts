import { prisma } from "@/lib/prisma";
import { posterUrl } from "@/lib/tmdb-types";

// Resolve TMDB posters for activity views — `resolvePosterMap` returns a
// tmdbId→url map, `resolvePosterPathMap` the same lookup as raw TMDB paths.
// An id is absent when the title is uncached/unmapped so callers fall back to
// the letter placeholder.
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

function namespacesFor(mediaType?: string | null): ("movie" | "tv")[] {
  if (mediaType === "TV") return ["tv"];
  if (mediaType === "MOVIE") return ["movie"];
  return ["movie", "tv"]; // unknown/unmapped — consult both, first hit wins
}

export async function resolvePosterMap(
  items: PosterLookupItem[],
): Promise<Record<number, string>> {
  const paths = await resolvePosterPathMap(items);
  const map: Record<number, string> = {};
  for (const item of items) {
    if (item.tmdbId == null || map[item.tmdbId]) continue;
    const path = paths[posterPathKey(item.tmdbId, item.mediaType)];
    if (!path) continue;
    const url = posterUrl(path, "w342");
    if (url) map[item.tmdbId] = url;
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
  // Per numeric id, the set of namespaces any caller asked about. An id requested
  // with an unknown mediaType contributes both.
  const wanted = new Map<number, Set<"movie" | "tv">>();
  // Per numeric id, the namespaces a caller named EXPLICITLY. Tracked separately
  // because `wanted` is a union across items: one untyped row (or a typed row of
  // the OTHER medium) sharing the number would otherwise make the id look
  // "unknown" and hand the typed row the wrong medium's art.
  const explicit = new Map<number, Set<"movie" | "tv">>();
  for (const item of items) {
    if (item.tmdbId == null) continue;
    const namespaces = namespacesFor(item.mediaType);
    const set = wanted.get(item.tmdbId) ?? new Set<"movie" | "tv">();
    for (const ns of namespaces) set.add(ns);
    wanted.set(item.tmdbId, set);
    if (namespaces.length === 1) {
      const named = explicit.get(item.tmdbId) ?? new Set<"movie" | "tv">();
      for (const ns of namespaces) named.add(ns);
      explicit.set(item.tmdbId, named);
    }
  }
  if (wanted.size === 0) return {};

  const ids = [...wanted.keys()];
  const map: Record<string, string> = {};

  const coreRows = await prisma.tmdbMediaCore.findMany({
    where: { tmdbId: { in: ids } },
    select: { tmdbId: true, mediaType: true, posterPath: true },
  });
  for (const row of coreRows) {
    const ns = row.mediaType === "TV" ? "tv" : "movie";
    if (!wanted.get(row.tmdbId)?.has(ns)) continue;
    const key = `${ns}:${row.tmdbId}`;
    if (map[key]) continue;
    // Gate on posterUrl so a malformed stored path falls through to the
    // TmdbCache row below rather than being handed out as a dead path.
    if (row.posterPath && posterUrl(row.posterPath, "w342")) {
      map[key] = row.posterPath;
    }
  }

  const missing: string[] = [];
  for (const [id, namespaces] of wanted) {
    const named = explicit.get(id);
    for (const ns of namespaces) {
      if (map[`${ns}:${id}`]) continue;
      // A namespace the caller NAMED is always resolved on its own — the other
      // medium's hit is not an answer for it.
      if (named?.has(ns)) {
        missing.push(`${ns}:${id}`);
        continue;
      }
      // Unknown mediaType ⇒ both namespaces were requested, but either one
      // answers the question (finalize mirrors it), so one hit ends the search.
      if (map[`movie:${id}`] || map[`tv:${id}`]) continue;
      missing.push(`${ns}:${id}`);
    }
  }
  if (missing.length === 0) return finalize(map, wanted, explicit);

  const rows = await prisma.tmdbCache.findMany({
    where: { key: { in: missing.map((k) => `${k}:details`) } },
    select: { key: true, data: true },
  });

  for (const row of rows) {
    const [ns, rawId] = row.key.split(":");
    const id = parseInt(rawId ?? "", 10);
    if (!Number.isFinite(id) || (ns !== "movie" && ns !== "tv")) continue;
    const key = `${ns}:${id}`;
    if (map[key]) continue;
    try {
      const parsed = JSON.parse(row.data) as { posterPath?: string | null };
      if (parsed.posterPath && posterUrl(parsed.posterPath, "w342")) {
        map[key] = parsed.posterPath;
      }
    } catch {
      // ignore unparseable cache rows
    }
  }
  return finalize(map, wanted, explicit);
}

// An id whose mediaType the caller did NOT know was looked up in both
// namespaces; mirror whichever one hit onto the other so a `posterPathKey(id,
// null)` lookup (which spells "movie:<id>") still resolves. A namespace some
// caller NAMED is never filled from the other one: `wanted` is a union per
// numeric id, so a single untyped row (or a typed row of the other medium)
// sharing the number would otherwise leak a movie's art onto the TV row —
// exactly the cross-namespace bug `posterPathKey` above documents.
function finalize(
  map: Record<string, string>,
  wanted: Map<number, Set<"movie" | "tv">>,
  explicit: Map<number, Set<"movie" | "tv">>,
): Record<string, string> {
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
