import "server-only";
import { getCacheMany, setCache } from "./tmdb-cache";
import { coalesce } from "./concurrency";
import { processSingleton } from "./process-singleton";
import { prisma } from "./prisma";
import {
  fetchPersonTranslations,
  fetchTitleTranslations,
  getMovieGenres,
  getTVGenres,
  tmdbLanguageFor,
  type PersonTranslations,
  type TitleTranslations,
} from "./tmdb";
import type { TmdbMedia } from "./tmdb-types";
import { isLocale, type Locale } from "./i18n/locales";
import { instanceDefaultLocale } from "./i18n/server-locale";

// TMDB content in the viewer's language, as an OVERLAY on the English payloads
// (guardrail 40a).
//
// Why an overlay and not a `language=` parameter on every fetch:
// - Every TMDB cache (lists, details, TmdbMediaCore, the recommendation graph)
//   is shared server-wide and English. Keying them by language would multiply
//   all of them by the number of languages in use, and the ratings, request and
//   *arr paths read them as English (a request still stores the English title).
// - One TMDB call (details + appended translations + language-tagged posters)
//   answers EVERY language, so a title costs one extra fetch per TTL however
//   many languages its viewers use.
//
// What is localized: title, overview, tagline and the poster (anything TMDB has
// no translation for keeps its English value), genre names on the detail rows
// that carry `genreList`, a person's biography, and the titles in a recipient's
// notifications and calendar feed. Cast and backdrops are not.
//
// English is a no-op: no DB read, no fetch, the input returned as-is — so an
// English instance, unit tests and crons behave exactly as before.

// v2: the payload gained `posterPath` (language-tagged posters).
const KEY_VERSION = "v2";
const translationsKey = (mediaType: string, id: number) => `${mediaType}:${id}:i18n:${KEY_VERSION}`;
const personKey = (id: number) => `person:${id}:i18n:v1`;
const dbType = (mediaType: string) => (mediaType === "MOVIE" || mediaType === "movie" ? "movie" : "tv");

// Translations change rarely, and the library prewarm needs the headroom: at
// MAX_PREWARM_PER_RUN a day, 30 days covers a library of well over 100k titles.
export const TRANSLATIONS_TTL = 30 * 24 * 60 * 60;

// How long a page waits for translations it doesn't have cached yet. Fetches
// still running at the deadline keep going and fill the cache, so the next view
// is localized; this view shows those titles in English. One cold page then
// costs at most this much extra latency, once per title per TTL.
const MISS_BUDGET_MS = 2_500;
// At most this many uncached titles are fetched per call — a list page with
// hundreds of items warms in slices across views instead of all at once.
const MAX_MISSES_PER_CALL = 120;
// Process-wide cap on concurrent translation fetches across every request and
// the prewarm, so they can't burst past TMDB's rate budget (guardrail 31).
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
  const key = translationsKey(dbType(mediaType), id);
  return coalesce(key, () =>
    limited(async () => {
      const value = await fetchTitleTranslations(dbType(mediaType), id);
      await setCache(key, value, TRANSLATIONS_TTL);
      return value;
    }),
  );
}

// Cached translations for `refs`, fetching up to MAX_MISSES_PER_CALL misses and
// waiting for them at most `budgetMs` (fetchMisses false ⇒ cache reads only).
// Keyed by `<movie|tv>:<id>`.
async function translationsFor(
  refs: readonly { id: number; mediaType: string }[],
  opts: { fetchMisses: boolean; budgetMs?: number },
): Promise<Map<string, TitleTranslations>> {
  const keyOf = (r: { id: number; mediaType: string }) => translationsKey(dbType(r.mediaType), r.id);
  const unique = new Map<string, { id: number; mediaType: string }>();
  for (const r of refs) unique.set(keyOf(r), r);
  const cached = await getCacheMany<TitleTranslations>([...unique.keys()]);
  if (!opts.fetchMisses) return cached;

  const missing = [...unique].filter(([k]) => !cached.has(k)).slice(0, MAX_MISSES_PER_CALL);
  if (missing.length === 0) return cached;
  const all = Promise.allSettled(
    missing.map(([k, r]) =>
      loadTranslations(r.mediaType, r.id).then((value) => {
        cached.set(k, value);
      }),
    ),
  );
  let timer: ReturnType<typeof setTimeout> | undefined;
  await Promise.race([
    all,
    new Promise<void>((resolve) => {
      timer = setTimeout(resolve, opts.budgetMs ?? MISS_BUDGET_MS);
    }),
  ]);
  clearTimeout(timer);
  // Fetches past the deadline finish in the background (each awaits its own
  // cache write) and the result is read from the cache on the next call.
  return cached;
}

function overlay<T extends TmdbMedia>(
  item: T,
  tr: TitleTranslations | undefined,
  locale: Exclude<Locale, "en">,
  genreNames: Map<number, string> | undefined,
): T {
  const t = tr?.[locale];
  const title = localizedTitle(item, t?.title, locale);
  const localizedGenres =
    genreNames && item.genreList?.length
      ? item.genreList.map((g) => ({ id: g.id, name: genreNames.get(g.id) ?? g.name }))
      : undefined;
  if (!title && !t?.overview && !t?.tagline && !t?.posterPath && !localizedGenres) return item;

  const out: T = { ...item };
  if (title) {
    out.title = title;
    // "Original title: X" under a heading that now reads X says nothing.
    if (out.originalTitle === title) delete out.originalTitle;
  }
  if (t?.overview) out.overview = t.overview;
  if (t?.tagline) out.tagline = t.tagline;
  if (t?.posterPath) out.posterPath = t.posterPath;
  if (localizedGenres) {
    out.genreList = localizedGenres;
    out.genres = localizedGenres.map((g) => g.name);
  }
  return out;
}

// A title in the viewer's own language often has no translation entry at all:
// TMDB's original title IS the localized one there.
function localizedTitle(
  item: { originalLanguage?: string | null; originalTitle?: string | null },
  translated: string | undefined,
  locale: Exclude<Locale, "en">,
): string | undefined {
  return translated || (item.originalLanguage === locale && item.originalTitle ? item.originalTitle : undefined);
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
 * Returns `items` with title/overview/tagline/poster (and detail-row genres) in
 * `locale`. Never throws and never removes or reorders items: any failure
 * leaves the affected titles in English.
 */
export async function localizeMedia<T extends TmdbMedia>(items: T[], locale: Locale): Promise<T[]> {
  if (locale === "en" || items.length === 0) return items;
  const language = tmdbLanguageFor(locale);
  if (!language) return items;
  try {
    const [cached, genreNames] = await Promise.all([
      translationsFor(items, { fetchMisses: true }),
      genreNamesFor(items, language),
    ]);
    return items.map((i) => overlay(i, cached.get(translationsKey(i.mediaType, i.id)), locale, genreNames));
  } catch (err) {
    console.warn("[tmdb-localize] overlay failed:", err instanceof Error ? err.message : err);
    return items;
  }
}

/**
 * Titles only, from the CACHE only — for surfaces that must not reach TMDB per
 * request (the iCal feed is polled by every subscriber's calendar app; the
 * prewarm fills these keys). Returns `<movie|tv>:<id>` → localized title for the
 * titles that have one; anything absent keeps its English title.
 */
export async function cachedLocalizedTitles(
  refs: readonly { tmdbId: number; mediaType: string }[],
  locale: Locale,
): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  if (locale === "en" || refs.length === 0) return out;
  try {
    const cached = await translationsFor(refs.map((r) => ({ id: r.tmdbId, mediaType: r.mediaType })), { fetchMisses: false });
    for (const r of refs) {
      const title = cached.get(translationsKey(dbType(r.mediaType), r.tmdbId))?.[locale]?.title;
      if (title) out.set(`${dbType(r.mediaType)}:${r.tmdbId}`, title);
    }
  } catch (err) {
    console.warn("[tmdb-localize] cached titles failed:", err instanceof Error ? err.message : err);
  }
  return out;
}

/**
 * Notification rows (`{ requestedBy, tmdbId, mediaType, title }`) with each
 * `title` in its REQUESTER's language — the stored `User.locale`, else the
 * instance default. Notifications have no viewer and no response to protect,
 * so misses are fetched (bounded like every other read). Rows without a tmdbId,
 * or whose requester reads English, come back unchanged; any failure returns
 * the rows as given. Display only: the stored request keeps its English title.
 */
export async function localizeNotificationTitles<T extends { requestedBy: string; title?: string; tmdbId?: number | null; mediaType?: string }>(
  rows: T[],
  // Each requester's stored User.locale, when the caller already read it (the
  // batch claim does) — otherwise read here.
  storedLocales?: ReadonlyMap<string, string | null>,
): Promise<T[]> {
  if (rows.length === 0) return rows;
  try {
    const fallback = instanceDefaultLocale();
    const stored =
      storedLocales ??
      new Map(
        (
          await prisma.user.findMany({
            where: { id: { in: [...new Set(rows.map((r) => r.requestedBy))] } },
            select: { id: true, locale: true },
          })
        ).map((u) => [u.id, u.locale ?? null]),
      );
    const localeOf = new Map(
      rows.map((r) => {
        const l = stored.get(r.requestedBy);
        return [r.requestedBy, isLocale(l) ? l : fallback] as const;
      }),
    );
    const wanted = rows.filter(
      (r) => typeof r.tmdbId === "number" && r.mediaType && (localeOf.get(r.requestedBy) ?? fallback) !== "en",
    );
    if (wanted.length === 0) return rows;
    const cached = await translationsFor(
      wanted.map((r) => ({ id: r.tmdbId as number, mediaType: r.mediaType as string })),
      { fetchMisses: true },
    );
    return rows.map((r) => {
      const locale = localeOf.get(r.requestedBy) ?? fallback;
      if (locale === "en" || typeof r.tmdbId !== "number" || !r.mediaType) return r;
      const title = cached.get(translationsKey(dbType(r.mediaType), r.tmdbId))?.[locale]?.title;
      return title ? { ...r, title } : r;
    });
  } catch (err) {
    console.warn("[tmdb-localize] notification titles failed:", err instanceof Error ? err.message : err);
    return rows;
  }
}

/**
 * One title in `locale` (a stored `User.locale` value or null ⇒ the instance
 * default), for a single-recipient notification whose caller already read the
 * recipient's row. Returns `title` unchanged for English, no tmdbId, or any failure.
 */
export async function localizedTitleFor(
  ref: { tmdbId?: number | null; mediaType?: string; title: string },
  storedLocale: string | null | undefined,
): Promise<string> {
  const locale = isLocale(storedLocale) ? storedLocale : instanceDefaultLocale();
  if (locale === "en" || typeof ref.tmdbId !== "number" || !ref.mediaType) return ref.title;
  try {
    const cached = await translationsFor([{ id: ref.tmdbId, mediaType: ref.mediaType }], { fetchMisses: true });
    return cached.get(translationsKey(dbType(ref.mediaType), ref.tmdbId))?.[locale]?.title ?? ref.title;
  } catch {
    return ref.title;
  }
}

/** A person's biography in `locale`, or null to keep the English one. Never throws. */
export async function localizedBiography(personId: number, locale: Locale): Promise<string | null> {
  if (locale === "en") return null;
  try {
    const key = personKey(personId);
    const cached = await getCacheMany<PersonTranslations>([key]);
    let value = cached.get(key);
    if (!value) {
      value = await coalesce(key, () =>
        limited(async () => {
          const v = await fetchPersonTranslations(personId);
          await setCache(key, v, TRANSLATIONS_TTL);
          return v;
        }),
      );
    }
    return value[locale as Exclude<Locale, "en">]?.biography ?? null;
  } catch {
    return null;
  }
}

// ── Prewarm ─────────────────────────────────────────────────────────────────

// Titles the daily prewarm fetches at most per run. At MAX_IN_FLIGHT parallel
// fetches that is a few minutes of TMDB traffic.
export const MAX_PREWARM_PER_RUN = 4_000;
const PREWARM_CHUNK = 500;

/**
 * Whether anyone on this instance reads a non-English language: the instance
 * default, or an active account's stored choice. A browser-negotiated language
 * with no stored choice isn't seen here — those viewers warm titles as they
 * browse.
 */
export async function nonEnglishInUse(): Promise<boolean> {
  if (instanceDefaultLocale() !== "en") return true;
  const n = await prisma.user.count({ where: { deactivatedAt: null, locale: { not: null, notIn: ["en"] } } });
  return n > 0;
}

/**
 * Fill translation rows for the titles people are most likely to see in a
 * list: the library, then requests and watchlists. Skips titles already cached
 * (an expired row counts as missing), stops at MAX_PREWARM_PER_RUN fetches, and
 * observes `signal` between chunks (guardrail 41). A no-op — zero fetches —
 * unless nonEnglishInUse().
 */
export async function prewarmTitleTranslations(
  opts: { signal?: AbortSignal; maxFetches?: number } = {},
): Promise<{ skipped: boolean; candidates: number; fetched: number; failed: number }> {
  const result = { skipped: true, candidates: 0, fetched: 0, failed: 0 };
  if (!(await nonEnglishInUse())) return result;
  result.skipped = false;
  const max = opts.maxFetches ?? MAX_PREWARM_PER_RUN;

  const [plex, jellyfin, requests, watchlist] = await Promise.all([
    prisma.plexLibraryItem.findMany({ select: { tmdbId: true, mediaType: true }, distinct: ["tmdbId", "mediaType"] }),
    prisma.jellyfinLibraryItem.findMany({ select: { tmdbId: true, mediaType: true }, distinct: ["tmdbId", "mediaType"] }),
    prisma.mediaRequest.findMany({ select: { tmdbId: true, mediaType: true }, distinct: ["tmdbId", "mediaType"] }),
    prisma.watchlistItem.findMany({ select: { tmdbId: true, mediaType: true }, distinct: ["tmdbId", "mediaType"] }),
  ]);
  const unique = new Map<string, { id: number; mediaType: string }>();
  for (const r of [...requests, ...watchlist, ...plex, ...jellyfin]) {
    unique.set(translationsKey(dbType(r.mediaType), r.tmdbId), { id: r.tmdbId, mediaType: r.mediaType });
  }
  const all = [...unique];
  result.candidates = all.length;

  for (let i = 0; i < all.length && result.fetched + result.failed < max; i += PREWARM_CHUNK) {
    if (opts.signal?.aborted) break;
    const chunk = all.slice(i, i + PREWARM_CHUNK);
    const cached = await getCacheMany<TitleTranslations>(chunk.map(([k]) => k));
    const missing = chunk.filter(([k]) => !cached.has(k)).slice(0, max - result.fetched - result.failed);
    const settled = await Promise.allSettled(missing.map(([, r]) => loadTranslations(r.mediaType, r.id)));
    for (const s of settled) {
      if (s.status === "fulfilled") result.fetched++;
      else result.failed++;
    }
  }
  return result;
}
