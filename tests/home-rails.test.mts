// The native home feed's rail shaping (src/lib/home-rails.ts): a hidden title
// never comes back as its raw item, hideAvailable reads only the servers the
// viewer is shown, and the featured titles leave the trending rail.
import { test } from "node:test";
import assert from "node:assert/strict";

const { dedupeUnion, emptiedByHideAvailable, mediaKey, projectRail, splitFeatured } = await import("../src/lib/home-rails.ts");
type Media = import("../src/lib/tmdb-types.ts").TmdbMedia;

const media = (id: number, mediaType: "movie" | "tv", extra: Partial<Media> = {}): Media => ({
  id, mediaType, title: `t${id}`, overview: "", posterPath: null, backdropPath: null,
  releaseDate: null, releaseYear: "", voteAverage: 0, ...extra,
});

test("dedupeUnion keeps the first occurrence of each title across rails", () => {
  const a = media(1, "movie", { title: "first" });
  const b = media(1, "movie", { title: "second" });
  const tv = media(1, "tv");
  assert.deepEqual(dedupeUnion([[a], [b, tv]]).map((m) => [mediaKey(m), m.title]), [["movie-1", "first"], ["tv-1", "t1"]]);
});

test("projectRail drops a title the enrichment filtered out instead of resurrecting the raw item", () => {
  const raw = [media(1, "movie"), media(2, "movie")];
  const enriched = new Map([[mediaKey(raw[1]), { ...raw[1], title: "enriched" }]]);
  const out = projectRail(raw, enriched, { hideAvailable: false, showPlex: true, showJellyfin: true }, 10);
  assert.deepEqual(out.map((m) => m.title), ["enriched"]);
});

test("projectRail with hideAvailable drops only titles available on a server the viewer is SHOWN", () => {
  const plexOnly = media(1, "movie", { plexAvailable: true });
  const jfOnly = media(2, "movie", { jellyfinAvailable: true });
  const neither = media(3, "movie");
  const raw = [plexOnly, jfOnly, neither];
  const enriched = new Map(raw.map((m) => [mediaKey(m), m]));
  const plexPinned = projectRail(raw, enriched, { hideAvailable: true, showPlex: true, showJellyfin: false }, 10);
  assert.deepEqual(plexPinned.map((m) => m.id), [2, 3], "a Plex-pinned viewer keeps the Jellyfin-only title");
  const both = projectRail(raw, enriched, { hideAvailable: true, showPlex: true, showJellyfin: true }, 10);
  assert.deepEqual(both.map((m) => m.id), [3]);
  const off = projectRail(raw, enriched, { hideAvailable: false, showPlex: true, showJellyfin: true }, 2);
  assert.deepEqual(off.map((m) => m.id), [1, 2], "the limit caps the rail");
});

test("splitFeatured takes the first movie and the first show off the trending rail", () => {
  const rail = [media(1, "tv"), media(2, "movie"), media(3, "movie"), media(4, "tv")];
  const { featured, rest } = splitFeatured(rail);
  assert.deepEqual(featured.map(mediaKey), ["movie-2", "tv-1"]);
  assert.deepEqual(rest.map(mediaKey), ["movie-3", "tv-4"]);
  assert.deepEqual(splitFeatured([]), { featured: [], rest: [] });
});

test("emptiedByHideAvailable is true only when Hide Available itself emptied the rail", () => {
  const plexOnly = media(1, "movie", { plexAvailable: true });
  const jfOnly = media(2, "movie", { jellyfinAvailable: true });
  const vis = { hideAvailable: true, showPlex: true, showJellyfin: true };
  const all = new Map([plexOnly, jfOnly].map((m) => [mediaKey(m), m]));
  assert.equal(emptiedByHideAvailable([plexOnly, jfOnly], all, vis), true);
  assert.equal(emptiedByHideAvailable([plexOnly, jfOnly], all, { ...vis, hideAvailable: false }), false);
  // A Plex-pinned viewer still sees the Jellyfin-only title, so the rail was not emptied.
  assert.equal(emptiedByHideAvailable([plexOnly, jfOnly], all, { ...vis, showJellyfin: false }), false);
  // A failed source (no titles) or titles the viewer hid (missing from the map) are not "all available".
  assert.equal(emptiedByHideAvailable([], all, vis), false);
  assert.equal(emptiedByHideAvailable([media(9, "movie")], all, vis), false);
});
