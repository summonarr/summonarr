// Audit fix C078 (part 1): one /admin/stats storage computation loads the
// whole-library watch facts ONCE. The storage section computes the Library
// cleanup report (computeCleanupReport) AND the never-watched report
// (getNeverWatchedReport), and each ran the whole loadLibraryWatchFacts load —
// five whole-table PlayHistory aggregates plus sessions, upstream evidence,
// requests and coverage — itself. The fix hands ONE lazily-loaded facts object
// (SharedWatchFacts, never-watched-data.ts) to both, each still computing
// exactly what it computes on its own page — never a second computation path
// for cleanup candidates (guardrail 14d).
//
// What is pinned:
//   - one stats computation runs each facts read once (cold never-watched
//     cache, warm cache, either feature off);
//   - the cleanup and never-watched figures equal what each function computes
//     alone from the same data, and each function's whole result is unchanged
//     by the shared load (same index, same `now`);
//   - the never-watched report built from the shared load is stored for the
//     page — and NEVER when the shared inputs could predate an invalidation
//     (the load started first, the index was dropped since, an invalidation
//     landed mid-computation: the guardrail-19b shape);
//   - a shared load that doesn't fit the read it replaces throws.
// In-memory prisma, Radarr/Sonarr scripted on RFC1918 literals. No DB, no network.
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import dns from "node:dns/promises";

process.env.TOKEN_ENCRYPTION_KEY = "ab".repeat(32);
process.env.NEXTAUTH_SECRET = "stats-load-test-secret-0123456789abcdef";
(process.env as Record<string, string | undefined>).NODE_ENV = "test";

const fakeLookup = async () => [{ address: "10.0.0.250", family: 4 }];
(dns as { lookup: unknown }).lookup = fakeLookup;
if ((dns as { lookup: unknown }).lookup !== fakeLookup) throw new Error("could not stub dns.lookup");

console.warn = () => {};
console.error = () => {};

// ── scripted Radarr/Sonarr ───────────────────────────────────────────────────
const RADARR = "http://10.0.0.5:7878";
const SONARR = "http://10.0.0.7:8989";
const radarrMovies = [
  { id: 11, tmdbId: 100, title: "Movie 100", sizeOnDisk: 1_000 },
  { id: 12, tmdbId: 200, title: "Movie 200", sizeOnDisk: 2_000 },
  { id: 13, tmdbId: 250, title: "Movie 250", sizeOnDisk: 2_500 },
];
const sonarrSeries = [
  { id: 31, tmdbId: 300, tvdbId: 3000, title: "Show 300", status: "ended", statistics: { sizeOnDisk: 700 } },
  { id: 36, tmdbId: 600, tvdbId: 6000, title: "Show 600", status: "ended", statistics: { sizeOnDisk: 6_000 } },
];
globalThis.fetch = (async (input: RequestInfo | URL) => {
  const url = new URL(String(input));
  if (url.pathname === "/api/v3/diskspace") return Response.json([{ path: "/data", label: "", freeSpace: 500, totalSpace: 1_000 }]);
  if (url.origin === RADARR && url.pathname === "/api/v3/movie") return Response.json(radarrMovies);
  if (url.origin === SONARR && url.pathname === "/api/v3/series") return Response.json(sonarrSeries);
  throw new Error(`unexpected fetch ${url}`);
}) as unknown as typeof fetch;

const { prisma } = await import("../src/lib/prisma.ts");
const { shadowPrismaModel, shadowPrismaClientMethod } = await import("./_helpers.mts");
const { invalidateFeatureFlagCache } = await import("../src/lib/features.ts");

// ── read counters ────────────────────────────────────────────────────────────
// Every read loadLibraryWatchFacts makes once per load, by name. The per-server
// first play ("source,serverInstance") is its own 5-minute cache and is not
// counted.
const FACT_READS = [
  "playHistory.groupBy:tmdbId,mediaType",
  "playHistory.groupBy:tmdbId,seasonNumber",
  "playHistory.groupBy:source,serverInstance,sourceItemId,tmdbId",
  "playHistory.groupBy:source,serverInstance,sourceShowId,seasonNumber,tmdbId",
  "playHistory.groupBy:source,serverInstance,title,mediaType,seasonNumber,sourceItemId,sourceShowId",
  "plexLibraryItem.findMany",
  "jellyfinLibraryItem.findMany",
  "activeSession.findMany",
  "upstreamWatchEvidence.findMany",
  "mediaRequest.groupBy",
] as const;
const SEASON_READ = "$queryRaw:TVEpisodeCache";
let reads = new Map<string, number>();
const hit = (name: string) => reads.set(name, (reads.get(name) ?? 0) + 1);
const count = (name: string) => reads.get(name) ?? 0;
const factLoads = () => Object.fromEntries(FACT_READS.map((n) => [n, count(n)]));
const expectLoads = (n: number) => Object.fromEntries(FACT_READS.map((k) => [k, n]));

// ── data stubs ───────────────────────────────────────────────────────────────
const settings = new Map<string, string>();
shadowPrismaModel(prisma, "setting", {
  findMany: async (args?: { where?: { key?: { in?: string[] } } }) => {
    const keys = args?.where?.key?.in;
    return [...settings.entries()].filter(([k]) => !keys || keys.includes(k)).map(([key, value]) => ({ key, value }));
  },
  findUnique: async (args: { where: { key: string } }) => {
    const v = settings.get(args.where.key);
    return v === undefined ? null : { key: args.where.key, value: v };
  },
});

const ADDED = new Date("2024-01-01T00:00:00.000Z");
type Lib = { tmdbId: number; mediaType: "MOVIE" | "TV"; serverInstance: string; title: string; year: string | null; addedAt: Date | null; plexRatingKey: string; plexRatingKeys: string[] };
// 100 watched movie; 200, 250 never-watched movies; 400 never watched, no
// Radarr copy; 300 a watched show whose season 2 never was; 600 a never-watched show.
const plexLib: Lib[] = [
  ...[100, 200, 250, 400].map((tmdbId) => ({ tmdbId, mediaType: "MOVIE" as const, serverInstance: "", title: `Movie ${tmdbId}`, year: "2020", addedAt: ADDED, plexRatingKey: `rk${tmdbId}`, plexRatingKeys: [] })),
  ...[300, 600].map((tmdbId) => ({ tmdbId, mediaType: "TV" as const, serverInstance: "", title: `Show ${tmdbId}`, year: "2019", addedAt: ADDED, plexRatingKey: `rk${tmdbId}`, plexRatingKeys: [] })),
];
const inIds = (where: { tmdbId?: { in?: number[] } } | undefined, id: number | null) =>
  !where?.tmdbId?.in || (id !== null && where.tmdbId.in.includes(id));
shadowPrismaModel(prisma, "plexLibraryItem", {
  findMany: async (args: { where?: { tmdbId?: { in?: number[] } } }) => {
    hit("plexLibraryItem.findMany");
    return plexLib.filter((r) => inIds(args.where, r.tmdbId));
  },
});
shadowPrismaModel(prisma, "jellyfinLibraryItem", {
  findMany: async () => {
    hit("jellyfinLibraryItem.findMany");
    return [];
  },
});
const PLAYED = new Date("2025-03-01T00:00:00.000Z");
const firstPlays = [{ source: "plex", serverInstance: "", _min: { startedAt: new Date("2023-06-01T00:00:00.000Z") } }];
shadowPrismaModel(prisma, "playHistory", {
  groupBy: async (args: { by: string[] }) => {
    const shape = args.by.join(",");
    if (shape === "source,serverInstance") return firstPlays;
    hit(`playHistory.groupBy:${shape}`);
    if (shape === "tmdbId,mediaType") {
      return [
        { tmdbId: 100, mediaType: "MOVIE", _count: { _all: 2 }, _max: { startedAt: PLAYED } },
        { tmdbId: 300, mediaType: "TV", _count: { _all: 5 }, _max: { startedAt: PLAYED } },
      ];
    }
    if (shape === "tmdbId,seasonNumber") return [{ tmdbId: 300, seasonNumber: 1, _count: { _all: 5 }, _max: { startedAt: PLAYED } }];
    return [];
  },
});
// When set, the session read waits on it — parks a computation mid-load.
let sessionsGate: Promise<void> | null = null;
shadowPrismaModel(prisma, "activeSession", {
  findMany: async () => {
    hit("activeSession.findMany");
    if (sessionsGate) await sessionsGate;
    return [];
  },
});
shadowPrismaModel(prisma, "upstreamWatchEvidence", {
  findMany: async () => {
    hit("upstreamWatchEvidence.findMany");
    return [];
  },
});
shadowPrismaModel(prisma, "mediaRequest", {
  groupBy: async () => {
    hit("mediaRequest.groupBy");
    return [];
  },
  findMany: async () => [],
});
const votes = [
  { tmdbId: 100, mediaType: "MOVIE", n: 2 },
  { tmdbId: 600, mediaType: "TV", n: 1 },
];
shadowPrismaModel(prisma, "deletionVote", {
  groupBy: async (args: { where?: { tmdbId?: { in?: number[] } } }) =>
    votes.filter((v) => inIds(args.where, v.tmdbId)).map((v) => ({ tmdbId: v.tmdbId, mediaType: v.mediaType, _count: { _all: v.n } })),
});
shadowPrismaModel(prisma, "watchlistItem", { groupBy: async () => [] });
// 250 is protected: never-watched, but no cleanup candidate.
shadowPrismaModel(prisma, "cleanupProtection", {
  findMany: async (args: { where?: { tmdbId?: { in?: number[] } } }) =>
    [{ tmdbId: 250, mediaType: "MOVIE" }].filter((p) => inIds(args.where, p.tmdbId)),
});
shadowPrismaModel(prisma, "tmdbMediaCore", { findMany: async () => [] });
shadowPrismaModel(prisma, "tmdbCache", { findMany: async () => [], findUnique: async () => null });
// The season facts read (TVEpisodeCache): show 300 has two seasons on the server.
shadowPrismaClientMethod(prisma, "$queryRaw", async (first: { sql?: string } | TemplateStringsArray) => {
  const sql = Array.isArray(first) ? first.join("?") : String((first as { sql?: string }).sql ?? "");
  if (!sql.includes("TVEpisodeCache")) throw new Error(`unexpected raw query: ${sql}`);
  hit(SEASON_READ);
  return [
    { tmdbId: 300, seasonNumber: 1, episodes: 5, firstAddedAt: ADDED, lastAddedAt: ADDED, undated: 0, plexEpisodes: 5, jellyfinEpisodes: 0 },
    { tmdbId: 300, seasonNumber: 2, episodes: 4, firstAddedAt: ADDED, lastAddedAt: ADDED, undated: 0, plexEpisodes: 4, jellyfinEpisodes: 0 },
  ];
});

const stats = await import("../src/lib/admin-stats-data.ts");
const { computeCleanupReport, loadCleanupTitles } = await import("../src/lib/library-cleanup-data.ts");
const nwReport = await import("../src/lib/never-watched-report.ts");
const { shareLibraryWatchFacts } = await import("../src/lib/never-watched-data.ts");
const { _setArrListingRetryDelayForTests, getCachedArrLibraryIndex, invalidateArrLibraryIndexCache } = await import("../src/lib/library-cleanup-arr.ts");
_setArrListingRetryDelayForTests(0);

const NOW = new Date("2026-06-01T00:00:00.000Z");

function setFeatures(cleanup: boolean, neverWatched: boolean) {
  settings.set("feature.admin.cleanup", String(cleanup));
  settings.set("feature.admin.neverWatched", String(neverWatched));
  invalidateFeatureFlagCache();
}

beforeEach(() => {
  reads = new Map();
  sessionsGate = null;
  settings.clear();
  for (const [k, v] of Object.entries({
    playHistoryEnabled: "true",
    playHistoryPlexEnabled: "true",
    cleanupVotesEnabled: "true",
    cleanupVotesMin: "1",
    cleanupNeverWatchedEnabled: "true",
    cleanupNeverWatchedDays: "30",
    cleanupMinAgeDays: "0",
    // No upstream snapshot here: let the watch rules reach candidates.
    cleanupRequireUpstreamCheck: "false",
    radarrUrl: RADARR, radarrApiKey: "radarr-key",
    sonarrUrl: SONARR, sonarrApiKey: "sonarr-key",
  })) settings.set(k, v);
  setFeatures(true, true);
  // Every cache in the path is process-wide: start each test cold.
  invalidateArrLibraryIndexCache();
  nwReport.invalidateNeverWatchedReport();
});

// What /admin/stats derives from each report (computeStorageStats).
const reclaimableOf = (r: Awaited<ReturnType<typeof computeCleanupReport>>) => {
  const candidates = r.rows.filter((row) => row.candidate);
  return { titles: candidates.length, bytes: candidates.reduce((sum, row) => sum + (row.sizeOnDisk ?? 0), 0) };
};
const neverWatchedOf = (r: Awaited<ReturnType<typeof nwReport.computeNeverWatchedReport>>) => ({
  titles: r.totals.never.titles,
  bytes: r.totals.never.bytes,
  seasons: r.totals.seasons.count,
  seasonBytes: r.totals.seasons.bytes,
  unknown: r.totals.unknown + r.seasons.filter((s) => s.state === "unobservable").length,
  possible: r.totals.possible + r.seasons.filter((s) => s.state === "possiblyWatched").length,
  trackingOn: r.trackingOn,
});

test("one stats computation runs the whole-library watch-facts reads ONCE, for both figures", async () => {
  const s = await stats.getStorageStats({ fresh: true });
  assert.deepEqual(factLoads(), expectLoads(1));
  assert.equal(count(SEASON_READ), 1, "the season facts the never-watched report needs, read once");
  // Both figures were computed (non-trivially) from that one load.
  // 100 and 600 by votes, 200 and 400 never watched (400 has no copy to size).
  assert.deepEqual(s.reclaimable, { titles: 4, bytes: 1_000 + 2_000 + 6_000 });
  // 200, 250 (protected: no candidate), 400 (no copy: unsized), 600; show 300's season 2.
  assert.deepEqual(s.neverWatched, { titles: 4, bytes: 2_000 + 2_500 + 6_000, seasons: 1, seasonBytes: 0, unknown: 0, possible: 0, trackingOn: true });
});

test("the stats figures equal what each function computes on its own from the same data", async () => {
  const s = await stats.getStorageStats({ fresh: true });
  const { index } = await getCachedArrLibraryIndex();
  const now = new Date();
  const cleanupAlone = await computeCleanupReport(index, now, undefined, { resolveTargets: true, crossRef: "cached" });
  const nwAlone = await nwReport.computeNeverWatchedReport({ now });
  assert.deepEqual(s.reclaimable, reclaimableOf(cleanupAlone));
  assert.deepEqual(s.neverWatched, neverWatchedOf(nwAlone));
});

test("each computation's WHOLE result is unchanged by the shared load (same index, same now)", async () => {
  const { index, at } = await getCachedArrLibraryIndex();
  // Seasons on: the cleanup report reads the same titles either way.
  const shared = shareLibraryWatchFacts(index, at, { now: NOW, seasons: true });
  const cleanupShared = await computeCleanupReport(index, NOW, undefined, { resolveTargets: true, crossRef: "cached", shared });
  const nwShared = await nwReport.computeNeverWatchedReport({ shared });
  assert.deepEqual(factLoads(), expectLoads(1), "both from the one load");
  reads = new Map();
  const cleanupAlone = await computeCleanupReport(index, NOW, undefined, { resolveTargets: true, crossRef: "cached" });
  const nwAlone = await nwReport.computeNeverWatchedReport({ now: NOW });
  assert.deepEqual(factLoads(), expectLoads(2), "alone, each loads its own");
  assert.deepEqual(cleanupShared, cleanupAlone);
  assert.deepEqual(nwShared, nwAlone);
  // The cleanup report without seasons, as the page and the dry run read it.
  const noSeasons = shareLibraryWatchFacts(index, at, { now: NOW, seasons: false });
  assert.deepEqual(await computeCleanupReport(index, NOW, undefined, { resolveTargets: true, crossRef: "cached", shared: noSeasons }), cleanupAlone);
});

test("the never-watched report built from the shared load is stored for the page", async () => {
  const s = await stats.getStorageStats({ fresh: true });
  reads = new Map();
  const page = await nwReport.getNeverWatchedReport();
  assert.deepEqual(factLoads(), expectLoads(0), "the page reads the report the stats computation stored");
  assert.deepEqual(neverWatchedOf(page), s.neverWatched);
});

test("a warm never-watched cache: the stats computation loads only the cleanup report's facts, once", async () => {
  await nwReport.getNeverWatchedReport();
  reads = new Map();
  await stats.getStorageStats({ fresh: true });
  assert.deepEqual(factLoads(), expectLoads(1));
  assert.equal(count(SEASON_READ), 1, "seasons: the never-watched page is on");
});

test("either feature off: one load, and no season read without the never-watched report", async () => {
  setFeatures(true, false);
  const a = await stats.getStorageStats({ fresh: true });
  assert.deepEqual(factLoads(), expectLoads(1));
  assert.equal(count(SEASON_READ), 0);
  assert.equal(a.neverWatched, null);
  assert.ok(a.reclaimable);

  reads = new Map();
  setFeatures(false, true);
  nwReport.invalidateNeverWatchedReport();
  const b = await stats.getStorageStats({ fresh: true });
  assert.deepEqual(factLoads(), expectLoads(1));
  assert.equal(b.reclaimable, null);
  assert.ok(b.neverWatched);

  reads = new Map();
  setFeatures(false, false);
  await stats.getStorageStats({ fresh: true });
  assert.deepEqual(factLoads(), expectLoads(0));
});

test("a shared load that STARTED before the report's call is never stored (19b)", async () => {
  const { index, at } = await getCachedArrLibraryIndex();
  const shared = shareLibraryWatchFacts(index, at, { now: NOW, seasons: true });
  await shared.load();
  const report = await nwReport.getNeverWatchedReport({ shared });
  assert.equal(report.computedAt, NOW.toISOString(), "computed from the shared load");
  assert.deepEqual(factLoads(), expectLoads(1));
  reads = new Map();
  await nwReport.getNeverWatchedReport();
  assert.deepEqual(factLoads(), expectLoads(1), "nothing was stored: the page computes its own");
});

test("a shared index the arr cache dropped since (Add / Remove / cleanup delete) is never stored", async () => {
  const { index, at } = await getCachedArrLibraryIndex();
  const shared = shareLibraryWatchFacts(index, at, { now: NOW, seasons: true });
  // What the title manager's Add and Remove and the cleanup delete do.
  invalidateArrLibraryIndexCache();
  nwReport.invalidateNeverWatchedReport();
  await nwReport.getNeverWatchedReport({ shared });
  reads = new Map();
  await nwReport.getNeverWatchedReport();
  assert.deepEqual(factLoads(), expectLoads(1), "nothing was stored");
});

test("an invalidation landing while the shared computation runs is never stored", async () => {
  const { index, at } = await getCachedArrLibraryIndex();
  const shared = shareLibraryWatchFacts(index, at, { now: NOW, seasons: true });
  let release!: () => void;
  sessionsGate = new Promise<void>((r) => { release = r; });
  const pending = nwReport.getNeverWatchedReport({ shared });
  for (let i = 0; i < 50 && count("activeSession.findMany") === 0; i++) await new Promise((r) => setImmediate(r));
  assert.equal(count("activeSession.findMany"), 1, "parked inside the shared load");
  nwReport.invalidateNeverWatchedReport();
  sessionsGate = null;
  release();
  await pending;
  reads = new Map();
  await nwReport.getNeverWatchedReport();
  assert.deepEqual(factLoads(), expectLoads(1), "nothing was stored");
});

test("a shared load that doesn't fit the read it replaces throws instead of standing in for it", async () => {
  const { index, at } = await getCachedArrLibraryIndex();
  const shared = shareLibraryWatchFacts(index, at, { now: NOW, seasons: true });
  const other = { byKey: new Map(), tvdbOnly: new Map(), errors: [] };
  await assert.rejects(computeCleanupReport(other, NOW, undefined, { shared }), /another Radarr\/Sonarr index/);
  await assert.rejects(computeCleanupReport(index, new Date(NOW.getTime() + 1), undefined, { shared }), /another now/);
  await assert.rejects(loadCleanupTitles(index, [{ tmdbId: 100, mediaType: "MOVIE" }], { now: NOW, shared }), /a narrowed read/);
  await assert.rejects(
    nwReport.computeNeverWatchedReport({ shared: shareLibraryWatchFacts(index, at, { now: NOW, seasons: false }) }),
    /no seasons/,
  );
  await assert.rejects(nwReport.computeNeverWatchedReport({ shared, now: new Date(NOW.getTime() + 1) }), /another now/);
  assert.deepEqual(factLoads(), expectLoads(0), "refused before any read");
});
