import "server-only";
import { prisma } from "./prisma";
import { setCache, libraryDetailsTtl } from "./tmdb-cache";
import { upsertTmdbMediaCore } from "./tmdb-core-sync";
import { safeFetchTrusted, SafeFetchError } from "./safe-fetch";
import { iterateLibrary, LIBRARY_PAGE_SIZE } from "./library-iterator";
import type { LibraryItem } from "./library-iterator";
import { tmdbAuth } from "./tmdb-auth";
import type { TmdbMedia } from "./tmdb-types";

const CONCURRENCY = 5;
const BATCH_DELAY_MS = 250;

const MAX_PREWARM_ITEMS = 200_000;
const TMDB_FETCH_TIMEOUT_MS = 15_000;

const TMDB_BASE = "https://api.themoviedb.org/3";

interface RawSeason {
  season_number: number;
  episode_count: number;
  air_date?: string | null;
  poster_path?: string | null;
  name?: string;
  overview?: string;
}

interface RawProvider {
  provider_id: number;
  provider_name: string;
  logo_path: string | null;
}

interface RawItem {
  id: number;
  title?: string;
  name?: string;
  original_title?: string;
  original_name?: string;
  overview?: string;
  poster_path?: string | null;
  backdrop_path?: string | null;
  release_date?: string;
  first_air_date?: string;
  last_air_date?: string | null;
  vote_average?: number;
  vote_count?: number;
  seasons?: RawSeason[];
  videos?: { results?: { key: string; site: string; type: string; official: boolean }[] };
  belongs_to_collection?: { id: number; name: string } | null;

  runtime?: number;
  episode_run_time?: number[];
  status?: string;
  type?: string;
  in_production?: boolean;
  tagline?: string;
  imdb_id?: string;
  homepage?: string | null;
  budget?: number | null;
  revenue?: number | null;
  genres?: { id: number; name: string }[];
  networks?: { id: number; name: string }[];
  production_companies?: { id: number; name: string }[];
  production_countries?: { iso_3166_1: string; name: string }[];
  origin_country?: string[];
  spoken_languages?: { iso_639_1: string; english_name?: string; name?: string }[];
  original_language?: string;
  number_of_seasons?: number;
  number_of_episodes?: number;
  next_episode_to_air?: { air_date?: string | null } | null;
  keywords?: { keywords?: { id: number; name: string }[]; results?: { id: number; name: string }[] };
  "watch/providers"?: { results?: Record<string, { flatrate?: RawProvider[]; rent?: RawProvider[]; buy?: RawProvider[] }> };
  external_ids?: { tvdb_id?: number | null };
  release_dates?: { results?: { iso_3166_1: string; release_dates: { certification?: string }[] }[] };
  content_ratings?: { results?: { iso_3166_1: string; rating?: string }[] };
}

let pwRegionNames: Intl.DisplayNames | null = null;
let pwLanguageNames: Intl.DisplayNames | null = null;
function pwRegion(code: string): string {
  try { pwRegionNames ??= new Intl.DisplayNames(["en"], { type: "region" }); return pwRegionNames.of(code.toUpperCase()) ?? code; } catch { return code; }
}
function pwLanguage(code: string): string {
  try { pwLanguageNames ??= new Intl.DisplayNames(["en"], { type: "language" }); return pwLanguageNames.of(code) ?? code; } catch { return code; }
}
function pwKeywords(raw?: RawItem["keywords"]): { id: number; name: string }[] | undefined {
  const list = raw?.keywords ?? raw?.results;
  if (!list?.length) return undefined;
  return list.slice(0, 12).map((k) => ({ id: k.id, name: k.name }));
}
// Mirrors extractTrailerKey in tmdb.ts (not exported there): official YouTube
// trailer first, then any trailer, then official teaser, then any teaser.
function pwTrailerKey(videos?: RawItem["videos"]): string | null {
  if (!videos?.results?.length) return null;
  const trailers = videos.results.filter((v) => v.site === "YouTube" && v.type === "Trailer");
  const teasers  = videos.results.filter((v) => v.site === "YouTube" && v.type === "Teaser");
  const official = trailers.find((v) => v.official) ?? trailers[0] ?? teasers.find((v) => v.official) ?? teasers[0];
  return official?.key ?? null;
}
function pwWatchProviders(raw?: RawItem["watch/providers"], region = "US"): TmdbMedia["watchProviders"] {
  const r = raw?.results?.[region];
  if (!r) return undefined;
  const out: NonNullable<TmdbMedia["watchProviders"]> = [];
  const seen = new Set<number>();
  const add = (type: "stream" | "rent" | "buy", list?: RawProvider[]) => {
    for (const p of list ?? []) {
      if (seen.has(p.provider_id)) continue;
      seen.add(p.provider_id);
      out.push({ type, name: p.provider_name, logoPath: p.logo_path });
    }
  };
  add("stream", r.flatrate); add("rent", r.rent); add("buy", r.buy);
  return out.length ? out : undefined;
}

async function fetchAndStore(tmdbId: number, mediaType: "MOVIE" | "TV"): Promise<void> {
  const type = mediaType === "MOVIE" ? "movie" : "tv";
  const auth = tmdbAuth();
  if (!auth) return;

  const url = new URL(`${TMDB_BASE}/${type}/${tmdbId}`);
  for (const [k, v] of Object.entries(auth.query)) url.searchParams.set(k, v);
  // release_dates/content_ratings included so the prewarm rewrite of the shared
  // :details blob (and the TmdbMediaCore upsert) carries the US certification —
  // omitting them made every prewarm refresh silently drop a previously-stored
  // cert badge from both the grid and the detail page. `videos` rides along for
  // the same reason: without it the rewrite dropped the trailerKey that
  // getMovieDetails/getTVDetails had stored, and the trailer button vanished
  // for library titles (same failure class as the cert drop).
  url.searchParams.set(
    "append_to_response",
    mediaType === "TV"
      ? "seasons,keywords,watch/providers,external_ids,content_ratings,videos"
      : "keywords,watch/providers,external_ids,release_dates,videos",
  );

  let res: Response;
  try {
    // Use safeFetchTrusted instead of Next.js fetch so the request bypasses the Next cache and
    // never gets deduped or revalidated against a stale store entry.
    res = await safeFetchTrusted(url.toString(), {
      allowedHosts: ["api.themoviedb.org"],
      headers: auth.headers,
      timeoutMs: TMDB_FETCH_TIMEOUT_MS,
    });
  } catch (err) {
    if (err instanceof SafeFetchError) {
      console.warn(`[prewarm] TMDB ${type}:${tmdbId} → ${err.reason} (${err.message})`);
      return;
    }
    throw err;
  }
  if (!res.ok) {
    if (res.status !== 404) {
      console.warn(`[prewarm] TMDB ${type}:${tmdbId} → HTTP ${res.status}`);
    }
    return;
  }

  // Read as text first so we can log a diagnostic snippet if JSON parsing fails — `await res.json()`
  // throws a SyntaxError whose message renders non-printable leading bytes invisibly ("Unexpected
  // token '', \"\"..."), making the failure mode impossible to diagnose from the log alone.
  const bodyText = await res.text();
  let raw: RawItem;
  try {
    raw = JSON.parse(bodyText) as RawItem;
  } catch (err) {
    const head = bodyText.slice(0, 80);
    const hex = Buffer.from(bodyText.slice(0, 16), "utf-8").toString("hex");
    console.warn(
      `[prewarm] TMDB ${type}:${tmdbId} JSON.parse failed (len=${bodyText.length}, ` +
      `ce=${res.headers.get("content-encoding") ?? "none"}, ` +
      `ct=${res.headers.get("content-type") ?? "none"}, head=${JSON.stringify(head)}, hex=${hex}):`,
      err instanceof Error ? err.message : String(err),
    );
    return;
  }
  const rawDate = mediaType === "MOVIE" ? raw.release_date : raw.first_air_date;
  // US certification, extracted the same way getMovieDetails/getTVDetails do.
  const certification =
    (mediaType === "MOVIE"
      ? raw.release_dates?.results?.find((x) => x.iso_3166_1 === "US")
          ?.release_dates.find((d) => d.certification)?.certification
      : raw.content_ratings?.results?.find((x) => x.iso_3166_1 === "US")?.rating) || undefined;

  const seasons = mediaType === "TV"
    ? (raw.seasons ?? [])
        .filter((s) => s.season_number > 0 && s.episode_count > 0)
        .map((s) => ({
          seasonNumber: s.season_number,
          episodeCount: s.episode_count,
          airDate: s.air_date ?? null,
          posterPath: s.poster_path ?? null,
          name: s.name ?? `Season ${s.season_number}`,
          overview: s.overview ?? "",
        }))
    : undefined;

  const title = (mediaType === "MOVIE" ? raw.title : raw.name) ?? "";
  // null (not "Unknown") — the normalize writers (tmdb.ts) use null for a
  // missing year, and both persist the same :details key / TmdbMediaCore row.
  const releaseYear = rawDate ? rawDate.substring(0, 4) : null;
  const originalTitle = mediaType === "MOVIE" ? raw.original_title : raw.original_name;
  const studios = (mediaType === "TV" && raw.networks?.length ? raw.networks : raw.production_companies) ?? [];
  const countries = raw.production_countries?.length
    ? raw.production_countries.map((c) => c.name || pwRegion(c.iso_3166_1))
    : (raw.origin_country?.map(pwRegion) ?? []);
  // Match the normalize shape (src/lib/tmdb.ts): `genres`/`keywords` = names (back-compat),
  // `genreList`/`keywordList` = id+name. Both writers persist the same `:details` cache key.
  const genreObjs = raw.genres?.map((g) => ({ id: g.id, name: g.name })) ?? [];
  const keywordObjs = pwKeywords(raw.keywords) ?? [];
  await setCache(`${type}:${tmdbId}:details`, {
    id: raw.id,
    mediaType: type,
    title,
    // `?? ""` (not null) — TmdbMedia.overview is a non-nullable string and the
    // normalize writers use "", so the shared :details key keeps one nullability.
    overview: raw.overview ?? "",
    posterPath: raw.poster_path ?? null,
    backdropPath: raw.backdrop_path ?? null,
    releaseDate: rawDate ?? null,
    releaseYear,
    voteAverage: raw.vote_average ?? 0,
    voteCount: raw.vote_count ?? 0,
    ...(certification && { certification }),
    ...(seasons !== undefined && { seasons }),
    // trailerKey/collection mirror getMovieDetails/getTVDetails — omitting them
    // made every prewarm refresh erase the trailer button and the collection
    // row from library titles' detail pages (see the append_to_response note).
    trailerKey: pwTrailerKey(raw.videos),
    ...(mediaType === "MOVIE" && raw.belongs_to_collection
      ? { collectionId: raw.belongs_to_collection.id, collectionName: raw.belongs_to_collection.name }
      : {}),

    genres:          genreObjs.map((g) => g.name),
    genreList:       genreObjs,
    studios:         studios.map((c) => c.name),
    tagline:         raw.tagline ?? null,
    status:          raw.status ?? null,
    imdbId:          raw.imdb_id ?? null,
    runtime:         raw.runtime ?? (raw.episode_run_time?.[0] ?? null),
    numberOfSeasons: raw.number_of_seasons ?? null,
    numberOfEpisodes: raw.number_of_episodes ?? null,

    originalTitle:       originalTitle && originalTitle !== title ? originalTitle : null,
    originalLanguage:    raw.original_language ?? null,
    spokenLanguages:     raw.spoken_languages?.map((l) => l.english_name || l.name || pwLanguage(l.iso_639_1)) ?? [],
    productionCountries: countries,
    homepage:            raw.homepage || null,
    budget:              raw.budget || null,
    revenue:             raw.revenue || null,
    keywords:            keywordObjs.map((k) => k.name),
    keywordList:         keywordObjs,
    watchProviders:      pwWatchProviders(raw["watch/providers"]) ?? [],
    tvdbId:              raw.external_ids?.tvdb_id ?? null,
    lastAirDate:         raw.last_air_date ?? null,
    inProduction:        raw.in_production ?? null,
    tvType:              raw.type ?? null,
    nextEpisodeAirDate:  raw.next_episode_to_air?.air_date ?? null,
  }, libraryDetailsTtl(rawDate));
  await upsertTmdbMediaCore({
    id: raw.id,
    mediaType: type,
    title,
    overview: raw.overview ?? "",
    posterPath: raw.poster_path ?? null,
    backdropPath: raw.backdrop_path ?? null,
    releaseDate: rawDate ?? null,
    releaseYear,
    voteAverage: raw.vote_average ?? 0,
    ...(certification && { certification }),
  });
}

async function processPrewarmPage(
  page: LibraryItem[],
  stats: { fetched: number; backfilled: number; skipped: number; failed: number },
): Promise<void> {
  const cacheKey = (i: LibraryItem) =>
    `${i.mediaType === "MOVIE" ? "movie" : "tv"}:${i.tmdbId}:details`;

  const keys = page.map(cacheKey);
  const cacheRows = await prisma.tmdbCache.findMany({
    where: { key: { in: keys } },
    select: { key: true, cachedAt: true, expiresAt: true },
  });
  const freshKeySet = new Set<string>();
  // "Fresh" means the row still has more than 25% of its original TTL remaining — below that threshold
  // it's cheaper to re-fetch now than risk a cache miss in production during peak traffic.
  for (const r of cacheRows) {
    const originalTtlMs = r.expiresAt.getTime() - r.cachedAt.getTime();
    if (r.expiresAt.getTime() - Date.now() > originalTtlMs * 0.25) freshKeySet.add(r.key);
  }

  const freshItems = page.filter((i) => freshKeySet.has(cacheKey(i)));
  const staleItems = page.filter((i) => !freshKeySet.has(cacheKey(i)));

  if (freshItems.length > 0) {
    const coreRows = await prisma.tmdbMediaCore.findMany({
      where: { OR: freshItems.map((x) => ({ tmdbId: x.tmdbId, mediaType: x.mediaType })) },
      select: { tmdbId: true, mediaType: true },
    });
    const coreSet = new Set(coreRows.map((r) => `${r.tmdbId}:${r.mediaType}`));

    // Items with a fresh TmdbCache entry but no TmdbMediaCore row missed a previous upsert; backfill
    // from the cached JSON rather than making a live TMDB request.
    const toBackfill = freshItems.filter((i) => !coreSet.has(`${i.tmdbId}:${i.mediaType}`));
    stats.skipped += freshItems.length - toBackfill.length;

    if (toBackfill.length > 0) {
      const backfillKeys = toBackfill.map(cacheKey);
      const cachedRows = await prisma.tmdbCache.findMany({
        where: { key: { in: backfillKeys } },
        select: { data: true },
      });
      for (const row of cachedRows) {
        try {
          await upsertTmdbMediaCore(JSON.parse(row.data) as TmdbMedia);
          stats.backfilled++;
        } catch (err) {
          stats.failed++;
          console.warn("[prewarm] TmdbMediaCore backfill from cache failed:", err);
        }
      }
    }
  }

  for (let i = 0; i < staleItems.length; i += CONCURRENCY) {
    const batch = staleItems.slice(i, i + CONCURRENCY);
    const results = await Promise.allSettled(
      batch.map((item) => fetchAndStore(item.tmdbId, item.mediaType)),
    );
    for (const r of results) {
      if (r.status === "fulfilled") stats.fetched++;
      else { stats.failed++; console.warn("[prewarm] item failed:", r.reason); }
    }
    if (i + CONCURRENCY < staleItems.length) {
      await new Promise((resolve) => setTimeout(resolve, BATCH_DELAY_MS));
    }
  }
}

// Walk the Plex + Jellyfin libraries (deduped), fetching each title's full TMDB
// detail page into the cache so browse/detail views hit warm rows; fresh entries
// are skipped and cache-only rows are backfilled into TmdbMediaCore without a live fetch.
export async function prewarmLibraryCache(): Promise<{ total: number; fetched: number; backfilled: number; skipped: number; failed: number }> {
  if (!tmdbAuth()) {
    return { total: 0, fetched: 0, backfilled: 0, skipped: 0, failed: 0 };
  }

  const seen = new Set<string>();
  let total = 0;
  const stats = { fetched: 0, backfilled: 0, skipped: 0, failed: 0 };

  const sources = ["plex", "jellyfin"] as const;
  const mediaTypes = ["MOVIE", "TV"] as const;

  let pageBuffer: LibraryItem[] = [];

  const flushPage = async () => {
    if (pageBuffer.length === 0) return;
    await processPrewarmPage(pageBuffer, stats);
    pageBuffer = [];
  };

  outer: for (const source of sources) {
    for (const mediaType of mediaTypes) {
      for await (const item of iterateLibrary(source, mediaType)) {
        const k = `${item.tmdbId}:${item.mediaType}`;
        if (seen.has(k)) continue;
        seen.add(k);
        total++;
        pageBuffer.push(item);

        if (pageBuffer.length >= LIBRARY_PAGE_SIZE) await flushPage();
        if (total >= MAX_PREWARM_ITEMS) {
          console.warn(`[prewarm] Reached MAX_PREWARM_ITEMS (${MAX_PREWARM_ITEMS}) — library scan truncated`);
          break outer;
        }
      }
    }
  }

  await flushPage();

  if (total === 0) {
    return { total: 0, ...stats };
  }

  return { total, ...stats };
}
