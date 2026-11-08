import "server-only";
import { getCacheMany, setCache } from "./tmdb-cache";
import { coalesce, settleLimit } from "./concurrency";
import { processSingleton } from "./process-singleton";
import { prisma } from "./prisma";
import {
  fetchCollectionTranslations,
  fetchPersonTranslations,
  fetchTitleTranslations,
  getMovieGenres,
  getTVGenres,
  isTmdbNotFound,
  tmdbLanguageFor,
  type CollectionTranslations,
  type PersonTranslations,
  type TitleTranslations,
} from "./tmdb";
import type { MediaType } from "./tmdb-types";
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
const personKey = (id: number) => `person:${id}:i18n:v1`;
const collectionKey = (id: number) => `collection:${id}:i18n:v1`;
const dbType = (mediaType: string) => (mediaType === "MOVIE" || mediaType === "movie" ? "movie" : "tv");
// The ONE key for a title's translations, from either media type spelling
// ("movie"/"MOVIE"): every read and write goes through it, so a caller holding
// the other spelling can never miss a stored row.
const titleKey = (mediaType: string, id: number) => `${dbType(mediaType)}:${id}:i18n:${KEY_VERSION}`;

// Translations change rarely, and the library prewarm needs the headroom: at
// MAX_PREWARM_PER_RUN a day, 30 days covers a library of well over 100k titles.
export const TRANSLATIONS_TTL = 30 * 24 * 60 * 60;
// A TMDB 404 (a dead id) is a definitive answer: {} is cached for this long, as
// the details prewarm tombstones one (tmdb-prewarm.ts), instead of re-fetching
// it on every view and every prewarm run.
const NOT_FOUND_TTL = 14 * 24 * 60 * 60;

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
export const MAX_IN_FLIGHT = 6;
// Past this many fetches parked behind the limiter, a page's misses are not
// queued at all (it reads the cache only): while TMDB is slow every view would
// otherwise park up to MAX_MISSES_PER_CALL more closures behind it.
export const MAX_QUEUED_MISSES = 240;
// A transient failure (timeout, 5xx, 429) is remembered in this process for
// this long, so the next views don't fetch the same title again while TMDB is
// struggling. Never written to the cache: a failure is not an answer.
export const RETRY_AFTER_FAILURE_MS = 10 * 60_000;
const MAX_RETRY_ENTRIES = 10_000;

/**
 * A bound on how many `fn`s run at once: the first `max` callers run, later
 * ones park in FIFO order. A finishing task HANDS its slot to the next waiter
 * instead of releasing it, so the count never drops while anyone is parked. The
 * waiter only resumes a microtask after it is woken; with release-then-wake a
 * caller arriving in that gap saw a free slot and ran, and the woken waiter then
 * ran on top of it — one over the cap per woken waiter. mapLimit/settleLimit in
 * concurrency.ts bound ONE call's fan-out; this bounds every call in the process.
 */
export type InFlightLimiter = (<T>(fn: () => Promise<T>) => Promise<T>) & {
  /** How many callers are parked waiting for a slot. */
  waiting(): number;
};

export function createInFlightLimiter(max: number): InFlightLimiter {
  let active = 0;
  const queue: (() => void)[] = [];
  const limited = async function limited<T>(fn: () => Promise<T>): Promise<T> {
    if (active >= max) {
      // Resumes already holding the slot the finishing task handed over.
      await new Promise<void>((resolve) => queue.push(resolve));
    } else {
      active++;
    }
    try {
      return await fn();
    } finally {
      const next = queue.shift();
      if (next) next(); // slot transferred, `active` unchanged
      else active--;
    }
  };
  return Object.assign(limited, { waiting: () => queue.length });
}

// A new key whenever the limiter's shape changes, so a hot reload never reads
// an old one.
const limited = processSingleton("tmdb-localize:limiter:v2", () => createInFlightLimiter(MAX_IN_FLIGHT));

// cache key → when a fetch may be tried again after a transient failure.
const retryAfter = processSingleton("tmdb-localize:retryAfter", () => new Map<string, number>());

function inRetryBackoff(key: string, now: number = Date.now()): boolean {
  const until = retryAfter.get(key);
  if (until === undefined) return false;
  if (until > now) return true;
  retryAfter.delete(key);
  return false;
}

function noteTransientFailure(key: string): void {
  retryAfter.delete(key);
  if (retryAfter.size >= MAX_RETRY_ENTRIES) {
    const oldest = retryAfter.keys().next().value;
    if (oldest !== undefined) retryAfter.delete(oldest);
  }
  retryAfter.set(key, Date.now() + RETRY_AFTER_FAILURE_MS);
}

/** Test seam. */
export function _resetTranslationRetryForTests(): void {
  retryAfter.clear();
}

// Fetch + store one translations payload: coalesced on the cache key (a
// stampede of pages listing the same title shares one fetch) and run through
// the process-wide limiter. Nothing translated stores {} — a cached answer, not
// a miss to retry every view — and so does a TMDB 404, for NOT_FOUND_TTL.
function fetchAndCache<T extends object>(key: string, fetcher: () => Promise<T>): Promise<T> {
  return coalesce(key, () =>
    limited(async () => {
      let value: T;
      let ttl = TRANSLATIONS_TTL;
      try {
        value = await fetcher();
      } catch (err) {
        if (!isTmdbNotFound(err)) {
          noteTransientFailure(key);
          throw err;
        }
        value = {} as T;
        ttl = NOT_FOUND_TTL;
      }
      await setCache(key, value, ttl);
      return value;
    }),
  );
}

// Waits for `work` at most `budgetMs`, then answers `fallback` and lets the
// work finish in the background — it still writes the cache, so the next view
// is localized. A late rejection is swallowed here, never left unhandled.
async function withinBudget<T, F>(work: Promise<T>, budgetMs: number, fallback: F): Promise<T | F> {
  work.catch(() => {});
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      work,
      new Promise<F>((resolve) => {
        timer = setTimeout(() => resolve(fallback), budgetMs);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

function loadTranslations(mediaType: string, id: number): Promise<TitleTranslations> {
  return fetchAndCache(titleKey(mediaType, id), () => fetchTitleTranslations(dbType(mediaType), id));
}

// Cached translations for `refs`, fetching up to MAX_MISSES_PER_CALL misses and
// waiting for them at most `budgetMs` (fetchMisses false ⇒ cache reads only).
// Keyed by titleKey. A miss is not fetched while its title is in a failure
// backoff, nor while the limiter already has MAX_QUEUED_MISSES parked.
//
// The returned map is a SNAPSHOT taken at the deadline: fetches still running
// finish in the background and fill the cache for the next call, but never
// change what this caller holds (titleResolver keeps it in a closure, and the
// same notification must not render differently depending on timing).
async function translationsFor(
  refs: readonly { id: number; mediaType: string }[],
  opts: { fetchMisses: boolean; budgetMs?: number },
): Promise<Map<string, TitleTranslations>> {
  const unique = new Map<string, { id: number; mediaType: string }>();
  for (const r of refs) unique.set(titleKey(r.mediaType, r.id), r);
  const cached = await getCacheMany<TitleTranslations>([...unique.keys()]);
  if (!opts.fetchMisses || limited.waiting() >= MAX_QUEUED_MISSES) return cached;

  const now = Date.now();
  const missing = [...unique]
    .filter(([k]) => !cached.has(k) && !inRetryBackoff(k, now))
    .slice(0, MAX_MISSES_PER_CALL);
  if (missing.length === 0) return cached;
  const arrived = new Map<string, TitleTranslations>();
  const all = Promise.allSettled(
    missing.map(([k, r]) =>
      loadTranslations(r.mediaType, r.id).then((value) => {
        arrived.set(k, value);
      }),
    ),
  );
  await withinBudget(all, opts.budgetMs ?? MISS_BUDGET_MS, undefined);
  return new Map([...cached, ...arrived]);
}

/**
 * The fields the overlay reads and writes. A TmdbMedia is one; so is any card
 * shaped like one (a person's filmography credit), with no cast needed.
 */
export interface LocalizableMedia {
  id: number;
  mediaType: MediaType;
  title: string;
  overview?: string;
  tagline?: string | null;
  posterPath: string | null;
  originalTitle?: string | null;
  originalLanguage?: string | null;
  genres?: string[];
  genreList?: { id: number; name: string }[];
}

function overlay<T extends LocalizableMedia>(
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

async function genreNamesFor(items: LocalizableMedia[], language: string): Promise<Map<number, string> | undefined> {
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
export async function localizeMedia<T extends LocalizableMedia>(items: T[], locale: Locale): Promise<T[]> {
  if (locale === "en" || items.length === 0) return items;
  const language = tmdbLanguageFor(locale);
  if (!language) return items;
  noteLocaleSeen(locale);
  try {
    const [cached, genreNames] = await Promise.all([
      translationsFor(items, { fetchMisses: true }),
      genreNamesFor(items, language),
    ]);
    return items.map((i) => overlay(i, cached.get(titleKey(i.mediaType, i.id)), locale, genreNames));
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
      const title = cached.get(titleKey(r.mediaType, r.tmdbId))?.[locale]?.title;
      if (title) out.set(`${dbType(r.mediaType)}:${r.tmdbId}`, title);
    }
  } catch (err) {
    console.warn("[tmdb-localize] cached titles failed:", err instanceof Error ? err.message : err);
  }
  return out;
}

/** A title as a notification carries it: the stored English text plus, when known, its TMDB identity. */
export interface TitleRef {
  title: string;
  tmdbId?: number | null;
  mediaType?: string | null;
}
export type TitleResolver = (ref: TitleRef, locale: Locale) => string;
const englishTitles: TitleResolver = (ref) => ref.title;

/**
 * For senders that write one message per RECIPIENT LANGUAGE (email groups,
 * push payloads, Discord posts, the in-app inbox): resolves translations for
 * `refs` ONCE and returns a synchronous `(ref, locale) → title` for the render.
 * `locales` are the recipients' resolved languages; English, a ref without a
 * tmdbId, or any failure yields the stored English title. All-English
 * recipients cost nothing — no DB read, no fetch. Misses are fetched (these
 * paths have no viewer waiting), bounded like every other read.
 *
 * Display only: never write the result back to a request, issue or audit row.
 */
export async function titleResolver(refs: readonly TitleRef[], locales: Iterable<Locale>): Promise<TitleResolver> {
  const wanted = new Set([...locales].filter((l) => l !== "en"));
  const known = refs.filter((r) => typeof r.tmdbId === "number" && r.mediaType);
  if (wanted.size === 0 || known.length === 0) return englishTitles;
  try {
    const cached = await translationsFor(
      known.map((r) => ({ id: r.tmdbId as number, mediaType: r.mediaType as string })),
      { fetchMisses: true },
    );
    return (ref, locale) => {
      if (locale === "en" || typeof ref.tmdbId !== "number" || !ref.mediaType) return ref.title;
      return cached.get(titleKey(ref.mediaType, ref.tmdbId))?.[locale]?.title ?? ref.title;
    };
  } catch (err) {
    console.warn("[tmdb-localize] notification titles failed:", err instanceof Error ? err.message : err);
    return englishTitles;
  }
}

/** One title for one recipient's stored `User.locale` (null ⇒ the instance default). */
export async function localizedTitleFor(ref: TitleRef, storedLocale: string | null | undefined): Promise<string> {
  const locale = isLocale(storedLocale) ? storedLocale : instanceDefaultLocale();
  return (await titleResolver([ref], [locale]))(ref, locale);
}

/** The instance default language — what a shared Discord channel post is written in. */
export function channelLocale(): Locale {
  return instanceDefaultLocale();
}

/**
 * Stored rows (the in-app inbox) with `title` in the READER's language,
 * rendered at read time so the inbox follows the reader's current choice.
 */
export async function localizeStoredTitles<T extends TitleRef>(rows: T[], locale: Locale): Promise<T[]> {
  if (locale === "en" || rows.length === 0) return rows;
  const resolve = await titleResolver(rows, [locale]);
  return rows.map((r) => {
    const title = resolve(r, locale);
    return title === r.title ? r : { ...r, title };
  });
}

/**
 * A collection's name in `locale`, or `englishName` when untranslated or not
 * cached within the miss budget (the page renders on; the fetch fills the cache
 * for the next view). Never throws.
 */
export async function localizedCollectionName(
  collectionId: number,
  englishName: string,
  locale: Locale,
  opts: { budgetMs?: number } = {},
): Promise<string> {
  if (locale === "en") return englishName;
  try {
    const key = collectionKey(collectionId);
    const cached = await getCacheMany<CollectionTranslations>([key]);
    const value =
      cached.get(key) ??
      (await withinBudget(
        fetchAndCache(key, () => fetchCollectionTranslations(collectionId)),
        opts.budgetMs ?? MISS_BUDGET_MS,
        null,
      ));
    return value?.[locale as Exclude<Locale, "en">]?.name ?? englishName;
  } catch {
    return englishName;
  }
}

/**
 * A person's biography in `locale`, or null to keep the English one (also when
 * it isn't cached within the miss budget — see localizedCollectionName). Never throws.
 */
export async function localizedBiography(
  personId: number,
  locale: Locale,
  opts: { budgetMs?: number } = {},
): Promise<string | null> {
  if (locale === "en") return null;
  try {
    const key = personKey(personId);
    const cached = await getCacheMany<PersonTranslations>([key]);
    const value =
      cached.get(key) ??
      (await withinBudget(
        fetchAndCache(key, () => fetchPersonTranslations(personId)),
        opts.budgetMs ?? MISS_BUDGET_MS,
        null,
      ));
    return value?.[locale as Exclude<Locale, "en">]?.biography ?? null;
  } catch {
    return null;
  }
}

// ── Prewarm ─────────────────────────────────────────────────────────────────

// A viewer whose language comes from their BROWSER (no stored choice) leaves no
// trace in the User table, so the overlay records that a language was actually
// served: one Setting row per language, stamped at most every SEEN_WRITE_EVERY_MS
// per process (a page view must not cost a write). nonEnglishInUse() counts a
// language seen within SEEN_WINDOW_MS.
const SEEN_PREFIX = "contentLocaleSeen:";
const SEEN_WRITE_EVERY_MS = 12 * 60 * 60 * 1000;
const SEEN_WINDOW_MS = 30 * 24 * 60 * 60 * 1000;
const seenWrites = processSingleton("tmdb-localize:seenWrites", () => new Map<string, number>());

function noteLocaleSeen(locale: Exclude<Locale, "en">): void {
  const now = Date.now();
  const last = seenWrites.get(locale);
  if (last !== undefined && now - last < SEEN_WRITE_EVERY_MS) return;
  seenWrites.set(locale, now);
  const key = `${SEEN_PREFIX}${locale}`;
  const value = new Date(now).toISOString();
  // Best-effort bookkeeping: a failed write only means the prewarm may skip
  // this language until the next stamp.
  void Promise.resolve()
    .then(() => prisma.setting.upsert({ where: { key }, update: { value }, create: { key, value } }))
    .catch(() => {});
}

// Titles the daily prewarm fetches at most per run. At MAX_IN_FLIGHT parallel
// fetches that is a few minutes of TMDB traffic.
export const MAX_PREWARM_PER_RUN = 4_000;
const PREWARM_CHUNK = 500;

/**
 * Whether anyone on this instance reads a non-English language: the instance
 * default, an active account's stored choice, or a language the overlay served
 * within the last 30 days (a browser-negotiated viewer with no stored choice).
 */
export async function nonEnglishInUse(): Promise<boolean> {
  if (instanceDefaultLocale() !== "en") return true;
  const [stored, seen] = await Promise.all([
    prisma.user.count({ where: { deactivatedAt: null, locale: { not: null, notIn: ["en"] } } }),
    // Select the key too: without it the Prisma extension can't tell these
    // plaintext timestamps from a secret and logs "Setting.?" for each.
    prisma.setting.findMany({ where: { key: { startsWith: SEEN_PREFIX } }, select: { key: true, value: true } }),
  ]);
  if (stored > 0) return true;
  const cutoff = Date.now() - SEEN_WINDOW_MS;
  return seen.some((r) => {
    const at = Date.parse(r.value);
    return Number.isFinite(at) && at >= cutoff;
  });
}

/**
 * Fill translation rows for the titles people are most likely to see in a
 * list: requests and watchlists first (the iCal feed's titles, which it reads
 * from the cache only), then the library. Skips titles already cached (an
 * expired row counts as missing; a TMDB 404 is cached as an answer), stops at
 * MAX_PREWARM_PER_RUN fetches, and observes `signal` before each title
 * (guardrail 41). A no-op — zero fetches — unless nonEnglishInUse().
 *
 * It shares the process-wide limiter with page renders but never holds more
 * than MAX_IN_FLIGHT of its own titles in it, so a viewer's miss waits for at
 * most one fetch to finish, not for the rest of a 500-title chunk.
 */
export async function prewarmTitleTranslations(
  opts: { signal?: AbortSignal; maxFetches?: number } = {},
): Promise<{ skipped: boolean; candidates: number; fetched: number; failed: number }> {
  const result = { skipped: true, candidates: 0, fetched: 0, failed: 0 };
  if (!(await nonEnglishInUse())) return result;
  result.skipped = false;
  const max = opts.maxFetches ?? MAX_PREWARM_PER_RUN;
  // Fetches this run may still make; a failure spends the budget too.
  const budgetLeft = () => max - result.fetched - result.failed;

  const all = await prewarmCandidates();
  result.candidates = all.length;

  for (let i = 0; i < all.length && budgetLeft() > 0; i += PREWARM_CHUNK) {
    if (opts.signal?.aborted) break;
    const chunk = all.slice(i, i + PREWARM_CHUNK);
    const cached = await getCacheMany<TitleTranslations>(chunk.map(([k]) => k));
    const now = Date.now();
    const missing = chunk.filter(([k]) => !cached.has(k) && !inRetryBackoff(k, now)).slice(0, budgetLeft());
    const settled = await settleLimit(missing, MAX_IN_FLIGHT, async ([, r]) => {
      if (opts.signal?.aborted) return false;
      await loadTranslations(r.mediaType, r.id);
      return true;
    });
    for (const s of settled) {
      if (s.status === "rejected") result.failed++;
      else if (s.value) result.fetched++;
    }
  }
  return result;
}

// Every distinct title worth translating, keyed by titleKey, requests and
// watchlists first (the iCal feed's titles), then the library. Distinct per
// table in the database, so each read returns one row per title.
async function prewarmCandidates(): Promise<[string, { id: number; mediaType: string }][]> {
  const [plex, jellyfin, requests, watchlist] = await Promise.all([
    prisma.plexLibraryItem.findMany({ select: { tmdbId: true, mediaType: true }, distinct: ["tmdbId", "mediaType"] }),
    prisma.jellyfinLibraryItem.findMany({ select: { tmdbId: true, mediaType: true }, distinct: ["tmdbId", "mediaType"] }),
    prisma.mediaRequest.findMany({ select: { tmdbId: true, mediaType: true }, distinct: ["tmdbId", "mediaType"] }),
    prisma.watchlistItem.findMany({ select: { tmdbId: true, mediaType: true }, distinct: ["tmdbId", "mediaType"] }),
  ]);
  const unique = new Map<string, { id: number; mediaType: string }>();
  for (const r of [...requests, ...watchlist, ...plex, ...jellyfin]) {
    unique.set(titleKey(r.mediaType, r.tmdbId), { id: r.tmdbId, mediaType: r.mediaType });
  }
  return [...unique];
}
