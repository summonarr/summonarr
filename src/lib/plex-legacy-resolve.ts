import { getCacheMany, setCache } from "./tmdb-cache";
import { tmdbAuth } from "./tmdb-auth";
import { safeFetchTrusted } from "./safe-fetch";
import { sanitizeForLog } from "./sanitize";
import { mapLimit } from "./concurrency";
import { v, check } from "./validate";
import { resolveTvdbToTmdb } from "./arr";
import { foldDuplicateRatingKeys, plexLibraryRatingKeys, getPlexTmdbIds, type PlexLegacyGuidRef, type PlexLibraryItemData, type PlexSection } from "./plex";

// Resolves the legacy-agent secondary channel (see PlexLegacyGuidRef in
// plex.ts) to tmdb ids via TMDB /find — com.plexapp.agents.thetvdb:// shows
// and com.plexapp.agents.imdb:// movies carry no tmdb id at all, so those
// items were entirely invisible to availability and the episode cache (users
// re-requested titles already on the server). Lives OUTSIDE plex.ts because
// resolution needs the TmdbCache/prisma layer and plex.ts is deliberately
// DB-free (its test suite loads it against a bare fetch stub).
//
// Best-effort by design: any resolution failure degrades that item to its
// previous invisibility instead of throwing, so guardrail 35's all-or-nothing
// instance gates can never trip on a metadata lookup.

const IMDB_TO_TMDB_TTL_RESOLVED   = 365 * 24 * 60 * 60;
const IMDB_TO_TMDB_TTL_UNRESOLVED =        24 * 60 * 60;
const IMDB_FIND_CONCURRENCY = 5; // matches arr.ts's tvdb→tmdb fan-out bound

// Both result types are cached from one /find call: the same imdb id is asked
// once even when movie and TV libraries both carry legacy imdb guids.
type ImdbToTmdbCache = { movie: number | null; tv: number | null };
// A cached row of any other shape is a miss (asked again), never an id that
// lands on a library row.
const ImdbToTmdbCacheSchema = v.object({ movie: v.nullable(v.int()), tv: v.nullable(v.int()) });

// The /find fields read. An answer that doesn't fit is a failed lookup (warned,
// not cached), never a cached "no match".
const FindResultSchema = v.object({
  movie_results: v.optional(v.array(v.object({ id: v.int() }))),
  tv_results: v.optional(v.array(v.object({ id: v.int() }))),
});

export interface ResolvedLegacyItem {
  tmdbId: number;
  ratingKey: string;
  data: PlexLibraryItemData;
}

export interface LegacyResolution {
  items: ResolvedLegacyItem[];
  // False when some lookup failed (TVDB batch, cache read, an uncached /find):
  // a ref may be missing because the answer never came, not because there is
  // none. A full replace fed by an incomplete set drops those titles until the
  // next good run, so a caller that can hold its replace should.
  complete: boolean;
}

const imdbCacheKey = (imdbId: string) => `imdb-to-tmdb:${imdbId}`;

// thetvdb:// (the legacy default TV agent) — reuse the arr-side batch
// resolver: cache → MediaRequest → TMDB /find, with its own negative TTLs.
async function resolveTvdbRefs(
  list: PlexLegacyGuidRef[],
  out: ResolvedLegacyItem[],
): Promise<{ resolvedKeys: Set<string>; hadErrors: boolean }> {
  const resolvedKeys = new Set<string>();
  const tvdbRefs = list.filter((r): r is PlexLegacyGuidRef & { tvdbId: number } => r.tvdbId != null);
  if (tvdbRefs.length === 0) return { resolvedKeys, hadErrors: false };
  const { map, hadErrors } = await resolveTvdbToTmdb(tvdbRefs.map((r) => r.tvdbId));
  for (const ref of tvdbRefs) {
    const tmdbId = map.get(ref.tvdbId);
    if (tmdbId == null) continue;
    out.push({ tmdbId, ratingKey: ref.ratingKey, data: ref.data });
    resolvedKeys.add(ref.ratingKey);
  }
  return { resolvedKeys, hadErrors };
}

// One TMDB /find for an imdb id, cached either way. False when no usable
// answer came back (nothing cached then).
async function findImdbId(imdbId: string, auth: NonNullable<ReturnType<typeof tmdbAuth>>, cached: Map<string, ImdbToTmdbCache>): Promise<boolean> {
  try {
    const url = new URL(`https://api.themoviedb.org/3/find/${imdbId}`);
    url.searchParams.set("external_source", "imdb_id");
    const res = await safeFetchTrusted(url.toString(), {
      allowedHosts: ["api.themoviedb.org"],
      headers: auth.headers,
      timeoutMs: 10_000,
    });
    if (!res.ok) {
      console.warn("[plex-legacy] imdb-to-tmdb lookup returned %s for %s", sanitizeForLog(res.status), sanitizeForLog(imdbId));
      return false;
    }
    const parsed = check(FindResultSchema, await res.json().catch(() => undefined));
    if (!parsed.ok) {
      console.warn("[plex-legacy] imdb-to-tmdb lookup for %s: unexpected answer (%s)", sanitizeForLog(imdbId), sanitizeForLog(parsed.error));
      return false;
    }
    const entry: ImdbToTmdbCache = {
      movie: parsed.value.movie_results?.[0]?.id ?? null,
      tv:    parsed.value.tv_results?.[0]?.id ?? null,
    };
    cached.set(imdbCacheKey(imdbId), entry);
    await setCache(
      imdbCacheKey(imdbId),
      entry,
      entry.movie !== null || entry.tv !== null ? IMDB_TO_TMDB_TTL_RESOLVED : IMDB_TO_TMDB_TTL_UNRESOLVED,
    );
    return true;
  } catch (err) {
    console.warn("[plex-legacy] imdb-to-tmdb lookup failed for %s:", sanitizeForLog(imdbId), sanitizeForLog(err instanceof Error ? err.message : err));
    return false;
  }
}

// imdb:// (the legacy "Plex Movie" agent) — /find with external_source=imdb_id.
// Returns whether every ref got an answer (cached or fetched).
async function resolveImdbRefs(
  imdbRefs: Array<PlexLegacyGuidRef & { imdbId: string }>,
  mediaType: "MOVIE" | "TV",
  out: ResolvedLegacyItem[],
): Promise<boolean> {
  if (imdbRefs.length === 0) return true;
  const cached: Map<string, ImdbToTmdbCache> = await getCacheMany(imdbRefs.map((r) => imdbCacheKey(r.imdbId)), ImdbToTmdbCacheSchema);
  // One lookup per distinct id: two copies of a title share an imdb id.
  const uncached = [...new Set(imdbRefs.map((r) => r.imdbId).filter((id) => !cached.has(imdbCacheKey(id))))];
  let complete = true;
  if (uncached.length > 0) {
    const auth = tmdbAuth();
    if (!auth) {
      complete = false;
    } else {
      const answered = await mapLimit(uncached, IMDB_FIND_CONCURRENCY, (id) => findImdbId(id, auth, cached));
      if (answered.includes(false)) complete = false;
    }
  }
  for (const ref of imdbRefs) {
    const entry = cached.get(imdbCacheKey(ref.imdbId));
    const tmdbId = mediaType === "MOVIE" ? entry?.movie : entry?.tv;
    if (tmdbId != null) out.push({ tmdbId, ratingKey: ref.ratingKey, data: ref.data });
  }
  return complete;
}

/**
 * Resolves legacy-agent refs to tmdb ids and says whether every lookup
 * answered. Never throws: a failed stage keeps what resolved before it and
 * reports `complete: false`.
 */
export async function resolvePlexLegacyGuidsDetailed(
  refs: Map<string, PlexLegacyGuidRef>,
  mediaType: "MOVIE" | "TV",
): Promise<LegacyResolution> {
  if (refs.size === 0) return { items: [], complete: true };
  const out: ResolvedLegacyItem[] = [];
  const list = Array.from(refs.values());
  let complete = true;

  let tvdbResolved = new Set<string>();
  if (mediaType === "TV") {
    try {
      const tvdb = await resolveTvdbRefs(list, out);
      tvdbResolved = tvdb.resolvedKeys;
      if (tvdb.hadErrors) complete = false;
    } catch (err) {
      complete = false;
      console.warn("[plex-legacy] tvdb guid resolution failed:", err instanceof Error ? err.message : String(err));
    }
  }

  // A show TVDB already resolved is not asked again by imdb id: that doubled
  // the /find calls, and two answers that disagreed put two tmdb ids on one
  // ratingKey.
  const imdbRefs = list.filter(
    (r): r is PlexLegacyGuidRef & { imdbId: string } => r.imdbId != null && !tvdbResolved.has(r.ratingKey),
  );
  try {
    if (!(await resolveImdbRefs(imdbRefs, mediaType, out))) complete = false;
  } catch (err) {
    complete = false;
    console.warn("[plex-legacy] imdb guid resolution failed:", err instanceof Error ? err.message : String(err));
  }
  return { items: out, complete };
}

export async function resolvePlexLegacyGuids(
  refs: Map<string, PlexLegacyGuidRef>,
  mediaType: "MOVIE" | "TV",
): Promise<ResolvedLegacyItem[]> {
  return (await resolvePlexLegacyGuidsDetailed(refs, mediaType)).items;
}

// Merge resolved legacy items into the maps the sync writers consume, keeping
// the availability map and the episode ratingKey mapping in agreement (the
// invariant the multi-valued extractAllTmdbIds comment in plex.ts documents).
// A tmdbId already present from a modern-agent item wins — legacy resolution
// must never shadow an authoritative Guid match.
export function mergeResolvedLegacyItems(
  resolved: ResolvedLegacyItem[],
  items: Map<number, PlexLibraryItemData>,
  ratingKeyToTmdb?: Map<string, number[]>,
): void {
  // Two legacy items can resolve to ONE tmdb id (a split duplicate, two sections).
  // The first one merged becomes the stored row, and `resolved` arrives in the
  // order the legacy map was filled — by section walks that run concurrently
  // (Promise.all in getPlexTmdbIds), so arrival order varies between runs and
  // would flip which copy owns the row's ratingKey/filePath. Order by ratingKey
  // (numeric-aware) so the same copy wins every time (guardrail 37b's rule).
  const ordered = [...resolved].sort((a, b) =>
    a.ratingKey.localeCompare(b.ratingKey, "en", { numeric: true }) || a.tmdbId - b.tmdbId,
  );
  const otherCopyKeys = new Map<number, string[]>();
  for (const r of ordered) {
    if (items.has(r.tmdbId)) {
      // The modern-agent row keeps the title; the legacy copy's ratingKey stays
      // addressable so its plays still resolve (guardrail 37c). Folded once
      // below, not per copy (see foldDuplicateRatingKeys in plex.ts).
      let keys = otherCopyKeys.get(r.tmdbId);
      if (!keys) {
        keys = [];
        otherCopyKeys.set(r.tmdbId, keys);
      }
      for (const k of plexLibraryRatingKeys(r.data)) keys.push(k);
    } else {
      items.set(r.tmdbId, r.data);
    }
    if (ratingKeyToTmdb && !ratingKeyToTmdb.has(r.ratingKey)) {
      ratingKeyToTmdb.set(r.ratingKey, [r.tmdbId]);
    }
  }
  for (const [tmdbId, keys] of otherCopyKeys) {
    items.set(tmdbId, foldDuplicateRatingKeys(items.get(tmdbId)!, keys));
  }
}

// The show ratingKey -> tmdb ids map a WHOLE-table TVEpisodeCache rewrite needs,
// legacy-agent shows included. getPlexTVEpisodes' own fallback walk only reads
// modern Guid[] shows, so a rewrite fed by it (the standalone tv-episodes route,
// the per-source Plex resync's recentOnly path) silently dropped the episodes of
// every thetvdb:// / imdb:// show the orchestrator had cached, until its next
// run. Same listing the internal walk pages, so no extra requests. `signal`
// ends the walk (it rejects) when a caller's advisory lock is lost.
export async function buildPlexShowKeyMap(
  serverUrl: string,
  token: string,
  selectedKeys: Set<string> | undefined,
  sections: PlexSection[],
  signal?: AbortSignal,
): Promise<Map<string, number[]>> {
  const ratingKeyToTmdb = new Map<string, number[]>();
  const tvLegacy = new Map<string, PlexLegacyGuidRef>();
  const tvIds = await getPlexTmdbIds(serverUrl, token, "TV", {
    selectedKeys,
    sections,
    ratingKeyToTmdbOut: ratingKeyToTmdb,
    legacyOut: tvLegacy,
    signal,
  });
  mergeResolvedLegacyItems(await resolvePlexLegacyGuids(tvLegacy, "TV"), tvIds, ratingKeyToTmdb);
  return ratingKeyToTmdb;
}
