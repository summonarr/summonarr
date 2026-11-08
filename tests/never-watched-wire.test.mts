// The Never watched page's check of the report it reads
// (src/components/admin/never-watched-wire.ts). The row schemas are pinned to
// NwTitleRow / NwSeasonRow at the type level in the module itself; these pin
// the runtime side: a real-shaped page passes, a malformed one is a failed
// load instead of a render that throws.
import { test } from "node:test";
import assert from "node:assert/strict";
import type { NwSeasonRow, NwTitleRow } from "../src/lib/never-watched-report.ts";

const { NwPageWire, NwCheckResultWire } = await import("../src/components/admin/never-watched-wire.ts");
const { check } = await import("../src/lib/validate.ts");

const titleRow: NwTitleRow = {
  kind: "title", tmdbId: 1, mediaType: "MOVIE", title: "A", posterPath: null, year: "2020", servers: ["plex"],
  addedAt: "2024-01-01T00:00:00.000Z", shelfStart: null, state: "neverWatched", reason: null, reasonServers: [],
  windowStart: "2024-01-01T00:00:00.000Z", days: 300, fullyObserved: true, softPlays: 0, softServers: [],
  arr: [{ service: "radarr", instance: "", sizeOnDisk: 5 }], sizeOnDisk: 5, protected: false,
  cleanup: { matched: ["neverWatched"], excludedBy: ["upstreamUnchecked"], candidate: true }, eligible: false,
};
const seasonRow: NwSeasonRow = {
  kind: "season", tmdbId: 2, mediaType: "TV", title: "B", posterPath: "/p.jpg", year: null, servers: ["jellyfin"],
  seasonNumber: 3, episodes: 10, state: "unobservable", reason: "noHistory", reasonServers: ["jellyfin"],
  windowStart: null, days: null, fullyObserved: false, airing: true, sizeOnDisk: null, sizeMismatch: false,
};
const page = {
  totals: { never: { titles: 1, bytes: 5, unsized: 0 }, seasons: { count: 1, bytes: 0 }, eligible: { titles: 0, bytes: 0 }, possible: 0, unknown: 1, libraryTitles: 9 },
  coverage: [{
    server: "plex", source: "plex", tracked: true, since: null, holds: true,
    upstream: { health: "failed", fetchedAt: null, attemptedAt: null, entries: 0, matched: 0, samples: 0, agreed: 0, error: "x", errorCode: "http", httpStatus: 502 },
  }],
  trackingOn: true, historyStart: "2024-01-01T00:00:00.000Z", unplacedPlays: 0, softPlays: 0,
  arrErrors: [{ service: "sonarr", instance: "4k", error: "boom", kind: "timeout" }],
  sizesAsOf: null, cleanupEnabled: true, neverWatchedDays: 365, requireUpstreamCheck: true, computedAt: "2024-01-01T00:00:00.000Z",
  query: { level: "title" }, rows: [titleRow, seasonRow], total: 2,
};

test("a page the route sends passes, with each row as its own kind", () => {
  const parsed = check(NwPageWire, page);
  assert.ok(parsed.ok, parsed.ok ? "" : parsed.error);
  assert.deepEqual(parsed.value.rows, [titleRow, seasonRow], "every row field survives the check");
  assert.equal(parsed.value.coverage[0].upstream.httpStatus, 502);
});

test("a malformed page is refused instead of rendered", () => {
  assert.equal(check(NwPageWire, { ...page, totals: undefined }).ok, false);
  assert.equal(check(NwPageWire, { ...page, coverage: null }).ok, false);
  assert.equal(check(NwPageWire, { ...page, rows: [{ ...titleRow, cleanup: undefined }] }).ok, false, "a title row with no cleanup verdict");
  assert.equal(check(NwPageWire, { ...page, rows: [{ ...titleRow, state: "gone" }] }).ok, false, "a state the page has no label for");
  assert.equal(check(NwPageWire, "<html>").ok, false);
});

test("Check now's result: the servers' reads, or nothing", () => {
  assert.ok(check(NwCheckResultWire, { servers: [{ ok: true, health: "ok", name: "plex" }] }).ok);
  assert.ok(check(NwCheckResultWire, {}).ok);
  assert.equal(check(NwCheckResultWire, { servers: [{ ok: "yes", health: "ok" }] }).ok, false);
});
