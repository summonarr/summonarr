// mergeRatings (src/components/media/ratings-merge.ts): the one mapping from a
// title plus its lazily fetched ratings to RatingsBar's props. MediaCard and
// DiscoverHero each carried an 11-field copy of it, and their chip rows had
// already drifted apart. Also pins RatingsBar's compact mode, which dropped the
// visible source labels and left screen readers with bare numbers.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { mergeRatings } from "../src/components/media/ratings-merge.ts";
import type { RatingsPayload } from "../src/lib/client/ratings-batcher.ts";

const FIELDS = [
  "imdbRating", "imdbId", "imdbVotes", "rottenTomatoes", "rtAudienceScore", "metacritic",
  "traktRating", "letterboxdRating", "mdblistScore", "malRating", "rogerEbertRating",
] as const;

const filled = (prefix: string) =>
  Object.fromEntries(FIELDS.map((f) => [f, `${prefix}-${f}`])) as unknown as RatingsPayload;

test("mergeRatings covers exactly the eleven RatingsPayload fields", () => {
  assert.deepEqual(Object.keys(mergeRatings(filled("m"), null)).sort(), [...FIELDS].sort());
});

test("a live value wins over the list item's value, field by field", () => {
  assert.deepEqual(mergeRatings(filled("media"), filled("live")), filled("live"));
});

test("a null live value, or no live payload, falls back to the list item's value", () => {
  const nullLive = Object.fromEntries(FIELDS.map((f) => [f, null])) as unknown as RatingsPayload;
  assert.deepEqual(mergeRatings(filled("media"), nullLive), filled("media"));
  assert.deepEqual(mergeRatings(filled("media"), null), filled("media"));
  // Mixed: each field decides on its own.
  const mixed = { ...nullLive, metacritic: "live-mc" };
  const out = mergeRatings(filled("media"), mixed);
  assert.equal(out.metacritic, "live-mc");
  assert.equal(out.traktRating, "media-traktRating");
});

test("MediaCard and DiscoverHero share the ratings merge and the availability chips", () => {
  for (const p of ["src/components/media/media-card.tsx", "src/components/media/discover-hero.tsx"]) {
    const src = readFileSync(new URL(`../${p}`, import.meta.url), "utf8");
    assert.match(src, /\{\.\.\.mergeRatings\(media, liveRatings\)\}/, p);
    assert.match(src, /<AvailabilityChips\b/, p);
    assert.doesNotMatch(src, /liveRatings\?\.\w+ \?\? media\./, `${p}: an inline ratings merge is back`);
    assert.doesNotMatch(src, /ds-chip-plex/, `${p}: an inline Plex chip is back`);
  }
});

test("RatingsBar keeps a screen-reader source name for every label compact mode hides", () => {
  const src = readFileSync(new URL("../src/components/media/ratings-bar.tsx", import.meta.url), "utf8");
  assert.match(src, /\{compact && <span className="sr-only">Metacritic<\/span>\}/);
  assert.match(src, /\{compact && <span className="sr-only">\{t\("media\.ratings\.trakt"\)\}<\/span>\}/);
  assert.match(src, /\{compact \? <span className="sr-only">\{t\("media\.ratings\.mdblist"\)\}<\/span> : /);
  assert.match(src, /\{compact \? <span className="sr-only">\{t\("media\.ratings\.tmdb"\)\}<\/span> : /);
});
