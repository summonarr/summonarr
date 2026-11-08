// Pure release-date → calendar-event rules for the personal iCal feed. No
// prisma, no fetch: the loader (calendar-feed.ts) reads the TMDB caches and
// hands the parsed blobs in, so every selection rule is unit-testable.
//
// Data sources (all already cached by the app — the feed route makes NO
// upstream call):
//   movie:<id>:release-info:v2  { primary, digital, physical }  (arr.ts getMovieReleaseInfo)
//   movie:<id>:details          TmdbMedia.releaseDate           (fallback for primary)
//   tv:<id>:calendar:v1         CalendarTvInfo                  (tmdb.ts getTVCalendarInfo)
//   tv:<id>:details             TmdbMedia seasons/nextEpisodeAirDate (fallback)
//   tv:<id>:season:<n>          TmdbEpisode[]                   (tmdb.ts getTVSeasonEpisodes)
//
// Deliberately NOT a source: TVEpisodeCache. It is the one table that cannot be
// scoped to a restricted media-server instance (guardrail 35), and the feed is
// about release dates, not about which server holds what — so it never reads a
// library table at all, and never says anything about availability.

import type { IcsEvent } from "./ics";
import type { Translator } from "./i18n/translate";
import { translatorFor } from "./i18n/server-locale";

export type CalendarMediaType = "movie" | "tv";

export interface CalendarTitle {
  tmdbId: number;
  mediaType: CalendarMediaType;
  title: string;
}

/** Inclusive `YYYY-MM-DD` bounds. */
export interface CalendarWindow {
  from: string;
  to: string;
}

export interface MovieReleaseDates {
  primary?: string | null;
  digital?: string | null;
  physical?: string | null;
}

export interface CalendarTvSeason {
  seasonNumber: number;
  airDate: string | null;
}

/** What the feed needs to know about a show, from either TV cache shape. */
export interface CalendarTvInfo {
  status?: string | null;
  lastAirDate?: string | null;
  seasons: CalendarTvSeason[];
  nextEpisode?: {
    airDate: string;
    seasonNumber?: number | null;
    episodeNumber?: number | null;
    name?: string | null;
  } | null;
}

export interface CalendarEpisode {
  seasonNumber: number;
  episodeNumber: number;
  name?: string | null;
  airDate: string | null;
}

export interface CalendarSourceData {
  movies: ReadonlyMap<number, MovieReleaseDates>;
  tv: ReadonlyMap<number, CalendarTvInfo>;
  /** Keyed by tmdbId; every cached episode of the seasons read for that show. */
  episodes: ReadonlyMap<number, readonly CalendarEpisode[]>;
}

export const CALENDAR_PAST_DAYS = 30;
export const CALENDAR_FUTURE_DAYS = 365;
/** Hard cap on events in one feed — bounds the response for the all-requests feed. */
export const MAX_CALENDAR_EVENTS = 3000;

function isoDay(d: Date): string {
  return d.toISOString().slice(0, 10);
}

/** ~30 days back to ~1 year ahead of `now`, as UTC calendar days. */
export function calendarWindow(now: Date): CalendarWindow {
  const day = 24 * 60 * 60 * 1000;
  return {
    from: isoDay(new Date(now.getTime() - CALENDAR_PAST_DAYS * day)),
    to: isoDay(new Date(now.getTime() + CALENDAR_FUTURE_DAYS * day)),
  };
}

/**
 * Normalize a TMDB date (`YYYY-MM-DD` or a full ISO timestamp, as
 * /release_dates returns) to `YYYY-MM-DD`, or null when unusable.
 */
export function toDay(value: string | null | undefined): string | null {
  if (!value || typeof value !== "string") return null;
  const day = value.slice(0, 10);
  return /^\d{4}-\d{2}-\d{2}$/.test(day) ? day : null;
}

export function inWindow(day: string | null, w: CalendarWindow): day is string {
  return day !== null && day >= w.from && day <= w.to;
}

const pad2 = (n: number) => String(n).padStart(2, "0");

/**
 * Which seasons' episode lists the feed (and the warm cron) should read for a
 * show. The newest two regular seasons that have premiered by the window's end
 * or are undated — an airing show's current season, plus the previous one for
 * the 30-day look-back. An ended show whose last episode predates the window
 * needs none.
 */
export function seasonsToRead(info: CalendarTvInfo, w: CalendarWindow): number[] {
  const ended = info.status === "Ended" || info.status === "Canceled";
  const last = toDay(info.lastAirDate);
  if (ended && last !== null && last < w.from) return [];
  const regular = info.seasons
    .filter((s) => s.seasonNumber > 0)
    .filter((s) => {
      const d = toDay(s.airDate);
      return d === null || d <= w.to;
    })
    .map((s) => s.seasonNumber)
    .sort((a, b) => b - a);
  // The season next_episode_to_air names may be newer than the season list
  // (a stale details blob) — always include it.
  const next = info.nextEpisode?.seasonNumber;
  const out = new Set(regular.slice(0, 2));
  if (typeof next === "number" && next > 0) out.add(next);
  return [...out].sort((a, b) => a - b);
}

/** Absolute link to a title page, or undefined when no site URL is known. */
function titleUrl(siteUrl: string | null, t: CalendarTitle): string | undefined {
  if (!siteUrl) return undefined;
  return `${siteUrl}/${t.mediaType}/${t.tmdbId}`;
}

function describe(kind: string, url: string | undefined): string {
  return url ? `${kind}\n${url}` : kind;
}

// Labels come from the notify.calendar.label.* / text.* catalog keys, in the
// feed owner's language.
const MOVIE_KINDS = ["primary", "digital", "physical"] as const;

/** A TMDB placeholder episode name ("Episode 4") adds nothing to the summary. */
function isPlaceholderName(name: string | null | undefined, episodeNumber: number): boolean {
  if (!name) return true;
  const n = name.trim();
  return n === "" || n === `Episode ${episodeNumber}` || n.toUpperCase() === "TBA";
}

type EventContext = { w: CalendarWindow; url: string | undefined; tr: Translator };

function movieEvents(t: CalendarTitle, dates: MovieReleaseDates, { w, url, tr }: EventContext): IcsEvent[] {
  const out: IcsEvent[] = [];
  for (const kind of MOVIE_KINDS) {
    const day = toDay(dates[kind]);
    if (!inWindow(day, w)) continue;
    out.push({
      uid: `movie-${t.tmdbId}-${kind === "primary" ? "theatrical" : kind}@summonarr`,
      date: day,
      summary: `${t.title} (${tr(`notify.calendar.label.${kind}`)})`,
      description: describe(tr(`notify.calendar.text.${kind}`), url),
      url,
    });
  }
  return out;
}

// What a show's episode rows already cover, for the premiere and next-episode
// fallbacks below.
type EpisodeCoverage = {
  /** Seasons with at least one DATED episode row: their premiere needs no fallback. */
  seasonsWithEpisodes: Set<number>;
  /** In-window SxxEyy codes and days. */
  episodeCodes: Set<string>;
  episodeDays: Set<string>;
};

function episodeEvents(
  t: CalendarTitle,
  episodes: readonly CalendarEpisode[],
  { w, url, tr }: EventContext,
): { events: IcsEvent[]; coverage: EpisodeCoverage } {
  const events: IcsEvent[] = [];
  const coverage: EpisodeCoverage = { seasonsWithEpisodes: new Set(), episodeCodes: new Set(), episodeDays: new Set() };
  for (const ep of episodes) {
    if (ep.seasonNumber <= 0) continue; // specials never carry a dependable date
    const day = toDay(ep.airDate);
    // Only a dated row covers its season: a list of undated placeholders must
    // not hide the season's own premiere date.
    if (day !== null) coverage.seasonsWithEpisodes.add(ep.seasonNumber);
    if (!inWindow(day, w)) continue;
    // Only in-window rows "cover" a nextEpisode SxxEyy. A stale cached
    // airDate outside the window emits nothing — treating it as covered
    // dropped the upcoming fallback and the episode vanished from the feed.
    coverage.episodeCodes.add(`${ep.seasonNumber}:${ep.episodeNumber}`);
    coverage.episodeDays.add(day);
    const code = `S${pad2(ep.seasonNumber)}E${pad2(ep.episodeNumber)}`;
    const suffix = isPlaceholderName(ep.name, ep.episodeNumber) ? "" : ` – ${ep.name!.trim()}`;
    events.push({
      uid: `tv-${t.tmdbId}-s${ep.seasonNumber}e${ep.episodeNumber}@summonarr`,
      date: day,
      summary: `${t.title} ${code}${suffix}`,
      description: describe(tr("notify.calendar.episodeAirDate"), url),
      url,
    });
  }
  return { events, coverage };
}

// A season premiere we have no dated episode list for yet.
function premiereEvents(
  t: CalendarTitle,
  info: CalendarTvInfo,
  coverage: EpisodeCoverage,
  { w, url, tr }: EventContext,
): IcsEvent[] {
  const out: IcsEvent[] = [];
  for (const s of info.seasons) {
    if (s.seasonNumber <= 0 || coverage.seasonsWithEpisodes.has(s.seasonNumber)) continue;
    const day = toDay(s.airDate);
    if (!inWindow(day, w)) continue;
    coverage.episodeDays.add(day);
    out.push({
      uid: `tv-${t.tmdbId}-s${s.seasonNumber}-premiere@summonarr`,
      date: day,
      summary: tr("notify.calendar.seasonPremiereSummary", { title: t.title, season: s.seasonNumber }),
      description: describe(tr("notify.calendar.seasonPremiere"), url),
      url,
    });
  }
  return out;
}

// The next episode, when the episode lists don't already emit it — by its
// SxxEyy when known (an in-window list row's own date wins), otherwise by
// date. One stable UID, so a date change updates the event instead of adding one.
function nextEpisodeEvent(
  t: CalendarTitle,
  info: CalendarTvInfo,
  coverage: EpisodeCoverage,
  { w, url, tr }: EventContext,
): IcsEvent | null {
  const next = info.nextEpisode;
  const nextDay = toDay(next?.airDate);
  if (!next || !inWindow(nextDay, w)) return null;
  const s = next.seasonNumber;
  const e = next.episodeNumber;
  const hasCode = typeof s === "number" && s > 0 && typeof e === "number" && e > 0;
  const covered = hasCode ? coverage.episodeCodes.has(`${s}:${e}`) : coverage.episodeDays.has(nextDay);
  if (covered) return null;
  const code = hasCode ? ` S${pad2(s)}E${pad2(e)}` : "";
  const suffix = hasCode && !isPlaceholderName(next.name, e) ? ` – ${next.name!.trim()}` : "";
  return {
    uid: `tv-${t.tmdbId}-next@summonarr`,
    date: nextDay,
    summary: hasCode ? `${t.title}${code}${suffix}` : tr("notify.calendar.newEpisode", { title: t.title }),
    description: describe(tr("notify.calendar.episodeAirDate"), url),
    url,
  };
}

function tvEvents(t: CalendarTitle, data: CalendarSourceData, ctx: EventContext): IcsEvent[] {
  const { events, coverage } = episodeEvents(t, data.episodes.get(t.tmdbId) ?? [], ctx);
  const info = data.tv.get(t.tmdbId);
  if (!info) return events;
  events.push(...premiereEvents(t, info, coverage, ctx));
  const next = nextEpisodeEvent(t, info, coverage, ctx);
  if (next) events.push(next);
  return events;
}

/** By date, then UID. */
function compareEvents(a: IcsEvent, b: IcsEvent): number {
  if (a.date !== b.date) return a.date < b.date ? -1 : 1;
  if (a.uid !== b.uid) return a.uid < b.uid ? -1 : 1;
  return 0;
}

/** First occurrence of each (mediaType, tmdbId); its display title wins. */
export function dedupeCalendarTitles<T extends { mediaType: string; tmdbId: number }>(titles: readonly T[]): T[] {
  const seen = new Set<string>();
  const out: T[] = [];
  for (const t of titles) {
    const key = `${t.mediaType}:${t.tmdbId}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(t);
  }
  return out;
}

/**
 * Build the feed's events. Titles are deduplicated by (mediaType, tmdbId) —
 * the first occurrence's display title wins. Output is sorted by date, then
 * UID, and capped at MAX_CALENDAR_EVENTS (nearest dates kept).
 *
 * `siteUrl` is the absolute app root (AUTH_URL origin + BASE_PATH, no trailing
 * slash), or null to omit links. `tr` writes the event labels in the feed
 * owner's language (English when omitted).
 */
export function buildCalendarEvents(
  titles: readonly CalendarTitle[],
  data: CalendarSourceData,
  w: CalendarWindow,
  siteUrl: string | null,
  tr: Translator = translatorFor("en"),
): IcsEvent[] {
  const events: IcsEvent[] = [];
  for (const t of dedupeCalendarTitles(titles)) {
    const ctx: EventContext = { w, url: titleUrl(siteUrl, t), tr };
    if (t.mediaType === "movie") {
      const dates = data.movies.get(t.tmdbId);
      if (dates) events.push(...movieEvents(t, dates, ctx));
    } else {
      events.push(...tvEvents(t, data, ctx));
    }
  }
  events.sort(compareEvents);
  return events.slice(0, MAX_CALENDAR_EVENTS);
}

/** Parse either TV cache blob into CalendarTvInfo, or null when unusable. */
export function parseTvInfo(raw: unknown): CalendarTvInfo | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  const seasonsRaw = Array.isArray(r.seasons) ? r.seasons : [];
  const seasons: CalendarTvSeason[] = [];
  for (const s of seasonsRaw) {
    if (!s || typeof s !== "object") continue;
    const so = s as Record<string, unknown>;
    if (typeof so.seasonNumber !== "number") continue;
    seasons.push({ seasonNumber: so.seasonNumber, airDate: typeof so.airDate === "string" ? so.airDate : null });
  }
  let nextEpisode: CalendarTvInfo["nextEpisode"] = null;
  if (r.nextEpisode && typeof r.nextEpisode === "object") {
    // tv:<id>:calendar:v1 shape
    const n = r.nextEpisode as Record<string, unknown>;
    if (typeof n.airDate === "string") {
      nextEpisode = {
        airDate: n.airDate,
        seasonNumber: typeof n.seasonNumber === "number" ? n.seasonNumber : null,
        episodeNumber: typeof n.episodeNumber === "number" ? n.episodeNumber : null,
        name: typeof n.name === "string" ? n.name : null,
      };
    }
  } else if (typeof r.nextEpisodeAirDate === "string") {
    // tv:<id>:details (TmdbMedia) shape — a date only
    nextEpisode = { airDate: r.nextEpisodeAirDate };
  }
  return {
    status: typeof r.status === "string" ? r.status : null,
    lastAirDate: typeof r.lastAirDate === "string" ? r.lastAirDate : null,
    seasons,
    nextEpisode,
  };
}

/** Parse a cached TmdbEpisode[] blob into CalendarEpisode[]. */
export function parseEpisodes(raw: unknown): CalendarEpisode[] {
  if (!Array.isArray(raw)) return [];
  const out: CalendarEpisode[] = [];
  for (const e of raw) {
    if (!e || typeof e !== "object") continue;
    const eo = e as Record<string, unknown>;
    if (typeof eo.seasonNumber !== "number" || typeof eo.episodeNumber !== "number") continue;
    out.push({
      seasonNumber: eo.seasonNumber,
      episodeNumber: eo.episodeNumber,
      name: typeof eo.name === "string" ? eo.name : null,
      airDate: typeof eo.airDate === "string" ? eo.airDate : null,
    });
  }
  return out;
}

/** Parse a movie cache blob: release-info:v2 ({primary,digital,physical}) or details (TmdbMedia). */
export function parseMovieDates(releaseInfo: unknown, details: unknown): MovieReleaseDates | null {
  const out: MovieReleaseDates = {};
  if (releaseInfo && typeof releaseInfo === "object") {
    const r = releaseInfo as Record<string, unknown>;
    if (typeof r.primary === "string") out.primary = r.primary;
    if (typeof r.digital === "string") out.digital = r.digital;
    if (typeof r.physical === "string") out.physical = r.physical;
  }
  if (out.primary == null && details && typeof details === "object") {
    const d = details as Record<string, unknown>;
    if (typeof d.releaseDate === "string") out.primary = d.releaseDate;
  }
  return out.primary == null && out.digital == null && out.physical == null ? null : out;
}
