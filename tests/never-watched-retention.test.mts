// The never-watched window never reaches back past the play-history retention
// cutoff (guardrail 14d). Plays before it are deleted by the hourly purge, so a
// window opening earlier would claim "no plays" over a span whose plays are gone
// — and the per-server first-play read is cached, so a just-purged first play
// can linger. Separate file: play-history's settings are cached per process.
import { test } from "node:test";
import assert from "node:assert/strict";
import { shadowPrismaClientMethod, shadowPrismaModel } from "./_helpers.mts";

process.env.TOKEN_ENCRYPTION_KEY = "ab".repeat(32);
console.warn = () => {};

const { prisma } = await import("../src/lib/prisma.ts");
const NOW = new Date("2026-10-01T00:00:00.000Z");
const daysAgo = (n: number) => new Date(NOW.getTime() - n * 86_400_000);

const settings = new Map<string, string>([
  ["playHistoryEnabled", "true"],
  ["playHistoryPlexEnabled", "true"],
  ["playHistoryRetentionDays", "100"],
]);
shadowPrismaModel(prisma, "setting", {
  findMany: async () => [...settings.entries()].map(([key, value]) => ({ key, value })),
});
shadowPrismaModel(prisma, "plexLibraryItem", {
  findMany: async () => [{
    tmdbId: 1, mediaType: "MOVIE", serverInstance: "", title: "Old", year: "2000",
    addedAt: daysAgo(1000), plexRatingKey: "rk1", plexRatingKeys: ["rk1"],
  }],
});
shadowPrismaModel(prisma, "jellyfinLibraryItem", { findMany: async () => [] });
shadowPrismaModel(prisma, "playHistory", {
  groupBy: async (args: { by: string[] }) =>
    args.by.join() === "source,serverInstance"
      // A first play 500 days ago — older than the 100-day retention cutoff,
      // as a cached read taken before the purge would report.
      ? [{ source: "plex", serverInstance: "", _min: { startedAt: daysAgo(500) } }]
      : [],
});
shadowPrismaModel(prisma, "activeSession", { findMany: async () => [] });
shadowPrismaModel(prisma, "upstreamWatchEvidence", { findMany: async () => [] });
shadowPrismaModel(prisma, "mediaRequest", { groupBy: async () => [] });
shadowPrismaClientMethod(prisma, "$queryRaw", async () => []);

const { loadLibraryWatchFacts } = await import("../src/lib/never-watched-data.ts");

test("the window opens no earlier than the retention cutoff, whatever the first recorded play says", async () => {
  const facts = await loadLibraryWatchFacts(null, { now: NOW });
  const t = facts.titles[0];
  assert.equal(t.verdict.state, "noPlaysSince");
  assert.equal(t.verdict.windowStart?.toISOString(), daysAgo(100).toISOString());
  assert.equal(t.verdict.days, 100);
});

test("switching tracking back on moves the window to that moment — a play while it was off was never recorded", async () => {
  settings.set("playHistoryPlexTrackedSince", daysAgo(30).toISOString());
  try {
    const t = (await loadLibraryWatchFacts(null, { now: NOW })).titles[0];
    assert.equal(t.verdict.windowStart?.toISOString(), daysAgo(30).toISOString());
  } finally {
    settings.delete("playHistoryPlexTrackedSince");
  }
});
