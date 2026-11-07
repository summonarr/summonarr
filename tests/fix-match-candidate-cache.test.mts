// The Plex picker's candidate cache (src/lib/fix-match-candidate-cache.ts):
// re-setting a key that is already cached refreshes it to the newest slot and
// never evicts an unrelated entry to make room for it. Pure process state.
import test, { beforeEach } from "node:test";
import assert from "node:assert/strict";
import { clearCandidateCache, getCachedCandidates, setCachedCandidates } from "../src/lib/fix-match-candidate-cache.ts";

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

  // Nine more new keys evict k2..k9 and then k11 — never the refreshed k10,
  // which left its old slot when it was re-set.
  for (let i = 52; i <= 60; i++) setCachedCandidates(`k${i}`, { i }, now);
  assert.equal(getCachedCandidates("k11", now), null);
  assert.deepEqual(getCachedCandidates("k10", now), { i: 10, again: true }, "a refreshed entry counts as new");
});
