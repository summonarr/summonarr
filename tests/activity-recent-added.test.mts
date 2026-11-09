// The admin "Recently added" grid's reads (src/lib/activity-recent-added.ts).
import { test } from "node:test";
import assert from "node:assert/strict";
import { mergeRecentlyAdded, newestDistinctTitles, type RecentLibraryRow } from "@/lib/activity-recent-added.ts";

const row = (tmdbId: number, day: number, mediaType: "MOVIE" | "TV" = "MOVIE"): RecentLibraryRow => ({
  tmdbId, mediaType, title: `t${tmdbId}`, year: null, addedAt: new Date(Date.UTC(2026, 0, day)),
});

test("copies on several servers don't use up the slots: it reads on until enough distinct titles", async () => {
  // Newest first: every title is on two servers, so a 4-row cut held 2 titles.
  const library = [row(1, 9), row(1, 9), row(2, 8), row(2, 8), row(3, 7), row(3, 7), row(4, 6)];
  const reads: [number, number][] = [];
  const out = await newestDistinctTitles(async (skip, take) => {
    reads.push([skip, take]);
    return library.slice(skip, skip + take);
  }, { limit: 3, page: 4 });
  assert.deepEqual(out.map((r) => r.tmdbId), [1, 2, 3]);
  assert.deepEqual(reads, [[0, 4], [4, 4]], "stopped once three distinct titles were in");
});

test("it stops when the library runs out or the read budget is spent", async () => {
  let reads = 0;
  const out = await newestDistinctTitles(async () => {
    reads++;
    return [row(1, 1), row(1, 1)];
  }, { limit: 5, page: 2, maxPages: 3 });
  assert.equal(out.length, 1);
  assert.equal(reads, 3);
  reads = 0;
  await newestDistinctTitles(async () => { reads++; return [row(1, 1)]; }, { limit: 5, page: 2 });
  assert.equal(reads, 1, "a short page is the end");
});

test("the merge unions sources and keeps the newest addedAt with its title", () => {
  const merged = mergeRecentlyAdded(
    [{ ...row(1, 2), title: "Old" }, row(2, 1, "TV")],
    [{ ...row(1, 5), title: "New" }],
    "Unknown",
  );
  assert.deepEqual(merged.map((m) => [m.tmdbId, m.title, m.sources]), [
    [1, "New", { plex: true, jellyfin: true }],
    [2, "t2", { plex: true, jellyfin: false }],
  ]);
  assert.equal(mergeRecentlyAdded([{ ...row(3, 1), title: null }], [], "Unknown")[0].title, "Unknown");
});

test("an older titled copy replaces the placeholder of a newer untitled one", () => {
  const merged = mergeRecentlyAdded(
    [{ ...row(1, 5), title: null }],
    [{ ...row(1, 2), title: "Real" }],
    "Unknown",
  );
  assert.equal(merged[0].title, "Real");
  assert.equal(merged[0].addedAt.getTime(), new Date(Date.UTC(2026, 0, 5)).getTime());
});
