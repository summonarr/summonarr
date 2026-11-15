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
//        as the suggestions attach, not serialized behind it. Pinned by
//        ordering: the collection load starts before the detail's availability
//        pass reads the library. The per-viewer reads (deletionVote / watchlist
//        / hidden) join that wave too — they key only on the title and the
//        viewer — instead of a third wave after it. The best-effort contract is
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
    // The cache key rides along for tmdbCache, so a test can tell which load a read starts.
    findUnique: async (args?: { where?: { key?: string } }) => {
      ops.push(m === "tmdbCache" && args?.where?.key ? `${m}.findUnique ${args.where.key}` : `${m}.findUnique`);
      return null;
    },
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
function inScope<T>(fn: () => Promise<T>, scopeHeaders: Record<string, string> = {}): Promise<T> {
  const workStore = {
    route: "/review-p21.test", forceStatic: false, dynamicShouldError: false,
    afterContext: { after: () => {} },
  };
  const reqHeaders = new Headers(scopeHeaders);
  const requestStore = {
    type: "request", phase: "render",
    headers: HeadersAdapter.seal(reqHeaders),
    cookies: RequestCookiesAdapter.seal(new RequestCookies(reqHeaders)),
    usedDynamic: false,
  };
  return workAsyncStorage.run(workStore, () => workUnitAsyncStorage.run(requestStore, fn));
}
// `extra` headers ride on the request AND on the scope's headers() bag (the
// content-language overlay reads the latter).
const mediaGet = (token: string, type: string, tmdbId: string, extra: Record<string, string> = {}) =>
  inScope(() => media.GET(
    new NextRequest(`http://localhost:3000/api/media/${type}/${tmdbId}`, { method: "GET", headers: { cookie: `${COOKIE}=${token}`, ...extra } }),
    { params: Promise.resolve({ type, tmdbId }) },
  ), extra);

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
  // An unknown id would not work here: the stub answers it with a generic 200
  // body that still normalizes into a title. So make the detail call itself
  // return a real 500 instead.
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

test("an id TMDB doesn't know is a 404, told apart from an outage's 502", async () => {
  const { token } = await mintSession();
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = new URL(String(input));
    if (/\/movie\/27205/.test(url.pathname)) return new Response(JSON.stringify({ status_code: 34 }), { status: 404, headers: { "content-type": "application/json" } });
    return realFetch(input);
  }) as unknown as typeof fetch;
  try {
    const res = await mediaGet(token, "movie", "27205");
    assert.equal(res.status, 404);
    assert.deepEqual(await res.json(), { error: "Not found" });
  } finally {
    globalThis.fetch = realFetch;
  }
});

// ── genres: the id+name list is in the same language as the names ────────────

// A fresh id with genres; TMDB's fr genre list renames 18 and leaves 878 out, so
// the overlay keeps that one's English name.
const MOVIE_WITH_GENRES = {
  id: 550, title: "Fight Club", overview: "o", poster_path: "/f.jpg", backdrop_path: "/b.jpg",
  release_date: "1999-10-15", vote_average: 8.4, vote_count: 28000, runtime: 139,
  genres: [{ id: 18, name: "Drama" }, { id: 878, name: "Science Fiction" }],
};
async function withGenreMovie<T>(fn: () => Promise<T>): Promise<T> {
  const realFetch = globalThis.fetch;
  const json = (b: unknown) => new Response(JSON.stringify(b), { status: 200, headers: { "content-type": "application/json" } });
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = new URL(String(input));
    if (/\/movie\/550$/.test(url.pathname)) return json(MOVIE_WITH_GENRES);
    if (/\/genre\/movie\/list$/.test(url.pathname)) {
      return json({ genres: url.searchParams.get("language")?.startsWith("fr") ? [{ id: 18, name: "Drame" }] : MOVIE_WITH_GENRES.genres });
    }
    return realFetch(input);
  }) as unknown as typeof fetch;
  try {
    return await fn();
  } finally {
    globalThis.fetch = realFetch;
  }
}

test("media: a French viewer's genreList carries the same translated names as genres", async () => {
  const { token } = await mintSession();
  const body = await withGenreMovie(async () => (await mediaGet(token, "movie", "550", { "accept-language": "fr" })).json());
  assert.deepEqual(body.genres, ["Drame", "Science Fiction"]);
  assert.deepEqual(body.genreList, [{ id: 18, name: "Drame" }, { id: 878, name: "Science Fiction" }]);
});

test("media: an English viewer's genres and genreList are TMDB's own", async () => {
  const { token } = await mintSession();
  const body = await withGenreMovie(async () => (await mediaGet(token, "movie", "550")).json());
  assert.deepEqual(body.genres, ["Drama", "Science Fiction"]);
  assert.deepEqual(body.genreList, MOVIE_WITH_GENRES.genres);
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

test("the collection load starts BEFORE the detail's availability pass reads the library (parallel, not serialized)", async () => {
  const { token } = await mintSession();
  const res = await mediaGet(token, "movie", "604");
  assert.equal(res.status, 200);
  // The collection's first step is its cache read; the old code awaited the
  // suggestions wave AND the deletionVote/watchlist/hidden wave before even
  // starting getMovieCollection, so it came after every library read.
  const collectionStart = ops.findIndex((o) => o === `tmdbCache.findUnique collection:${COLLECTION_ID}`);
  const firstLibraryRead = ops.findIndex((o) => o === "plexLibraryItem.findMany");
  assert.ok(collectionStart >= 0, `the collection was never loaded: ${ops.join(", ")}`);
  assert.ok(ops.includes(`fetch /3/collection/${COLLECTION_ID}`), "the cold cache fell through to TMDB");
  assert.ok(firstLibraryRead >= 0, `no availability pass ran: ${ops.join(", ")}`);
  assert.ok(collectionStart < firstLibraryRead, `the collection load (#${collectionStart}) waited for the availability pass (#${firstLibraryRead}) — serialized again`);
});

test("the viewer's own flags (deletion vote, watchlist, hidden) are read in the availability wave, not a third one after it", async () => {
  const { token } = await mintSession();
  await mediaGet(token, "movie", "604");
  // attachAllAvailability issues one plexLibraryItem read per non-empty attach
  // call (the suggestions rail is empty here, so: the detail pass + the
  // collection pass). The per-viewer reads key only on the title and the user,
  // so they start beside the detail pass instead of waiting for it.
  const attachReads = ops.map((o, i) => [o, i] as const).filter(([o]) => o === "plexLibraryItem.findMany").map(([, i]) => i);
  assert.ok(attachReads.length >= 2, `expected the detail + collection attach passes, saw ${attachReads.length}: ${ops.join(", ")}`);
  for (const flag of ["deletionVote.findFirst", "watchlistItem.findFirst", "hiddenItem.findFirst"]) {
    const at = ops.indexOf(flag);
    assert.ok(at >= 0, `${flag} was never read: ${ops.join(", ")}`);
    assert.ok(at < attachReads[0], `${flag} (#${at}) waited for the availability pass (#${attachReads[0]})`);
  }
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

// ── id parsing + the 4K visibility read ──────────────────────────────────────
// The tmdbId path segment is accepted only in canonical digits: parseInt served
// "550abc" and "550.9" as movie 550. And the 4K-visibility settings read sits
// inside the handler's try like every other read, so its failure is the
// localized 502, not a bare framework 500.

for (const bad of ["27205abc", "1.5", "1e3", "0x3E8", " 27205", "027205", "-1", "0", "abc", ""]) {
  test(`media: tmdbId ${JSON.stringify(bad)} is 400 and never reaches TMDB`, async () => {
    const { token } = await mintSession();
    const res = await mediaGet(token, "movie", bad);
    assert.equal(res.status, 400);
    assert.deepEqual(await res.json(), { error: "tmdbId must be a positive integer" });
    assert.ok(!ops.some((o) => o.startsWith("fetch ")), `TMDB was called: ${ops.join(", ")}`);
  });
}

test("media: a canonical id past INT4 is the out-of-range 400", async () => {
  const { token } = await mintSession();
  const res = await mediaGet(token, "movie", "2147483648");
  assert.equal(res.status, 400);
  assert.deepEqual(await res.json(), { error: "tmdbId is out of range" });
  assert.ok(!ops.some((o) => o.startsWith("fetch ")));
});

test("media: a failing 4K-visibility settings read is the localized 502, not an escaped throw", async () => {
  const { token } = await mintSession();
  // The 4K settings are held for a few seconds; this read must be a fresh one.
  (await import("../src/lib/four-k-visibility.ts")).invalidateShow4kVisibilityCache();
  shadowPrismaModel(prisma, "setting", {
    findUnique: async () => null,
    findMany: async (args: { where?: { key?: { in?: string[] } } } = {}) => {
      // Only getShow4kVisibility's read, so auth and the rest are untouched.
      if (args.where?.key?.in?.includes("radarr4kUrl")) throw new Error("settings exploded");
      return [];
    },
    upsert: async () => ({}), create: async () => ({}), update: async () => ({}), deleteMany: async () => ({ count: 0 }),
  });
  try {
    const res = await mediaGet(token, "movie", "27205");
    assert.equal(res.status, 502);
    assert.deepEqual(await res.json(), { error: "Could not load this title" });
    assert.ok(errors.some((e) => e.startsWith("[media] detail fetch failed")), `no scoped log: ${errors.join(" | ")}`);
  } finally {
    shadowPrismaModel(prisma, "setting", {
      findUnique: async () => null,
      findMany: async () => [],
      upsert: async () => ({}), create: async () => ({}), update: async () => ({}), deleteMany: async () => ({ count: 0 }),
    });
  }
});
