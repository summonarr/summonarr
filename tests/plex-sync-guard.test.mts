// plexHoldReason (src/lib/plex-sync-guard.ts): when the sync orchestrator holds
// a Plex instance back instead of replacing its rows with a short answer.
import { test } from "node:test";
import assert from "node:assert/strict";
import { plexHoldNeedsCounts, plexHoldReason } from "../src/lib/plex-sync-guard.ts";

const MOVIES = { key: "1", type: "movie" as const };
const SHOWS = { key: "2", type: "show" as const };
const base = { selectedKeys: undefined, sections: [MOVIES, SHOWS], movieCount: 10, tvCount: 5, heldMovieRows: 10, heldTvRows: 5 };

test("a full answer is never held", () => {
  assert.equal(plexHoldReason(base), null);
  assert.equal(plexHoldNeedsCounts(base), false, "no DB read on the common path");
});

test("nothing stored ⇒ nothing to protect: a new or empty server is never held", () => {
  assert.equal(plexHoldReason({ ...base, movieCount: 0, tvCount: 0, heldMovieRows: 0, heldTvRows: 0 }), null);
  assert.equal(plexHoldReason({ ...base, selectedKeys: new Set(["9"]), heldMovieRows: 0, heldTvRows: 0 }), null);
});

test("both types empty with rows stored is held (the v0.37.1 rule)", () => {
  assert.deepEqual(plexHoldReason({ ...base, movieCount: 0, tvCount: 0 }), { kind: "empty" });
});

test("a selected key the server no longer lists is held when its type came back empty, even while the other type still answers", () => {
  // TV library recreated: was 2, now 3; the saved selection still says 1,2.
  const input = { ...base, selectedKeys: new Set(["1", "2"]), sections: [MOVIES, { key: "3", type: "show" as const }], tvCount: 0 };
  assert.equal(plexHoldNeedsCounts(input), true);
  assert.deepEqual(plexHoldReason(input), { kind: "missing-section", keys: ["2"], mediaType: "TV" });
});

test("a stale key ALONE never holds: the pickers keep saved keys they no longer list, so such a hold could never clear", () => {
  // The admin ticked the recreated library (3); the picker saved "1,2,3" because
  // it keeps the unlisted 2. Every type answers, so nothing is held.
  const input = { ...base, selectedKeys: new Set(["1", "2", "3"]), sections: [MOVIES, { key: "3", type: "show" as const }] };
  assert.equal(plexHoldNeedsCounts(input), false, "no DB read when every type answered");
  assert.equal(plexHoldReason(input), null);
});

test("a library removed on purpose with its key still selected: a Resync empties that type's rows, after which nothing is held", () => {
  const input = { ...base, selectedKeys: new Set(["1", "2"]), sections: [MOVIES], tvCount: 0 };
  assert.equal(plexHoldReason(input)?.kind, "missing-section", "held until the admin acts");
  assert.equal(plexHoldReason({ ...input, heldTvRows: 0 }), null, "after Resync no TV rows are stored ⇒ nothing to protect");
});

test("one covered type answering empty with its rows stored is held (mid-scan)", () => {
  assert.deepEqual(plexHoldReason({ ...base, tvCount: 0 }), { kind: "empty-type", mediaType: "TV" });
  assert.deepEqual(plexHoldReason({ ...base, movieCount: 0 }), { kind: "empty-type", mediaType: "MOVIE" });
});

test("a type with no stored rows answering empty is not held", () => {
  assert.equal(plexHoldReason({ ...base, tvCount: 0, heldTvRows: 0 }), null);
});

test("deselecting a library on purpose is not held: no selected section of that type remains", () => {
  assert.equal(plexHoldReason({ ...base, selectedKeys: new Set(["1"]), tvCount: 0 }), null);
});

test("a type with no section on the server at all is not held (the library was deleted in Plex)", () => {
  assert.equal(plexHoldReason({ ...base, sections: [MOVIES], tvCount: 0 }), null);
});
