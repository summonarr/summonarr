import "server-only";
import { getCacheMany, setCache, TTL } from "./tmdb-cache";
import { coalesce } from "./concurrency";
import { processSingleton } from "./process-singleton";
import {
  fetchTitleTranslations,
  getMovieGenres,
  getTVGenres,
  tmdbLanguageFor,
  type TitleTranslations,
} from "./tmdb";
import type { TmdbMedia } from "./tmdb-types";
import type { Locale } from "./i18n/locales";

// TMDB content in the viewer's language, as an OVERLAY on the English payloads.
//
// Why an overlay and not a `language=` parameter on every fetch:
// - Every TMDB cache (lists, details, TmdbMediaCore, the recommendation graph)
//   is shared server-wide and English. Keying them by language would multiply
//   all of them by the number of languages in use, and the ratings, request and
//   *arr paths read them as English (a request still stores the English title).
// - TMDB's /translations answers EVERY language in one call, so a title costs
//   one extra fetch per TTL however many languages its viewers use.
//
// What is localized: title, overview and tagline (anything TMDB has no
// translation for keeps its English text), and genre names on the detail rows
// that carry `genreList`. Posters, cast and credits are not.
//
// English is a no-op: no DB read, no fetch, the input array returned as-is —
// so an English instance, unit tests and crons behave exactly as before.

const KEY_VERSION = "v1";
const translationsKey = (mediaType: string, id: number) => `${mediaType}:${id}:i18n:${KEY_VERSION}`;

// How long a page waits for translations it doesn't have cached yet. Fetches
// still running at the deadline keep going and fill the cache, so the next view
// is localized; this view shows those titles in English. One cold page then
// costs at most this much extra latency, once per title per TTL.
const MISS_BUDGET_MS = 2_500;
// At most this many uncached titles are fetched per call — a list page with
// hundreds of items warms in slices across views instead of all at once.
const MAX_MISSES_PER_CALL = 120;
// Process-wide cap on concurrent /translations fetches across every request, so
// several cold pages at once can't burst past TMDB's rate budget (guardrail 31).
const MAX_IN_FLIGHT = 6;

interface Limiter {
  active: number;
  queue: (() => void)[];
}
const limiter = processSingleton<Limiter>("tmdb-localize:limiter", () => ({ active: 0, queue: [] }));

async function limited<T>(fn: () => Promise<T>): Promise<T> {
  if (limiter.active >= MAX_IN_FLIGHT) {
    await new Promise<void>((resolve) => limiter.queue.push(resolve));
  }
  limiter.active++;
  try {
    return await fn();
  } finally {
    limiter.active--;
    limiter.queue.shift()?.();
  }
}

// Fetch + store one title's translations. Coalesced on the cache key, so a
// stampede of pages listing the same title shares one fetch. A title with no
// translation stores {} — a cached answer, not a miss to retry every view.
function loadTranslations(mediaType: string, id: number): Promise<TitleTranslations> {
  const key = translationsKey(mediaType, id);
  return coalesce(key, () =>
    limited(async () => {
      const value = await fetchTitleTranslations(mediaType === "movie" ? "movie" : "tv", id);
      await setCache(key, value, TTL.DETAILS);
      return value;
    }),
  );
}

function overlay<T extends TmdbMedia>(
  item: T,
  tr: TitleTranslations | undefined,
  locale: Exclude<Locale, "en">,
  genreNames: Map<number, string> | undefined,
): T {
  const t = tr?.[locale];
  // A title in the viewer's own language often has no translation entry at all:
  // TMDB's original title IS the localized one there.
  const ownLanguage = item.originalLanguage === locale && item.originalTitle ? item.originalTitle : undefined;
  const title = t?.title || ownLanguage;
  const localizedGenres =
    genreNames && item.genreList?.length
      ? item.genreList.map((g) => ({ id: g.id, name: genreNames.get(g.id) ?? g.name }))
      : undefined;
  if (!title && !t?.overview && !t?.tagline && !localizedGenres) return item;

  const out: T = { ...item };
  if (title) {
    out.title = title;
    // "Original title: X" under a heading that now reads X says nothing.
    if (out.originalTitle === title) delete out.originalTitle;
  }
  if (t?.overview) out.overview = t.overview;
  if (t?.tagline) out.tagline = t.tagline;
  if (localizedGenres) {
    out.genreList = localizedGenres;
    out.genres = localizedGenres.map((g) => g.name);
  }
  return out;
}

async function genreNamesFor(items: TmdbMedia[], language: string): Promise<Map<number, string> | undefined> {
  const types = new Set(items.filter((i) => i.genreList?.length).map((i) => i.mediaType));
  if (types.size === 0) return undefined;
  const lists = await Promise.all(
    [...types].map((type) => (type === "movie" ? getMovieGenres(language) : getTVGenres(language)).catch(() => [])),
  );
  // TMDB's movie and TV genres share one id space (a genre in both lists has
  // the same id, e.g. 16 Animation), so one map serves both.
  return new Map(lists.flat().map((g) => [g.id, g.name]));
}

/**
 * Returns `items` with title/overview/tagline (and detail-row genres) in
 * `locale`. Never throws and never removes or reorders items: any failure
 * leaves the affected titles in English.
 */
export async function localizeMedia<T extends TmdbMedia>(items: T[], locale: Locale): Promise<T[]> {
  if (locale === "en" || items.length === 0) return items;
  const language = tmdbLanguageFor(locale);
  if (!language) return items;
  try {
    const keyOf = (i: TmdbMedia) => translationsKey(i.mediaType, i.id);
    const keys = [...new Set(items.map(keyOf))];
    const [cached, genreNames] = await Promise.all([
      getCacheMany<TitleTranslations>(keys),
      genreNamesFor(items, language),
    ]);

    const missing = items
      .filter((i, idx, arr) => !cached.has(keyOf(i)) && arr.findIndex((j) => keyOf(j) === keyOf(i)) === idx)
      .slice(0, MAX_MISSES_PER_CALL);
    if (missing.length > 0) {
      const all = Promise.allSettled(
        missing.map((i) =>
          loadTranslations(i.mediaType, i.id).then((value) => {
            cached.set(keyOf(i), value);
          }),
        ),
      );
      let timer: ReturnType<typeof setTimeout> | undefined;
      await Promise.race([
        all,
        new Promise<void>((resolve) => {
          timer = setTimeout(resolve, MISS_BUDGET_MS);
        }),
      ]);
      clearTimeout(timer);
      // Fetches past the deadline finish in the background (each awaits its own
      // cache write) and the result is read from the cache on the next view.
    }

    return items.map((i) => overlay(i, cached.get(keyOf(i)), locale, genreNames));
  } catch (err) {
    console.warn("[tmdb-localize] overlay failed:", err instanceof Error ? err.message : err);
    return items;
  }
}
