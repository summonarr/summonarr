// jellyfinHoldReason (src/lib/jellyfin-sync-guard.ts): when the sync orchestrator
// holds a Jellyfin instance back instead of replacing its rows with a short answer.
import { test } from "node:test";
import assert from "node:assert/strict";
import { jellyfinHoldNeedsCounts, jellyfinHoldReason } from "../src/lib/jellyfin-sync-guard.ts";

const MOVIES = { id: "m1", collectionType: "movies" };
const SHOWS = { id: "s1", collectionType: "tvshows" };
const base = { selectedIds: undefined, folders: [MOVIES, SHOWS], movieCount: 10, tvCount: 5, heldMovieRows: 10, heldTvRows: 5 };

test("a full answer is never held and needs no DB read", () => {
  assert.equal(jellyfinHoldReason(base), null);
  assert.equal(jellyfinHoldNeedsCounts(base), false);
});

test("nothing stored means nothing to protect", () => {
  assert.equal(jellyfinHoldReason({ ...base, movieCount: 0, tvCount: 0, heldMovieRows: 0, heldTvRows: 0 }), null);
});

test("both types empty with rows stored is held", () => {
  assert.deepEqual(jellyfinHoldReason({ ...base, movieCount: 0, tvCount: 0 }), { kind: "empty" });
});

test("a covered type answering empty with its rows stored is held (mid-scan)", () => {
  assert.deepEqual(jellyfinHoldReason({ ...base, tvCount: 0 }), { kind: "empty-type", mediaType: "TV" });
  assert.deepEqual(jellyfinHoldReason({ ...base, movieCount: 0 }), { kind: "empty-type", mediaType: "MOVIE" });
});

test("a selected library id the server no longer lists is held when its type came back empty", () => {
  const input = { ...base, selectedIds: new Set(["m1", "s1"]), folders: [MOVIES, { id: "s2", collectionType: "tvshows" }], tvCount: 0 };
  assert.deepEqual(jellyfinHoldReason(input), { kind: "missing-library", ids: ["s1"], mediaType: "TV" });
});

test("a stale id alone never holds, because the pickers keep saved ids they no longer list", () => {
  const input = { ...base, selectedIds: new Set(["m1", "s1", "s2"]), folders: [MOVIES, { id: "s2", collectionType: "tvshows" }] };
  assert.equal(jellyfinHoldNeedsCounts(input), false);
  assert.equal(jellyfinHoldReason(input), null);
});

test("deselecting a library on purpose is not held", () => {
  assert.equal(jellyfinHoldReason({ ...base, selectedIds: new Set(["m1"]), tvCount: 0 }), null);
});

test("a type with no library on the server at all is not held", () => {
  assert.equal(jellyfinHoldReason({ ...base, folders: [MOVIES], tvCount: 0 }), null);
});

test("a type with no stored rows answering empty is not held", () => {
  assert.equal(jellyfinHoldReason({ ...base, tvCount: 0, heldTvRows: 0 }), null);
});
