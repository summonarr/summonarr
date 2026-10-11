// Unit tests for the Library cleanup table's filters and sorts
// (src/lib/library-cleanup-view.ts) — pure, no DB, no network. The view decides
// which titles an admin sees (and can tick for deletion), so each filter is
// pinned on its own, every sort on its null handling, and the URL round-trip on
// its whitelist.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  CLEANUP_VIEW_DEFAULTS,
  cleanupFiltersActive,
  filterCleanupRows,
  parseCleanupView,
  serializeCleanupView,
  sortCleanupRows,
  type CleanupViewRow,
  type CleanupViewState,
} from "../src/lib/library-cleanup-view.ts";

const GB = 1024 ** 3;
const row = (tmdbId: number, over: Partial<CleanupViewRow> = {}): CleanupViewRow => ({
  tmdbId, mediaType: "MOVIE", title: `Title ${tmdbId}`, servers: ["plex"],
  arr: [{ service: "radarr", instance: "" }], sizeOnDisk: 5 * GB,
  addedAt: "2025-01-01T00:00:00.000Z", lastPlayedAt: null, playCount: 0, votes: 0, idleDays: 100,
  matched: ["neverWatched"], excludedBy: [], candidate: true, ...over,
});
const view = (over: Partial<CleanupViewState> = {}): CleanupViewState => ({ ...CLEANUP_VIEW_DEFAULTS, view: "all", ...over });
const ids = (rows: CleanupViewRow[]) => rows.map((r) => r.tmdbId);

// ── filters ─────────────────────────────────────────────────────────────────

test("view: candidates / held / all", () => {
  const rows = [row(1), row(2, { candidate: false, excludedBy: ["protected"] })];
  assert.deepEqual(ids(filterCleanupRows(rows, view({ view: "candidates" }))), [1]);
  assert.deepEqual(ids(filterCleanupRows(rows, view({ view: "held" }))), [2]);
  assert.deepEqual(ids(filterCleanupRows(rows, view())), [1, 2]);
});

test("deletable: a candidate with something to delete — not a candidate Radarr/Sonarr doesn't manage", () => {
  const rows = [row(1), row(2, { arr: [] }), row(3, { candidate: false })];
  assert.deepEqual(ids(filterCleanupRows(rows, view({ deletable: true }))), [1]);
});

test("held back by: one exclusion, or nothing at all", () => {
  const rows = [row(1), row(2, { candidate: false, excludedBy: ["airing", "watchlisted"] }), row(3, { candidate: false, excludedBy: ["protected"] })];
  assert.deepEqual(ids(filterCleanupRows(rows, view({ excl: "watchlisted" }))), [2]);
  assert.deepEqual(ids(filterCleanupRows(rows, view({ excl: "none" }))), [1]);
});

test("media server and Radarr/Sonarr instance, including 'in none'", () => {
  const rows = [
    row(1, { servers: ["plex"], arr: [{ service: "radarr", instance: "" }] }),
    row(2, { servers: ["jellyfin", "plex:remote"], arr: [{ service: "radarr", instance: "4k" }] }),
    row(3, { servers: ["jellyfin"], arr: [] }),
  ];
  assert.deepEqual(ids(filterCleanupRows(rows, view({ server: "plex:remote" }))), [2]);
  assert.deepEqual(ids(filterCleanupRows(rows, view({ server: "jellyfin" }))), [2, 3]);
  assert.deepEqual(ids(filterCleanupRows(rows, view({ arr: "radarr:4k" }))), [2]);
  assert.deepEqual(ids(filterCleanupRows(rows, view({ arr: "radarr:" }))), [1], "the default instance is its own key, not a prefix of 4k");
  assert.deepEqual(ids(filterCleanupRows(rows, view({ arr: "none" }))), [3]);
});

test("size: at-least thresholds never include an unknown size; 'unknown' is only those", () => {
  const rows = [row(1, { sizeOnDisk: 0.5 * GB }), row(2, { sizeOnDisk: 10 * GB }), row(3, { sizeOnDisk: null })];
  assert.deepEqual(ids(filterCleanupRows(rows, view({ size: "1g" }))), [2]);
  assert.deepEqual(ids(filterCleanupRows(rows, view({ size: "10g" }))), [2], "exactly 10 GB is at least 10 GB");
  assert.deepEqual(ids(filterCleanupRows(rows, view({ size: "50g" }))), []);
  assert.deepEqual(ids(filterCleanupRows(rows, view({ size: "unknown" }))), [3]);
});

test("type, rule and title search compose with everything else", () => {
  const rows = [
    row(1, { mediaType: "TV", title: "Show Alpha", matched: ["votes"] }),
    row(2, { mediaType: "TV", title: "Show Beta", matched: ["unwatched"] }),
    row(3, { title: "Alpha Movie", matched: ["votes"] }),
  ];
  assert.deepEqual(ids(filterCleanupRows(rows, view({ type: "TV", rule: "votes" }))), [1]);
  assert.deepEqual(ids(filterCleanupRows(rows, view({ q: "  alpha " }))), [1, 3]);
});

// ── sorts ───────────────────────────────────────────────────────────────────

test("size sorts both ways with unknown sizes LAST either way", () => {
  const rows = [row(1, { sizeOnDisk: 2 * GB }), row(2, { sizeOnDisk: null }), row(3, { sizeOnDisk: 9 * GB })];
  assert.deepEqual(ids(sortCleanupRows(rows, "size", "desc")), [3, 1, 2]);
  assert.deepEqual(ids(sortCleanupRows(rows, "size", "asc")), [1, 3, 2]);
});

test("last played: never played is the OLDEST — first oldest-first, last most-recent-first", () => {
  const rows = [
    row(1, { lastPlayedAt: "2026-01-01T00:00:00.000Z" }),
    row(2, { lastPlayedAt: null }),
    row(3, { lastPlayedAt: "2025-01-01T00:00:00.000Z" }),
  ];
  assert.deepEqual(ids(sortCleanupRows(rows, "lastPlayed", "asc")), [2, 3, 1]);
  assert.deepEqual(ids(sortCleanupRows(rows, "lastPlayed", "desc")), [1, 3, 2]);
});

test("idle, added, plays, votes and title each sort on their own field; ties break by title", () => {
  const rows = [
    row(1, { title: "B", idleDays: 10, addedAt: "2025-03-01T00:00:00.000Z", playCount: 4, votes: 1 }),
    row(2, { title: "A", idleDays: 300, addedAt: null, playCount: 1, votes: 7 }),
    row(3, { title: "C", idleDays: null, addedAt: "2024-01-01T00:00:00.000Z", playCount: 4, votes: 2 }),
  ];
  assert.deepEqual(ids(sortCleanupRows(rows, "idle", "desc")), [2, 1, 3]);
  assert.deepEqual(ids(sortCleanupRows(rows, "added", "asc")), [3, 1, 2], "an unknown added date sorts last");
  assert.deepEqual(ids(sortCleanupRows(rows, "plays", "desc")), [1, 3, 2], "4 plays tie → title B before C");
  assert.deepEqual(ids(sortCleanupRows(rows, "votes", "desc")), [2, 3, 1]);
  assert.deepEqual(ids(sortCleanupRows(rows, "title", "asc")), [2, 1, 3]);
  assert.deepEqual(ids(sortCleanupRows(rows, "title", "desc")), [3, 1, 2]);
});

test("sorting never reorders the caller's array", () => {
  const rows = [row(1, { sizeOnDisk: 1 }), row(2, { sizeOnDisk: 2 })];
  sortCleanupRows(rows, "size", "desc");
  assert.deepEqual(ids(rows), [1, 2]);
});

// ── URL round-trip ──────────────────────────────────────────────────────────

test("the defaults serialize to an empty query and parse back to the defaults", () => {
  assert.equal(serializeCleanupView(CLEANUP_VIEW_DEFAULTS), "");
  assert.deepEqual(parseCleanupView(new URLSearchParams("")), CLEANUP_VIEW_DEFAULTS);
  assert.equal(cleanupFiltersActive(CLEANUP_VIEW_DEFAULTS), false);
});

test("a full state round-trips through the URL", () => {
  const s: CleanupViewState = {
    view: "held", type: "TV", rule: "unwatched", excl: "airing", server: "jellyfin:remote", arr: "sonarr:anime",
    size: "50g", deletable: true, q: "foo", sort: "lastPlayed", dir: "asc",
  };
  assert.deepEqual(parseCleanupView(new URLSearchParams(serializeCleanupView(s))), s);
  assert.equal(cleanupFiltersActive(s), true);
});

test("every parameter is whitelisted: junk falls back to the default", () => {
  const s = parseCleanupView(new URLSearchParams(
    "view=x&type=movie&rule=y&excl=z&server=<script>&arr=" + "a".repeat(200) + "&size=7g&deletable=yes&sort=size;drop&dir=up",
  ));
  assert.deepEqual(s, CLEANUP_VIEW_DEFAULTS);
  assert.equal(parseCleanupView(new URLSearchParams("sort=title")).dir, "asc", "title defaults to A→Z");
  assert.equal(parseCleanupView(new URLSearchParams(`q=${"x".repeat(500)}`)).q.length, 200);
});
