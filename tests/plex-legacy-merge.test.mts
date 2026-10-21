// mergeResolvedLegacyItems (src/lib/plex-legacy-resolve.ts): two legacy-agent
// items that resolve to one tmdb id must produce the SAME stored row whatever
// order the resolver handed them over in (the legacy map is filled by section
// walks that run concurrently, so arrival order varies between runs).
import { test } from "node:test";
import assert from "node:assert/strict";

process.env.TOKEN_ENCRYPTION_KEY = "ab".repeat(32);
(globalThis as unknown as { prisma: unknown }).prisma = {};

const { mergeResolvedLegacyItems } = await import("../src/lib/plex-legacy-resolve.ts");
type Resolved = Parameters<typeof mergeResolvedLegacyItems>[0][number];

const data = (ratingKey: string) => ({
  filePath: `/tv/${ratingKey}`, ratingKey, title: "Show", year: null, overview: null,
  contentRating: null, addedAt: null,
});
const a: Resolved = { tmdbId: 7, ratingKey: "9", data: data("9") };
const b: Resolved = { tmdbId: 7, ratingKey: "10", data: data("10") };

test("the stored legacy copy does not depend on resolver arrival order", () => {
  const one = new Map();
  const two = new Map();
  mergeResolvedLegacyItems([a, b], one);
  mergeResolvedLegacyItems([b, a], two);
  assert.deepEqual(one.get(7), two.get(7));
  // numeric-aware: "9" sorts before "10", so it owns the row and "10" rides along.
  assert.equal(one.get(7).ratingKey, "9");
  assert.deepEqual(one.get(7).duplicateRatingKeys, ["10"]);
});
