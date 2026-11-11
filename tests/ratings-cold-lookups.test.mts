// What a ratings request may make Summonarr fetch upstream for titles it has
// never cached ("cold" titles), and how concurrent requests share that work.
// src/lib/omdb-availability.ts (attachRatingsUnified) and the
// /api/ratings/batch route that drives it for every grid of cards.
//
// Pinned here, each mutation-verified:
//   - the route awaits at most ITS inline cap of OMDb chains (TMDB external_ids
//     + OMDb) and leaves the rest of a 200-title cold batch to after();
//   - past the per-user hourly budget of cold titles the route answers from the
//     cache only: no upstream call, nothing deferred;
//   - two concurrent deferred passes over the same cold titles send ONE MDBList
//     batch between them, and the pass that didn't send it doesn't chase those
//     titles through OMDb either.
//
// No DB or network: prisma is shadowed in-memory (tests/_helpers.mts), fetch is
// scripted per host, dns/promises.lookup is stubbed, and a synthetic Next
// request scope collects after() callbacks instead of running them.
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { AsyncLocalStorage } from "node:async_hooks";
import dns from "node:dns/promises";
import type { TmdbMedia } from "../src/lib/tmdb-types.ts";

(globalThis as { AsyncLocalStorage?: unknown }).AsyncLocalStorage = AsyncLocalStorage;

process.env.TOKEN_ENCRYPTION_KEY = "ab".repeat(32);
process.env.NEXTAUTH_SECRET = "ratings-cold-lookups-secret-0123456789";
process.env.AUTH_URL = "http://localhost:3000";
process.env.TRUST_PROXY = "true";
process.env.TMDB_READ_TOKEN = "test-tmdb-read-token";
(process.env as Record<string, string | undefined>).NODE_ENV = "test";

const fakeLookup = async () => [{ address: "93.184.216.34", family: 4 }];
(dns as { lookup: unknown }).lookup = fakeLookup;
if ((dns as { lookup: unknown }).lookup !== fakeLookup) throw new Error("could not stub dns.lookup");

console.warn = () => {};
console.error = () => {};

const cjsRequire = createRequire(import.meta.url);
type RunStore = { run<T>(store: unknown, fn: () => T): T };
const { workAsyncStorage } = cjsRequire("next/dist/server/app-render/work-async-storage.external.js") as { workAsyncStorage: RunStore };
const { workUnitAsyncStorage } = cjsRequire("next/dist/server/app-render/work-unit-async-storage.external.js") as { workUnitAsyncStorage: RunStore };
const { RequestCookies } = cjsRequire("next/dist/server/web/spec-extension/cookies.js") as { RequestCookies: new (h: Headers) => unknown };
const { RequestCookiesAdapter } = cjsRequire("next/dist/server/web/spec-extension/adapters/request-cookies.js") as { RequestCookiesAdapter: { seal(c: unknown): unknown } };
const { HeadersAdapter } = cjsRequire("next/dist/server/web/spec-extension/adapters/headers.js") as { HeadersAdapter: { seal(h: Headers): unknown } };

const { NextRequest } = await import("next/server");
const { prisma } = await import("../src/lib/prisma.ts");
const { shadowPrismaModel } = await import("./_helpers.mts");
const { signSessionJwt } = await import("../src/lib/session-jwt.ts");
const { getSessionCookieName } = await import("../src/lib/session-cookie.ts");

// The one per-user budget (src/lib/ratings-cold-budget.ts), spelled out here so
// a changed number is a deliberate edit in two places.
const ROUTE_MAX_BLOCKING_MISSES = 40;
const COLD_LOOKUP_BUDGET = 600;
const budget = await import("../src/lib/ratings-cold-budget.ts");
if (budget.COLD_LOOKUP_BUDGET !== COLD_LOOKUP_BUDGET || budget.USER_MAX_BLOCKING_MISSES !== ROUTE_MAX_BLOCKING_MISSES) {
  throw new Error("ratings-cold-budget.ts numbers changed: update this file's copies on purpose");
}

// ── auth fixture ─────────────────────────────────────────────────────────────
const usersById = new Map<string, Record<string, unknown>>();
const sessionRows = new Set<string>();
shadowPrismaModel(prisma, "authSession", {
  findUnique: async (args: { where: { sessionId: string } }) =>
    sessionRows.has(args.where.sessionId) ? { id: `row-${args.where.sessionId}`, sessionId: args.where.sessionId } : null,
  update: async () => ({}),
});
shadowPrismaModel(prisma, "user", {
  findUnique: async (args: { where: { id: string } }) => usersById.get(args.where.id) ?? null,
  findMany: async () => [],
});

let seq = 0;
async function mintSession(): Promise<string> {
  seq++;
  const userId = `viewer-${seq}`;
  const sessionId = `sess-${seq}`;
  usersById.set(userId, {
    id: userId, name: `Viewer ${seq}`, email: `viewer-${seq}@example.com`, role: "USER",
    permissions: 0n, mediaServer: null, sessionsRevokedAt: null,
    passwordChangedAt: null, deactivatedAt: null, notificationEmail: null,
  });
  sessionRows.add(sessionId);
  const iat = Math.floor(Date.now() / 1000);
  return signSessionJwt(
    { id: userId, role: "USER", permissions: "0", provider: "credentials", sessionId, expiresAt: iat + 86_400 },
    { expiresInSeconds: 7_200, iat },
  );
}
const COOKIE = getSessionCookieName();

// ── settings and cache ───────────────────────────────────────────────────────
// Both providers are configured throughout (the API keys are memoized for 30s,
// so they never change in this file).
shadowPrismaModel(prisma, "setting", {
  findUnique: async (args: { where: { key: string } }) => {
    if (args.where.key === "omdbApiKey") return { key: "omdbApiKey", value: "test-omdb-key" };
    if (args.where.key === "mdblistApiKey") return { key: "mdblistApiKey", value: "test-mdblist-key" };
    return null;
  },
});
// GET /api/ratings reads the title's release year for its cache TTL bucket.
shadowPrismaModel(prisma, "tmdbMediaCore", { findUnique: async () => null });
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

// ── scripted fetch ───────────────────────────────────────────────────────────
// MDBList answers every batch POST with an EMPTY array (no ratings, nothing
// negative-cached) and every single-title probe with 404, so every miss falls
// through to OMDb. OMDb rates everything.
type Call = { host: string; path: string; method: string; ids: number[] };
const calls: Call[] = [];
let holdMdblistBatch: Promise<void> | null = null;
let markBatchSent: () => void = () => {};
// Switches for the tests that need MDBList to rate: the batch POST, or the
// single-title endpoint.
let batchRated = false;
let singleRated = false;
const ratedRow = (id: number) => ({ tmdb_id: id, ratings: [{ source: "imdb", value: 7.5, votes: 1000 }] });
globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
  const url = new URL(String(input));
  const method = init?.method ?? "GET";
  const ids = typeof init?.body === "string" ? ((JSON.parse(init.body) as { ids?: number[] }).ids ?? []) : [];
  calls.push({ host: url.hostname, path: url.pathname, method, ids });
  const json = (body: unknown, status = 200) =>
    new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
  if (url.hostname === "api.mdblist.com") {
    if (method === "POST") {
      // Only the FIRST batch is held open; any later one answers at once.
      const first = calls.filter((c) => c.host === "api.mdblist.com" && c.method === "POST").length === 1;
      if (first) markBatchSent();
      if (first && holdMdblistBatch) await holdMdblistBatch;
      return json(batchRated ? ids.map(ratedRow) : []);
    }
    if (singleRated) return json(ratedRow(Number(url.pathname.match(/\/(\d+)\/?$/)?.[1] ?? 0)));
    return json({ error: "not found" }, 404);
  }
  if (url.hostname === "api.themoviedb.org") {
    const id = url.pathname.match(/\/(\d+)\/external_ids$/)?.[1] ?? "0";
    return json({ imdb_id: `tt${id.padStart(7, "0")}` });
  }
  if (url.hostname === "www.omdbapi.com") return json({ Response: "True", imdbRating: "7.0" });
  return new Response("unexpected host", { status: 500 });
}) as typeof fetch;

const omdbCalls = () => calls.filter((c) => c.host === "www.omdbapi.com").length;
const batchPosts = () => calls.filter((c) => c.host === "api.mdblist.com" && c.method === "POST");

// ── scope ────────────────────────────────────────────────────────────────────
const afterTasks: Array<() => Promise<unknown>> = [];
function inScope<T>(fn: () => Promise<T>): Promise<T> {
  const workStore = {
    route: "/ratings-cold-lookups.test", forceStatic: false, dynamicShouldError: false,
    afterContext: {
      after: (t: unknown) => { afterTasks.push(typeof t === "function" ? (t as () => Promise<unknown>) : async () => t); },
    },
  };
  const reqHeaders = new Headers();
  const requestStore = {
    type: "request", phase: "render",
    headers: HeadersAdapter.seal(reqHeaders),
    cookies: RequestCookiesAdapter.seal(new RequestCookies(reqHeaders)),
    usedDynamic: false,
  };
  return workAsyncStorage.run(workStore, () => workUnitAsyncStorage.run(requestStore, fn));
}

const ratingsBatch = await import("../src/app/api/ratings/batch/route.ts");
const { attachRatingsUnified } = await import("../src/lib/omdb-availability.ts");

function postBatch(token: string, ids: number[]): Promise<Response> {
  const req = new NextRequest("http://localhost:3000/api/ratings/batch", {
    method: "POST",
    headers: { cookie: `${COOKIE}=${token}`, "content-type": "application/json" },
    body: JSON.stringify({ items: ids.map((id) => ({ id, type: "movie" })) }),
  });
  return inScope(() => ratingsBatch.POST(req, undefined));
}

const ratingsSingle = await import("../src/app/api/ratings/route.ts");
function getRating(token: string, id: number): Promise<Response> {
  const req = new NextRequest(`http://localhost:3000/api/ratings?id=${id}&type=movie`, {
    headers: { cookie: `${COOKIE}=${token}` },
  });
  return inScope(() => ratingsSingle.GET(req, undefined));
}

function movie(id: number): TmdbMedia {
  return {
    id, mediaType: "movie", title: "", overview: "", posterPath: null, backdropPath: null,
    releaseDate: null, releaseYear: null, voteAverage: 0,
  };
}

const range = (from: number, count: number) => Array.from({ length: count }, (_, i) => from + i);

beforeEach(() => {
  calls.length = 0;
  afterTasks.length = 0;
  holdMdblistBatch = null;
  markBatchSent = () => {};
  batchRated = false;
  singleRated = false;
});

// ── the route ────────────────────────────────────────────────────────────────

test("a 200-title cold batch awaits at most the route's inline cap of OMDb chains; the rest are warmed after the response", async () => {
  const token = await mintSession();
  const res = await postBatch(token, range(10_000, 200));
  assert.equal(res.status, 200);
  assert.equal(omdbCalls(), ROUTE_MAX_BLOCKING_MISSES, "only the inline cap went out before the response");
  const { ratings } = (await res.json()) as { ratings: Record<string, unknown> };
  assert.equal(Object.keys(ratings).length, ROUTE_MAX_BLOCKING_MISSES);

  assert.equal(afterTasks.length, 1, "the overflow is one after() task");
  await afterTasks[0]();
  assert.equal(omdbCalls(), 200, "and it warms the other 160");
});

test("past the hourly cold-lookup budget the route answers from the cache only: no upstream call, nothing deferred", async () => {
  const token = await mintSession();
  // Three calls of 200 distinct cold titles spend the 600.
  for (let i = 0; i < COLD_LOOKUP_BUDGET / 200; i++) {
    assert.equal((await postBatch(token, range(20_000 + i * 200, 200))).status, 200);
  }
  calls.length = 0;
  afterTasks.length = 0;

  const res = await postBatch(token, range(30_000, 200));
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { ratings: {} }, "cold titles have nothing cached yet");
  assert.equal(calls.length, 0, "no MDBList, TMDB or OMDb call");
  assert.equal(afterTasks.length, 0, "and nothing left to run after the response");

  // Another user's budget is their own.
  const other = await mintSession();
  await postBatch(other, range(40_000, 10));
  assert.ok(omdbCalls() > 0, "a fresh user's cold titles still go upstream");
});

// ── one budget, every surface ───────────────────────────────────────────────

test("GET /api/ratings spends the same budget: once the batch route has used it up, a cold title is answered from the cache only", async () => {
  const token = await mintSession();
  for (let i = 0; i < COLD_LOOKUP_BUDGET / 200; i++) {
    assert.equal((await postBatch(token, range(80_000 + i * 200, 200))).status, 200);
  }
  calls.length = 0;
  afterTasks.length = 0;

  const cold = await getRating(token, 81_000);
  assert.equal(cold.status, 200);
  assert.equal(await cold.json(), null, "nothing is cached for it yet");
  assert.equal(calls.length, 0, "no MDBList, TMDB or OMDb call for the cold title");

  // A title the cache already rates is still answered (80_000 got its OMDb row
  // from the first batch call), again with no upstream call.
  const cached = await getRating(token, 80_000);
  assert.equal(((await cached.json()) as { imdbRating: string | null }).imdbRating, "7.0");
  assert.equal(calls.length, 0, "served from the cache");

  // Another user's budget is their own.
  const other = await mintSession();
  const fresh = await getRating(other, 81_001);
  assert.equal(((await fresh.json()) as { imdbRating: string | null }).imdbRating, "7.0");
  assert.equal(omdbCalls(), 1, "a fresh user's cold title still goes upstream");
});

test("GET /api/ratings charges the budget only for cold titles: 600 cold lookups, then the 601st is cache-only", async () => {
  const token = await mintSession();
  // The route's own 60-a-minute limit would stop a real client long before
  // this; spend the hour's budget directly.
  const user = `viewer-${seq}`; // mintSession's newest user
  for (let i = 0; i < COLD_LOOKUP_BUDGET - 1; i++) assert.equal(budget.admitColdLookup(user), true);

  assert.equal(((await (await getRating(token, 82_000)).json()) as { imdbRating: string }).imdbRating, "7.0", "the 600th cold lookup is admitted");
  const before = calls.length;
  assert.equal(await (await getRating(token, 82_001)).json(), null);
  assert.equal(calls.length, before, "the 601st cold title sends nothing");
});

test("a person's filmography waits for at most the per-request share of cold lookups", async () => {
  // getEnrichedPerson needs a live TMDB person; the wiring is pinned at the
  // source, the behaviour of the option by the batch-route test above.
  const { readFileSync } = await import("node:fs");
  const src = readFileSync(new URL("../src/lib/person.ts", import.meta.url), "utf8");
  assert.match(src, /blockRatings:\s*true,\s*maxBlockingRatingMisses:\s*USER_MAX_BLOCKING_MISSES/);
  const attachAll = readFileSync(new URL("../src/lib/attach-all.ts", import.meta.url), "utf8");
  assert.match(attachAll, /maxBlockingMisses:\s*options\.maxBlockingRatingMisses/);
});

// ── concurrent deferred passes ──────────────────────────────────────────────

test("two concurrent deferred passes over the same cold titles send ONE MDBList batch, and only its sender chases them through OMDb", async () => {
  const items = range(50_000, 3).map(movie);
  let release: () => void = () => {};
  holdMdblistBatch = new Promise<void>((r) => { release = r; });
  const sent = new Promise<void>((r) => { markBatchSent = r; });

  const first = attachRatingsUnified(items, { deferToAfter: false });
  await sent; // the first pass's batch POST is on the wire, unanswered
  // The second pass finds every title already being batched.
  await attachRatingsUnified(items, { deferToAfter: false });
  assert.equal(batchPosts().length, 1, "no second batch for the same titles");
  assert.equal(omdbCalls(), 0, "the second pass left the OMDb fallback to the first");

  release();
  await first;
  assert.equal(batchPosts().length, 1);
  assert.deepEqual(batchPosts()[0].ids, [50_000, 50_001, 50_002]);
  assert.equal(omdbCalls(), 3, "the first pass's own fallback ran once per title");
});

test("two concurrent BLOCKING passes over the same cold titles send ONE MDBList batch, and the second serves its answer inline", async () => {
  const items = range(60_000, 2).map(movie);
  batchRated = true;
  let release: () => void = () => {};
  holdMdblistBatch = new Promise<void>((r) => { release = r; });
  const sent = new Promise<void>((r) => { markBatchSent = r; });

  const first = attachRatingsUnified(items, { blocking: true, deferToAfter: false });
  await sent; // the first pass's batch POST is on the wire, unanswered
  const second = attachRatingsUnified(items, { blocking: true, deferToAfter: false });
  release();
  const [a, b] = await Promise.all([first, second]);

  assert.equal(batchPosts().length, 1, "the second pass waits on the batch in flight instead of buying the same ids again");
  assert.deepEqual(a.map((m) => m.imdbRating), ["7.5", "7.5"]);
  assert.deepEqual(b.map((m) => m.imdbRating), ["7.5", "7.5"], "and serves its answer in this response");
  assert.equal(omdbCalls(), 0);
});

test("every title MDBList's batch could not rate goes to OMDb — no single-title probe decides for the whole page", async () => {
  // The single-title endpoint would rate anything; one probe of it used to
  // decide that the whole page needed no OMDb fallback at all.
  singleRated = true;
  const rated = await attachRatingsUnified(range(70_000, 3).map(movie), { blocking: true, deferToAfter: false });
  assert.equal(calls.filter((c) => c.host === "api.mdblist.com" && c.method === "GET").length, 0, "no probe");
  assert.equal(omdbCalls(), 3);
  assert.deepEqual(rated.map((m) => m.imdbRating), ["7.0", "7.0", "7.0"]);
});
