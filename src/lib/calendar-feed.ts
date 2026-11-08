// Prisma half of the personal iCal feed: which titles a feed covers, reading
// their cached release dates, resolving a feed token to its owner, and the
// bounded cache warm that runs inside the upcoming-releases cron.
//
// The feed ROUTE is cache-read only. Calendar apps poll on their own schedule
// (Google every few hours, Apple as often as every 5 minutes), so an upstream
// call per poll would multiply TMDB traffic by subscribers × titles. Missing
// dates are filled by warmCalendarCache from /api/sync/upcoming instead — a
// bounded, signal-aware pass (guardrails 31/41) — and until then a title simply
// has no events.

import { prisma } from "./prisma";
import { mapLimit } from "./concurrency";
import { getMovieReleaseInfo } from "./arr";
import { getTVCalendarInfo, getTVSeasonEpisodes, tvCalendarKey } from "./tmdb";
import { tmdbDetailsKey } from "./tmdb-cache";
import { isFeatureEnabled } from "./features";
import { isPurgedRow } from "./account-lifecycle";
import { parseAuthUrl } from "./auth-url";
import { calendarTokenMatches, hashCalendarToken, isWellFormedCalendarToken } from "./calendar-token";
import { buildIcsCalendar } from "./ics";
import { localeForUser, translatorForUser } from "./i18n/server-locale";
import { cachedLocalizedTitles } from "./tmdb-localize";
import type { Prisma } from "@/generated/prisma";
import {
  buildCalendarEvents,
  calendarWindow,
  dedupeCalendarTitles,
  parseEpisodes,
  parseMovieDates,
  parseTvInfo,
  seasonsToRead,
  toDay,
  type CalendarEpisode,
  type CalendarTitle,
  type CalendarTvInfo,
  type CalendarWindow,
  type MovieReleaseDates,
} from "./calendar-events";

export const CALENDAR_FEATURE_KEY = "feature.integration.calendar";
export const CALENDAR_REFRESH_INTERVAL = "PT6H";

export type CalendarScope = { kind: "user"; userId: string } | { kind: "all" };

/** Per-source row cap for a personal feed (requests, and watchlist, each). */
const MAX_USER_SOURCE_ROWS = 2000;
/** Row cap for the all-requests feed. */
const MAX_ALL_SOURCE_ROWS = 5000;
/** `IN (…)` list size per cache read. */
const CACHE_READ_CHUNK = 500;

const movieReleaseKey = (id: number) => `movie:${id}:release-info:v2`;
const movieDetailsKey = (id: number) => tmdbDetailsKey("movie", id);
const tvDetailsKey = (id: number) => tmdbDetailsKey("tv", id);
const tvSeasonKey = (id: number, n: number) => `tv:${id}:season:${n}`;

const toMediaType = (m: string): "movie" | "tv" => (m === "MOVIE" ? "movie" : "tv");

const TITLE_SELECT = { tmdbId: true, mediaType: true, title: true } as const;

// Request rows, then watchlist rows (when asked for), each newest first and
// capped at `take`, as calendar titles. Not deduplicated.
async function loadTitleSources(opts: {
  requestWhere: Prisma.MediaRequestWhereInput;
  watchlistWhere: Prisma.WatchlistItemWhereInput | null;
  take: number;
}): Promise<CalendarTitle[]> {
  const [requests, watchlist] = await Promise.all([
    prisma.mediaRequest.findMany({
      where: opts.requestWhere,
      select: TITLE_SELECT,
      orderBy: { createdAt: "desc" },
      take: opts.take,
    }),
    opts.watchlistWhere
      ? prisma.watchlistItem.findMany({
          where: opts.watchlistWhere,
          select: TITLE_SELECT,
          orderBy: { createdAt: "desc" },
          take: opts.take,
        })
      : Promise.resolve([]),
  ]);
  return [...requests, ...watchlist].map((r) => ({
    tmdbId: r.tmdbId,
    mediaType: toMediaType(r.mediaType),
    title: r.title,
  }));
}

/**
 * The titles a feed covers. Personal: the user's own requests in any
 * non-declined status, plus their watchlist. All: every non-declined request
 * (no requester is ever read — the feed carries titles only).
 */
export async function loadCalendarTitles(scope: CalendarScope): Promise<CalendarTitle[]> {
  if (scope.kind === "all") {
    return loadTitleSources({ requestWhere: { status: { not: "DECLINED" } }, watchlistWhere: null, take: MAX_ALL_SOURCE_ROWS });
  }
  return loadTitleSources({
    requestWhere: { requestedBy: scope.userId, status: { not: "DECLINED" } },
    watchlistWhere: { userId: scope.userId },
    take: MAX_USER_SOURCE_ROWS,
  });
}

/**
 * Read TmdbCache blobs regardless of expiry: a release date a few days past its
 * TTL is still the best answer the feed has, and the warm refreshes it. Rows the
 * orchestrator has already purged are simply absent. Sequential chunks — this
 * runs per poll and must never pin more than one pooled connection.
 */
async function readCacheBlobs(keys: readonly string[]): Promise<Map<string, unknown>> {
  const out = new Map<string, unknown>();
  for (let i = 0; i < keys.length; i += CACHE_READ_CHUNK) {
    const chunk = keys.slice(i, i + CACHE_READ_CHUNK);
    const rows = await prisma.tmdbCache.findMany({
      where: { key: { in: chunk } },
      select: { key: true, data: true },
    });
    for (const row of rows) {
      try {
        out.set(row.key, JSON.parse(row.data));
      } catch {
        // malformed row — a miss
      }
    }
  }
  return out;
}

/** Load every cached date the feed needs for `titles`. Cache reads only. */
export async function loadCalendarData(titles: readonly CalendarTitle[], w: CalendarWindow) {
  const movies = new Map<number, MovieReleaseDates>();
  const tv = new Map<number, CalendarTvInfo>();

  const movieIds = titles.filter((t) => t.mediaType === "movie").map((t) => t.tmdbId);
  const tvIds = titles.filter((t) => t.mediaType === "tv").map((t) => t.tmdbId);

  // The small date blobs first. A full `:details` blob is read (and parsed)
  // only as a fallback: for a movie whose release info has no primary date, a
  // show with no usable calendar blob — not for every title on every poll.
  const first = await readCacheBlobs([...movieIds.map(movieReleaseKey), ...tvIds.map(tvCalendarKey)]);
  const hasPrimary = (id: number) => {
    const info = first.get(movieReleaseKey(id));
    return !!info && typeof info === "object" && typeof (info as { primary?: unknown }).primary === "string";
  };
  const fallback = await readCacheBlobs([
    ...movieIds.filter((id) => !hasPrimary(id)).map(movieDetailsKey),
    ...tvIds.filter((id) => !parseTvInfo(first.get(tvCalendarKey(id)))).map(tvDetailsKey),
  ]);
  for (const id of movieIds) {
    const dates = parseMovieDates(first.get(movieReleaseKey(id)), fallback.get(movieDetailsKey(id)));
    if (dates) movies.set(id, dates);
  }
  const seasonKeys: Array<{ id: number; key: string }> = [];
  for (const id of tvIds) {
    // The calendar blob (short TTL, carries the next episode's number) wins
    // over the details blob (7-day TTL, a bare next-episode date).
    const info = parseTvInfo(first.get(tvCalendarKey(id))) ?? parseTvInfo(fallback.get(tvDetailsKey(id)));
    if (!info) continue;
    tv.set(id, info);
    for (const n of seasonsToRead(info, w)) seasonKeys.push({ id, key: tvSeasonKey(id, n) });
  }
  return { movies, tv, episodes: await loadSeasonEpisodes(seasonKeys) };
}

// The cached episode lists of the seasons the feed reads, per show.
async function loadSeasonEpisodes(seasonKeys: Array<{ id: number; key: string }>): Promise<Map<number, CalendarEpisode[]>> {
  const episodes = new Map<number, CalendarEpisode[]>();
  if (seasonKeys.length === 0) return episodes;
  const blobs = await readCacheBlobs(seasonKeys.map((s) => s.key));
  for (const { id, key } of seasonKeys) {
    const eps = parseEpisodes(blobs.get(key));
    if (eps.length === 0) continue;
    const list = episodes.get(id) ?? [];
    for (const ep of eps) list.push(ep);
    episodes.set(id, list);
  }
  return episodes;
}

/** Absolute app root (AUTH_URL origin + BASE_PATH), no trailing slash; null when AUTH_URL is unusable. */
export function calendarSiteUrl(fallbackOrigin?: string): string | null {
  const base = parseAuthUrl(process.env.AUTH_URL) ?? parseAuthUrl(fallbackOrigin);
  if (!base) return null;
  const raw = (process.env.BASE_PATH ?? "").trim();
  const bp = !raw || raw === "/" ? "" : `/${raw.replace(/^\/+|\/+$/g, "")}`;
  return new URL(bp || "/", base.origin).toString().replace(/\/+$/, "");
}

/** The subscription URL for a plaintext token. */
export function calendarFeedPath(token: string): string {
  return `/api/calendar/feed/${token}.ics`;
}

/**
 * Build the whole .ics document for a scope. `locale` is the feed owner's stored
 * User.locale (null/omitted → the instance default): the calendar name and the
 * event labels are written in it.
 */
export async function buildCalendarFeed(
  scope: CalendarScope,
  now: Date = new Date(),
  locale?: string | null,
): Promise<string> {
  const tr = translatorForUser({ locale });
  const w = calendarWindow(now);
  const englishTitles = dedupeCalendarTitles(await loadCalendarTitles(scope));
  // Event titles in the owner's language, from cached translations only — the
  // feed never reaches TMDB per poll; the library prewarm fills these rows
  // (guardrail 40a). Untranslated titles stay English.
  const localized = await cachedLocalizedTitles(englishTitles, localeForUser({ locale }));
  const titles = localized.size === 0
    ? englishTitles
    : englishTitles.map((t) => {
        const title = localized.get(`${t.mediaType}:${t.tmdbId}`);
        return title ? { ...t, title } : t;
      });
  const data = await loadCalendarData(titles, w);
  const events = buildCalendarEvents(titles, data, w, calendarSiteUrl(), tr);
  return buildIcsCalendar({
    name: scope.kind === "all" ? tr("notify.calendar.nameAll") : tr("notify.calendar.nameMine"),
    description:
      scope.kind === "all"
        ? tr("notify.calendar.descriptionAll")
        : tr("notify.calendar.descriptionMine"),
    refreshInterval: CALENDAR_REFRESH_INTERVAL,
    events,
    now,
  });
}

export interface CalendarTokenOwner {
  id: string;
  role: string;
  permissions: bigint;
  /** Stored UI language — the feed's labels are written in it. */
  locale: string | null;
}

/**
 * Resolve a presented feed token to its owner, or null. Null covers a malformed
 * token (rejected before any query), an unknown or revoked one, and an account
 * that is disabled or purged (guardrail 33 — a disabled account keeps its row,
 * so the row lookup alone would still succeed).
 */
export async function resolveCalendarToken(token: string): Promise<CalendarTokenOwner | null> {
  if (!isWellFormedCalendarToken(token)) return null;
  const user = await prisma.user.findUnique({
    where: { calendarTokenHash: hashCalendarToken(token) },
    select: {
      id: true,
      email: true,
      role: true,
      permissions: true,
      deactivatedAt: true,
      purgedAt: true,
      calendarTokenHash: true,
      locale: true,
    },
  });
  if (!user || !calendarTokenMatches(user.calendarTokenHash, token)) return null;
  if (user.deactivatedAt != null || isPurgedRow(user)) return null;
  return { id: user.id, role: user.role, permissions: user.permissions, locale: user.locale ?? null };
}

// ─── Cache warm (runs inside the /api/sync/upcoming cron) ──────────────────

/** Titles considered per warm run, newest requests/watchlist entries first. */
export const MAX_CALENDAR_WARM_TITLES = 2000;
/** Upstream (TMDB) calls per warm run, across both phases. */
export const MAX_CALENDAR_WARM_FETCHES = 300;
const WARM_CONCURRENCY = 3;

export interface CalendarWarmResult {
  skipped?: "disabled";
  titles: number;
  fetched: number;
  failed: number;
  aborted: boolean;
}

async function freshKeys(keys: readonly string[], now: Date): Promise<Set<string>> {
  const out = new Set<string>();
  for (let i = 0; i < keys.length; i += CACHE_READ_CHUNK) {
    const rows = await prisma.tmdbCache.findMany({
      where: { key: { in: keys.slice(i, i + CACHE_READ_CHUNK) }, expiresAt: { gt: now } },
      select: { key: true },
    });
    for (const r of rows) out.add(r.key);
  }
  return out;
}

// Every title anyone's feed could cover: every non-declined request (the "all"
// feed shows them whoever filed them) and the watchlists of accounts whose feed
// can still answer (a disabled account's feed 404s).
async function loadWarmTitles(): Promise<CalendarTitle[]> {
  const rows = await loadTitleSources({
    requestWhere: { status: { not: "DECLINED" } },
    watchlistWhere: { user: { deactivatedAt: null } },
    take: MAX_CALENDAR_WARM_TITLES,
  });
  return dedupeCalendarTitles(rows).slice(0, MAX_CALENDAR_WARM_TITLES);
}

// How long after its newest known date a movie with missing release kinds
// stops being worth re-asking about: an old film that never got a physical
// (or digital) date will not get one now.
const MOVIE_SETTLE_MS = 365 * 24 * 60 * 60 * 1000;

/**
 * True when an EXPIRED blob already proves the title can produce no event in
 * the window, so re-fetching it would only learn the same thing: a movie whose
 * every known date is behind the window (all three known, or the newest a year
 * before it), a show that ended before it.
 */
export function settledCalendarTitle(t: CalendarTitle, blob: unknown, w: CalendarWindow): boolean {
  if (t.mediaType === "movie") {
    const d = parseMovieDates(blob, null);
    const days = [d?.primary, d?.digital, d?.physical].map((v) => toDay(v));
    const known = days.filter((v): v is string => v !== null);
    if (known.length === 0 || known.some((v) => v >= w.from)) return false;
    if (known.length === days.length) return true;
    const newest = known.reduce((a, b) => (a > b ? a : b));
    return Date.parse(`${newest}T00:00:00Z`) + MOVIE_SETTLE_MS < Date.parse(`${w.from}T00:00:00Z`);
  }
  const info = parseTvInfo(blob);
  if (!info || (info.status !== "Ended" && info.status !== "Canceled")) return false;
  const last = toDay(info.lastAirDate);
  return last !== null && last < w.from;
}

const releaseKeyFor = (t: CalendarTitle) => (t.mediaType === "movie" ? movieReleaseKey(t.tmdbId) : tvCalendarKey(t.tmdbId));

// Phase 1 — per-title date blobs that are missing or expired and still matter.
async function dateBlobTasks(titles: CalendarTitle[], w: CalendarWindow, now: Date): Promise<Array<() => Promise<unknown>>> {
  const fresh = await freshKeys(titles.map(releaseKeyFor), now);
  const stale = await readCacheBlobs(titles.map(releaseKeyFor).filter((k) => !fresh.has(k)));
  const tasks: Array<() => Promise<unknown>> = [];
  for (const t of titles) {
    const key = releaseKeyFor(t);
    if (fresh.has(key) || settledCalendarTitle(t, stale.get(key), w)) continue;
    if (t.mediaType === "movie") {
      // getMovieReleaseInfo swallows its own failures to null; a null with
      // credentials configured is a failed fetch, not a success.
      tasks.push(async () => {
        if ((await getMovieReleaseInfo(t.tmdbId)) === null) throw new Error("release info unavailable");
      });
    } else {
      tasks.push(() => getTVCalendarInfo(t.tmdbId));
    }
  }
  return tasks;
}

// Phase 2 — episode lists for the seasons the feed will read.
async function seasonTasks(tvIds: number[], w: CalendarWindow, now: Date): Promise<Array<() => Promise<unknown>>> {
  const blobs = await readCacheBlobs(tvIds.map(tvCalendarKey));
  const wanted: Array<{ id: number; n: number }> = [];
  for (const id of tvIds) {
    const info = parseTvInfo(blobs.get(tvCalendarKey(id)));
    if (!info) continue;
    for (const n of seasonsToRead(info, w)) wanted.push({ id, n });
  }
  const fresh = await freshKeys(wanted.map((s) => tvSeasonKey(s.id, s.n)), now);
  return wanted
    .filter((s) => !fresh.has(tvSeasonKey(s.id, s.n)))
    .map((s) => () => getTVSeasonEpisodes(s.id, s.n));
}

/**
 * Fill the release-date caches the feed reads, for every title anyone's feed
 * could cover. Bounded three ways: MAX_CALENDAR_WARM_TITLES titles, a
 * MAX_CALENDAR_WARM_FETCHES upstream budget, WARM_CONCURRENCY in flight — and
 * every task awaits all of its upstream work (guardrail 31a: no detached SWR
 * refreshes). Observes the advisory-lock AbortSignal and RETURNS on abort
 * (guardrail 41).
 */
export async function warmCalendarCache(
  opts: { signal?: AbortSignal; now?: Date } = {},
): Promise<CalendarWarmResult> {
  const result: CalendarWarmResult = { titles: 0, fetched: 0, failed: 0, aborted: false };
  if (!(await isFeatureEnabled(CALENDAR_FEATURE_KEY))) return { ...result, skipped: "disabled" };
  const now = opts.now ?? new Date();
  const w = calendarWindow(now);
  const titles = await loadWarmTitles();
  result.titles = titles.length;

  let budget = MAX_CALENDAR_WARM_FETCHES;
  const run = async (tasks: Array<() => Promise<unknown>>) => {
    const take = tasks.slice(0, Math.max(0, budget));
    budget -= take.length;
    await mapLimit(take, WARM_CONCURRENCY, async (task) => {
      if (opts.signal?.aborted) {
        result.aborted = true;
        return;
      }
      try {
        await task();
        result.fetched++;
      } catch {
        result.failed++;
      }
    });
  };

  await run(await dateBlobTasks(titles, w, now));
  if (opts.signal?.aborted) return { ...result, aborted: true };

  const tvIds = titles.filter((t) => t.mediaType === "tv").map((t) => t.tmdbId);
  if (tvIds.length > 0 && budget > 0) await run(await seasonTasks(tvIds, w, now));
  if (result.failed > 0) {
    console.warn(`[calendar] warm: ${result.failed} of ${result.fetched + result.failed} release-date lookups failed`);
  }
  return result;
}
