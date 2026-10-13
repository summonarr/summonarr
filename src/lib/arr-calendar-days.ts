// Admin → Arr Calendar: the viewer's DAYS. Pure and zero-import (types only),
// so the page and the unit suite share one definition of the two decisions the
// calendar rests on — which local day an entry lands on (entryMs), and which
// entries fall inside the two weeks shown (entriesInWindow) — plus the week's
// first day, the view state kept in the URL, and the folding of one title's
// entries into one row.
//
// Everything here reads the RUNTIME's time zone through the local Date getters.
// The page calls it only after mount (guardrail 16): the server render cannot
// know the viewer's zone.
import type { CalendarEntry, CalendarKind, CalendarStatus } from "./arr-calendar";

/** Days the page shows at once. */
export const CALENDAR_DAYS = 14;

// The first instant of local day (y, m, d): midnight, or the first instant that
// exists where a DST jump skips midnight. An out-of-range day rolls over.
function dayStart(y: number, m: number, d: number): number {
  return new Date(y, m, d).getTime();
}

/**
 * The start of the local day `n` days after the one holding `ms`. Calendar
 * arithmetic, never n × 24 h: a DST change inside the span would leave the
 * result an hour off midnight, and the window's last hour on the wrong side.
 */
export function addDays(ms: number, n: number): number {
  const d = new Date(ms);
  return dayStart(d.getFullYear(), d.getMonth(), d.getDate() + n);
}

/** The local start of the week holding `ms`, weeks beginning on `firstDay` (ISO: 1 = Monday … 7 = Sunday). */
export function weekStart(ms: number, firstDay = 1): number {
  const first = Number.isInteger(firstDay) && firstDay >= 1 && firstDay <= 7 ? firstDay : 1;
  const d = new Date(ms);
  const iso = d.getDay() === 0 ? 7 : d.getDay();
  return dayStart(d.getFullYear(), d.getMonth(), d.getDate() - ((iso - first + 7) % 7));
}

/** The local date holding `ms`, as YYYY-MM-DD — a day's identity, and the URL's `week`. */
export function localDayKey(ms: number): string {
  const d = new Date(ms);
  return `${String(d.getFullYear()).padStart(4, "0")}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

/**
 * When an entry falls, as a local instant. An episode airs at a real time. A
 * movie's release date is a calendar DATE (Radarr stores midnight UTC), placed
 * on that same date locally — read in local time, midnight UTC is the previous
 * day everywhere west of UTC.
 */
export function entryMs(e: Pick<CalendarEntry, "kind" | "date">): number {
  const ms = Date.parse(e.date);
  if (e.kind === "episode") return ms;
  const d = new Date(ms);
  return dayStart(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
}

/**
 * The entries inside the window's own days, [start, start + days). The server
 * pads both arrs' windows (calendarFetchWindow — Radarr a day either side,
 * Sonarr 14 h), so entries just outside it come back and are dropped here.
 */
export function entriesInWindow<T extends Pick<CalendarEntry, "kind" | "date">>(entries: readonly T[], startMs: number, days = CALENDAR_DAYS): T[] {
  const end = addDays(startMs, days);
  return entries.filter((e) => {
    const ms = entryMs(e);
    return ms >= startMs && ms < end;
  });
}

// Statuses the server gives a date that has passed in UTC. On the viewer's
// clock the date may still be ahead (a movie's date sits on local midnight,
// which is AFTER midnight UTC everywhere west of UTC), and then it is upcoming.
const PAST_DATE_STATUSES: ReadonlySet<CalendarStatus> = new Set<CalendarStatus>(["missing", "released", "unmonitored", "aired"]);

/**
 * An entry's status as of the viewer's day. The server judges a movie's date
 * against midnight UTC (Radarr's rule, and the Missing search's — a Search
 * offered before it would 409); the page places it on local midnight
 * (entryMs). So a release is upcoming until the LATER of the two: nothing on a
 * future local day reads missing. `downloaded`/`downloading`/`airing`/
 * `upcoming` are never changed, and an episode — placed at its real instant,
 * which the server already compared — never changes.
 */
export function localEntryStatus(e: Pick<CalendarEntry, "kind" | "date" | "status">, nowMs: number): CalendarStatus {
  return PAST_DATE_STATUSES.has(e.status) && entryMs(e) > nowMs ? "upcoming" : e.status;
}

type WeekInfo = { firstDay?: unknown };
type LocaleWeek = { getWeekInfo?: () => WeekInfo; weekInfo?: WeekInfo };

/**
 * The first day of the week (ISO 1…7) for the first of `tags` the runtime can
 * answer for — the viewer's region decides (en-US starts on Sunday, en-GB and
 * most of Europe on Monday). `Intl.Locale#getWeekInfo()`, or the older
 * `weekInfo` getter; Monday when neither exists (Firefox) or no tag parses.
 */
export function firstDayOfWeek(tags: ReadonlyArray<string | null | undefined>): number {
  for (const tag of tags) {
    if (!tag) continue;
    try {
      const loc = new Intl.Locale(tag) as unknown as LocaleWeek;
      const info = typeof loc.getWeekInfo === "function" ? loc.getWeekInfo() : loc.weekInfo;
      const day = info?.firstDay;
      if (typeof day === "number" && Number.isInteger(day) && day >= 1 && day <= 7) return day;
    } catch {
      // Not a locale tag — try the next one.
    }
  }
  return 1;
}

// ── the view in the URL ─────────────────────────────────────────────────────

export type CalendarStatusFilter = "all" | "missing" | "upcoming" | "downloaded";
export type CalendarTypeFilter = "all" | "radarr" | "sonarr";

export interface CalendarView {
  /** The window's first day (local YYYY-MM-DD); null = the current week. */
  week: string | null;
  filter: CalendarStatusFilter;
  type: CalendarTypeFilter;
  /** "all", or `${service}:${slug}`. */
  instance: string;
  unmonitored: boolean;
}

export const DEFAULT_CALENDAR_VIEW: CalendarView = { week: null, filter: "all", type: "all", instance: "all", unmonitored: false };

/** A YYYY-MM-DD that names a real date, or null. */
export function parseWeekParam(v: unknown): string | null {
  if (typeof v !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(v)) return null;
  const [y, m, d] = v.split("-").map(Number);
  const probe = new Date(Date.UTC(y, m - 1, d));
  return y >= 1970 && probe.getUTCFullYear() === y && probe.getUTCMonth() === m - 1 && probe.getUTCDate() === d ? v : null;
}

/** The local start of the day a `week` param names (already parsed). */
export function localDayStartOf(week: string): number {
  const [y, m, d] = week.split("-").map(Number);
  return dayStart(y, m - 1, d);
}

/** The URL's view, each value checked; an unknown one is the default. `instances` are the `${service}:${slug}` keys that exist. */
export function parseCalendarView(
  params: { week?: unknown; filter?: unknown; type?: unknown; instance?: unknown; unmonitored?: unknown },
  instances: readonly string[],
): CalendarView {
  const filter = params.filter === "missing" || params.filter === "upcoming" || params.filter === "downloaded" ? params.filter : "all";
  const type = params.type === "radarr" || params.type === "sonarr" ? params.type : "all";
  const instance = typeof params.instance === "string" && instances.includes(params.instance) ? params.instance : "all";
  return { week: parseWeekParam(params.week), filter, type, instance, unmonitored: params.unmonitored === "1" };
}

/** The view as a query string ("" for the defaults), for history.replaceState. */
export function calendarViewQuery(v: CalendarView): string {
  const q = new URLSearchParams();
  if (v.week) q.set("week", v.week);
  if (v.filter !== "all") q.set("filter", v.filter);
  if (v.type !== "all") q.set("type", v.type);
  if (v.instance !== "all") q.set("instance", v.instance);
  if (v.unmonitored) q.set("unmonitored", "1");
  return q.toString();
}

// The status chips. "Upcoming" includes an episode on the air right now; a
// download in progress, an expected cinema date, an aired special and an
// unmonitored title show under All only.
const STATUS_FILTER: Record<Exclude<CalendarStatusFilter, "all">, readonly CalendarStatus[]> = {
  missing: ["missing"],
  upcoming: ["upcoming", "airing"],
  downloaded: ["downloaded"],
};

export function matchesStatusFilter(status: CalendarStatus, filter: CalendarStatusFilter): boolean {
  return filter === "all" || STATUS_FILTER[filter].includes(status);
}

/**
 * Whether an instance the view includes couldn't be read — the instance filter
 * ("all" or `${service}:${slug}`) and the type filter ("all" or the service)
 * both admit it. While one does, "nothing on the calendar" is a claim nobody
 * can make: that instance's schedule is unknown, not empty.
 */
export function failedInView(
  errors: ReadonlyArray<{ service: string; instance: string }>,
  instance: string,
  type: CalendarTypeFilter,
): boolean {
  return errors.some((e) => (instance === "all" || `${e.service}:${e.instance}` === instance) && (type === "all" || e.service === type));
}

// ── labels ──────────────────────────────────────────────────────────────────

/** S01E01 opens the series, SnnE01 a season; a special's E01 opens nothing. */
export function premiereOf(e: Pick<CalendarEntry, "kind" | "seasonNumber" | "episodeNumber">): "series" | "season" | null {
  if (e.kind !== "episode" || e.episodeNumber !== 1 || e.seasonNumber === null || e.seasonNumber < 1) return null;
  return e.seasonNumber === 1 ? "series" : "season";
}

/** Sonarr v4's finaleType; a value it adds later still reads as a finale. */
export function finaleOf(finaleType: string | null): "series" | "season" | "midseason" | "other" | null {
  if (!finaleType) return null;
  const v = finaleType.toLowerCase();
  return v === "series" || v === "season" || v === "midseason" ? v : "other";
}

// ── rows ────────────────────────────────────────────────────────────────────

/** One instance's view of a row's title: its status there, and what its Search would act on. */
export interface CalendarCell {
  /** service:instance:arrId:episodeId — one search per title on an instance, whichever day it shows on. */
  key: string;
  service: CalendarEntry["service"];
  instance: string;
  arrId: number;
  episodeId: number | null;
  status: CalendarStatus;
  progress: number | null;
  /** Radarr/Sonarr flag a download of it as needing attention — any of the instance's entries for it that day. */
  attention: boolean;
}

/** One title on one local day: every release kind of it that day, every instance that has it. */
export interface CalendarRow {
  key: string;
  ms: number;
  /** The title's details, from the first of its entries. */
  entry: CalendarEntry;
  /** Filled from any of the entries — one instance's copy may lack them. */
  tmdbId: number | null;
  posterPath: string | null;
  /** The release kinds that fall on this day (a movie can have several); ["episode"] for an episode. */
  kinds: CalendarKind[];
  cells: CalendarCell[];
}

export interface CalendarDay {
  key: string;
  ms: number;
  rows: CalendarRow[];
}

// Which status a cell shows when one instance has several entries for the
// title that day (a movie's digital and physical dates together): what an
// admin can act on first.
const CELL_RANK: Record<CalendarStatus, number> = {
  missing: 0, downloading: 1, airing: 2, downloaded: 3, upcoming: 4, released: 5, aired: 6, unmonitored: 7,
};
const KIND_ORDER: Record<CalendarKind, number> = { episode: 0, cinema: 1, digital: 2, physical: 3 };

// The title across instances: a movie by its TMDB id, an episode by its
// series' TVDB (else TMDB) id and its numbers. The arr's own ids differ per
// instance, so they are only the fallback when nothing shared is known.
function titleIdentity(e: CalendarEntry): string {
  if (e.service === "radarr") return e.tmdbId !== null ? `tmdb:${e.tmdbId}` : `arr:${e.instance}:${e.arrId}`;
  const series = e.tvdbId !== null ? `tvdb:${e.tvdbId}` : e.tmdbId !== null ? `tmdb:${e.tmdbId}` : null;
  if (series === null || e.seasonNumber === null || e.episodeNumber === null) return `arr:${e.instance}:${e.episodeId ?? e.arrId}`;
  return `${series}:${e.seasonNumber}:${e.episodeNumber}`;
}

/**
 * Entries → local days → one row per title. A movie whose digital and physical
 * dates share a day, or a title two instances (HD + 4K) both carry, is ONE row
 * with one status chip — and one Search — per instance, not two rows with two
 * Search buttons for the same title.
 */
export function calendarDays(entries: readonly CalendarEntry[]): CalendarDay[] {
  const days = new Map<string, CalendarDay>();
  const rows = new Map<string, CalendarRow>();
  for (const e of entries) {
    const ms = entryMs(e);
    const dayKey = localDayKey(ms);
    let day = days.get(dayKey);
    if (!day) {
      day = { key: dayKey, ms, rows: [] };
      days.set(dayKey, day);
    }
    const rowKey = `${e.service}|${titleIdentity(e)}|${dayKey}`;
    let row = rows.get(rowKey);
    if (!row) {
      row = { key: rowKey, ms, entry: e, tmdbId: e.tmdbId, posterPath: e.posterPath, kinds: [], cells: [] };
      rows.set(rowKey, row);
      day.rows.push(row);
    }
    row.tmdbId ??= e.tmdbId;
    row.posterPath ??= e.posterPath;
    if (!row.kinds.includes(e.kind)) row.kinds.push(e.kind);
    row.ms = Math.min(row.ms, ms);
    const cellKey = `${e.service}:${e.instance}:${e.arrId}:${e.episodeId ?? ""}`;
    const cell = row.cells.find((c) => c.key === cellKey);
    if (!cell) {
      row.cells.push({ key: cellKey, service: e.service, instance: e.instance, arrId: e.arrId, episodeId: e.episodeId, status: e.status, progress: e.progress, attention: e.attention });
    } else {
      // The flag is the download's, whichever status the cell shows.
      cell.attention ||= e.attention;
      if (CELL_RANK[e.status] < CELL_RANK[cell.status]) {
        cell.status = e.status;
        cell.progress = e.progress;
      }
    }
  }
  const out = [...days.values()].sort((a, b) => a.ms - b.ms);
  for (const day of out) {
    day.ms = Math.min(...day.rows.map((r) => r.ms));
    for (const row of day.rows) row.kinds.sort((a, b) => KIND_ORDER[a] - KIND_ORDER[b]);
    day.rows.sort((a, b) =>
      a.ms - b.ms ||
      a.entry.title.localeCompare(b.entry.title) ||
      (a.entry.seasonNumber ?? 0) - (b.entry.seasonNumber ?? 0) ||
      (a.entry.episodeNumber ?? 0) - (b.entry.episodeNumber ?? 0));
  }
  return out;
}

/** How many rows `calendarDays` would draw — what a filter chip's count says. */
export function calendarRowCount(entries: readonly CalendarEntry[]): number {
  return calendarDays(entries).reduce((n, d) => n + d.rows.length, 0);
}
