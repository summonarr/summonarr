// Admin → Calendar: the pure half. Radarr's and Sonarr's own /api/v3/calendar
// (the titles they manage, not TMDB's) turned into one dated list: a Sonarr
// entry per episode airing, a Radarr entry per release date (in cinemas,
// physical, digital) that falls in the window. Each carries whether the arr
// already has the file, and — from the instance's download queue — whether one
// is on its way. Zero I/O; the data half is arr-calendar-data.ts, the viewer's
// days (local placement, the window, grouping) are arr-calendar-days.ts.
//
// A movie's status here is judged against midnight UTC of its date (Radarr's
// rule, and the Missing search's); the page lifts one whose local day hasn't
// begun back to upcoming (localEntryStatus in arr-calendar-days.ts), so
// nothing on a future local day reads missing.
import { bool, bytes, isoOrNull, nonNegInt, posInt, text, textOrNull } from "./arr-parse";
import { tmdbPosterPathFromImages } from "./arr-missing";
import { needsAttention, PROJECTION_SCAN_FACTOR, queuePhase } from "./arr-queue";
import type { ArrService } from "./arr-instances";

export type CalendarKind = "episode" | "cinema" | "physical" | "digital";

/**
 *   downloaded  — the arr has the file.
 *   downloading — no file, but the instance's download queue holds it (a failed
 *                 download doesn't count: the arr will look again).
 *   missing     — the date has passed, it is monitored, and there is no file
 *                 (a cinema date never counts: no home release exists yet; an
 *                 episode counts only once it has finished airing, and only in
 *                 a regular season — the Missing page's rule).
 *   airing      — an episode on the air right now (air time + runtime).
 *   aired       — a special (season 0) that has aired with no file: never
 *                 "missing", as on the Missing page.
 *   unmonitored — no file, and the arr is not looking for one.
 *   upcoming    — still in the future.
 *   released    — a cinema date that has passed, no file yet (expected).
 */
export type CalendarStatus = "downloaded" | "downloading" | "missing" | "airing" | "aired" | "unmonitored" | "upcoming" | "released";

export interface CalendarEntry {
  /** Stable across reloads: service, instance, id and kind. */
  key: string;
  service: ArrService;
  instance: string;
  kind: CalendarKind;
  date: string;
  /** Radarr movie id / Sonarr series id. */
  arrId: number;
  episodeId: number | null;
  title: string;
  year: number | null;
  tmdbId: number | null;
  tvdbId: number | null;
  posterPath: string | null;
  seasonNumber: number | null;
  episodeNumber: number | null;
  episodeTitle: string | null;
  /** "series"/"season"/"midseason" when Sonarr knows the episode ends one. */
  finaleType: string | null;
  /** Network (Sonarr) or studio (Radarr). */
  network: string | null;
  monitored: boolean;
  hasFile: boolean;
  status: CalendarStatus;
  /** 0..1 while `downloading` (null when the queue doesn't know the size); null otherwise. */
  progress: number | null;
  /**
   * While `downloading`: Radarr/Sonarr flag the download as needing attention
   * (import blocked, a tracked warning/error — `needsAttention`, the Download
   * Queue's own verdict). False otherwise.
   */
  attention: boolean;
}

/** The longest window one request may ask for. */
export const MAX_CALENDAR_DAYS = 62;

/** A start/end pair from a query string: two ISO instants, start before end, at most MAX_CALENDAR_DAYS apart. */
export function parseCalendarWindow(rawStart: string | null, rawEnd: string | null): { start: Date; end: Date } | null {
  if (!rawStart || !rawEnd || rawStart.length > 40 || rawEnd.length > 40) return null;
  const start = Date.parse(rawStart);
  const end = Date.parse(rawEnd);
  if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) return null;
  if (end - start > MAX_CALENDAR_DAYS * 86_400_000) return null;
  return { start: new Date(start), end: new Date(end) };
}

const DAY_MS = 86_400_000;
// Sonarr v3 runs a query date through DateTime.Parse (Local kind) — the same
// hedge as arr-watch's /history/since read (HISTORY_QUERY_OVERLAP_MS in
// arr-watch-data.ts). Were that ever compared as UTC on a host east or west
// of it, an episode in the window's first or last hours would come back in
// neither this window nor the next. The widest UTC offset is 14 h.
const SONARR_DATE_SLACK_MS = 14 * 60 * 60_000;

/**
 * The instants asked of the arr for a window of the viewer's days. Both are
 * padded, and the page keeps only the entries inside its own days
 * (entriesInWindow), so the padding costs nothing on screen. Sonarr's
 * calendar is on `airDateUtc`, a real instant: padded 14 h either side
 * against a host-local parse of the query (SONARR_DATE_SLACK_MS). A movie's
 * release date is a calendar DATE (Radarr stores midnight UTC), while the
 * window is the viewer's local days: Radarr's is padded by a day either side
 * so a date on the window's edge in any time zone (UTC−12…UTC+14) comes back.
 */
export function calendarFetchWindow(service: ArrService, start: Date, end: Date): { from: Date; to: Date } {
  const pad = service === "sonarr" ? SONARR_DATE_SLACK_MS : DAY_MS;
  return { from: new Date(start.getTime() - pad), to: new Date(end.getTime() + pad) };
}

/** The calendar request for one instance. Sonarr's carries the series (title, runtime, monitored) but not the files or images. */
export function calendarPath(service: ArrService, from: Date, to: Date, unmonitored: boolean): string {
  const q = new URLSearchParams({ start: from.toISOString(), end: to.toISOString(), unmonitored: String(unmonitored) });
  if (service === "sonarr") {
    q.set("includeSeries", "true");
    q.set("includeEpisodeFile", "false");
    q.set("includeEpisodeImages", "false");
  }
  return `/api/v3/calendar?${q.toString()}`;
}

type Raw = Record<string, unknown>;
const obj = (v: unknown): Raw | null => (v && typeof v === "object" && !Array.isArray(v) ? (v as Raw) : null);

/** How long an airing is assumed to last when neither the episode nor the series says. */
export const DEFAULT_RUNTIME_MINUTES = 60;
// A runtime is minutes; anything past a day is a bad value, not a broadcast.
const MAX_RUNTIME_MINUTES = 24 * 60;

// The calendar is the arr's own answer, which arrFetch caps only by size (50 MB
// — hundreds of thousands of minimal entries), projected synchronously on every
// page load and its snapshot refresh. So each instance keeps at most this many
// entries per window — the page reads two weeks, and even the API's longest
// window of a very large library stays far below it — and its raw list is read
// at most PROJECTION_SCAN_FACTOR times that deep (guardrail 5i).
export const MAX_CALENDAR_ENTRIES = 10_000;

function statusOf(
  kind: CalendarKind,
  dateMs: number,
  nowMs: number,
  hasFile: boolean,
  monitored: boolean,
  episode?: { endMs: number; regular: boolean },
): CalendarStatus {
  if (hasFile) return "downloaded";
  if (dateMs > nowMs) return "upcoming";
  // Still on the air: nothing could have been released, let alone grabbed.
  if (episode && nowMs < episode.endMs) return "airing";
  if (!monitored) return "unmonitored";
  if (kind === "cinema") return "released";
  if (episode && !episode.regular) return "aired";
  return "missing";
}

/**
 * Radarr calendar movies → one entry per release date inside [start, end).
 * Radarr answers with every movie that has ANY date in the window, so the
 * other dates are dropped here. A release date is a calendar DATE (Radarr
 * stores midnight UTC): the page places it on that date in any time zone.
 */
export function radarrCalendarEntries(instance: string, raw: unknown, startMs: number, endMs: number, nowMs: number): CalendarEntry[] {
  if (!Array.isArray(raw)) return [];
  const out: CalendarEntry[] = [];
  for (let i = 0, n = Math.min(raw.length, MAX_CALENDAR_ENTRIES * PROJECTION_SCAN_FACTOR); i < n && out.length < MAX_CALENDAR_ENTRIES; i++) {
    const m = obj(raw[i]);
    const arrId = posInt(m?.id);
    if (!m || arrId === null) continue;
    const hasFile = bool(m.hasFile);
    const monitored = bool(m.monitored);
    const dates: Array<[CalendarKind, unknown]> = [["cinema", m.inCinemas], ["physical", m.physicalRelease], ["digital", m.digitalRelease]];
    for (const [kind, rawDate] of dates) {
      if (out.length >= MAX_CALENDAR_ENTRIES) break;
      const iso = isoOrNull(rawDate);
      if (!iso) continue;
      const ms = Date.parse(iso);
      if (ms < startMs || ms >= endMs) continue;
      out.push({
        key: `radarr:${instance}:${arrId}:${kind}`,
        service: "radarr",
        instance,
        kind,
        date: iso,
        arrId,
        episodeId: null,
        title: text(m.title, 300),
        year: posInt(m.year),
        tmdbId: posInt(m.tmdbId),
        tvdbId: null,
        posterPath: tmdbPosterPathFromImages(m.images),
        seasonNumber: null,
        episodeNumber: null,
        episodeTitle: null,
        finaleType: null,
        network: textOrNull(m.studio, 200),
        monitored,
        hasFile,
        status: statusOf(kind, ms, nowMs, hasFile, monitored),
        progress: null,
        attention: false,
      });
    }
  }
  return out;
}

/** Sonarr calendar episodes (with includeSeries) → one entry each. */
export function sonarrCalendarEntries(instance: string, raw: unknown, nowMs: number): CalendarEntry[] {
  if (!Array.isArray(raw)) return [];
  const out: CalendarEntry[] = [];
  for (let i = 0, n = Math.min(raw.length, MAX_CALENDAR_ENTRIES * PROJECTION_SCAN_FACTOR); i < n && out.length < MAX_CALENDAR_ENTRIES; i++) {
    const e = obj(raw[i]);
    const episodeId = posInt(e?.id);
    const seriesId = posInt(e?.seriesId);
    const iso = isoOrNull(e?.airDateUtc);
    if (!e || episodeId === null || seriesId === null || !iso) continue;
    const series = obj(e.series);
    const hasFile = bool(e.hasFile);
    // An episode of an unmonitored series is unmonitored whatever its own flag says.
    const monitored = bool(e.monitored) && (series ? series.monitored !== false : true);
    const seasonNumber = nonNegInt(e.seasonNumber);
    const airMs = Date.parse(iso);
    // The episode's own runtime (Sonarr v4), else the series', else an hour.
    const runtime = Math.min(posInt(e.runtime) ?? posInt(series?.runtime) ?? DEFAULT_RUNTIME_MINUTES, MAX_RUNTIME_MINUTES);
    out.push({
      key: `sonarr:${instance}:${episodeId}:episode`,
      service: "sonarr",
      instance,
      kind: "episode",
      date: iso,
      arrId: seriesId,
      episodeId,
      title: text(series?.title, 300),
      year: posInt(series?.year),
      tmdbId: posInt(series?.tmdbId),
      tvdbId: posInt(series?.tvdbId),
      posterPath: null,
      seasonNumber,
      episodeNumber: nonNegInt(e.episodeNumber),
      episodeTitle: textOrNull(e.title, 300),
      finaleType: textOrNull(e.finaleType, 20),
      network: textOrNull(series?.network, 200),
      monitored,
      hasFile,
      // A special (season 0) is never "missing" — the Missing page counts
      // regular seasons only (missingEpisodeParts in arr-missing.ts).
      status: statusOf("episode", airMs, nowMs, hasFile, monitored, { endMs: airMs + runtime * 60_000, regular: seasonNumber !== null && seasonNumber > 0 }),
      progress: null,
      attention: false,
    });
  }
  return out;
}

/** One title's downloads on an instance: progress (0..1, null when the size is unknown), and whether the arr flags one as needing attention. */
export interface CalendarQueued {
  progress: number | null;
  attention: boolean;
}

/** What one instance's download queue holds, by Radarr movie id / Sonarr episode id. */
export interface CalendarQueue {
  movies: Map<number, CalendarQueued>;
  episodes: Map<number, CalendarQueued>;
}

/**
 * Raw /api/v3/queue records of ONE instance → what is on its way. A Radarr
 * record names its movie (`movieId`), a Sonarr record its episode
 * (`episodeId`; a season pack is one record per episode). A download that
 * failed is left out — the arr blocklists it and looks again, so the entry
 * keeps its own status (and its Search). One the arr flags as needing
 * attention (an import blocked, a tracked warning) is kept, flagged: it is on
 * the instance, so Search stays off, but it is not quietly "downloading".
 */
export function calendarQueue(service: ArrService, records: readonly unknown[]): CalendarQueue {
  const q: CalendarQueue = { movies: new Map(), episodes: new Map() };
  for (const x of records) {
    const r = obj(x);
    if (!r || queuePhase(r.status, r.trackedDownloadState) === "failed") continue;
    const id = posInt(service === "radarr" ? r.movieId : r.episodeId);
    if (id === null) continue;
    const size = bytes(r.size);
    const progress = size > 0 ? Math.max(0, Math.min(1, (size - Math.min(bytes(r.sizeleft), size)) / size)) : null;
    const map = service === "radarr" ? q.movies : q.episodes;
    const prior = map.get(id);
    // Two records for one title (a pack and a single, say): the furthest
    // along, flagged when either is.
    map.set(id, {
      progress: prior === undefined || prior.progress === null ? progress : progress === null ? prior.progress : Math.max(prior.progress, progress),
      attention: (prior?.attention ?? false) || needsAttention(r),
    });
  }
  return q;
}

/** Mark the entries of the SAME instance whose title is downloading. An entry with its file keeps "downloaded" (a queued upgrade is not news here). */
export function applyCalendarQueue(entries: CalendarEntry[], queue: CalendarQueue): void {
  for (const e of entries) {
    if (e.hasFile) continue;
    const id = e.service === "radarr" ? e.arrId : e.episodeId;
    const map = e.service === "radarr" ? queue.movies : queue.episodes;
    const queued = id === null ? undefined : map.get(id);
    if (queued === undefined) continue;
    e.status = "downloading";
    e.progress = queued.progress;
    e.attention = queued.attention;
  }
}

/** By date, then title, then episode. */
export function sortCalendarEntries(entries: CalendarEntry[]): CalendarEntry[] {
  return entries.sort((a, b) =>
    a.date.localeCompare(b.date) ||
    a.title.localeCompare(b.title) ||
    (a.seasonNumber ?? 0) - (b.seasonNumber ?? 0) ||
    (a.episodeNumber ?? 0) - (b.episodeNumber ?? 0));
}
