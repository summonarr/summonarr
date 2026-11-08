// How the Radarr/Sonarr client (src/lib/arr.ts and its arr-*.ts siblings) reads
// what Radarr, Sonarr and TMDB answer, end to end against scripted upstreams:
//
//   - QUALITY PROFILE OVERRIDE: one normalized value decides both whether the
//     instance's profiles are fetched and what the add POSTs. An override of 0
//     or NaN used to fetch the profiles (it is falsy) and then POST itself anyway
//     (it survives `??`), which the arr refuses with a 400.
//   - PARTIAL tvdb→tmdb RESOLUTION: a Sonarr series TMDB can't map this run no
//     longer throws away the whole wanted/available result. The resolved series
//     update; the cache refresh keeps every cached row the result doesn't
//     mention, so a series that only failed to resolve is never evicted.
//   - TMDB LOOKUPS run a bounded few at a time, never in batches that wait for
//     their slowest member.
//   - THE SERIES LOOKUP's verified answer is reused for a while (Sonarr's lookup
//     queries its internet metadata service); a miss is not kept.
//   - EPISODES: every episode read asks for its season only, and a missing
//     episode is one policy everywhere — a plain Error before anything is sent,
//     the grab included.
//   - RELEASES: a release the arr sent without what a grab needs is left out of
//     the list instead of failing the whole search; the projection holds the
//     documented wire enum.
//   - CONNECTION TEST: an answer that names no version is refused.
//
// No DB, no network: prisma models are shadowed in memory, dns.lookup is stubbed,
// every arr is an RFC1918 IP literal, and globalThis.fetch is scripted per test.
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import dns from "node:dns/promises";

process.env.NEXTAUTH_SECRET ??= "unit-test-session-secret-0123456789abcdef";
process.env.TOKEN_ENCRYPTION_KEY ??= "ab".repeat(32);
process.env.DATABASE_URL ??= "postgresql://unit:unit@127.0.0.1:9/never_connects";
delete process.env.TMDB_READ_TOKEN;

const fakeLookup = async () => [{ address: "93.184.216.34", family: 4 }];
(dns as { lookup: unknown }).lookup = fakeLookup;
if ((dns as { lookup: unknown }).lookup !== fakeLookup) {
  throw new Error("could not stub dns.lookup — aborting before a real DNS query can leave the process");
}
const warns: string[] = [];
console.warn = (...args: unknown[]) => { warns.push(args.map(String).join(" ")); };
console.error = () => {};

// ── scripted upstreams ──────────────────────────────────────────────────────
type Call = { url: URL; method: string; body?: string };
const calls: Call[] = [];
let route: (call: Call) => Response | Promise<Response> = (c) => { throw new Error(`unexpected fetch ${c.method} ${c.url}`); };

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
  const call: Call = { url: new URL(String(input)), method: init?.method ?? "GET", body: typeof init?.body === "string" ? init.body : undefined };
  calls.push(call);
  return route(call);
}) as unknown as typeof fetch;

const { prisma } = await import("../src/lib/prisma.ts");
const { shadowPrismaModel, shadowPrismaClientMethod } = await import("./_helpers.mts");

const settings = new Map<string, string>();
shadowPrismaModel(prisma, "setting", {
  findMany: async (args: { where: { key: { in: string[] } } }) =>
    args.where.key.in.filter((k) => settings.has(k)).map((k) => ({ key: k, value: settings.get(k)! })),
  findUnique: async (args: { where: { key: string } }) => {
    const value = settings.get(args.where.key);
    return value === undefined ? null : { key: args.where.key, value };
  },
});
shadowPrismaModel(prisma, "user", { findUnique: async () => null });
shadowPrismaModel(prisma, "mediaRequest", { findMany: async () => [] });
const tmdbCache = new Map<string, string>();
shadowPrismaModel(prisma, "tmdbCache", {
  findUnique: async (args: { where: { key: string } }) => {
    const data = tmdbCache.get(args.where.key);
    return data === undefined ? null : { key: args.where.key, data, expiresAt: new Date(Date.now() + 86_400_000) };
  },
  findMany: async (args: { where: { key: { in: string[] } } }) =>
    args.where.key.in.filter((k) => tmdbCache.has(k)).map((k) => ({ key: k, data: tmdbCache.get(k)!, expiresAt: new Date(Date.now() + 86_400_000) })),
  upsert: async (args: { where: { key: string }; create: { data: string } }) => {
    tmdbCache.set(args.where.key, args.create.data);
    return {};
  },
  deleteMany: async () => ({ count: 0 }),
});

// The Sonarr wanted/available cache tables, for the refresh's transaction.
const tables = { sonarrWantedItem: [] as Array<{ tmdbId: number; arrInstance: string }>, sonarrAvailableItem: [] as Array<{ tmdbId: number; arrInstance: string }> };
const tableClient = (name: keyof typeof tables) => ({
  findMany: async (args: { where: { arrInstance: string } }) => tables[name].filter((r) => r.arrInstance === args.where.arrInstance),
  deleteMany: async (args: { where: { arrInstance: string } }) => {
    const before = tables[name].length;
    tables[name] = tables[name].filter((r) => r.arrInstance !== args.where.arrInstance);
    return { count: before - tables[name].length };
  },
  createMany: async (args: { data: Array<{ tmdbId: number; arrInstance: string }> }) => {
    tables[name].push(...args.data);
    return { count: args.data.length };
  },
});
shadowPrismaClientMethod(prisma, "$transaction", async (fn: (tx: unknown) => Promise<unknown>) =>
  fn({ $executeRaw: async () => 0, sonarrWantedItem: tableClient("sonarrWantedItem"), sonarrAvailableItem: tableClient("sonarrAvailableItem") }),
);

const arr = await import("../src/lib/arr.ts");
const { _resetSeriesLookupCacheForTests } = await import("../src/lib/arr-id-map.ts");
const { refreshArrCache } = await import("../src/lib/arr-cache-refresh.ts");

let instance = 0;
let RADARR = "";
let SONARR = "";
beforeEach(() => {
  instance += 1;
  RADARR = `http://10.0.21.${instance}:7878`;
  SONARR = `http://10.0.22.${instance}:8989`;
  calls.length = 0;
  warns.length = 0;
  settings.clear();
  settings.set("radarrUrl", RADARR);
  settings.set("radarrApiKey", "radarr-key");
  settings.set("sonarrUrl", SONARR);
  settings.set("sonarrApiKey", "sonarr-key");
  tmdbCache.clear();
  tables.sonarrWantedItem = [];
  tables.sonarrAvailableItem = [];
  delete process.env.TMDB_READ_TOKEN;
  _resetSeriesLookupCacheForTests();
  route = (c) => { throw new Error(`unexpected fetch ${c.method} ${c.url}`); };
});

const gets = (path: string) => calls.filter((c) => c.method === "GET" && c.url.pathname === path);
const posts = (path: string) => calls.filter((c) => c.method === "POST" && c.url.pathname === path);
const bodyOf = (c: Call) => JSON.parse(c.body!) as Record<string, unknown>;

// ═══ quality profile override ═══════════════════════════════════════════════

const MOVIE = { title: "The Matrix", tmdbId: 603, year: 1999, images: [], titleSlug: "the-matrix-603", status: "released" };
const SERIES = { title: "Game of Thrones", tvdbId: 121361, tmdbId: 1399, year: 2011, images: [], titleSlug: "game-of-thrones", seasons: [{ seasonNumber: 1, monitored: true }], firstAired: "2011-04-17T00:00:00Z", status: "ended" };

function addArrs(profiles: unknown[]) {
  route = (c) => {
    if (c.url.pathname === "/api/v3/movie/lookup") return json([MOVIE]);
    if (c.url.pathname === "/api/v3/series/lookup") return json([SERIES]);
    if (c.url.pathname === "/api/v3/qualityprofile") return json(profiles);
    if ((c.url.pathname === "/api/v3/movie" || c.url.pathname === "/api/v3/series") && c.method === "POST") return json({ id: 1 }, 201);
    throw new Error(`unexpected fetch ${c.method} ${c.url}`);
  };
}

test("override: an override of 0 or NaN is no override — the configured profile is POSTed, no profile list is fetched", async () => {
  settings.set("radarrRootFolder", "/movies");
  settings.set("radarrQualityProfileId", "6");
  settings.set("sonarrRootFolder", "/tv");
  settings.set("sonarrQualityProfileId", "6");
  addArrs([{ id: 1 }]);
  for (const override of [0, Number.NaN, -3]) {
    calls.length = 0;
    await arr.addMovieToRadarr(603, "", override);
    await arr.addSeriesToSonarr(1399, "", override);
    assert.equal(bodyOf(posts("/api/v3/movie")[0]).qualityProfileId, 6, `movie, override ${override}`);
    assert.equal(bodyOf(posts("/api/v3/series")[0]).qualityProfileId, 6, `series, override ${override}`);
    assert.equal(gets("/api/v3/qualityprofile").length, 0, "the configured profile needs no list");
  }
});

test("override: with nothing configured an unusable override falls back to the instance's first usable profile", async () => {
  settings.set("radarrRootFolder", "/movies");
  addArrs([{ id: "x" }, { name: "no id" }, { id: 4 }]);
  await arr.addMovieToRadarr(603, "", 0);
  assert.equal(gets("/api/v3/qualityprofile").length, 1);
  assert.equal(bodyOf(posts("/api/v3/movie")[0]).qualityProfileId, 4);
});

test("override: a real override wins over the configured default and fetches nothing", async () => {
  settings.set("radarrRootFolder", "/movies");
  settings.set("radarrQualityProfileId", "6");
  addArrs([{ id: 1 }]);
  await arr.addMovieToRadarr(603, "", 9);
  assert.equal(bodyOf(posts("/api/v3/movie")[0]).qualityProfileId, 9);
  assert.equal(gets("/api/v3/qualityprofile").length, 0);
});

// ═══ partial tvdb→tmdb resolution ═══════════════════════════════════════════

const complete = (tvdbId: number, tmdbId?: number) => ({
  tvdbId, ...(tmdbId === undefined ? {} : { tmdbId }), seasons: [{ seasonNumber: 1, statistics: { episodeFileCount: 10, episodeCount: 10 } }],
});

test("partial: a series TMDB can't map keeps the result, marked partial — the resolved ones still count", async () => {
  // No TMDB credential: the tvdb-only series can't be resolved this run.
  route = (c) => (c.url.pathname === "/api/v3/series" ? json([complete(10, 100), complete(20)]) : json({}, 500));
  const sets = await arr.getSonarrWantedTmdbIds();
  assert.ok(sets, "a result, not null — one unresolvable series no longer discards the whole library");
  assert.equal(sets.partial, true);
  assert.deepEqual([...sets.available], [100]);
  assert.deepEqual([...sets.wanted], []);
  assert.ok(warns.some((w) => w.includes("resolution incomplete")));

  // A resolved run is complete again.
  tmdbCache.set("tvdb-to-tmdb:20", JSON.stringify({ tmdbId: 200 }));
  const again = await arr.getSonarrWantedTmdbIds();
  assert.equal(again?.partial, undefined);
  assert.deepEqual([...(again?.available ?? [])].sort(), [100, 200]);
});

test("mergePartialWantedSets: unmentioned cached rows stay where they were; mentioned titles take their new table", () => {
  const merged = arr.mergePartialWantedSets(
    { wanted: new Set([1]), available: new Set([2]), partial: true },
    { wanted: [2, 3], available: [1, 4] },
  );
  assert.deepEqual([...merged.wanted].sort(), [1, 3], "2 moved to available; 3 is kept");
  assert.deepEqual([...merged.available].sort(), [2, 4], "1 moved to wanted; 4 is kept");
  const whole = { wanted: new Set([1]), available: new Set<number>() };
  assert.deepEqual(arr.mergePartialWantedSets(whole, { wanted: [9], available: [8] }), { wanted: whole.wanted, available: whole.available }, "a complete result replaces the cache");
});

test("partial: the cache refresh writes what resolved and keeps the rows it can't account for", async () => {
  tables.sonarrWantedItem = [{ tmdbId: 100, arrInstance: "" }, { tmdbId: 200, arrInstance: "" }];
  tables.sonarrAvailableItem = [{ tmdbId: 300, arrInstance: "" }];
  route = (c) => (c.url.pathname === "/api/v3/series" ? json([complete(10, 100), complete(20)]) : json({}, 500));

  const refresh = await refreshArrCache("sonarr");
  assert.equal(refresh.outcome, "written", "a partial result is written, not skipped");
  if (refresh.outcome !== "written") return;
  assert.deepEqual(refresh.syncedSlugs, [""]);
  assert.deepEqual(tables.sonarrAvailableItem.map((r) => r.tmdbId).sort(), [100, 300], "100 completed; 300 kept");
  assert.deepEqual(tables.sonarrWantedItem.map((r) => r.tmdbId), [200], "the unresolvable series' row is kept, not evicted");
  assert.equal(refresh.wanted, 1);
  assert.equal(refresh.available, 2);
});

test("a complete result still replaces the cache wholesale — a series gone from Sonarr is evicted", async () => {
  tables.sonarrWantedItem = [{ tmdbId: 999, arrInstance: "" }];
  route = (c) => (c.url.pathname === "/api/v3/series" ? json([complete(10, 100)]) : json({}, 500));
  const refresh = await refreshArrCache("sonarr");
  assert.equal(refresh.outcome, "written");
  assert.deepEqual(tables.sonarrWantedItem, []);
  assert.deepEqual(tables.sonarrAvailableItem.map((r) => r.tmdbId), [100]);
});

// ═══ TMDB lookups: bounded, not batched ═════════════════════════════════════

test("tvdb→tmdb: lookups run at most five at a time, and one slow lookup holds up no other", async () => {
  process.env.TMDB_READ_TOKEN = "unit-test-tmdb-token";
  let inFlight = 0;
  let maxInFlight = 0;
  const started = new Set<number>();
  let releaseSlow: () => void = () => {};
  const slow = new Promise<void>((resolve) => { releaseSlow = resolve; });
  route = async (c) => {
    const tvdbId = Number(c.url.pathname.split("/").pop());
    started.add(tvdbId);
    inFlight += 1;
    maxInFlight = Math.max(maxInFlight, inFlight);
    if (tvdbId === 1) await slow;
    inFlight -= 1;
    return json({ tv_results: [{ id: tvdbId + 1000 }] });
  };
  const ids = Array.from({ length: 12 }, (_, i) => i + 1);
  const run = arr.resolveTvdbToTmdb(ids);
  // Drain the event loop a bounded number of turns (no timer): every lookup but
  // the slow one finishes, so every id should have started meanwhile.
  for (let turn = 0; turn < 500 && started.size < ids.length; turn++) await new Promise((r) => setImmediate(r));
  assert.equal(started.size, ids.length, "lookups after the slow one's batch started while it was still running");
  releaseSlow();
  const { map, hadErrors } = await run;
  assert.equal(hadErrors, false);
  assert.equal(map.get(12), 1012);
  assert.ok(maxInFlight <= 5, `at most five at once (saw ${maxInFlight})`);
});

test("tvdb→tmdb: an unusable TMDB answer is a failed lookup — not cached, reported as an error", async () => {
  process.env.TMDB_READ_TOKEN = "unit-test-tmdb-token";
  for (const id of ["not-a-number", 0, -4]) {
    route = () => json({ tv_results: [{ id }] });
    const { map, hadErrors } = await arr.resolveTvdbToTmdb([5]);
    assert.equal(hadErrors, true, `id ${id}`);
    assert.equal(map.size, 0, `id ${id}`);
    assert.equal(tmdbCache.has("tvdb-to-tmdb:5"), false, "never cached as 'no such show'");
  }
});

// ═══ the series lookup's answer is reused ═══════════════════════════════════

test("lookup: a verified answer serves the next queue check and first-aired read; a miss is asked again", async () => {
  let lookupAnswer: unknown[] = [{ tmdbId: 888, tvdbId: 777, firstAired: "2026-01-02T00:00:00Z" }];
  route = (c) => {
    if (c.url.pathname === "/api/v3/queue") return json({ records: [{ series: { tvdbId: 777 } }], totalRecords: 1 });
    if (c.url.pathname === "/api/v3/series/lookup") return json(lookupAnswer);
    throw new Error(`unexpected fetch ${c.url}`);
  };
  const lookups = () => gets("/api/v3/series/lookup").length;
  assert.equal(await arr.isSeriesDownloadingInSonarr(888), true);
  assert.equal(await arr.isSeriesDownloadingInSonarr(888), true);
  assert.equal(await arr.getSeriesFirstAired(888), "2026-01-02T00:00:00Z");
  assert.equal(lookups(), 1, "one lookup for three questions about the same show");

  lookupAnswer = [];
  assert.equal(await arr.isSeriesDownloadingInSonarr(999), null);
  assert.equal(await arr.isSeriesDownloadingInSonarr(999), null);
  assert.equal(lookups(), 3, "a miss is never kept: a new show may resolve on the next ask");
});

test("lookup: the webhook's download verify never reads the reused answer — it asks Sonarr itself", async () => {
  route = (c) => {
    if (c.url.pathname === "/api/v3/queue") return json({ records: [{ series: { tvdbId: 777 } }], totalRecords: 1 });
    if (c.url.pathname === "/api/v3/series/lookup") return json([{ tmdbId: 888, tvdbId: 777 }]);
    if (c.url.pathname === "/api/v3/series") return json([complete(777)]);
    throw new Error(`unexpected fetch ${c.url}`);
  };
  await arr.isSeriesDownloadingInSonarr(888);
  const before = gets("/api/v3/series/lookup").length;
  const verdict = await arr.isSeriesDownloadedInSonarr({ tmdbId: 888 });
  assert.equal(verdict?.downloaded, true);
  assert.equal(gets("/api/v3/series/lookup").length, before + 1);
});

// ═══ episodes: one season, one policy ═══════════════════════════════════════

function sonarrWithEpisodes(episodes: unknown[]) {
  route = (c) => {
    if (c.url.pathname === "/api/v3/series") return json([{ id: 21, tvdbId: 81189 }]);
    if (c.url.pathname === "/api/v3/episode") return json(episodes);
    if (c.url.pathname === "/api/v3/release" && c.method === "GET") return json([]);
    if (c.url.pathname === "/api/v3/release" && c.method === "POST") return json({});
    if (c.url.pathname === "/api/v3/command") return json({ id: 1 });
    throw new Error(`unexpected fetch ${c.method} ${c.url}`);
  };
}

test("episodes: every episode read asks for its season only", async () => {
  sonarrWithEpisodes([{ id: 501, seriesId: 21, seasonNumber: 1, episodeNumber: 2 }]);
  await arr.getReleasesForSeries(81189, "EPISODE", 1, 2);
  await arr.grabSeriesRelease(81189, "g", 3, 1, 2);
  await arr.searchEpisodeInSonarr(81189, 1, 2);
  const reads = gets("/api/v3/episode");
  assert.equal(reads.length, 3);
  for (const r of reads) assert.deepEqual([r.url.searchParams.get("seriesId"), r.url.searchParams.get("seasonNumber")], ["21", "1"]);
  assert.deepEqual(bodyOf(posts("/api/v3/release")[0]), { guid: "g", indexerId: 3, seriesId: 21, episodeId: 501 });
});

test("episodes: a missing episode is a plain Error before anything is sent — the grab included", async () => {
  // Another series' episode with the same numbers is not this one's.
  sonarrWithEpisodes([{ id: 900, seriesId: 99, seasonNumber: 1, episodeNumber: 2 }]);
  for (const run of [
    () => arr.getReleasesForSeries(81189, "EPISODE", 1, 2),
    () => arr.grabSeriesRelease(81189, "g", 3, 1, 2, "", { sent: false }),
    () => arr.searchEpisodeInSonarr(81189, 1, 2),
  ]) {
    await assert.rejects(run(), (e: unknown) => e instanceof Error && !(e instanceof arr.ArrItemNotFoundError) && /S1E2 not found/.test(e.message));
  }
  assert.equal(posts("/api/v3/release").length, 0, "no grab was sent");
  assert.equal(posts("/api/v3/command").length, 0);
});

test("episodes: a grab with no episode number names only the series and reads no episodes", async () => {
  sonarrWithEpisodes([]);
  const progress = { sent: false };
  await arr.grabSeriesRelease(81189, "g", 3, 1, null, "", progress);
  assert.equal(progress.sent, true);
  assert.equal(gets("/api/v3/episode").length, 0);
  assert.deepEqual(bodyOf(posts("/api/v3/release")[0]), { guid: "g", indexerId: 3, seriesId: 21 });
});

// ═══ releases ═══════════════════════════════════════════════════════════════

const release = (over: Record<string, unknown> = {}) => ({
  guid: "g1", title: "The.Matrix.1999.1080p", size: 1e9, indexerId: 3, indexer: "NZBgeek", qualityWeight: 10, protocol: "usenet",
  quality: { quality: { id: 7, name: "Bluray-1080p" }, revision: { version: 1 } }, age: 2, rejected: false, rejections: [], downloadAllowed: true,
  ...over,
});

test("releases: one release missing what a grab needs is left out — the search still answers with the rest", async () => {
  route = (c) => {
    if (c.url.pathname === "/api/v3/movie") return json([{ id: 42, tmdbId: 603 }]);
    if (c.url.pathname === "/api/v3/release") {
      return json([
        release(),
        release({ guid: undefined }),
        release({ guid: "g3", quality: null }),
        release({ guid: "g4", indexerId: "3" }),
        release({ guid: "g5", protocol: "unknown", rejections: ["Not wanted", { reason: "object" }], seeders: "many" }),
      ]);
    }
    throw new Error(`unexpected fetch ${c.url}`);
  };
  const list = await arr.getReleasesForMovie(603);
  assert.deepEqual(list.map((r) => r.guid), ["g1", "g5"]);
  const odd = list.find((r) => r.guid === "g5")!;
  assert.equal(odd.protocol, "usenet", "the documented wire enum: anything but a torrent is usenet");
  assert.deepEqual(odd.rejections, ["Not wanted"]);
  assert.equal(odd.seeders, null);
});

test("releases: an answer that isn't a list fails the request's search; the title manager's reads it as none", async () => {
  route = (c) => {
    if (c.url.pathname === "/api/v3/movie") return json([{ id: 42, tmdbId: 603 }]);
    if (c.url.pathname === "/api/v3/release") return json({ message: "odd" });
    throw new Error(`unexpected fetch ${c.url}`);
  };
  await assert.rejects(arr.getReleasesForMovie(603), (e: unknown) => e instanceof Error && /unusable release list/.test(e.message));
  assert.deepEqual(await arr.searchReleasesByArrId({ url: RADARR, apiKey: "k" }, "movieId=42"), []);
});

// ═══ connection test ════════════════════════════════════════════════════════

test("connection test: the version is required, and a present appName must name the service", async () => {
  let status: unknown = { appName: "Radarr" };
  route = () => json(status);
  await assert.rejects(arr.testRadarrConnection(RADARR, "k"), /did not answer like Radarr/);
  status = { version: "5.20.1", appName: "Radarr" };
  assert.equal(await arr.testRadarrConnection(RADARR, "k"), "5.20.1");
  status = { version: "4.0.15" };
  assert.equal(await arr.testSonarrConnection(SONARR, "k"), "4.0.15", "an older build without appName passes");
  status = { version: "4.0.15", appName: "Sonarr" };
  await assert.rejects(arr.testRadarrConnection(RADARR, "k"), /points at Sonarr, not Radarr/);
});
