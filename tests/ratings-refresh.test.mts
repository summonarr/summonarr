// Unit tests for the REFRESH half of attachRatingsUnified
// (src/lib/omdb-availability.ts): how many upstream calls a batch's stale-row
// refresh may run at once, and WHEN it runs. tests/omdb-availability.test.mts
// covers the pure arbitration gate and stays network-free on purpose; this is
// the scripted-fetch counterpart.
//
// Why it exists: a recommendations run was followed by a wall of
// `[omdb] TMDB external_ids fetch failed (429)` lines. Two things combined:
//   - the stale-OMDB refresh went through getOmdbRatingsForTmdb, which serves
//     the stale row and DETACHES its refresh, so the mapLimit around it bounded
//     only the cache reads; the OMDB fallback for misses did the same whenever
//     a miss already held a stale OMDB row (every title, on an MDBList-less
//     instance);
//   - the verdict pass (blocking:true, one call per 200 titles) still handed
//     those refreshes to after() (Next's "run this once the response is sent"
//     hook), and Next starts every after() callback of a request together, with
//     no limit, once the response closes (guardrail 31a).
//
// Pinned here, each mutation-verified: with deferToAfter:false the refresh runs
// before the call returns and never exceeds OMDB_FALLBACK_CONCURRENCY upstream
// calls, on every route a stale OMDB row can take (the miss fallback with and
// without an MDBList quota lockout, and the stale-OMDB pass); and without it a
// page's call still returns before any upstream call starts, with the queued
// task bounded the same way. The verdict pass's use of the option is pinned in
// tests/recommendations.test.mts.
//
// Half the stale rows are not-found SENTINELS, whose refresh is one TMDB
// external_ids lookup (answered with no imdb_id, so no OMDB call follows); the
// other half are rated VALUE rows, whose refresh reuses the stored imdbId and is
// one OMDB call. Either way one refresh is one upstream call, and each call is
// held open for a moment, which is what makes overlapping calls observable.
//
// No DB or network: prisma.setting / prisma.tmdbCache are shadowed in-memory
// (tests/_helpers.mts), globalThis.fetch is scripted, and dns/promises.lookup is
// stubbed so the safe-fetch SSRF resolver never issues a real lookup.
import { test, beforeEach, mock } from "node:test";
import assert from "node:assert/strict";
import dns from "node:dns/promises";
import { createRequire } from "node:module";
import { AsyncLocalStorage } from "node:async_hooks";
import type { TmdbMedia } from "../src/lib/tmdb-types.ts";

// Next's async-local-storage shim captures globalThis.AsyncLocalStorage at
// module load — assign it BEFORE anything pulls in next/server.
(globalThis as { AsyncLocalStorage?: unknown }).AsyncLocalStorage = AsyncLocalStorage;

process.env.TOKEN_ENCRYPTION_KEY = "ab".repeat(32); // prisma.ts pulls in token-crypto
process.env.TMDB_READ_TOKEN = "test-tmdb-token"; // tmdbAuth() reads this per call

// Only Date is mocked (timers stay real, so held responses still resolve): the
// last test steps past mdblist.ts's 30s API-key memo.
const T0 = Date.UTC(2026, 0, 15, 12, 0, 0);
mock.timers.enable({ apis: ["Date"], now: T0 });
let clockNow = T0;
function advanceClock(ms: number): void {
  clockNow += ms;
  mock.timers.setTime(clockNow);
}
const DAY_MS = 24 * 60 * 60 * 1000;
const OMDB_FALLBACK_CONCURRENCY = 6; // mirrors src/lib/omdb-availability.ts
const TITLES = 12; // twice the limit, so an unbounded fan-out cannot pass

// ── DNS stub (see tests/omdb-quota.test.mts for the rationale) ──────────────
const fakeLookup = async () => [{ address: "93.184.216.34", family: 4 }];
(dns as { lookup: unknown }).lookup = fakeLookup;
if ((dns as { lookup: unknown }).lookup !== fakeLookup) {
  throw new Error("could not stub dns.lookup — aborting before a real DNS query can leave the process");
}

// ── console capture ─────────────────────────────────────────────────────────
console.warn = () => {};
console.error = () => {};

// The storage singletons after() reads. createRequire (not import) gets the
// exact CJS instances next/server's after() itself loads.
type RunStore = { run<T>(store: unknown, fn: () => T): T };
const cjsRequire = createRequire(import.meta.url);
const { workAsyncStorage } = cjsRequire("next/dist/server/app-render/work-async-storage.external.js") as { workAsyncStorage: RunStore };
const { workUnitAsyncStorage } = cjsRequire("next/dist/server/app-render/work-unit-async-storage.external.js") as { workUnitAsyncStorage: RunStore };

const { prisma } = await import("../src/lib/prisma.ts");
const { shadowPrismaModel } = await import("./_helpers.mts");
const { attachRatingsUnified } = await import("../src/lib/omdb-availability.ts");
const { fetchMdblistBatch, isMdblistQuotaLocked } = await import("../src/lib/mdblist.ts");

// ── prisma stubs ────────────────────────────────────────────────────────────
// OMDB is configured throughout. MDBList is not, until the last test.
let mdblistKeyValue: string | null = null;
shadowPrismaModel(prisma, "setting", {
  findUnique: async (args: { where: { key: string } }) => {
    if (args.where.key === "omdbApiKey") return { key: "omdbApiKey", value: "test-omdb-key" };
    if (args.where.key === "mdblistApiKey" && mdblistKeyValue !== null) return { key: "mdblistApiKey", value: mdblistKeyValue };
    return null;
  },
});

type CacheRow = { key: string; data: string; cachedAt: Date; expiresAt: Date };
const cacheRows = new Map<string, CacheRow>();
shadowPrismaModel(prisma, "tmdbCache", {
  findUnique: async (args: { where: { key: string } }) => cacheRows.get(args.where.key) ?? null,
  findMany: async (args: { where: { key: { in: string[] } } }) =>
    args.where.key.in.flatMap((k) => {
      const row = cacheRows.get(k);
      return row ? [row] : [];
    }),
  upsert: async (args: { where: { key: string }; create: CacheRow }) => {
    cacheRows.set(args.where.key, args.create);
    return args.create;
  },
});

// ── scripted fetch ──────────────────────────────────────────────────────────
const UPSTREAM_HOSTS = new Set(["api.themoviedb.org", "www.omdbapi.com"]);
const fetchHosts: string[] = [];
let upstreamInFlight = 0;
let upstreamPeak = 0;
globalThis.fetch = (async (input: RequestInfo | URL) => {
  const url = new URL(String(input));
  fetchHosts.push(url.hostname);
  if (url.hostname === "api.mdblist.com") {
    return new Response(JSON.stringify({ error: "rate limited" }), { status: 429 });
  }
  if (!UPSTREAM_HOSTS.has(url.hostname)) {
    return new Response("unexpected host", { status: 500 });
  }
  upstreamInFlight++;
  upstreamPeak = Math.max(upstreamPeak, upstreamInFlight);
  try {
    await new Promise((r) => setTimeout(r, 10));
    const body = url.hostname === "api.themoviedb.org"
      ? { imdb_id: null }
      : { Response: "True", imdbRating: "7.0" };
    return new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
  } finally {
    upstreamInFlight--;
  }
}) as typeof fetch;

// ── helpers ─────────────────────────────────────────────────────────────────
function movie(id: number): TmdbMedia {
  return {
    id,
    mediaType: "movie",
    title: `Movie ${id}`,
    overview: "",
    posterPath: null,
    backdropPath: null,
    releaseDate: "2001-01-01",
    releaseYear: "2001",
    voteAverage: 0,
    voteCount: 0,
  };
}

function seed(key: string, value: unknown, expiresAt: Date): void {
  cacheRows.set(key, { key, data: JSON.stringify(value), cachedAt: new Date(Date.now() - DAY_MS), expiresAt });
}

// The rating every stale VALUE row carries, so a test can see it was served.
const STALE_RATING = "6.0";

// TITLES movies, each holding a STALE OMDB row: even ids a not-found sentinel,
// odd ids a rated value row. `mdblistSentinel` also gives each a FRESH MDBList
// sentinel, which keeps them out of the miss path entirely.
function staleOmdbTitles(firstId: number, opts: { mdblistSentinel?: boolean } = {}): TmdbMedia[] {
  const items = Array.from({ length: TITLES }, (_, i) => movie(firstId + i));
  const staleAt = new Date(Date.now() - 60_000);
  for (const item of items) {
    const value = item.id % 2 === 0
      ? { _notFound: true }
      : { imdbId: `tt${item.id}`, imdbRating: STALE_RATING, imdbVotes: null, rottenTomatoes: null, metacritic: null };
    seed(`omdb:tmdb:movie:${item.id}`, value, staleAt);
    if (opts.mdblistSentinel) seed(`mdblist:tmdb:movie:${item.id}`, { _notFound: true }, new Date(Date.now() + DAY_MS));
  }
  return items;
}

// A minimal request scope whose after() RECORDS the task instead of running it.
function inRequestScope<T>(afterTasks: (() => Promise<unknown>)[], fn: () => Promise<T>): Promise<T> {
  const workStore = {
    route: "/ratings-refresh.test",
    forceStatic: false,
    dynamicShouldError: false,
    afterContext: {
      after: (task: unknown) => {
        afterTasks.push(typeof task === "function" ? (task as () => Promise<unknown>) : async () => task);
      },
    },
  };
  const requestStore = { type: "request", phase: "action" };
  return workAsyncStorage.run(workStore, () => workUnitAsyncStorage.run(requestStore, fn));
}

function assertBoundedRefresh(label: string): void {
  const upstream = fetchHosts.filter((h) => UPSTREAM_HOSTS.has(h));
  assert.equal(upstream.length, TITLES, `${label}: each stale row refreshed exactly once`);
  assert.equal(upstream.filter((h) => h === "www.omdbapi.com").length, TITLES / 2, `${label}: a rated row refreshes by its stored imdbId`);
  assert.equal(upstreamInFlight, 0, `${label}: every refresh finished before it returned`);
  assert.equal(upstreamPeak, OMDB_FALLBACK_CONCURRENCY, `${label}: bounded by the fallback limit, and still parallel`);
}

beforeEach(async () => {
  // A failing test can leave detached refreshes running. Let them finish first,
  // or they land in the next test's counts and blame the wrong pin.
  for (let i = 0; i < 200 && upstreamInFlight > 0; i++) {
    await new Promise((r) => setTimeout(r, 5));
  }
  cacheRows.clear();
  fetchHosts.length = 0;
  upstreamPeak = 0;
});

// ── deferToAfter:false ──────────────────────────────────────────────────────

test("deferToAfter:false on an MDBList-less instance: a stale OMDB row on a miss is served warm, and its refresh is bounded and awaited", async () => {
  // With no MDBList key every title is a miss on every call, so the OMDB
  // fallback sees them all. Before the fix it called the getter on each, which
  // handed back the stale sentinel and detached a refresh: twelve TMDB calls at
  // once under a limit of six. Called outside any request scope, where after()
  // throws, so returning at all proves nothing was deferred.
  const items = staleOmdbTitles(900);

  const out = await attachRatingsUnified(items, { blocking: true, deferToAfter: false });

  assertBoundedRefresh("miss path");
  // Served from the rows the call started with, exactly as the getter used to
  // hand them back: a rated row keeps its rating, a sentinel shows none.
  assert.deepEqual(
    out.map((m) => m.imdbRating ?? null),
    items.map((m) => (m.id % 2 === 0 ? null : STALE_RATING)),
  );
});

test("deferToAfter:false when MDBList answered not-found: the stale-OMDB pass alone is bounded and awaited", async () => {
  // A fresh MDBList sentinel keeps these titles out of the miss path, so the
  // stale-OMDB pass is the only thing that refreshes them.
  const items = staleOmdbTitles(950, { mdblistSentinel: true });

  await attachRatingsUnified(items, { blocking: true, deferToAfter: false });

  assertBoundedRefresh("stale-OMDB pass");
});

// ── the default: pages still defer ──────────────────────────────────────────

test("by default a page's call returns before any refresh starts, blocking or not — the work waits in after()", async () => {
  for (const blocking of [true, false]) {
    cacheRows.clear();
    fetchHosts.length = 0;
    upstreamPeak = 0;
    const items = staleOmdbTitles(blocking ? 1000 : 1050, { mdblistSentinel: true });
    const afterTasks: (() => Promise<unknown>)[] = [];

    await inRequestScope(afterTasks, () => attachRatingsUnified(items, { blocking }));

    assert.equal(fetchHosts.length, 0, `blocking=${blocking}: nothing fetched before the call returned`);
    assert.equal(afterTasks.length, 1, `blocking=${blocking}: one task queued`);
    await afterTasks[0]();
    assertBoundedRefresh(`blocking=${blocking} queued task`);
  }
});

test("a page's queued task on an MDBList-less instance keeps stale OMDB rows out of the miss fallback too", async () => {
  // The non-blocking twin of the first test: here the miss fallback runs inside
  // the after() task, where a detached refresh would escape just the same.
  const items = staleOmdbTitles(1100);
  const afterTasks: (() => Promise<unknown>)[] = [];

  await inRequestScope(afterTasks, () => attachRatingsUnified(items));
  assert.equal(fetchHosts.length, 0);
  assert.equal(afterTasks.length, 1);
  await afterTasks[0]();

  assertBoundedRefresh("queued miss path");
});

// ── MDBList quota-locked ────────────────────────────────────────────────────
// ORDER-DEPENDENT and deliberately LAST: it trips mdblist.ts's module-global
// quota lockout, which has no reset export.

test("with MDBList quota-locked, both miss branches still leave stale OMDB rows to the bounded refresh", async () => {
  mdblistKeyValue = "test-mdblist-key";
  advanceClock(31_000); // past mdblist.ts's 30s API-key memo, which cached "no key"
  await fetchMdblistBatch([{ id: 1 }], "movie"); // scripted 429
  assert.equal(isMdblistQuotaLocked(), true, "precondition: MDBList is locked out");

  fetchHosts.length = 0;
  const blockingItems = staleOmdbTitles(1200);
  await attachRatingsUnified(blockingItems, { blocking: true, deferToAfter: false });
  assertBoundedRefresh("locked, blocking");
  // Equality via some(): fetchHosts holds hostnames, so includes() was already an
  // exact match, but CodeQL reads `.includes("api.mdblist.com")` as a substring
  // host check (js/incomplete-url-substring-sanitization) and fails the gate.
  assert.ok(!fetchHosts.some((h) => h === "api.mdblist.com"), "a locked MDBList is not called");

  cacheRows.clear();
  fetchHosts.length = 0;
  upstreamPeak = 0;
  const pageItems = staleOmdbTitles(1250);
  const afterTasks: (() => Promise<unknown>)[] = [];
  await inRequestScope(afterTasks, () => attachRatingsUnified(pageItems));
  await afterTasks[0]();
  assertBoundedRefresh("locked, queued");
});
