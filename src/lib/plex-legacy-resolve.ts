import { getCacheMany, setCache } from "./tmdb-cache";
import { tmdbAuth } from "./tmdb-auth";
import { safeFetchTrusted } from "./safe-fetch";
import { sanitizeForLog } from "./sanitize";
import { mapLimit } from "./concurrency";
import { resolveTvdbToTmdb } from "./arr";
import { withDuplicateRatingKeys, getPlexTmdbIds, type PlexLegacyGuidRef, type PlexLibraryItemData, type PlexSection } from "./plex";

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

export interface ResolvedLegacyItem {
  tmdbId: number;
  ratingKey: string;
  data: PlexLibraryItemData;
}

export async function resolvePlexLegacyGuids(
  refs: Map<string, PlexLegacyGuidRef>,
  mediaType: "MOVIE" | "TV",
): Promise<ResolvedLegacyItem[]> {
  if (refs.size === 0) return [];
  const out: ResolvedLegacyItem[] = [];
  const list = Array.from(refs.values());

  try {
    // thetvdb:// (the legacy default TV agent) — reuse the arr-side batch
    // resolver: cache → MediaRequest → TMDB /find, with its own negative TTLs.
    if (mediaType === "TV") {
      const tvdbRefs = list.filter((r) => r.tvdbId != null);
      if (tvdbRefs.length > 0) {
        const { map } = await resolveTvdbToTmdb(tvdbRefs.map((r) => r.tvdbId!));
        for (const ref of tvdbRefs) {
          const tmdbId = map.get(ref.tvdbId!);
          if (tmdbId != null) out.push({ tmdbId, ratingKey: ref.ratingKey, data: ref.data });
        }
      }
    }

    // imdb:// (the legacy "Plex Movie" agent) — /find with external_source=imdb_id.
    const imdbRefs = list.filter((r) => r.imdbId != null);
    if (imdbRefs.length > 0) {
      const cached = await getCacheMany<ImdbToTmdbCache>(imdbRefs.map((r) => `imdb-to-tmdb:${r.imdbId}`));
      const uncached = imdbRefs.filter((r) => !cached.has(`imdb-to-tmdb:${r.imdbId}`));
      const auth = tmdbAuth();
      if (auth && uncached.length > 0) {
        await mapLimit(uncached, IMDB_FIND_CONCURRENCY, async (ref) => {
          try {
            const url = new URL(`https://api.themoviedb.org/3/find/${ref.imdbId}`);
            url.searchParams.set("external_source", "imdb_id");
            for (const [k, v] of Object.entries(auth.query)) url.searchParams.set(k, v);
            const res = await safeFetchTrusted(url.toString(), {
              allowedHosts: ["api.themoviedb.org"],
              headers: auth.headers,
              timeoutMs: 10_000,
            });
            if (!res.ok) {
              console.warn("[plex-legacy] imdb-to-tmdb lookup returned %s for %s", sanitizeForLog(res.status), sanitizeForLog(ref.imdbId));
              return;
            }
            const data = await res.json() as { movie_results?: { id: number }[]; tv_results?: { id: number }[] };
            const entry: ImdbToTmdbCache = {
              movie: data.movie_results?.[0]?.id ?? null,
              tv:    data.tv_results?.[0]?.id ?? null,
            };
            cached.set(`imdb-to-tmdb:${ref.imdbId}`, entry);
            await setCache(
              `imdb-to-tmdb:${ref.imdbId}`,
              entry,
              entry.movie !== null || entry.tv !== null ? IMDB_TO_TMDB_TTL_RESOLVED : IMDB_TO_TMDB_TTL_UNRESOLVED,
            );
          } catch (err) {
            console.warn("[plex-legacy] imdb-to-tmdb lookup failed for %s:", sanitizeForLog(ref.imdbId), sanitizeForLog(err instanceof Error ? err.message : err));
          }
        });
      }
      for (const ref of imdbRefs) {
        const entry = cached.get(`imdb-to-tmdb:${ref.imdbId}`);
        const tmdbId = mediaType === "MOVIE" ? entry?.movie : entry?.tv;
        if (tmdbId != null) out.push({ tmdbId, ratingKey: ref.ratingKey, data: ref.data });
      }
    }
  } catch (err) {
    console.warn("[plex-legacy] legacy guid resolution failed:", err instanceof Error ? err.message : String(err));
  }
  return out;
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
  for (const r of ordered) {
    const existing = items.get(r.tmdbId);
    // The modern-agent row keeps the title; the legacy copy's ratingKey stays
    // addressable so its plays still resolve (guardrail 37c).
    items.set(r.tmdbId, existing ? withDuplicateRatingKeys(existing, r.data) : r.data);
    if (ratingKeyToTmdb && !ratingKeyToTmdb.has(r.ratingKey)) {
      ratingKeyToTmdb.set(r.ratingKey, [r.tmdbId]);
    }
  }
}

// The show ratingKey -> tmdb ids map a WHOLE-table TVEpisodeCache rewrite needs,
// legacy-agent shows included. getPlexTVEpisodes' own fallback walk only reads
// modern Guid[] shows, so a rewrite fed by it (the standalone tv-episodes route,
// the per-source Plex resync's recentOnly path) silently dropped the episodes of
// every thetvdb:// / imdb:// show the orchestrator had cached, until its next
// run. Same listing the internal walk pages, so no extra requests.
export async function buildPlexShowKeyMap(
  serverUrl: string,
  token: string,
  selectedKeys: Set<string> | undefined,
  sections: PlexSection[],
): Promise<Map<string, number[]>> {
  const ratingKeyToTmdb = new Map<string, number[]>();
  const tvLegacy = new Map<string, PlexLegacyGuidRef>();
  const tvIds = await getPlexTmdbIds(serverUrl, token, "TV", false, selectedKeys, sections, ratingKeyToTmdb, tvLegacy, true);
  mergeResolvedLegacyItems(await resolvePlexLegacyGuids(tvLegacy, "TV"), tvIds, ratingKeyToTmdb);
  return ratingKeyToTmdb;
}
