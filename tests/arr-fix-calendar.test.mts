// Admin → Arr Calendar: the decisions behind what each row says and where it
// lands (src/lib/arr-calendar.ts, src/lib/arr-calendar-days.ts).
//
//   1. Status: an episode is "airing" until air time + runtime and only then
//      "missing"; a special (S00) is never "missing" (the Missing page's
//      regular-season rule); a title in the instance's download queue reads
//      "downloading" (with progress) instead of offering a Search — unless the
//      download failed — and carries the arr's needs-attention flag; a movie
//      on a future LOCAL day is never "missing" (localEntryStatus, per zone).
//   2. The viewer's days, in REAL time zones (a child `node` per zone — Date
//      reads TZ through the runtime, so the only honest test is a process that
//      started in that zone): the week's start for a given first day; a movie's
//      release DATE lands on that date (not the day before west of UTC) and the
//      window's last day is in while the next is out — through the server's
//      Radarr padding; the window spans 14 calendar days across a DST change,
//      never 14 × 24 h.
//   3. Rows: one per title per day — a movie's dates that share a day, and a
//      title on two instances, fold into one row with a cell (status + Search)
//      per instance.
//   4. Labels, filters and the URL view; which failures stop the page from
//      claiming "nothing on the calendar".
//   5. The page's wiring (structural): keyed per server render, a report
//      never clears an in-flight search, the window follows the server's
//      clock until the admin picks a week.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";

// The in-process tests read local days too; pin them to UTC so they mean the
// same thing on every machine. The time-zone tests run in children.
process.env.TZ = "UTC";

const {
  applyCalendarQueue,
  calendarFetchWindow,
  calendarPath,
  calendarQueue,
  radarrCalendarEntries,
  sonarrCalendarEntries,
} = await import("../src/lib/arr-calendar.ts");
const {
  calendarDays,
  calendarViewQuery,
  failedInView,
  finaleOf,
  firstDayOfWeek,
  matchesStatusFilter,
  parseCalendarView,
  parseWeekParam,
  premiereOf,
} = await import("../src/lib/arr-calendar-days.ts");

const H = 3_600_000;
const NOW = Date.parse("2026-10-10T12:00:00Z");
const ep = (over: Record<string, unknown>) => ({
  id: 1, seriesId: 9, seasonNumber: 1, episodeNumber: 2, monitored: true, hasFile: false,
  series: { title: "S", tvdbId: 900, monitored: true }, ...over,
});
const at = (msBeforeNow: number) => new Date(NOW - msBeforeNow).toISOString();
const statusOf = (raw: Record<string, unknown>) => sonarrCalendarEntries("", [ep(raw)], NOW)[0].status;

// ── 1: status ───────────────────────────────────────────────────────────────

test("an episode is airing until air time + runtime, and missing only after that", () => {
  // The series' runtime when the episode has none.
  assert.equal(statusOf({ airDateUtc: at(0.5 * H), series: { title: "S", monitored: true, runtime: 60 } }), "airing");
  assert.equal(statusOf({ airDateUtc: at(1.5 * H), series: { title: "S", monitored: true, runtime: 60 } }), "missing");
  // The episode's own runtime (Sonarr v4) wins over the series'.
  assert.equal(statusOf({ airDateUtc: at(1.5 * H), runtime: 120, series: { title: "S", monitored: true, runtime: 30 } }), "airing");
  // Neither: an hour.
  assert.equal(statusOf({ airDateUtc: at(59 * 60_000) }), "airing");
  assert.equal(statusOf({ airDateUtc: at(61 * 60_000) }), "missing");
  // Still in the future, and already downloaded while on the air.
  assert.equal(statusOf({ airDateUtc: at(-H) }), "upcoming");
  assert.equal(statusOf({ airDateUtc: at(0.5 * H), hasFile: true }), "downloaded");
  // On the air but unmonitored: still airing — nothing to search either way.
  assert.equal(statusOf({ airDateUtc: at(0.5 * H), monitored: false }), "airing");
});

test("a special (season 0) that aired with no file is never missing", () => {
  assert.equal(statusOf({ seasonNumber: 0, episodeNumber: 1, airDateUtc: at(48 * H) }), "aired");
  assert.equal(statusOf({ seasonNumber: 0, episodeNumber: 1, airDateUtc: at(48 * H), monitored: false }), "unmonitored");
  assert.equal(statusOf({ seasonNumber: 0, episodeNumber: 1, airDateUtc: at(48 * H), hasFile: true }), "downloaded");
  assert.equal(statusOf({ seasonNumber: 1, episodeNumber: 1, airDateUtc: at(48 * H) }), "missing");
});

test("a title in the instance's download queue is downloading, with progress — unless the download failed", () => {
  const movies = radarrCalendarEntries("", [
    { id: 11, title: "Queued", monitored: true, hasFile: false, digitalRelease: "2026-10-05T00:00:00Z", inCinemas: "2026-10-05T00:00:00Z" },
    { id: 12, title: "Failed", monitored: true, hasFile: false, digitalRelease: "2026-10-05T00:00:00Z" },
    { id: 13, title: "Upgrade", monitored: true, hasFile: true, digitalRelease: "2026-10-05T00:00:00Z" },
    { id: 14, title: "Held", monitored: true, hasFile: false, digitalRelease: "2026-10-05T00:00:00Z" },
    { id: 15, title: "Blocked", monitored: true, hasFile: false, digitalRelease: "2026-10-05T00:00:00Z" },
  ], Date.parse("2026-10-01T00:00:00Z"), Date.parse("2026-10-15T00:00:00Z"), NOW);
  applyCalendarQueue(movies, calendarQueue("radarr", [
    { id: 1, movieId: 11, size: 400, sizeleft: 100, status: "downloading" },
    { id: 2, movieId: 12, size: 400, sizeleft: 0, status: "completed", trackedDownloadState: "failedPending" },
    { id: 3, movieId: 13, size: 400, sizeleft: 300, status: "downloading" },
    // A release Radarr is holding (delay profile): no size yet.
    { id: 4, movieId: 14, status: "delay" },
    { id: 5, movieId: "x" },
    null,
    // Finished downloading, import blocked: on the instance (no Search), but the arr says to look.
    { id: 6, movieId: 15, size: 400, sizeleft: 0, status: "completed", trackedDownloadState: "importBlocked", trackedDownloadStatus: "warning" },
  ]));
  assert.deepEqual(movies.map((e) => [e.title, e.kind, e.status, e.progress, e.attention]), [
    ["Queued", "cinema", "downloading", 0.75, false],
    ["Queued", "digital", "downloading", 0.75, false],
    ["Failed", "digital", "missing", null, false],
    ["Upgrade", "digital", "downloaded", null, false],
    ["Held", "digital", "downloading", null, false],
    ["Blocked", "digital", "downloading", 1, true],
  ]);

  // Sonarr's queue names the EPISODE; another episode of the same series is untouched.
  const eps = sonarrCalendarEntries("", [ep({ id: 1, airDateUtc: at(48 * H) }), ep({ id: 2, airDateUtc: at(48 * H) })], NOW);
  applyCalendarQueue(eps, calendarQueue("sonarr", [
    { id: 7, seriesId: 9, episodeId: 2, size: 100, sizeleft: 40 },
    { id: 8, seriesId: 9, episodeId: 2, size: 100, sizeleft: 90, trackedDownloadStatus: "warning" },
  ]));
  assert.deepEqual(eps.map((e) => [e.episodeId, e.status, e.progress, e.attention]), [[1, "missing", null, false], [2, "downloading", 0.6, true]],
    "two records for one episode: the furthest along, flagged when either is");
  // Order-independent: the flagged record first, then a clean one.
  const eps2 = sonarrCalendarEntries("", [ep({ id: 2, airDateUtc: at(48 * H) })], NOW);
  applyCalendarQueue(eps2, calendarQueue("sonarr", [
    { id: 8, seriesId: 9, episodeId: 2, size: 100, sizeleft: 0, status: "completed", trackedDownloadState: "importBlocked" },
    { id: 7, seriesId: 9, episodeId: 2, size: 100, sizeleft: 40 },
  ]));
  assert.deepEqual(eps2.map((e) => [e.status, e.progress, e.attention]), [["downloading", 1, true]]);
});

test("Radarr's window is padded a day either side, Sonarr's 14 h (a host-local date parse), and Sonarr's carries the series", () => {
  const start = new Date("2026-10-05T07:00:00Z");
  const end = new Date("2026-10-19T07:00:00Z");
  const r = calendarFetchWindow("radarr", start, end);
  assert.deepEqual([r.from.toISOString(), r.to.toISOString()], ["2026-10-04T07:00:00.000Z", "2026-10-20T07:00:00.000Z"]);
  const s = calendarFetchWindow("sonarr", start, end);
  assert.deepEqual([s.from.toISOString(), s.to.toISOString()], ["2026-10-04T17:00:00.000Z", "2026-10-19T21:00:00.000Z"]);
  const q = new URLSearchParams(calendarPath("sonarr", s.from, s.to, true).split("?")[1]);
  assert.equal(q.get("includeSeries"), "true");
  assert.equal(q.get("unmonitored"), "true");
  assert.equal(new URLSearchParams(calendarPath("radarr", r.from, r.to, false).split("?")[1]).get("includeSeries"), null);
});

// ── 2: the viewer's days, per time zone ─────────────────────────────────────

const LOADER = fileURLToPath(new URL("./_loader.mjs", import.meta.url));
const DAYS_URL = pathToFileURL(fileURLToPath(new URL("../src/lib/arr-calendar-days.ts", import.meta.url))).href;
const CAL_URL = pathToFileURL(fileURLToPath(new URL("../src/lib/arr-calendar.ts", import.meta.url))).href;

// Runs in a fresh `node` started in the zone under test; prints what the page
// would compute. Every input is a fixed instant, so only TZ varies.
const CHILD = `
const d = await import(${JSON.stringify(DAYS_URL)});
const c = await import(${JSON.stringify(CAL_URL)});
const key = d.localDayKey;
const wed = Date.parse("2026-10-21T12:00:00Z");
const sun = Date.parse("2026-10-25T20:00:00Z");
const start = d.weekStart(wed, 1);
const end = d.addDays(start, d.CALENDAR_DAYS);
const nextWeek = d.addDays(start, 7);
// The page's request, the server's padded Radarr read, the page's own days.
const win = c.calendarFetchWindow("radarr", new Date(start), new Date(end));
const movies = c.radarrCalendarEntries("", [
  { id: 1, title: "First", monitored: true, hasFile: true, digitalRelease: "2026-10-19T00:00:00Z" },
  { id: 2, title: "Last", monitored: true, hasFile: true, physicalRelease: "2026-11-01T00:00:00Z" },
  { id: 3, title: "After", monitored: true, hasFile: true, digitalRelease: "2026-11-02T00:00:00Z" },
  { id: 4, title: "Before", monitored: true, hasFile: true, inCinemas: "2026-10-18T00:00:00Z" },
], win.from.getTime(), win.to.getTime(), 0);
const placed = d.calendarDays(d.entriesInWindow(movies, start)).flatMap((day) => day.rows.map((r) => [r.entry.title, day.key]));
const airs = ["2026-10-20T03:30:00Z", "2026-11-01T23:30:00Z", "2026-11-02T00:30:00Z", "2026-11-02T07:30:00Z"];
const eps = c.sonarrCalendarEntries("", airs.map((a, i) => ({ id: i + 1, seriesId: 9, seasonNumber: 1, episodeNumber: i + 1, airDateUtc: a, monitored: true, hasFile: true, series: { title: "S" } })), 0);
const inWindow = d.entriesInWindow(eps, start).map((e) => e.date);
// The padded Sonarr read returns episodes up to 14 h outside the window; the page's own days drop them.
const sWin = c.calendarFetchWindow("sonarr", new Date(start), new Date(end));
const padAirs = [new Date(start - 10 * 3600000).toISOString(), new Date(end + 10 * 3600000).toISOString()];
const padEps = c.sonarrCalendarEntries("", padAirs.map((a, i) => ({ id: 100 + i, seriesId: 9, seasonNumber: 1, episodeNumber: 50 + i, airDateUtc: a, monitored: true, hasFile: true, series: { title: "S" } })), 0);
console.log(JSON.stringify({
  offsetJuly: new Date("2026-07-01T00:00:00Z").getTimezoneOffset(),
  monWed: key(d.weekStart(wed, 1)), sunWed: key(d.weekStart(wed, 7)),
  monSun: key(d.weekStart(sun, 1)), sunSun: key(d.weekStart(sun, 7)), satSun: key(d.weekStart(sun, 6)),
  start: key(start), startHour: new Date(start).getHours(),
  end: key(end), endHour: new Date(end).getHours(), endMinute: new Date(end).getMinutes(),
  nextWeek: key(nextWeek), nextWeekHour: new Date(nextWeek).getHours(),
  lastDay: key(d.addDays(start, d.CALENDAR_DAYS - 1)),
  placed,
  epDay: key(d.entryMs(eps[0])),
  inWindow,
  sonarrPadded: [start - sWin.from.getTime(), sWin.to.getTime() - end],
  padInWindow: d.entriesInWindow(padEps, start).length,
}));
`;

function inZone(tz: string, script = CHILD): Record<string, unknown> {
  const r = spawnSync(process.execPath, [
    "--disable-warning=MODULE_TYPELESS_PACKAGE_JSON", "--import", LOADER, "--input-type=module", "-e", script,
  ], { env: { ...process.env, TZ: tz }, encoding: "utf8" });
  assert.equal(r.status, 0, `${tz}: ${r.stderr}`);
  return JSON.parse(r.stdout.trim().split("\n").at(-1) ?? "{}") as Record<string, unknown>;
}

// The window is Mon 2026-10-19 … Sun 2026-11-01 in every zone below. It spans
// London's BST→GMT change (Oct 25) and Los Angeles' PDT→PST change (Nov 1).
const ZONES: Array<{ tz: string; offsetJuly: number; monSun: string; sunSun: string; satSun: string; epDay: string; inWindow: string[] }> = [
  {
    tz: "America/Los_Angeles", offsetJuly: 420,
    monSun: "2026-10-19", sunSun: "2026-10-25", satSun: "2026-10-24",
    // 03:30Z on the 20th is 20:30 on the 19th here.
    epDay: "2026-10-19",
    // Every air time but the first is still Nov 1 here — 07:30Z on Nov 2 is 23:30 PST on Nov 1, the window's last hour.
    inWindow: ["2026-10-20T03:30:00.000Z", "2026-11-01T23:30:00.000Z", "2026-11-02T00:30:00.000Z", "2026-11-02T07:30:00.000Z"],
  },
  {
    tz: "Pacific/Kiritimati", offsetJuly: -840,
    // Sunday 20:00Z is already Monday the 26th at UTC+14.
    monSun: "2026-10-26", sunSun: "2026-10-25", satSun: "2026-10-24",
    epDay: "2026-10-20",
    // 23:30Z on Nov 1 is Nov 2 here: past the window.
    inWindow: ["2026-10-20T03:30:00.000Z"],
  },
  {
    tz: "Pacific/Pago_Pago", offsetJuly: 660,
    monSun: "2026-10-19", sunSun: "2026-10-25", satSun: "2026-10-24",
    epDay: "2026-10-19",
    inWindow: ["2026-10-20T03:30:00.000Z", "2026-11-01T23:30:00.000Z", "2026-11-02T00:30:00.000Z", "2026-11-02T07:30:00.000Z"],
  },
  {
    tz: "Europe/London", offsetJuly: -60,
    monSun: "2026-10-19", sunSun: "2026-10-25", satSun: "2026-10-24",
    epDay: "2026-10-20",
    // After the clocks went back: 23:30Z on Nov 1 is 23:30 GMT, the last half hour of the window; 00:30Z is past it.
    inWindow: ["2026-10-20T03:30:00.000Z", "2026-11-01T23:30:00.000Z"],
  },
];

for (const z of ZONES) {
  test(`${z.tz}: weeks start on the chosen day, a movie's date lands on that date, and the window is 14 calendar days across DST`, () => {
    const got = inZone(z.tz);
    assert.equal(got.offsetJuly, z.offsetJuly, "the child really ran in this zone");
    // Wednesday the 21st (Thursday at UTC+14) is in the week starting Monday the 19th / Sunday the 18th.
    assert.equal(got.monWed, "2026-10-19");
    assert.equal(got.sunWed, "2026-10-18");
    assert.deepEqual([got.monSun, got.sunSun, got.satSun], [z.monSun, z.sunSun, z.satSun]);
    // Local midnights, fourteen calendar days apart, whatever DST did in between.
    assert.deepEqual([got.start, got.startHour], ["2026-10-19", 0]);
    assert.deepEqual([got.end, got.endHour, got.endMinute], ["2026-11-02", 0, 0]);
    assert.deepEqual([got.nextWeek, got.nextWeekHour], ["2026-10-26", 0]);
    assert.equal(got.lastDay, "2026-11-01");
    // The movie on the window's first day and the one on its LAST day are on
    // those dates; the day before and the day after (which the padded Radarr
    // read returns) are not shown.
    assert.deepEqual(got.placed, [["First", "2026-10-19"], ["Last", "2026-11-01"]]);
    // An episode airs at a real instant: its local day.
    assert.equal(got.epDay, z.epDay);
    assert.deepEqual(got.inWindow, z.inWindow);
    // Sonarr's read is padded 14 h either side, and what the padding brings back is not shown.
    assert.deepEqual(got.sonarrPadded, [14 * H, 14 * H]);
    assert.equal(got.padInWindow, 0);
  });
}

// A movie's status as of the viewer's day, at several instants around its
// date (Oct 15, stored as midnight UTC). Each `now` is fed to the server's
// builder AND to localEntryStatus, as the page sees one report.
const STATUS_CHILD = `
const d = await import(${JSON.stringify(DAYS_URL)});
const c = await import(${JSON.stringify(CAL_URL)});
const at = (now, movie, queue) => {
  const es = c.radarrCalendarEntries("", [{ id: 1, title: "M", monitored: true, hasFile: false, ...movie }],
    Date.parse("2026-10-01T00:00:00Z"), Date.parse("2026-11-01T00:00:00Z"), Date.parse(now));
  if (queue) c.applyCalendarQueue(es, c.calendarQueue("radarr", [{ id: 1, movieId: 1, size: 10, sizeleft: 5, status: "downloading" }]));
  return es.map((e) => [e.status, d.localEntryStatus(e, Date.parse(now))]);
};
const out = {};
for (const now of ["2026-10-14T16:00:00Z", "2026-10-15T00:30:00Z", "2026-10-15T07:30:00Z"]) {
  out[now] = {
    digital: at(now, { digitalRelease: "2026-10-15T00:00:00Z" }),
    cinema: at(now, { inCinemas: "2026-10-15T00:00:00Z" }),
    unmonitored: at(now, { digitalRelease: "2026-10-15T00:00:00Z", monitored: false }),
    downloading: at(now, { digitalRelease: "2026-10-15T00:00:00Z" }, true),
  };
}
out.offset = new Date("2026-10-15T00:00:00Z").getTimezoneOffset();
console.log(JSON.stringify(out));
`;

test("America/Los_Angeles: a movie dated tomorrow locally is upcoming, not missing, between midnight UTC and local midnight", () => {
  const got = inZone("America/Los_Angeles", STATUS_CHILD) as Record<string, Record<string, unknown>>;
  assert.equal(got.offset, 420, "the child really ran in this zone");
  // 17:30 PDT on the 14th: past midnight UTC of the 15th, but the row sits under the 15th.
  assert.deepEqual(got["2026-10-15T00:30:00Z"].digital, [["missing", "upcoming"]]);
  assert.deepEqual(got["2026-10-15T00:30:00Z"].cinema, [["released", "upcoming"]]);
  assert.deepEqual(got["2026-10-15T00:30:00Z"].unmonitored, [["unmonitored", "upcoming"]]);
  // 00:30 PDT on the 15th: its local day has begun.
  assert.deepEqual(got["2026-10-15T07:30:00Z"].digital, [["missing", "missing"]]);
  assert.deepEqual(got["2026-10-15T07:30:00Z"].cinema, [["released", "released"]]);
  // A download on its way is never re-labelled.
  assert.deepEqual(got["2026-10-15T00:30:00Z"].downloading, [["downloading", "downloading"]]);
  assert.deepEqual(got["2026-10-14T16:00:00Z"].digital, [["upcoming", "upcoming"]]);
});

test("Asia/Tokyo: a movie whose local day began before midnight UTC stays upcoming until midnight UTC (the search's rule)", () => {
  const got = inZone("Asia/Tokyo", STATUS_CHILD) as Record<string, Record<string, unknown>>;
  assert.equal(got.offset, -540, "the child really ran in this zone");
  // 01:00 JST on the 15th: the row is today's, but Radarr (and the search route) say it isn't out yet.
  assert.deepEqual(got["2026-10-14T16:00:00Z"].digital, [["upcoming", "upcoming"]]);
  assert.deepEqual(got["2026-10-15T00:30:00Z"].digital, [["missing", "missing"]]);
  assert.deepEqual(got["2026-10-15T00:30:00Z"].downloading, [["downloading", "downloading"]]);
});

// ── 3: rows ─────────────────────────────────────────────────────────────────

test("one row per title per day: a movie's dates on one day, and a title on two instances, fold together with a cell each", () => {
  const window = [Date.parse("2026-10-01T00:00:00Z"), Date.parse("2026-10-20T00:00:00Z")] as const;
  const hd = radarrCalendarEntries("", [
    { id: 11, tmdbId: 603, title: "The Matrix", monitored: true, hasFile: false, inCinemas: "2026-10-05T00:00:00Z", digitalRelease: "2026-10-05T00:00:00Z", physicalRelease: "2026-10-12T00:00:00Z" },
  ], ...window, NOW);
  const uhd = radarrCalendarEntries("4k", [
    // A different Radarr id for the same movie on the 4K instance.
    { id: 77, tmdbId: 603, title: "The Matrix", monitored: true, hasFile: true, digitalRelease: "2026-10-05T00:00:00Z" },
  ], ...window, NOW);
  const other = radarrCalendarEntries("", [
    { id: 12, tmdbId: 604, title: "The Matrix Reloaded", monitored: true, hasFile: false, digitalRelease: "2026-10-05T00:00:00Z" },
  ], ...window, NOW);
  const days = calendarDays([...hd, ...uhd, ...other]);
  assert.deepEqual(days.map((d) => [d.key, d.rows.map((r) => r.entry.title)]), [
    ["2026-10-05", ["The Matrix", "The Matrix Reloaded"]],
    ["2026-10-12", ["The Matrix"]],
  ]);
  const matrix = days[0].rows[0];
  assert.deepEqual(matrix.kinds, ["cinema", "digital"]);
  // One cell per instance: HD's digital date is missing (its cinema date only
  // "released") — the cell shows what can be acted on; 4K has the file.
  assert.deepEqual(matrix.cells.map((c) => [c.instance, c.arrId, c.status]), [["", 11, "missing"], ["4k", 77, "downloaded"]]);
  // The same movie on another day is the same search on that instance.
  assert.equal(days[1].rows[0].cells[0].key, matrix.cells[0].key);

  // Episodes fold across instances by the series' TVDB id and the numbers — not by the arr's own ids.
  const s1 = sonarrCalendarEntries("", [ep({ id: 5, seriesId: 9, airDateUtc: "2026-10-06T01:00:00Z" })], NOW);
  const s2 = sonarrCalendarEntries("anime", [ep({ id: 50, seriesId: 90, airDateUtc: "2026-10-06T01:00:00Z", hasFile: true })], NOW);
  const s3 = sonarrCalendarEntries("", [ep({ id: 6, seriesId: 9, episodeNumber: 3, airDateUtc: "2026-10-06T01:00:00Z" })], NOW);
  const epDays = calendarDays([...s1, ...s2, ...s3]);
  assert.deepEqual(epDays[0].rows.map((r) => [r.entry.episodeNumber, r.cells.map((c) => `${c.instance}:${c.episodeId}:${c.status}`)]), [
    [2, [":5:missing", "anime:50:downloaded"]],
    [3, [":6:missing"]],
  ]);
});

test("a cell needs attention when any of its instance's entries for the title that day does, in either order", () => {
  const window = [Date.parse("2026-10-01T00:00:00Z"), Date.parse("2026-10-20T00:00:00Z")] as const;
  const both = radarrCalendarEntries("", [
    { id: 11, tmdbId: 603, title: "M", monitored: true, hasFile: false, digitalRelease: "2026-10-05T00:00:00Z", physicalRelease: "2026-10-05T00:00:00Z" },
  ], ...window, NOW);
  assert.equal(both.length, 2);
  for (const flagged of [0, 1]) {
    const entries = both.map((e, i) => ({ ...e, status: "downloading" as const, progress: 1, attention: i === flagged }));
    const [cell] = calendarDays(entries)[0].rows[0].cells;
    assert.equal(cell.attention, true, `flag on entry ${flagged}`);
  }
  const clean = both.map((e) => ({ ...e, attention: false }));
  assert.equal(calendarDays(clean)[0].rows[0].cells[0].attention, false);
  // The flag rides with its own entry even when another status ranks first for the cell.
  const mixed = [{ ...both[0], status: "missing" as const, attention: false }, { ...both[1], status: "downloading" as const, attention: true }];
  const [m] = calendarDays(mixed)[0].rows[0].cells;
  assert.deepEqual([m.status, m.attention], ["missing", true]);
});

// ── 4: labels, filters, the URL ─────────────────────────────────────────────

test("a premiere is a regular season's first episode; S00E01 is none", () => {
  const e = (seasonNumber: number | null, episodeNumber: number | null) => ({ kind: "episode" as const, seasonNumber, episodeNumber });
  assert.equal(premiereOf(e(1, 1)), "series");
  assert.equal(premiereOf(e(3, 1)), "season");
  assert.equal(premiereOf(e(0, 1)), null);
  assert.equal(premiereOf(e(2, 2)), null);
  assert.equal(premiereOf(e(null, 1)), null);
  assert.equal(premiereOf({ kind: "digital", seasonNumber: null, episodeNumber: null }), null);
  assert.deepEqual(["series", "season", "midseason", "Midseason", "somethingNew", null].map((v) => finaleOf(v)), ["series", "season", "midseason", "midseason", "other", null]);
});

test("the status chips: Missing is only missing; Upcoming includes on the air; downloading is under All only", () => {
  const all = ["downloaded", "downloading", "missing", "airing", "aired", "unmonitored", "upcoming", "released"] as const;
  const pick = (f: "missing" | "upcoming" | "downloaded") => all.filter((s) => matchesStatusFilter(s, f));
  assert.deepEqual(pick("missing"), ["missing"]);
  assert.deepEqual(pick("upcoming"), ["airing", "upcoming"]);
  assert.deepEqual(pick("downloaded"), ["downloaded"]);
  assert.ok(all.every((s) => matchesStatusFilter(s, "all")));
});

test("the view in the URL: each value checked, defaults left out, a real date only", () => {
  const instances = ["radarr:", "sonarr:anime"];
  const v = parseCalendarView({ week: "2026-10-19", filter: "missing", type: "sonarr", instance: "sonarr:anime", unmonitored: "1" }, instances);
  assert.deepEqual(v, { week: "2026-10-19", filter: "missing", type: "sonarr", instance: "sonarr:anime", unmonitored: true });
  assert.equal(calendarViewQuery(v), "week=2026-10-19&filter=missing&type=sonarr&instance=sonarr%3Aanime&unmonitored=1");
  assert.deepEqual(
    parseCalendarView({ week: "2026-02-30", filter: "bogus", type: "lidarr", instance: "radarr:gone", unmonitored: "yes" }, instances),
    { week: null, filter: "all", type: "all", instance: "all", unmonitored: false },
  );
  assert.equal(calendarViewQuery(parseCalendarView({}, instances)), "");
  for (const bad of ["2026-13-01", "2026-1-01", "20261001", "1969-12-31", "", undefined, 20261001]) assert.equal(parseWeekParam(bad), null, String(bad));
  assert.equal(parseWeekParam("2028-02-29"), "2028-02-29");
});

test("a failed instance the filters include stops the page claiming nothing is on the calendar", () => {
  const errors = [{ service: "sonarr", instance: "anime" }];
  assert.equal(failedInView(errors, "sonarr:anime", "all"), true, "the instance filter on the failed instance");
  assert.equal(failedInView(errors, "sonarr:", "all"), false, "the instance filter on a healthy one");
  assert.equal(failedInView(errors, "radarr:", "all"), false, "another service's instance");
  assert.equal(failedInView(errors, "all", "all"), true, "everything, one failed");
  assert.equal(failedInView(errors, "all", "radarr"), false, "the type filter names only the healthy service");
  assert.equal(failedInView(errors, "all", "sonarr"), true, "the type filter names the failed service");
  assert.equal(failedInView(errors, "sonarr:anime", "radarr"), false, "both filters must admit it");
  assert.equal(failedInView([], "all", "all"), false);
});

test("the week's first day comes from the viewer's region, Monday when nothing answers", () => {
  assert.equal(firstDayOfWeek(["en-US"]), 7);
  assert.equal(firstDayOfWeek(["en-GB"]), 1);
  assert.equal(firstDayOfWeek(["en-US-u-fw-mon"]), 1, "an explicit first-day extension is honoured");
  assert.equal(firstDayOfWeek(["not a tag!!", null, "", "en-US"]), 7, "the first tag that answers");
  assert.equal(firstDayOfWeek([]), 1);
  assert.equal(firstDayOfWeek(["not a tag!!"]), 1);
  // A runtime with neither getWeekInfo() nor weekInfo (Firefox).
  const proto = Intl.Locale.prototype as unknown as Record<string, unknown>;
  const saved = { get: Object.getOwnPropertyDescriptor(proto, "getWeekInfo"), info: Object.getOwnPropertyDescriptor(proto, "weekInfo") };
  try {
    Object.defineProperty(proto, "getWeekInfo", { value: undefined, configurable: true, writable: true });
    Object.defineProperty(proto, "weekInfo", { value: undefined, configurable: true, writable: true });
    assert.equal(firstDayOfWeek(["en-US"]), 1);
  } finally {
    if (saved.get) Object.defineProperty(proto, "getWeekInfo", saved.get);
    else delete proto.getWeekInfo;
    if (saved.info) Object.defineProperty(proto, "weekInfo", saved.info);
    else delete proto.weekInfo;
  }
  assert.equal(firstDayOfWeek(["en-US"]), 7, "restored");
});

// ── 5: the page's wiring ────────────────────────────────────────────────────

const PAGE_SRC = readFileSync(new URL("../src/app/(app)/admin/arr-calendar/page.tsx", import.meta.url), "utf8");
const CAL_SRC = readFileSync(new URL("../src/components/admin/arr-calendar.tsx", import.meta.url), "utf8");

test("the page keys the calendar on each server render's `today`, so a query-only navigation starts from the URL's view", () => {
  // Next keeps a page's client state across a search-param navigation; an unkeyed
  // calendar kept its old week and filters while the URL changed.
  assert.match(PAGE_SRC, /const today = new Date\(\)\.toISOString\(\);/);
  assert.match(PAGE_SRC, /<ArrCalendar key=\{today\} [^>]*today=\{today\}/);
  assert.doesNotMatch(PAGE_SRC, /today=\{new Date\(\)/, "the key and the prop are the same instant");
});

test("a fresh report keeps an in-flight search busy instead of re-enabling its Search", () => {
  assert.doesNotMatch(CAL_SRC, /setSearches\(\{\}\)/);
  assert.match(CAL_SRC, /setSearches\(\(s\) => Object\.fromEntries\(Object\.entries\(s\)\.filter\(\(\[, v\]\) => v\.phase === "busy"\)\)\)/);
});

test("the window follows the server's clock until the admin picks a week; Today follows it again", () => {
  assert.match(CAL_SRC, /const followToday = useRef\(initialView\.week === null\);/);
  // load() re-anchors on the report's own clock before storing it.
  assert.match(CAL_SRC, /const current = weekStart\(Date\.parse\(data\.now\), firstDayRef\.current\);\s*if \(followToday\.current && Number\.isFinite\(current\) && current !== from\) \{\s*\/\/[^\n]*\n\s*setStart\(current\);\s*return;/);
  // Previous and Next pin a week; Today follows again.
  assert.equal([...CAL_SRC.matchAll(/followToday\.current = false;\s*setStart\(addDays\(start, (-7|7)\)\);/g)].length, 2);
  assert.match(CAL_SRC, /followToday\.current = true;\s*setStart\(weekStart\(todayMs, firstDay\)\);/);
});

test("statuses are the viewer's day's, an empty view with a failed instance makes no claim, and attention links the queue", () => {
  assert.match(CAL_SRC, /\.map\(\(e\) => \(\{ \.\.\.e, status: localEntryStatus\(e, nowMs\) \}\)\)/);
  assert.match(CAL_SRC, /const nowMs = Date\.parse\(report\.now\);/, "the report's clock, never Date.now() (guardrail 16)");
  assert.match(CAL_SRC, /const viewFailed = report !== null && failedInView\(report\.errors, instanceFilter, typeFilter\);/);
  assert.match(CAL_SRC, /\) : viewFailed \? null : \(\s*<EmptyState\s+icon=\{CalendarDays\}\s+title=\{t\("adminArr\.calendar\.empty"\)\}/);
  assert.match(CAL_SRC, /t\(unmonitored \? "adminArr\.calendar\.emptyHintAll" : "adminArr\.calendar\.emptyHint"\)/);
  assert.match(CAL_SRC, /\{c\.attention && \(\s*<Link\s+href=\{queueTitleHref\(\{ service: c\.service, instance: c\.instance, arrId: c\.arrId \}\)\}/);
});
