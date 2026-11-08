// The detail-page chip (getTitleNeverWatched) keeps its answer for the report's
// TTL instead of re-running the narrowed read on every admin view — and, like
// the report's own cache, never serves it across a new recorded play or a
// report invalidation (guardrail 19b). Separate file: the caches are per process.
import { test } from "node:test";
import assert from "node:assert/strict";
import { shadowPrismaClientMethod, shadowPrismaModel } from "./_helpers.mts";

process.env.TOKEN_ENCRYPTION_KEY = "ab".repeat(32);
console.warn = () => {};

const { prisma } = await import("../src/lib/prisma.ts");

let libraryReads = 0;
shadowPrismaModel(prisma, "setting", {
  findMany: async () => [{ key: "playHistoryEnabled", value: "true" }, { key: "playHistoryPlexEnabled", value: "true" }],
});
shadowPrismaModel(prisma, "plexLibraryItem", {
  findMany: async () => {
    libraryReads++;
    return [{
      tmdbId: 1, mediaType: "MOVIE", serverInstance: "", title: "Old", year: "2000",
      addedAt: new Date("2024-01-01T00:00:00.000Z"), plexRatingKey: "rk1", plexRatingKeys: ["rk1"],
    }];
  },
});
shadowPrismaModel(prisma, "jellyfinLibraryItem", { findMany: async () => [] });
shadowPrismaModel(prisma, "playHistory", {
  groupBy: async (args: { by: string[] }) =>
    args.by.join() === "source,serverInstance"
      ? [{ source: "plex", serverInstance: "", _min: { startedAt: new Date("2023-01-01T00:00:00.000Z") } }]
      : [],
});
shadowPrismaModel(prisma, "activeSession", { findMany: async () => [] });
shadowPrismaModel(prisma, "upstreamWatchEvidence", { findMany: async () => [] });
shadowPrismaModel(prisma, "mediaRequest", { groupBy: async () => [] });
shadowPrismaClientMethod(prisma, "$queryRaw", async () => []);

const { getTitleNeverWatched, invalidateNeverWatchedReport } = await import("../src/lib/never-watched-report.ts");
const { clearActivityCache } = await import("../src/lib/play-history.ts");

test("a second view of the same title is served without a read; a new play or an invalidation reads again", async () => {
  const first = await getTitleNeverWatched(1, "MOVIE");
  assert.ok(first);
  assert.equal(libraryReads, 1);
  assert.deepEqual(await getTitleNeverWatched(1, "MOVIE"), first);
  assert.equal(libraryReads, 1, "served from the memo");

  clearActivityCache();
  await getTitleNeverWatched(1, "MOVIE");
  assert.equal(libraryReads, 2, "a finished play moves the generation");

  invalidateNeverWatchedReport();
  await getTitleNeverWatched(1, "MOVIE");
  assert.equal(libraryReads, 3, "a report invalidation drops the memo too");

  await getTitleNeverWatched(2, "MOVIE");
  assert.equal(libraryReads, 4, "another title is its own entry");
});
