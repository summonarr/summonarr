// Admin → Calendar: the pure half. Radarr's and Sonarr's own /api/v3/calendar
// (the titles they manage, not TMDB's) turned into one dated list: a Sonarr
// entry per episode airing, a Radarr entry per release date (in cinemas,
// physical, digital) that falls in the window. Each carries whether the arr
// already has the file. Zero I/O; the data half is arr-calendar-data.ts.
import { bool, isoOrNull, nonNegInt, posInt, text, textOrNull } from "./arr-parse";
import { tmdbPosterPathFromImages } from "./arr-missing";
import type { ArrService } from "./arr-instances";

export type CalendarKind = "episode" | "cinema" | "physical" | "digital";

/**
 *   downloaded  — the arr has the file.
 *   missing     — the date has passed, it is monitored, and there is no file
 *                 (a cinema date never counts: no home release exists yet).
 *   unmonitored — no file, and the arr is not looking for one.
 *   upcoming    — still in the future.
 *   released    — a cinema date that has passed, no file yet (expected).
 */
export type CalendarStatus = "downloaded" | "missing" | "unmonitored" | "upcoming" | "released";

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

type Raw = Record<string, unknown>;
const obj = (v: unknown): Raw | null => (v && typeof v === "object" && !Array.isArray(v) ? (v as Raw) : null);

function statusOf(kind: CalendarKind, dateMs: number, nowMs: number, hasFile: boolean, monitored: boolean): CalendarStatus {
  if (hasFile) return "downloaded";
  if (dateMs > nowMs) return "upcoming";
  if (!monitored) return "unmonitored";
  return kind === "cinema" ? "released" : "missing";
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
  for (const x of raw) {
    const m = obj(x);
    const arrId = posInt(m?.id);
    if (!m || arrId === null) continue;
    const hasFile = bool(m.hasFile);
    const monitored = bool(m.monitored);
    const dates: Array<[CalendarKind, unknown]> = [["cinema", m.inCinemas], ["physical", m.physicalRelease], ["digital", m.digitalRelease]];
    for (const [kind, rawDate] of dates) {
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
      });
    }
  }
  return out;
}

/** Sonarr calendar episodes (with includeSeries) → one entry each. */
export function sonarrCalendarEntries(instance: string, raw: unknown, nowMs: number): CalendarEntry[] {
  if (!Array.isArray(raw)) return [];
  const out: CalendarEntry[] = [];
  for (const x of raw) {
    const e = obj(x);
    const episodeId = posInt(e?.id);
    const seriesId = posInt(e?.seriesId);
    const iso = isoOrNull(e?.airDateUtc);
    if (!e || episodeId === null || seriesId === null || !iso) continue;
    const series = obj(e.series);
    const hasFile = bool(e.hasFile);
    // An episode of an unmonitored series is unmonitored whatever its own flag says.
    const monitored = bool(e.monitored) && (series ? series.monitored !== false : true);
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
      seasonNumber: nonNegInt(e.seasonNumber),
      episodeNumber: nonNegInt(e.episodeNumber),
      episodeTitle: textOrNull(e.title, 300),
      finaleType: textOrNull(e.finaleType, 20),
      network: textOrNull(series?.network, 200),
      monitored,
      hasFile,
      status: statusOf("episode", Date.parse(iso), nowMs, hasFile, monitored),
    });
  }
  return out;
}

/** By date, then title, then episode. */
export function sortCalendarEntries(entries: CalendarEntry[]): CalendarEntry[] {
  return entries.sort((a, b) =>
    a.date.localeCompare(b.date) ||
    a.title.localeCompare(b.title) ||
    (a.seasonNumber ?? 0) - (b.seasonNumber ?? 0) ||
    (a.episodeNumber ?? 0) - (b.episodeNumber ?? 0));
}
