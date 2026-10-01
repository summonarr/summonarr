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
import { isFeatureEnabled } from "./features";
import { isPurgedRow } from "./account-lifecycle";
import { parseAuthUrl } from "./auth-url";
import { calendarTokenMatches, hashCalendarToken, isWellFormedCalendarToken } from "./calendar-token";
import { buildIcsCalendar } from "./ics";
import {
  buildCalendarEvents,
  calendarWindow,
  parseEpisodes,
  parseMovieDates,
  parseTvInfo,
  seasonsToRead,
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
const movieDetailsKey = (id: number) => `movie:${id}:details`;
const tvDetailsKey = (id: number) => `tv:${id}:details`;
const tvSeasonKey = (id: number, n: number) => `tv:${id}:season:${n}`;

const toMediaType = (m: string): "movie" | "tv" => (m === "MOVIE" ? "movie" : "tv");

/**
 * The titles a feed covers. Personal: the user's own requests in any
 * non-declined status, plus their watchlist. All: every non-declined request
 * (no requester is ever read — the feed carries titles only).
 */
export async function loadCalendarTitles(scope: CalendarScope): Promise<CalendarTitle[]> {
  const select = { tmdbId: true, mediaType: true, title: true } as const;
  if (scope.kind === "all") {
    const rows = await prisma.mediaRequest.findMany({
      where: { status: { not: "DECLINED" } },
      select,
      orderBy: { createdAt: "desc" },
      take: MAX_ALL_SOURCE_ROWS,
    });
    return rows.map((r) => ({ tmdbId: r.tmdbId, mediaType: toMediaType(r.mediaType), title: r.title }));
  }
  const [requests, watchlist] = await Promise.all([
    prisma.mediaRequest.findMany({
      where: { requestedBy: scope.userId, status: { not: "DECLINED" } },
      select,
      orderBy: { createdAt: "desc" },
      take: MAX_USER_SOURCE_ROWS,
    }),
    prisma.watchlistItem.findMany({
      where: { userId: scope.userId },
      select,
      orderBy: { createdAt: "desc" },
      take: MAX_USER_SOURCE_ROWS,
    }),
  ]);
  return [...requests, ...watchlist].map((r) => ({
    tmdbId: r.tmdbId,
    mediaType: toMediaType(r.mediaType),
    title: r.title,
  }));
}

function dedupeTitles(titles: readonly CalendarTitle[]): CalendarTitle[] {
  const seen = new Set<string>();
  const out: CalendarTitle[] = [];
  for (const t of titles) {
    const k = `${t.mediaType}:${t.tmdbId}`;
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(t);
  }
  return out;
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
  const episodes = new Map<number, CalendarEpisode[]>();

  const movieIds = titles.filter((t) => t.mediaType === "movie").map((t) => t.tmdbId);
  const tvIds = titles.filter((t) => t.mediaType === "tv").map((t) => t.tmdbId);

  const first = await readCacheBlobs([
    ...movieIds.flatMap((id) => [movieReleaseKey(id), movieDetailsKey(id)]),
    ...tvIds.flatMap((id) => [tvCalendarKey(id), tvDetailsKey(id)]),
  ]);
  for (const id of movieIds) {
    const dates = parseMovieDates(first.get(movieReleaseKey(id)), first.get(movieDetailsKey(id)));
    if (dates) movies.set(id, dates);
  }
  const seasonKeys: Array<{ id: number; key: string }> = [];
  for (const id of tvIds) {
    // The calendar blob (short TTL, carries the next episode's number) wins
    // over the details blob (7-day TTL, a bare next-episode date).
    const info = parseTvInfo(first.get(tvCalendarKey(id))) ?? parseTvInfo(first.get(tvDetailsKey(id)));
    if (!info) continue;
    tv.set(id, info);
    for (const n of seasonsToRead(info, w)) seasonKeys.push({ id, key: tvSeasonKey(id, n) });
  }
  if (seasonKeys.length > 0) {
    const second = await readCacheBlobs(seasonKeys.map((s) => s.key));
    for (const { id, key } of seasonKeys) {
      const eps = parseEpisodes(second.get(key));
      if (eps.length === 0) continue;
      const list = episodes.get(id) ?? [];
      list.push(...eps);
      episodes.set(id, list);
    }
  }
  return { movies, tv, episodes };
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

/** Build the whole .ics document for a scope. */
export async function buildCalendarFeed(scope: CalendarScope, now: Date = new Date()): Promise<string> {
  const w = calendarWindow(now);
  const titles = dedupeTitles(await loadCalendarTitles(scope));
  const data = await loadCalendarData(titles, w);
  const events = buildCalendarEvents(titles, data, w, calendarSiteUrl());
  return buildIcsCalendar({
    name: scope.kind === "all" ? "Summonarr – All requests" : "Summonarr – My releases",
    description:
      scope.kind === "all"
        ? "Upcoming release dates for every open request on this Summonarr server."
        : "Upcoming release dates for your Summonarr requests and watchlist.",
    refreshInterval: CALENDAR_REFRESH_INTERVAL,
    events,
    now,
  });
}

export interface CalendarTokenOwner {
  id: string;
  role: string;
  permissions: bigint;
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
    },
  });
  if (!user || !calendarTokenMatches(user.calendarTokenHash, token)) return null;
  if (user.deactivatedAt != null || isPurgedRow(user)) return null;
  return { id: user.id, role: user.role, permissions: user.permissions };
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
  const select = { tmdbId: true, mediaType: true, title: true } as const;
  const [requests, watchlist] = await Promise.all([
    prisma.mediaRequest.findMany({
      where: { status: { not: "DECLINED" } },
      select,
      orderBy: { createdAt: "desc" },
      take: MAX_CALENDAR_WARM_TITLES,
    }),
    prisma.watchlistItem.findMany({
      // A disabled account's feed 404s, so its watchlist needs no warming.
      where: { user: { deactivatedAt: null } },
      select,
      orderBy: { createdAt: "desc" },
      take: MAX_CALENDAR_WARM_TITLES,
    }),
  ]);
  const titles = dedupeTitles(
    [...requests, ...watchlist].map((r) => ({ tmdbId: r.tmdbId, mediaType: toMediaType(r.mediaType), title: r.title })),
  ).slice(0, MAX_CALENDAR_WARM_TITLES);
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

  // Phase 1 — per-title date blobs.
  const movieIds = titles.filter((t) => t.mediaType === "movie").map((t) => t.tmdbId);
  const tvIds = titles.filter((t) => t.mediaType === "tv").map((t) => t.tmdbId);
  const fresh1 = await freshKeys([...movieIds.map(movieReleaseKey), ...tvIds.map(tvCalendarKey)], now);
  // An EXPIRED blob that already proves the title is finished — a movie with
  // all three dates behind the window, a show that ended before it — would only
  // be re-fetched to learn the same thing. Skip those so the budget goes to
  // titles that can still produce an event.
  const stale = await readCacheBlobs([
    ...movieIds.filter((id) => !fresh1.has(movieReleaseKey(id))).map(movieReleaseKey),
    ...tvIds.filter((id) => !fresh1.has(tvCalendarKey(id))).map(tvCalendarKey),
  ]);
  const settled = (t: CalendarTitle): boolean => {
    if (t.mediaType === "movie") {
      const d = parseMovieDates(stale.get(movieReleaseKey(t.tmdbId)), null);
      const days = [d?.primary, d?.digital, d?.physical].map((v) => (v ? v.slice(0, 10) : null));
      return days.every((v) => v !== null && v < w.from);
    }
    const info = parseTvInfo(stale.get(tvCalendarKey(t.tmdbId)));
    if (!info || (info.status !== "Ended" && info.status !== "Canceled")) return false;
    const last = info.lastAirDate ? info.lastAirDate.slice(0, 10) : null;
    return last !== null && last < w.from;
  };
  const phase1: Array<() => Promise<unknown>> = [];
  for (const t of titles) {
    if (settled(t)) continue;
    if (t.mediaType === "movie" && !fresh1.has(movieReleaseKey(t.tmdbId))) {
      // getMovieReleaseInfo swallows its own failures to null; a null with
      // credentials configured is a failed fetch, not a success.
      phase1.push(async () => {
        if ((await getMovieReleaseInfo(t.tmdbId)) === null) throw new Error("release info unavailable");
      });
    } else if (t.mediaType === "tv" && !fresh1.has(tvCalendarKey(t.tmdbId))) {
      phase1.push(() => getTVCalendarInfo(t.tmdbId));
    }
  }
  await run(phase1);
  if (opts.signal?.aborted) return { ...result, aborted: true };

  // Phase 2 — episode lists for the seasons the feed will read.
  if (tvIds.length > 0 && budget > 0) {
    const blobs = await readCacheBlobs(tvIds.map(tvCalendarKey));
    const wanted: Array<{ id: number; n: number }> = [];
    for (const id of tvIds) {
      const info = parseTvInfo(blobs.get(tvCalendarKey(id)));
      if (!info) continue;
      for (const n of seasonsToRead(info, w)) wanted.push({ id, n });
    }
    const fresh2 = await freshKeys(wanted.map((s) => tvSeasonKey(s.id, s.n)), now);
    await run(
      wanted
        .filter((s) => !fresh2.has(tvSeasonKey(s.id, s.n)))
        .map((s) => () => getTVSeasonEpisodes(s.id, s.n)),
    );
  }
  if (result.failed > 0) {
    console.warn(`[calendar] warm: ${result.failed} of ${result.fetched + result.failed} release-date lookups failed`);
  }
  return result;
}
