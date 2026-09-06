// Pins for src/lib/activity-title-resolve.ts — the (title, mediaType)-scoped
// tmdbId fallback used by the per-user admin activity page.
//
// The bug this replaces: the fallback was keyed on the bare title, so a TV play
// of "Fargo" (tmdbId null) with only the MOVIE "Fargo" in a library was
// relinked to the movie, its own TV type was overwritten by the library row's,
// and the recent-plays row linked to `/media/<movieId>?type=TV`. Each of those
// three consequences is pinned below, in the direction that fails on the old
// code.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  addTitleResolutions,
  collectUnmappedPairs,
  lookupTitleResolution,
  resolveUnmappedEntry,
  titleResolveKey,
  titleWhereDisjuncts,
  unresolvedPairs,
  type TitleResolveMap,
} from "@/lib/activity-title-resolve.ts";

const MOVIE_FARGO = { title: "Fargo", tmdbId: 275, mediaType: "MOVIE" as const };
const TV_FARGO = { title: "Fargo", tmdbId: 60622, mediaType: "TV" as const };

test("collectUnmappedPairs keeps (title, mediaType) pairs distinct and skips mapped/blank rows", () => {
  const pairs = collectUnmappedPairs([
    { title: "Fargo", tmdbId: null, mediaType: "TV" },
    { title: "Fargo", tmdbId: null, mediaType: "MOVIE" },
    { title: "Fargo", tmdbId: null, mediaType: "TV" }, // duplicate
    { title: "Fargo", tmdbId: null, mediaType: null },
    { title: "Heat", tmdbId: 949, mediaType: "MOVIE" }, // already mapped
    { title: "", tmdbId: null, mediaType: "MOVIE" }, // blank title
    { title: "Weird", tmdbId: null, mediaType: "episode" }, // unknown type → type-less
  ]);
  assert.deepEqual(pairs, [
    { title: "Fargo", mediaType: "TV" },
    { title: "Fargo", mediaType: "MOVIE" },
    { title: "Fargo", mediaType: null },
    { title: "Weird", mediaType: null },
  ]);
});

test("titleWhereDisjuncts scopes typed pairs on mediaType and leaves type-less ones open", () => {
  assert.deepEqual(
    titleWhereDisjuncts([
      { title: "Fargo", mediaType: "TV" },
      { title: "Fargo", mediaType: null },
    ]),
    [{ title: "Fargo", mediaType: "TV" }, { title: "Fargo" }],
  );
});

test("the map is never keyed on the bare title", () => {
  const map: TitleResolveMap = {};
  addTitleResolutions(map, [MOVIE_FARGO]);
  assert.equal(map["Fargo"], undefined);
  assert.deepEqual(map[titleResolveKey("Fargo", "MOVIE")], { tmdbId: 275, mediaType: "MOVIE" });
});

test("a TV play titled 'Fargo' with only a MOVIE 'Fargo' library row is NOT relinked", () => {
  const map = addTitleResolutions({}, [MOVIE_FARGO]);
  const play = { id: "p1", title: "Fargo", tmdbId: null, mediaType: "TV" as const };
  assert.equal(lookupTitleResolution(map, "Fargo", "TV"), undefined);
  assert.deepEqual(resolveUnmappedEntry(play, map), play);
  // …and it stays in the second-stage lookup input.
  assert.deepEqual(unresolvedPairs(map, [{ title: "Fargo", mediaType: "TV" }]), [
    { title: "Fargo", mediaType: "TV" },
  ]);
});

test("a type-less play accepts a typed match (either type), MOVIE first for determinism", () => {
  const tvOnly = addTitleResolutions({}, [TV_FARGO]);
  assert.deepEqual(resolveUnmappedEntry({ title: "Fargo", tmdbId: null, mediaType: null }, tvOnly), {
    title: "Fargo",
    tmdbId: 60622,
    mediaType: "TV",
  });
  // Both present, in either arrival order → always the movie.
  const both = addTitleResolutions({}, [TV_FARGO, MOVIE_FARGO]);
  const bothReversed = addTitleResolutions({}, [MOVIE_FARGO, TV_FARGO]);
  for (const map of [both, bothReversed]) {
    assert.deepEqual(resolveUnmappedEntry({ title: "Fargo", tmdbId: null, mediaType: null }, map), {
      title: "Fargo",
      tmdbId: 275,
      mediaType: "MOVIE",
    });
  }
  assert.deepEqual(unresolvedPairs(tvOnly, [{ title: "Fargo", mediaType: null }]), []);
});

test("a play's non-null mediaType is never overwritten by the resolver's", () => {
  // Same-type match: tmdbId fills in, type is the play's own.
  const map = addTitleResolutions({}, [TV_FARGO, MOVIE_FARGO]);
  const resolved = resolveUnmappedEntry(
    { id: "p2", title: "Fargo", tmdbId: null, mediaType: "TV" as const, seasonNumber: 2 },
    map,
  );
  assert.deepEqual(resolved, { id: "p2", title: "Fargo", tmdbId: 60622, mediaType: "TV", seasonNumber: 2 });
  // The link the page builds from it can never be `/media/<movieId>?type=TV`.
  assert.equal(`/admin/activity/media/${resolved.tmdbId}?type=${resolved.mediaType}`, "/admin/activity/media/60622?type=TV");
});

test("already-mapped entries pass through untouched and first writer wins per key", () => {
  const map = addTitleResolutions({}, [
    { title: "Fargo", tmdbId: 1, mediaType: "MOVIE" }, // PlayHistory match (authoritative first)
    { title: "Fargo", tmdbId: 2, mediaType: "MOVIE" }, // library row for the same key
    { title: null, tmdbId: 3, mediaType: "MOVIE" },
    { title: "Nope", tmdbId: null, mediaType: "MOVIE" },
  ]);
  assert.deepEqual(map, { "MOVIE:Fargo": { tmdbId: 1, mediaType: "MOVIE" } });
  const mapped = { title: "Fargo", tmdbId: 999, mediaType: "TV" as const };
  assert.equal(resolveUnmappedEntry(mapped, map), mapped);
});
