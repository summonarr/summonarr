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

// The main admin activity page's ActiveSession title fallback used to query
// PlayHistory with `distinct: ["title"]` and key the answer on `title:<title>`,
// so a TV session "Fargo" picked up the MOVIE "Fargo"'s tmdbId AND type — and
// the fire-and-forget backfill persisted both to ActiveSession (then PlayHistory
// at finalize). Structural pin: the page must go through this module.
test("admin activity page's session title fallback is (title, mediaType)-scoped", async () => {
  const { readFileSync } = await import("node:fs");
  const src = readFileSync(new URL("../src/app/(app)/admin/activity/page.tsx", import.meta.url), "utf8");
  assert.match(src, /from "@\/lib\/activity-title-resolve"/);
  assert.match(src, /titleWhereDisjuncts\(/);
  assert.match(src, /lookupTitleResolution\(titleResolved, s\.title, s\.mediaType\)/);
  assert.doesNotMatch(src, /distinct:\s*\["title"\]/);
  assert.doesNotMatch(src, /`title:\$\{/);
  // The session's own known type wins over the title resolution's.
  assert.match(src, /toActivityMediaType\(s\.mediaType\) \?\? byTitle\?\.mediaType/);
});

test("a TV ActiveSession-shaped entry keeps its type and is not linked to the same-titled movie", () => {
  const map: TitleResolveMap = {};
  addTitleResolutions(map, [MOVIE_FARGO]);
  const session = { title: "Fargo", tmdbId: null, mediaType: "TV" };
  assert.equal(lookupTitleResolution(map, session.title, session.mediaType), undefined);
  const out = resolveUnmappedEntry(session, map);
  assert.equal(out.tmdbId, null);
  assert.equal(out.mediaType, "TV");
});

// Calendar cell counts are watched=true only; the "View these plays" deep link
// must carry that filter and the page must seed the history table with it.
test("calendar 'View these plays' link carries watched=true and the page seeds it", async () => {
  const { readFileSync } = await import("node:fs");
  const cal = readFileSync(new URL("../src/components/admin/activity-calendar.tsx", import.meta.url), "utf8");
  assert.match(cal, /from: date, to: date, watched: "true"/);
  // The history table moved to its own route segment; the overview only redirects.
  const page = readFileSync(new URL("../src/app/(app)/admin/activity/history/page.tsx", import.meta.url), "utf8");
  assert.match(page, /initialWatched=\{initialWatched\}/);
  const table = readFileSync(new URL("../src/components/admin/activity-history-table.tsx", import.meta.url), "utf8");
  assert.match(table, /useState<"" \| "true" \| "false">\(initialWatched \?\? ""\)/);
});
