// The admin History table's state rules (src/components/admin/activity-history/
// helpers.ts) and the shape it checks /api/play-history's answers against
// (./schema.ts): the reducer that pages back to 1 in the same update as a
// filter change, the URL copy of the table's state that lets its filters
// survive a period change, the inverted-range guard, and the delete outcome.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  applyHistoryUrlEntries,
  beginLoad,
  buildHistoryFilterParams,
  dayEndsBefore,
  dateRangeInverted,
  deleteOutcome,
  EMPTY_HISTORY_FILTERS,
  hasActiveFilter,
  historyQueryReducer,
  historyUrlEntries,
  initialHistoryQuery,
  mediaTypeLabel,
  NEW_LOAD_TRACKER,
  playProgressPct,
  settleLoad,
} from "../src/components/admin/activity-history/helpers.ts";
import { historyPageSchema, userOptionsSchema } from "../src/components/admin/activity-history/schema.ts";
import { check } from "../src/lib/validate.ts";
import { shapeGroupedRow, shapeUngroupedRow } from "../src/lib/play-history-list.ts";
import type { HistoryQuery } from "../src/components/admin/activity-history/types.ts";

const base: HistoryQuery = {
  filters: EMPTY_HISTORY_FILTERS,
  grouped: true,
  sortBy: "startedAt",
  sortDir: "desc",
  limit: 25,
  page: 4,
};

test("every filter, grouping, sort and page-size change goes back to page 1 in the same update", () => {
  const changes = [
    { type: "filter", patch: { search: "matrix" } },
    { type: "filter", patch: { platform: "Roku" } },
    { type: "filter", patch: { fromDate: "2026-10-01" } },
    { type: "grouped", grouped: false },
    { type: "sort", field: "title" },
    { type: "limit", limit: 50 },
  ] as const;
  for (const action of changes) {
    const next = historyQueryReducer(base, action);
    assert.equal(next.page, 1, `${action.type} pages back to 1`);
    assert.notEqual(next, base);
  }
  assert.equal(historyQueryReducer({ ...base, filters: { ...EMPTY_HISTORY_FILTERS, userId: "u1" } }, { type: "clearFilters" }).page, 1);
});

test("a change to the value already set returns the same state, so nothing refetches", () => {
  assert.equal(historyQueryReducer(base, { type: "filter", patch: { search: "" } }), base);
  assert.equal(historyQueryReducer(base, { type: "grouped", grouped: true }), base);
  assert.equal(historyQueryReducer(base, { type: "limit", limit: 25 }), base);
  assert.equal(historyQueryReducer(base, { type: "clearFilters" }), base);
  assert.equal(historyQueryReducer(base, { type: "page", page: 4 }), base);
});

test("a page change keeps the filters and only moves the page", () => {
  const next = historyQueryReducer(base, { type: "page", page: 7 });
  assert.equal(next.page, 7);
  assert.equal(next.filters, base.filters);
  assert.equal(historyQueryReducer(base, { type: "page", page: 0 }).page, 1, "never below page 1");
});

test("sorting the same column flips it; a new column starts newest-first for the date, ascending otherwise", () => {
  const flipped = historyQueryReducer(base, { type: "sort", field: "startedAt" });
  assert.equal(flipped.sortDir, "asc");
  const byTitle = historyQueryReducer(flipped, { type: "sort", field: "title" });
  assert.deepEqual([byTitle.sortBy, byTitle.sortDir], ["title", "asc"]);
  const backToDate = historyQueryReducer(byTitle, { type: "sort", field: "startedAt" });
  assert.deepEqual([backToDate.sortBy, backToDate.sortDir], ["startedAt", "desc"]);
});

// The period/source/type selector copies the whole query string into its
// push, and the page remounts the table on those filters: whatever the table
// writes to the URL comes back on the remount.
test("the table's filters, sort and page size round-trip through the URL; defaults leave it bare", () => {
  const q: HistoryQuery = {
    filters: { search: "neo", watched: "false", method: "Transcode", platform: "Roku", userId: "msu_1", fromDate: "2026-10-01", toDate: "2026-10-31" },
    grouped: false,
    sortBy: "title",
    sortDir: "asc",
    limit: 100,
    page: 3,
  };
  const url = new URL("https://example.test/admin/activity/history?days=45&source=plex");
  assert.equal(applyHistoryUrlEntries(url, historyUrlEntries(q)), true);
  assert.equal(url.searchParams.get("days"), "45", "the period selector's own keys are left alone");
  assert.equal(url.searchParams.get("source"), "plex");
  const back = initialHistoryQuery(
    { fromDate: url.searchParams.get("from") ?? undefined, toDate: url.searchParams.get("to") ?? undefined, watched: "false" },
    url.searchParams,
  );
  assert.deepEqual(back, { ...q, page: 1 }, "everything but the page comes back");
  assert.equal(applyHistoryUrlEntries(url, historyUrlEntries(q)), false, "an unchanged state writes nothing");

  const cleared = new URL(url);
  applyHistoryUrlEntries(cleared, historyUrlEntries(base));
  assert.equal(cleared.search, "?days=45&source=plex", "defaults remove their keys");
});

test("a malformed URL value is dropped, never trusted", () => {
  const params = new URLSearchParams({
    sortBy: "password",
    sortDir: "sideways",
    limit: "9999",
    playMethod: "Teleport",
    ungrouped: "yes",
    search: "x".repeat(501),
  });
  const q = initialHistoryQuery({}, params);
  assert.equal(q.sortBy, "startedAt");
  assert.equal(q.sortDir, "desc");
  assert.equal(q.limit, 25);
  assert.equal(q.filters.method, "");
  assert.equal(q.grouped, true);
  assert.equal(q.filters.search, "");
  assert.equal(initialHistoryQuery({}, new URLSearchParams("limit=50")).limit, 50);
});

test("an inverted day range is caught; one bound alone or a malformed day is not", () => {
  assert.equal(dateRangeInverted("2026-10-31", "2026-10-01"), true);
  assert.equal(dateRangeInverted("2026-10-01", "2026-10-31"), false);
  assert.equal(dateRangeInverted("2026-10-01", "2026-10-01"), false, "one day is a range");
  assert.equal(dateRangeInverted("2026-10-31", ""), false);
  assert.equal(dateRangeInverted("2026-02-30", "2026-01-01"), false, "an impossible day is dropped, not compared");
});

test("the request carries the filters under the API's names, the day range as fromDay/toDay", () => {
  const params = buildHistoryFilterParams({
    globalSource: "plex",
    startDateIso: "2026-09-01T00:00:00.000Z",
    filters: { ...EMPTY_HISTORY_FILTERS, search: "neo", method: "DirectPlay", userId: "u1", toDate: "2026-10-31" },
    sortBy: "duration",
    sortDir: "asc",
    grouped: false,
  });
  assert.equal(
    params.toString(),
    "source=plex&startDate=2026-09-01T00%3A00%3A00.000Z&toDay=2026-10-31&search=neo&playMethod=DirectPlay&userId=u1&sortBy=duration&sortDir=asc&ungrouped=true",
  );
  const fromDay = buildHistoryFilterParams({ startDateIso: "x", filters: { ...EMPTY_HISTORY_FILTERS, fromDate: "2026-10-01" }, sortBy: "startedAt", sortDir: "desc", grouped: true });
  assert.equal(fromDay.get("fromDay"), "2026-10-01");
  assert.equal(fromDay.has("startDate"), false, "a From day replaces the period's lower bound");
});

test("a To day that ends before the period begins drops the period's lower bound", () => {
  const base = { filters: { ...EMPTY_HISTORY_FILTERS }, sortBy: "startedAt", sortDir: "desc", grouped: true } as const;
  const build = (toDate: string) =>
    buildHistoryFilterParams({ ...base, startDateIso: "2026-10-10T00:30:00.000Z", filters: { ...EMPTY_HISTORY_FILTERS, toDate } });
  const before = build("2026-07-01");
  assert.equal(before.has("startDate"), false, "the 30-day period can't overlap a day three months back");
  assert.equal(before.get("toDay"), "2026-07-01");
  assert.equal(build("2026-10-20").get("startDate"), "2026-10-10T00:30:00.000Z", "a To day inside the period keeps it");
  // The day before the bound may still overlap it in a zone west of UTC.
  assert.equal(build("2026-10-09").has("startDate"), true);
  assert.equal(build("2026-10-08").has("startDate"), false);
  assert.equal(dayEndsBefore("2026-02-31x", "2026-10-10T00:00:00Z"), false, "an unreadable day keeps the bound");
});

test("a live refresh re-reads in the background; a load the admin asked for, or one still owed an answer, is foreground", () => {
  const first = beginLoad(NEW_LOAD_TRACKER, "page=1|0");
  assert.equal(first.background, false, "the first load");
  const landed = settleLoad(first.tracker);
  assert.equal(beginLoad(landed, "page=1|0").background, true, "same request again (a new startDate only): background");
  assert.equal(beginLoad(landed, "page=2|0").background, false, "a page change");
  assert.equal(beginLoad(landed, "page=1|1").background, false, "a Retry or delete reload");
  // A refresh arriving while a page change is still loading carries the dimmed
  // rows on to an answer instead of leaving them dimmed for good.
  const inFlight = beginLoad(landed, "page=2|0").tracker;
  const refreshed = beginLoad(inFlight, "page=2|0");
  assert.equal(refreshed.background, false);
  assert.equal(beginLoad(settleLoad(refreshed.tracker), "page=2|0").background, true);
  assert.equal(settleLoad(landed), landed, "settling a settled tracker changes nothing");
});

test("a typed search shows Clear before the debounce commits it", () => {
  assert.equal(hasActiveFilter(EMPTY_HISTORY_FILTERS, ""), false);
  assert.equal(hasActiveFilter(EMPTY_HISTORY_FILTERS, "ne"), true);
  assert.equal(hasActiveFilter({ ...EMPTY_HISTORY_FILTERS, platform: "Roku" }, ""), true);
});

test("progress is clamped to 100 and an unknown length falls back", () => {
  assert.equal(playProgressPct(50, 100), 50);
  assert.equal(playProgressPct(300, 100), 100, "a chain's summed play time can pass the title's length");
  assert.equal(playProgressPct(30, 0), 0);
  assert.equal(playProgressPct(30, 0, 100), 100);
});

test("the media type is shown in the viewer's language, never as the raw enum", () => {
  const t = (key: string) => `<${key}>`;
  assert.equal(mediaTypeLabel(t, "MOVIE"), "<adminActivity.common.movie>");
  assert.equal(mediaTypeLabel(t, "TV"), "<adminActivity.filter.tv>");
  assert.equal(mediaTypeLabel(t, null), "");
});

test("a delete's answer: a 404 is done (already gone), a refusal shows the route's own reason, a drop does nothing", () => {
  const fail = (kind: "http" | "network" | "aborted", status: number, error: string) =>
    ({ ok: false, kind, status, error, body: null, detail: "" }) as const;
  assert.deepEqual(deleteOutcome({ ok: true, status: 204, data: null }), { kind: "done" });
  assert.deepEqual(deleteOutcome(fail("http", 404, "Not found")), { kind: "done" });
  assert.deepEqual(deleteOutcome(fail("http", 429, "Slow down — try again shortly.")), { kind: "error", message: "Slow down — try again shortly." });
  assert.deepEqual(deleteOutcome(fail("network", 0, "Couldn't delete")), { kind: "error", message: "Couldn't delete" });
  assert.deepEqual(deleteOutcome(fail("aborted", 0, "")), { kind: "ignore" });
});

// The schema the table checks must accept what the route actually answers, in
// both modes — including the grouped path's null user — after the JSON trip.
const RAW_PLAY = {
  id: "ph1", source: "plex", serverInstance: "", startedAt: new Date("2026-11-01T20:00:00Z"), stoppedAt: new Date("2026-11-01T22:00:00Z"),
  duration: 7200, playDuration: 7000, pausedDuration: 200, watched: true, completed: true, mediaServerUserId: "msu1",
  tmdbId: 603, mediaType: "MOVIE", title: "The Matrix", year: "1999", posterPath: null, seasonNumber: null, episodeNumber: null,
  episodeTitle: null, sourceSessionId: "s", sourceItemId: "i", sourceShowId: null, platform: "Chrome", player: "Plex Web",
  device: "Mac", ipAddress: "10.0.0.5", playMethod: "DirectPlay", videoCodec: "h264", audioCodec: "aac", resolution: "1080p",
  bitrate: 8000, videoDecision: "directplay", audioDecision: "directplay", container: "mkv", transcodeReason: null,
  location: "lan", bandwidth: 9000, secure: true, relayed: false, introStartMs: null, introEndMs: null, creditsStartMs: null,
  creditsEndMs: null, referenceId: null,
};

test("the table's row schema accepts both of the route's row shapes, the grouped null user included", () => {
  const ungrouped = shapeUngroupedRow(
    { ...RAW_PLAY, msu_username: "alice", msu_source: "plex", msu_thumb_url: null, msu_user_id: "u1", msu_user_name: null } as never,
    {},
  );
  const grouped = shapeGroupedRow(
    {
      ...RAW_PLAY, chain_id: "ph1", rn: 1, segment_count: 3, total_play_duration: 9000, total_paused_duration: 300,
      first_started_at: new Date("2026-10-30T20:00:00Z"), last_stopped_at: new Date("2026-11-01T22:00:00Z"),
      chain_watched: true, chain_completed: false, msu_username: null, msu_source: null, msu_thumb_url: null,
    } as never,
    {},
  );
  const page = JSON.parse(JSON.stringify({ items: [ungrouped, grouped], total: 2, page: 1, limit: 25, totalPages: 1 }));
  const parsed = check(historyPageSchema, page);
  assert.ok(parsed.ok, parsed.ok ? "" : parsed.error);
  assert.equal(parsed.value.items[0].mediaServerUser?.username, "alice");
  assert.equal(parsed.value.items[1].mediaServerUser, null);
  assert.equal(parsed.value.items[1].segmentCount, 3);
  assert.equal("transcodeReason" in parsed.value.items[0], false, "undeclared fields are dropped");
});

test("a malformed page is refused with the path that broke, not trusted", () => {
  const bad = check(historyPageSchema, { items: [{ id: 1 }], total: 1, totalPages: 1 });
  assert.equal(bad.ok, false);
  assert.match(bad.ok ? "" : bad.error, /^items\[0\]\.id: expected string/);
  assert.equal(check(historyPageSchema, { error: "Too many requests" }).ok, false);
  assert.equal(check(userOptionsSchema, [{ id: "u", username: "a", source: "plex" }]).ok, true, "serverInstance is optional");
});
