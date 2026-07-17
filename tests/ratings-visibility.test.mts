// Unit tests for parseHiddenRatingSources (src/lib/ratings-visibility.ts) — the
// defensive parser of the `ratingsHiddenSources` Setting, an admin-writable JSON
// string that reaches every ratings surface. Its contract is fail-open on the
// SAFE side: anything malformed means "hide nothing" (an admin typo must never
// blank every rating badge), and unknown/non-string entries are dropped so a
// stale or hand-edited value can't smuggle arbitrary strings into the hidden
// set. Pure module — no DB, no network.
import { test } from "node:test";
import assert from "node:assert/strict";
import { RATING_SOURCES, parseHiddenRatingSources } from "../src/lib/ratings-visibility.ts";

test("null / undefined / empty string mean 'hide nothing'", () => {
  assert.deepEqual(parseHiddenRatingSources(null), []);
  assert.deepEqual(parseHiddenRatingSources(undefined), []);
  assert.deepEqual(parseHiddenRatingSources(""), []);
});

test("valid array of known keys passes through in order", () => {
  assert.deepEqual(parseHiddenRatingSources('["imdb","trakt"]'), ["imdb", "trakt"]);
});

test("every registered source key is accepted (round-trip of RATING_SOURCES)", () => {
  const all = RATING_SOURCES.map((s) => s.key);
  assert.deepEqual(parseHiddenRatingSources(JSON.stringify(all)), all);
});

test("unknown keys are dropped, known keys survive", () => {
  assert.deepEqual(
    parseHiddenRatingSources('["imdb","notARealSource","metacritic"]'),
    ["imdb", "metacritic"],
  );
});

test("non-string entries are dropped", () => {
  assert.deepEqual(
    parseHiddenRatingSources('[42, null, {"key":"imdb"}, ["imdb"], "tmdb"]'),
    ["tmdb"],
  );
});

test("valid JSON that is not an array means 'hide nothing'", () => {
  assert.deepEqual(parseHiddenRatingSources('{"imdb":true}'), []);
  assert.deepEqual(parseHiddenRatingSources('"imdb"'), []);
  assert.deepEqual(parseHiddenRatingSources("42"), []);
  assert.deepEqual(parseHiddenRatingSources("null"), []);
});

test("malformed JSON means 'hide nothing' (never throws)", () => {
  assert.deepEqual(parseHiddenRatingSources("imdb,trakt"), []);
  assert.deepEqual(parseHiddenRatingSources('["imdb"'), []);
  assert.deepEqual(parseHiddenRatingSources("{"), []);
});

test("key matching is exact — case variants are unknown keys", () => {
  assert.deepEqual(parseHiddenRatingSources('["IMDB","Imdb","imdb"]'), ["imdb"]);
});
