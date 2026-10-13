// The cleanup selection cap (C062). The delete route takes at most
// CLEANUP_MAX_ITEMS titles, and Library cleanup's select-all used to tick every
// visible candidate — over 500 the dry run could only answer 400. One constant
// (src/lib/library-cleanup.ts) now bounds the route's parser and the page's
// selection; the pure helpers are tested directly and the wiring in the .tsx
// page and the route by a structural scan.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  CLEANUP_MAX_ITEMS,
  cleanupSelectAllOn,
  parseCleanupItems,
  toggleAllCleanupSelection,
  toggleCleanupSelection,
} from "../src/lib/library-cleanup.ts";

const items = (n: number) => Array.from({ length: n }, (_, i) => ({ tmdbId: i + 1, mediaType: "MOVIE" as const }));
const keys = (n: number, from = 1) => Array.from({ length: n }, (_, i) => `MOVIE:${i + from}`);

test("the route's parser takes exactly CLEANUP_MAX_ITEMS titles and refuses one more", () => {
  assert.equal(CLEANUP_MAX_ITEMS, 500);
  assert.equal(parseCleanupItems(items(CLEANUP_MAX_ITEMS))?.length, CLEANUP_MAX_ITEMS);
  assert.equal(parseCleanupItems(items(CLEANUP_MAX_ITEMS + 1)), null);
  assert.equal(parseCleanupItems([]), null);
  assert.equal(parseCleanupItems("x"), null);
});

test("the parser keeps the old item rules: positive integer ids, MOVIE|TV, duplicates dropped", () => {
  assert.deepEqual(parseCleanupItems([{ tmdbId: 1, mediaType: "TV" }, { tmdbId: 1, mediaType: "TV" }, { tmdbId: 1, mediaType: "MOVIE" }]), [
    { tmdbId: 1, mediaType: "TV" },
    { tmdbId: 1, mediaType: "MOVIE" },
  ]);
  assert.equal(parseCleanupItems([{ tmdbId: 0, mediaType: "TV" }]), null);
  assert.equal(parseCleanupItems([{ tmdbId: 1.5, mediaType: "TV" }]), null);
  assert.equal(parseCleanupItems([{ tmdbId: 1, mediaType: "tv" }]), null);
  assert.equal(parseCleanupItems([null]), null);
  assert.deepEqual(parseCleanupItems([{ tmdbId: 7, mediaType: "MOVIE", extra: true }]), [{ tmdbId: 7, mediaType: "MOVIE" }], "only the keys go through");
});

test("select-all over a view larger than the cap ticks the first CLEANUP_MAX_ITEMS in order", () => {
  const view = keys(CLEANUP_MAX_ITEMS + 200);
  const next = toggleAllCleanupSelection(new Set(), view);
  assert.equal(next.size, CLEANUP_MAX_ITEMS);
  assert.ok(next.has(view[0]) && next.has(view[CLEANUP_MAX_ITEMS - 1]) && !next.has(view[CLEANUP_MAX_ITEMS]));
});

test("select-all counts titles already selected elsewhere (another filter) against the cap", () => {
  const prev = new Set(keys(450, 10_000));
  const next = toggleAllCleanupSelection(prev, keys(100));
  assert.equal(next.size, CLEANUP_MAX_ITEMS);
  assert.ok([...prev].every((k) => next.has(k)), "nothing already chosen is dropped");
});

test("a full selection shows select-all as on, so the next click clears the view instead of doing nothing", () => {
  const view = keys(CLEANUP_MAX_ITEMS + 10);
  const full = toggleAllCleanupSelection(new Set(), view);
  assert.equal(cleanupSelectAllOn(full, view), true);
  assert.equal(toggleAllCleanupSelection(full, view).size, 0);
  assert.equal(cleanupSelectAllOn(new Set(["MOVIE:1"]), keys(3)), false, "a partial selection under the cap is not 'on'");
  assert.equal(cleanupSelectAllOn(new Set(keys(3)), keys(3)), true);
  assert.equal(cleanupSelectAllOn(new Set(), []), false);
});

test("a single tick past the cap is ignored; unticking always works", () => {
  const full = new Set(keys(CLEANUP_MAX_ITEMS));
  assert.equal(toggleCleanupSelection(full, "MOVIE:99999").size, CLEANUP_MAX_ITEMS);
  assert.equal(toggleCleanupSelection(full, "MOVIE:1").size, CLEANUP_MAX_ITEMS - 1);
  assert.equal(toggleCleanupSelection(new Set(), "MOVIE:1").has("MOVIE:1"), true);
});

test("the route and the Library cleanup page both read the one shared constant", () => {
  const route = readFileSync(new URL("../src/app/api/admin/cleanup/delete/route.ts", import.meta.url), "utf8");
  assert.match(route, /parseCleanupItems\(parsed\.items\)/);
  assert.match(route, /itemsInvalid", \{ max: CLEANUP_MAX_ITEMS \}/);
  assert.doesNotMatch(route, /MAX_ITEMS = \d/, "no private copy of the cap");
  assert.doesNotMatch(route, /function parseItems/);
  const page = readFileSync(new URL("../src/components/admin/library-cleanup.tsx", import.meta.url), "utf8");
  assert.match(page, /setSelected\(\(prev\) => toggleCleanupSelection\(prev, k\)\)/);
  assert.match(page, /setSelected\(\(prev\) => toggleAllCleanupSelection\(prev, selectableKeys\)\)/);
  assert.match(page, /checked=\{cleanupSelectAllOn\(selected, selectableKeys\)\}/);
  assert.match(page, /const selectionFull = selected\.size >= CLEANUP_MAX_ITEMS;/);
  assert.match(page, /\{selectionFull && \(/, "the page says why the rest weren't ticked");
  assert.doesNotMatch(page, /else next\.add\(k\);/, "no uncapped add left");
});
