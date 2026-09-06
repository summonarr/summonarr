// Review 2026-09, package P21 — GET /api/media/[type]/[tmdbId] degrade + ordering pins.
//
//   f47  A credits fetch failure must NOT fail the whole native detail response.
//        getMovieCredits/getTVCredits have no internal degrade (unlike the
//        suggestions helpers), so a bare Promise.all turned an isolated TMDB
//        /credits hiccup into a 502 "Could not load this title" — while the web
//        pages wrap the same helper as `.catch(() => [])`. The route now mirrors
//        that: 200, `cast: []`, one "[media]"-scoped error line (guardrail 7).
//
//   f48  The collection fetch + its availability pass must run in the SAME wave
//        as the suggestions attach, not serialized behind it AND the third
//        (deletionVote / watchlist / hidden) Prisma wave. Pinned by ordering:
//        the /collection/ TMDB fetch must be issued BEFORE the deletionVote read
//        (which the old code always ran first). The best-effort contract is
//        preserved: a failing /collection/ still answers 200 with
//        `collection: null`, and a successful-but-empty one ships `items: []`.
//
// Harness: the discovery-routes pattern — real withAuth handler, a genuine
// signed session JWT, a synthetic Next request scope, in-memory prisma stubs,
// scripted TMDB. No DB, no network.

import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { AsyncLocalStorage } from "node:async_hooks";
import dns from "node:dns/promises";

(globalThis as { AsyncLocalStorage?: unknown }).AsyncLocalStorage = AsyncLocalStorage;

process.env.TOKEN_ENCRYPTION_KEY = "ab".repeat(32);
process.env.NEXTAUTH_SECRET = "review-p21-media-secret-0123456789abc";
process.env.AUTH_URL = "http://localhost:3000";
process.env.TRUST_PROXY = "true";
process.env.TMDB_READ_TOKEN = "test-tmdb-read-token";
(process.env as Record<string, string | undefined>).NODE_ENV = "test";

const fakeLookup = async () => [{ address: "93.184.216.34", family: 4 }];
(dns as { lookup: unknown }).lookup = fakeLookup;
if ((dns as { lookup: unknown }).lookup !== fakeLookup) throw new Error("could not stub dns.lookup");

const errors: string[] = [];
console.warn = () => {};
console.error = (...args: unknown[]) => { errors.push(args.map(String).join(" ")); };

// ── unified op log (TMDB fetches + prisma reads, in issue order) ─────────────
let ops: string[] = [];

// ── scripted TMDB ────────────────────────────────────────────────────────────
let creditsOk = true;
let collectionOk = true;
let collectionParts: unknown[] | undefined = undefined;

const COLLECTION_ID = 2344;
// Fresh ids (not the 603/1399 used elsewhere) so every cache read is a real miss.
const MOVIE_IN_COLLECTION = {
  id: 604, title: "The Matrix Reloaded", overview: "o", poster_path: "/r.jpg", backdrop_path: "/b.jpg",
  release_date: "2003-05-15", vote_average: 7.0, vote_count: 12000, genres: [], runtime: 138,
  belongs_to_collection: { id: COLLECTION_ID, name: "The Matrix Collection" },
};
const MOVIE_STANDALONE = {
  id: 27205, title: "Inception", overview: "o", poster_path: "/i.jpg", backdrop_path: "/b.jpg",
  release_date: "2010-07-16", vote_average: 8.4, vote_count: 30000, genres: [], runtime: 148,
};
const TV = {
  id: 1396, name: "Breaking Bad", overview: "o", poster_path: "/bb.jpg", backdrop_path: "/b.jpg",
  first_air_date: "2008-01-20", vote_average: 8.9, vote_count: 12000, genres: [], seasons: [], number_of_seasons: 5,
};
const PARTS = [
  { id: 603, title: "The Matrix", poster_path: "/m.jpg", release_date: "1999-03-31", overview: "o", vote_average: 8.2, vote_count: 1, genre_ids: [] },
  { id: 604, title: "The Matrix Reloaded", poster_path: "/r.jpg", release_date: "2003-05-15", overview: "o", vote_average: 7.0, vote_count: 1, genre_ids: [] },
];
const CAST = [{ id: 6384, name: "Keanu Reeves", character: "Neo", profile_path: "/k.jpg", order: 0 }];

globalThis.fetch = (async (input: RequestInfo | URL) => {
  const url = new URL(String(input));
  ops.push(`fetch ${url.pathname}`);
  const json = (b: unknown, s = 200) => new Response(JSON.stringify(b), { status: s, headers: { "content-type": "application/json" } });
  if (!(url.hostname === "themoviedb.org" || url.hostname.endsWith(".themoviedb.org"))) return json({});

  if (/\/movie\/604$/.test(url.pathname)) return json(MOVIE_IN_COLLECTION);
  if (/\/movie\/27205$/.test(url.pathname)) return json(MOVIE_STANDALONE);
  if (/\/tv\/1396$/.test(url.pathname)) return json(TV);
  if (/\/(movie|tv)\/\d+\/credits$/.test(url.pathname)) {
    if (!creditsOk) return json({ status_message: "credits down" }, 500);
    return json({ id: 1, cast: CAST, crew: [] });
  }
  if (/\/collection\/\d+$/.test(url.pathname)) {
    if (!collectionOk) return json({ status_message: "collection down" }, 500);
    return json({ id: COLLECTION_ID, parts: collectionParts ?? PARTS });
  }
  if (/\/(movie|tv)\/\d+\/(similar|recommendations|videos|images|watch)/.test(url.pathname)) {
    return json({ page: 1, total_pages: 1, results: [] });
  }
  return json({ page: 1, total_pages: 1, total_results: 0, results: [] });
}) as unknown as typeof fetch;

const cjsRequire = createRequire(import.meta.url);
type RunStore = { run<T>(store: unknown, fn: () => T): T };
const { workAsyncStorage } = cjsRequire("next/dist/server/app-render/work-async-storage.external.js") as { workAsyncStorage: RunStore };
const { workUnitAsyncStorage } = cjsRequire("next/dist/server/app-render/work-unit-async-storage.external.js") as { workUnitAsyncStorage: RunStore };
const { RequestCookies } = cjsRequire("next/dist/server/web/spec-extension/cookies.js") as { RequestCookies: new (h: Headers) => unknown };
const { RequestCookiesAdapter } = cjsRequire("next/dist/server/web/spec-extension/adapters/request-cookies.js") as { RequestCookiesAdapter: { seal(c: unknown): unknown } };
const { HeadersAdapter } = cjsRequire("next/dist/server/web/spec-extension/adapters/headers.js") as { HeadersAdapter: { seal(h: Headers): unknown } };

const { NextRequest } = await import("next/server");
const { prisma } = await import("../src/lib/prisma.ts");
const { shadowPrismaModel, shadowPrismaClientMethod } = await import("./_helpers.mts");
const { signSessionJwt } = await import("../src/lib/session-jwt.ts");
const { getSessionCookieName } = await import("../src/lib/session-cookie.ts");

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
  findMany: async () => [], update: async () => ({}), count: async () => usersById.size,
});

let seq = 0;
async function mintSession(): Promise<{ userId: string; token: string }> {
  seq++;
  const userId = `viewer-${seq}`;
  const sessionId = `sess-${seq}`;
  usersById.set(userId, {
    id: userId, name: `Viewer ${seq}`, email: `viewer-${seq}@example.com`, role: "USER",
    permissions: 0n, mediaServer: null, sessionsRevokedAt: null, passwordChangedAt: null,
    deactivatedAt: null, notificationEmail: null, mediaServerGrants: null, maxContentRating: null,
  });
  sessionRows.add(sessionId);
  const iat = Math.floor(Date.now() / 1000);
  const token = await signSessionJwt(
    { id: userId, role: "USER", permissions: "0", provider: "credentials", sessionId, expiresAt: iat + 86_400 },
    { expiresInSeconds: 7_200, iat },
  );
  return { userId, token };
}
const COOKIE = getSessionCookieName();

// ── business stubs ───────────────────────────────────────────────────────────
shadowPrismaModel(prisma, "setting", {
  findUnique: async () => null,
  findMany: async () => [],
  upsert: async () => ({}), create: async () => ({}), update: async () => ({}), deleteMany: async () => ({ count: 0 }),
});
for (const m of [
  "plexLibraryItem", "jellyfinLibraryItem", "radarrWantedItem", "sonarrWantedItem",
  "radarrAvailableItem", "sonarrAvailableItem", "tVEpisodeCache", "blacklistItem",
  "tmdbCache", "tmdbMediaCore", "playHistory", "mediaServerUser", "hiddenItem",
  "mediaRequest", "watchlistItem", "ratingsCache", "auditLog", "notification", "deletionVote",
]) {
  shadowPrismaModel(prisma, m, {
    findMany: async () => { ops.push(`${m}.findMany`); return []; },
    findFirst: async () => { ops.push(`${m}.findFirst`); return null; },
    findUnique: async () => { ops.push(`${m}.findUnique`); return null; },
    count: async () => 0,
    groupBy: async () => [], aggregate: async () => ({ _count: { _all: 0 }, _sum: {}, _min: {}, _max: {} }),
    create: async () => ({}), createMany: async () => ({ count: 0 }), update: async () => ({}),
    updateMany: async () => ({ count: 0 }), upsert: async () => ({}), deleteMany: async () => ({ count: 0 }),
  });
}
shadowPrismaClientMethod(prisma, "$queryRaw", async () => []);
shadowPrismaClientMethod(prisma, "$queryRawUnsafe", async () => []);
shadowPrismaClientMethod(prisma, "$transaction", async (arg: unknown) =>
  Array.isArray(arg) ? Promise.all(arg) : (arg as (tx: unknown) => Promise<unknown>)(prisma));

const media = await import("../src/app/api/media/[type]/[tmdbId]/route.ts");

// ── scope ────────────────────────────────────────────────────────────────────
function inScope<T>(fn: () => Promise<T>): Promise<T> {
  const workStore = {
    route: "/review-p21.test", forceStatic: false, dynamicShouldError: false,
    afterContext: { after: () => {} },
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
const mediaGet = (token: string, type: string, tmdbId: string) =>
  inScope(() => media.GET(
    new NextRequest(`http://localhost:3000/api/media/${type}/${tmdbId}`, { method: "GET", headers: { cookie: `${COOKIE}=${token}` } }),
    { params: Promise.resolve({ type, tmdbId }) },
  ));

beforeEach(() => {
  ops = [];
  errors.length = 0;
  creditsOk = true;
  collectionOk = true;
  collectionParts = undefined;
});

// ── f47: credits failure degrades, never 502s ────────────────────────────────

test("f47: baseline — a healthy credits endpoint yields the cast", async () => {
  const { token } = await mintSession();
  const res = await mediaGet(token, "movie", "27205");
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.cast.length, 1);
  assert.equal(body.cast[0].name, "Keanu Reeves");
});

for (const [type, id] of [["movie", "27205"], ["tv", "1396"]] as const) {
  test(`f47: ${type} — a 500 on /credits alone still answers 200 with an empty cast`, async () => {
    creditsOk = false;
    const { token } = await mintSession();
    const res = await mediaGet(token, type, id);
    assert.equal(res.status, 200, "an isolated credits failure must not 502 the title");
    const body = await res.json();
    assert.equal(body.tmdbId ?? body.id, Number(id), "the detail itself was still served");
    assert.deepEqual(body.cast, []);
    assert.ok(ops.some((o) => o === `fetch /3/${type}/${id}/credits`), "the credits endpoint was actually hit");
    assert.ok(errors.some((e) => e.startsWith("[media] credits fetch failed")), `no scoped credits error logged: ${errors.join(" | ")}`);
    assert.ok(!errors.some((e) => e.startsWith("[media] detail fetch failed")), "the outer 502 path must not fire");
  });
}

test("f47: a failing DETAIL fetch still 502s — only the credits leg is best-effort", async () => {
  const { token } = await mintSession();
  // 999999 matches no fixture, so it falls to the generic list body: an object
  // with no id — normalize still yields a title, so use a real non-2xx instead.
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = new URL(String(input));
    if (/\/movie\/27205$/.test(url.pathname)) return new Response("{}", { status: 500, headers: { "content-type": "application/json" } });
    return realFetch(input);
  }) as unknown as typeof fetch;
  try {
    const res = await mediaGet(token, "movie", "27205");
    assert.equal(res.status, 502);
    assert.deepEqual(await res.json(), { error: "Could not load this title" });
  } finally {
    globalThis.fetch = realFetch;
  }
});

// ── f48: collection runs in the suggestions wave, best-effort preserved ──────

test("f48: a collection movie ships collection.items with the lite projection", async () => {
  const { token } = await mintSession();
  const res = await mediaGet(token, "movie", "604");
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.ok(body.collection, "collection missing");
  assert.equal(body.collection.id, COLLECTION_ID);
  assert.equal(body.collection.name, "The Matrix Collection");
  assert.deepEqual(body.collection.items.map((i: { tmdbId: number }) => i.tmdbId), [603, 604]);
  assert.deepEqual(Object.keys(body.collection.items[0]).sort(), [
    "arrPending", "jellyfinAvailable", "mediaType", "plexAvailable", "posterPath", "releaseYear", "requested", "title", "tmdbId",
  ]);
});

test("f48: the /collection/ fetch is issued BEFORE the third-wave deletionVote read (parallel, not serialized)", async () => {
  const { token } = await mintSession();
  const res = await mediaGet(token, "movie", "604");
  assert.equal(res.status, 200);
  const collectionAt = ops.findIndex((o) => o === `fetch /3/collection/${COLLECTION_ID}`);
  const voteAt = ops.findIndex((o) => o === "deletionVote.findFirst");
  assert.ok(collectionAt >= 0, `collection was never fetched: ${ops.join(", ")}`);
  assert.ok(voteAt >= 0, `deletionVote was never read: ${ops.join(", ")}`);
  // The old code awaited the suggestions wave AND the deletionVote/watchlist/
  // hidden wave before even starting getMovieCollection; the fix starts it as
  // soon as collectionId is known, so it must precede that third wave.
  assert.ok(collectionAt < voteAt, `collection fetch (#${collectionAt}) ran after deletionVote (#${voteAt}) — serialized again`);
});

test("f48: the collection availability pass overlaps the suggestions wave rather than following the third wave", async () => {
  const { token } = await mintSession();
  await mediaGet(token, "movie", "604");
  // attachAllAvailability issues one plexLibraryItem read per non-empty attach
  // call (the suggestions rail is empty here, so: the detail pass + the
  // collection pass). Both must land before the deletionVote read.
  const voteAt = ops.findIndex((o) => o === "deletionVote.findFirst");
  const attachReads = ops.map((o, i) => [o, i] as const).filter(([o]) => o === "plexLibraryItem.findMany").map(([, i]) => i);
  assert.ok(attachReads.length >= 2, `expected the detail + collection attach passes, saw ${attachReads.length}: ${ops.join(", ")}`);
  assert.ok(attachReads.every((i) => i < voteAt), `an attach pass ran after the deletionVote read: ${ops.join(", ")}`);
});

test("f48: a 500 on /collection/ alone still answers 200 with collection: null and a scoped error", async () => {
  collectionOk = false;
  const { token } = await mintSession();
  const res = await mediaGet(token, "movie", "604");
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.collection, null);
  assert.equal(body.cast.length, 1, "the rest of the payload is intact");
  assert.ok(errors.some((e) => e.startsWith("[media] collection fetch failed")), `no scoped collection error: ${errors.join(" | ")}`);
  assert.ok(!errors.some((e) => e.startsWith("[media] detail fetch failed")));
});

test("f48: a successful collection with no usable parts keeps the pre-fix wire shape ({ …, items: [] })", async () => {
  collectionParts = [];
  const { token } = await mintSession();
  const res = await mediaGet(token, "movie", "604");
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.deepEqual(body.collection, { id: COLLECTION_ID, name: "The Matrix Collection", items: [] });
});

test("f48: a movie with no collection ships collection: null and never fetches /collection/", async () => {
  const { token } = await mintSession();
  const res = await mediaGet(token, "movie", "27205");
  assert.equal(res.status, 200);
  assert.equal((await res.json()).collection, null);
  assert.ok(!ops.some((o) => o.startsWith("fetch /3/collection/")));
});

test("f48: tv never fetches /collection/", async () => {
  const { token } = await mintSession();
  const res = await mediaGet(token, "tv", "1396");
  assert.equal(res.status, 200);
  assert.equal((await res.json()).collection, null);
  assert.ok(!ops.some((o) => o.startsWith("fetch /3/collection/")));
});
