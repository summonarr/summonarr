// The Plex picker's candidate cache (src/lib/fix-match-candidate-cache.ts):
// re-setting a key that is already cached refreshes it to the newest slot and
// never evicts an unrelated entry to make room for it, and a read keeps an
// entry from being the next one evicted. Pure process state.
import test, { beforeEach } from "node:test";
import assert from "node:assert/strict";
import { candidateCacheKey, clearCandidateCache, dropCandidatesFor, dropCandidatesForTitles, getCachedCandidates, setCachedCandidates } from "../src/lib/fix-match-candidate-cache.ts";

beforeEach(() => clearCandidateCache());

test("re-setting a cached key keeps every other entry and moves the key to the newest slot", () => {
  const now = Date.now();
  for (let i = 1; i <= 50; i++) setCachedCandidates(`k${i}`, { i }, now);

  // Two concurrent misses for one title both write it: the second write must
  // not push an unrelated title out of a full cache.
  setCachedCandidates("k10", { i: 10, again: true }, now);
  assert.deepEqual(getCachedCandidates("k1", now), { i: 1 }, "the oldest unrelated entry survives a re-set");
  assert.deepEqual(getCachedCandidates("k10", now), { i: 10, again: true });
  for (let i = 1; i <= 50; i++) assert.ok(getCachedCandidates(`k${i}`, now), `k${i} still cached`);

  // The next NEW key evicts the oldest entry, k1.
  setCachedCandidates("k51", { i: 51 }, now);
  assert.equal(getCachedCandidates("k1", now), null, "the oldest entry is the one evicted");
  assert.deepEqual(getCachedCandidates("k51", now), { i: 51 });

  // A READ refreshes too: k2, now the least recently used, is read, so the
  // next new key evicts k3 instead.
  assert.ok(getCachedCandidates("k2", now));
  setCachedCandidates("k52", { i: 52 }, now);
  assert.equal(getCachedCandidates("k3", now), null, "the least recently used entry goes");
  assert.ok(getCachedCandidates("k2", now), "a just-read entry survives");
});

test("dropping one server's items removes every list for them, and only theirs", () => {
  const now = Date.now();
  const key = (serverInstance: string, ratingKey: string, correctTmdbId: number, arrHint: number | null = null) =>
    candidateCacheKey({ serverInstance, ratingKey, correctTmdbId, arrHint, mediaType: "MOVIE", tmdbId: 111 });
  const keys = [key("", "1001", 222), key("", "1001", 333, 5), key("", "10011", 222), key("remote", "1001", 222), key("", "2002", 222)];
  for (const k of keys) setCachedCandidates(k, { k }, now);

  dropCandidatesFor("", ["1001"]);
  assert.equal(getCachedCandidates(keys[0], now), null);
  assert.equal(getCachedCandidates(keys[1], now), null, "whatever target the list was for");
  assert.ok(getCachedCandidates(keys[2], now), "a key that merely starts the same is another item");
  assert.ok(getCachedCandidates(keys[3], now), "the same ratingKey on another server is another item");
  assert.ok(getCachedCandidates(keys[4], now));

  dropCandidatesFor("", []);
  assert.ok(getCachedCandidates(keys[4], now), "nothing touched, nothing dropped");
});

test("dropping titles removes their lists on every Plex server, and only theirs", () => {
  const now = Date.now();
  const key = (serverInstance: string, ratingKey: string, mediaType: "MOVIE" | "TV", tmdbId: number) =>
    candidateCacheKey({ serverInstance, ratingKey, correctTmdbId: 999, arrHint: null, mediaType, tmdbId });
  const keys = [
    key("", "1001", "MOVIE", 10),
    key("remote", "3003", "MOVIE", 10),
    key("", "1002", "MOVIE", 20),
    key("", "1003", "TV", 10),
    key("", "1004", "MOVIE", 100),
    key("", "1005", "MOVIE", 30),
  ];
  for (const k of keys) setCachedCandidates(k, { k }, now);

  dropCandidatesForTitles("MOVIE", [10, 20]);
  assert.equal(getCachedCandidates(keys[0], now), null);
  assert.equal(getCachedCandidates(keys[1], now), null, "the same title on another Plex server shows the same Jellyfin path");
  assert.equal(getCachedCandidates(keys[2], now), null, "the title moved to");
  assert.ok(getCachedCandidates(keys[3], now), "the same id as a show is another title");
  assert.ok(getCachedCandidates(keys[4], now), "an id that merely starts the same is another title");
  assert.ok(getCachedCandidates(keys[5], now), "an unrelated title's list survives");

  dropCandidatesForTitles("MOVIE", [0]);
  assert.ok(getCachedCandidates(keys[5], now), "an unmatched item's 0 names no list");
});
