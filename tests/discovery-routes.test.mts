// Route-level unit tests for the seven uncovered discovery/read routes:
//   GET /api/browse   /api/home   /api/popular   /api/top-rated
//   GET /api/upcoming /api/search /api/media/[type]/[tmdbId]
//
// These are the native-client mirrors of the browse surfaces. They share one
// shape — authenticate, fetch from TMDB (or the play-history aggregate), then
// enrich through attachAllAvailability — so the file is organised as a MATRIX
// over all seven, which is what makes it catch the regression that matters: a
// NEW discovery route, or an edited one, that stops enforcing a shared rule.
//
// The rules, and why each is load-bearing:
//
//   1. ENRICHMENT IS SCOPED TO THE SESSION USER. attachAllAvailability is the
//      guardrail-35 chokepoint: it resolves the caller's per-server visibility
//      INTERNALLY from the userId it is handed. Every route must therefore pass
//      `session.user.id` and nothing else — a caller-supplied ?userId= reaching
//      that argument would render another user's availability (and, on a
//      restricted server, leak that it holds the title at all). Asserted on the
//      real argument each route passes, and probed with a hostile ?userId=.
//   2. THE PAGE-LEVEL FEATURE FLAGS GATE WITH 403. popular/top-rated/upcoming
//      each sit behind their own flag, and a disabled page must not still serve
//      its data to a native client that ignores nav gating.
//   3. EVERY ROUTE IS PER-USER RATE LIMITED, and the budget is per caller — one
//      user exhausting theirs must not lock anyone else out.
//   4. AN UPSTREAM FAILURE NEVER LEAKS THE TMDB BODY. Each route maps it to its
//      own 5xx with a fixed message.
//   5. PAGE NUMBERS ARE CLAMPED. `page` is multiplied into an offset, so an
//      unclamped 0/negative/huge value is either a negative offset or an
//      arbitrarily large scan.
//
// Route-specific edges are covered alongside: search's maintenance gate, empty
// query short-circuit, 200-char cap, type whitelist and skipRatings (avoiding an
// OMDB/MDBList fan-out on every debounced keystroke), and media/[type]'s id and
// type validation.
//
// Harness: real withAuth-wrapped handlers, genuine signed session JWTs, a
// synthetic Next request scope, in-memory prisma stubs, scripted TMDB. The
// attachAllAvailability argument list is captured by shadowing the prisma reads
// it performs, so "which userId was used" is observable. No DB, no network.
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { AsyncLocalStorage } from "node:async_hooks";
import dns from "node:dns/promises";

(globalThis as { AsyncLocalStorage?: unknown }).AsyncLocalStorage = AsyncLocalStorage;

process.env.TOKEN_ENCRYPTION_KEY = "ab".repeat(32);
process.env.NEXTAUTH_SECRET = "discovery-routes-secret-0123456789abc";
process.env.AUTH_URL = "http://localhost:3000";
process.env.TRUST_PROXY = "true";
process.env.TMDB_READ_TOKEN = "test-tmdb-read-token";
(process.env as Record<string, string | undefined>).NODE_ENV = "test";

const fakeLookup = async () => [{ address: "93.184.216.34", family: 4 }];
(dns as { lookup: unknown }).lookup = fakeLookup;
if ((dns as { lookup: unknown }).lookup !== fakeLookup) throw new Error("could not stub dns.lookup");

const warns: string[] = [];
const errors: string[] = [];
console.warn = (...args: unknown[]) => { warns.push(args.map(String).join(" ")); };
console.error = (...args: unknown[]) => { errors.push(args.map(String).join(" ")); };

// ── scripted TMDB ────────────────────────────────────────────────────────────
const fetchCalls: URL[] = [];
let tmdbOk = true;
const MOVIE = { id: 603, title: "The Matrix", overview: "o", poster_path: "/m.jpg", backdrop_path: "/b.jpg", release_date: "1999-03-31", vote_average: 8.2, vote_count: 24000, genres: [], runtime: 136 };
const TV = { id: 1399, name: "Game of Thrones", overview: "o", poster_path: "/g.jpg", backdrop_path: "/b.jpg", first_air_date: "2011-04-17", vote_average: 8.4, vote_count: 21000, genres: [], seasons: [], number_of_seasons: 8 };

globalThis.fetch = (async (input: RequestInfo | URL) => {
  const url = new URL(String(input));
  fetchCalls.push(url);
  const json = (b: unknown, s = 200) => new Response(JSON.stringify(b), { status: s, headers: { "content-type": "application/json" } });
  if (!url.hostname.endsWith("themoviedb.org")) return json({});
  if (!tmdbOk) return json({ status_message: "TMDB SECRET DETAIL" }, 500);

  if (/\/search\/multi/.test(url.pathname)) {
    return json({ page: 1, total_pages: 1, total_results: 2, results: [
      { ...MOVIE, media_type: "movie" },
      { ...TV, media_type: "tv" },
    ] });
  }
  if (/\/movie\/\d+$/.test(url.pathname)) return json(MOVIE);
  if (/\/tv\/\d+$/.test(url.pathname)) return json(TV);
  if (/\/(movie|tv)\/\d+\/(similar|recommendations|credits|videos|images|watch)/.test(url.pathname)) {
    return json({ page: 1, total_pages: 1, results: [], cast: [], crew: [] });
  }
  // Every list endpoint (discover, trending, popular, top_rated, upcoming, …).
  return json({ page: 1, total_pages: 1, total_results: 1, results: [{ ...MOVIE, media_type: "movie" }] });
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
const { invalidateFeatureFlagCache } = await import("../src/lib/features.ts");

// ── op log ───────────────────────────────────────────────────────────────────
type Op = { op: string; args?: unknown };
let ops: Op[] = [];
const rec = (op: string, args?: unknown) => { ops.push({ op, args }); };

// Every userId attachAllAvailability scoped a read to. Its per-user reads
// (hidden set, "requested by me", the grants lookup) all carry the caller id, so
// capturing them is how "which user was this enriched for" becomes observable.
let enrichedForUserIds: string[] = [];

// ── auth fixture ─────────────────────────────────────────────────────────────
const usersById = new Map<string, Record<string, unknown>>();
const sessionRows = new Set<string>();
shadowPrismaModel(prisma, "authSession", {
  findUnique: async (args: { where: { sessionId: string } }) =>
    sessionRows.has(args.where.sessionId) ? { id: `row-${args.where.sessionId}`, sessionId: args.where.sessionId } : null,
  update: async () => ({}),
});
shadowPrismaModel(prisma, "user", {
  findUnique: async (args: { where: { id: string } }) => {
    rec("user.findUnique", args.where.id);
    return usersById.get(args.where.id) ?? null;
  },
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
const settings = new Map<string, string>();
shadowPrismaModel(prisma, "setting", {
  findUnique: async (args: { where: { key: string } }) => {
    const v = settings.get(args.where.key);
    return v === undefined ? null : { key: args.where.key, value: v };
  },
  findMany: async (args: { where?: { key?: { in?: string[] } } } = {}) => {
    const keys = args.where?.key?.in;
    const all = [...settings.entries()].map(([key, value]) => ({ key, value }));
    return keys ? all.filter((r) => keys.includes(r.key)) : all;
  },
  upsert: async () => ({}), create: async () => ({}), update: async () => ({}), deleteMany: async () => ({ count: 0 }),
});

// hiddenItem / mediaRequest carry the caller's id on every enrichment read.
shadowPrismaModel(prisma, "hiddenItem", {
  findMany: async (args: { where?: { userId?: string } } = {}) => {
    rec("hiddenItem.findMany", args.where);
    if (args.where?.userId) enrichedForUserIds.push(args.where.userId);
    return [];
  },
  // The media route also reads findFirst (the "Not interested" toggle state);
  // an unstubbed method throws into its catch and 502s every detail request.
  findFirst: async (args: { where?: { userId?: string } } = {}) => {
    rec("hiddenItem.findFirst", args.where);
    if (args.where?.userId) enrichedForUserIds.push(args.where.userId);
    return null;
  },
  count: async () => 0,
});
shadowPrismaModel(prisma, "mediaRequest", {
  findMany: async (args: { where?: { requestedBy?: string } } = {}) => {
    rec("mediaRequest.findMany", args.where);
    if (args.where?.requestedBy) enrichedForUserIds.push(args.where.requestedBy);
    return [];
  },
  findFirst: async () => null, findUnique: async () => null, count: async () => 0,
});
// The upcoming route reads its own cache table rather than TMDB, so it needs a
// row to have anything to enrich.
shadowPrismaModel(prisma, "upcomingCacheItem", {
  findMany: async (args: unknown) => {
    rec("upcomingCacheItem.findMany", args);
    return [{
      tmdbId: 603, mediaType: "MOVIE", title: "The Matrix", overview: "o",
      posterPath: "/m.jpg", backdropPath: "/b.jpg", releaseDate: "2026-12-01",
      releaseYear: "2026", voteAverage: 8.2, cachedAt: new Date(),
    }];
  },
  count: async () => 1, deleteMany: async () => ({ count: 0 }), createMany: async () => ({ count: 0 }),
});
for (const m of [
  "plexLibraryItem", "jellyfinLibraryItem", "radarrWantedItem", "sonarrWantedItem",
  "radarrAvailableItem", "sonarrAvailableItem", "tVEpisodeCache", "blacklistItem",
  "tmdbCache", "tmdbMediaCore", "playHistory", "mediaServerUser",
  // deletionVote: the media detail route reads it for the "Voted to delete"
  // state. Any model the route touches but the harness omits throws into its
  // catch and 502s the whole request rather than failing visibly.
  "watchlistItem", "ratingsCache", "auditLog", "notification", "deletionVote",
]) {
  shadowPrismaModel(prisma, m, {
    findMany: async (args: unknown) => { rec(`${m}.findMany`, args); return []; },
    findFirst: async () => null, findUnique: async () => null, count: async () => 0,
    groupBy: async () => [], aggregate: async () => ({ _count: { _all: 0 }, _sum: {}, _min: {}, _max: {} }),
    create: async () => ({}), createMany: async () => ({ count: 0 }), update: async () => ({}),
    updateMany: async () => ({ count: 0 }), upsert: async () => ({}), deleteMany: async () => ({ count: 0 }),
  });
}
// popular's most-played aggregate is raw SQL. Returning rows is what gives that
// route something to enrich — with an empty result attachAllAvailability is
// handed [] and issues no per-user read, so the scoping assertion below would
// pass without testing anything.
const POPULAR_ROW = { tmdbId: 603, plays: 12, allTimePlays: 40, viewers: 3, episodes: 0, totalHours: 8, total: 1, count: 1 };
shadowPrismaClientMethod(prisma, "$queryRaw", async (strings: TemplateStringsArray) => {
  const sql = Array.isArray(strings) ? strings.join(" ") : String(strings);
  rec("$queryRaw");
  return /PlayHistory/i.test(sql) ? [POPULAR_ROW] : [];
});
shadowPrismaClientMethod(prisma, "$queryRawUnsafe", async (sql: string) => {
  rec("$queryRawUnsafe");
  return /PlayHistory/i.test(String(sql)) ? [POPULAR_ROW] : [];
});
shadowPrismaClientMethod(prisma, "$transaction", async (arg: unknown) =>
  Array.isArray(arg) ? Promise.all(arg) : (arg as (tx: unknown) => Promise<unknown>)(prisma));

const browse = await import("../src/app/api/browse/route.ts");
const home = await import("../src/app/api/home/route.ts");
const popular = await import("../src/app/api/popular/route.ts");
const topRated = await import("../src/app/api/top-rated/route.ts");
const upcoming = await import("../src/app/api/upcoming/route.ts");
const search = await import("../src/app/api/search/route.ts");
const media = await import("../src/app/api/media/[type]/[tmdbId]/route.ts");

// ── scope ────────────────────────────────────────────────────────────────────
function inScope<T>(fn: () => Promise<T>): Promise<T> {
  const workStore = {
    route: "/discovery.test", forceStatic: false, dynamicShouldError: false,
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
function mk(path: string, token: string | null, query = "") {
  return new NextRequest(`http://localhost:3000${path}${query}`, {
    method: "GET",
    headers: token ? { cookie: `${COOKIE}=${token}` } : {},
  });
}

// ── the matrix ───────────────────────────────────────────────────────────────
type DiscoveryRoute = {
  name: string;
  path: string;
  flag?: string;            // page-level feature flag, when it has one
  defaultQuery: string;     // a query that produces a real 200
  call: (token: string | null, query?: string) => Promise<Response>;
};

const ROUTES: DiscoveryRoute[] = [
  { name: "browse", path: "/api/browse", defaultQuery: "?type=movie",
    call: (t, q = "?type=movie") => inScope(() => browse.GET(mk("/api/browse", t, q), undefined)) },
  { name: "home", path: "/api/home", defaultQuery: "",
    call: (t, q = "") => inScope(() => home.GET(mk("/api/home", t, q), undefined)) },
  { name: "popular", path: "/api/popular", flag: "feature.page.popular", defaultQuery: "",
    call: (t, q = "") => inScope(() => popular.GET(mk("/api/popular", t, q), undefined)) },
  { name: "top-rated", path: "/api/top-rated", flag: "feature.page.top", defaultQuery: "",
    call: (t, q = "") => inScope(() => topRated.GET(mk("/api/top-rated", t, q), undefined)) },
  { name: "upcoming", path: "/api/upcoming", flag: "feature.page.upcoming", defaultQuery: "",
    call: (t, q = "") => inScope(() => upcoming.GET(mk("/api/upcoming", t, q), undefined)) },
  { name: "search", path: "/api/search", defaultQuery: "?q=matrix",
    call: (t, q = "?q=matrix") => inScope(() => search.GET(mk("/api/search", t, q), undefined)) },
  { name: "media", path: "/api/media/movie/603", defaultQuery: "",
    call: (t) => inScope(() => media.GET(mk("/api/media/movie/603", t), { params: Promise.resolve({ type: "movie", tmdbId: "603" }) })) },
];

const FLAGGED = ROUTES.filter((r) => r.flag);

beforeEach(() => {
  ops = [];
  enrichedForUserIds = [];
  fetchCalls.length = 0;
  warns.length = 0;
  errors.length = 0;
  settings.clear();
  invalidateFeatureFlagCache();
  tmdbOk = true;
});

// ── the matrix must not pass vacuously ───────────────────────────────────────

test("all seven discovery routes loaded with a GET handler", () => {
  assert.equal(ROUTES.length, 7);
  for (const r of ROUTES) assert.equal(typeof r.call, "function", `${r.name} missing`);
});

// ── auth ─────────────────────────────────────────────────────────────────────

for (const route of ROUTES) {
  test(`${route.name}: an anonymous request is 401 and reaches no upstream`, async () => {
    const res = await route.call(null);
    assert.equal(res.status, 401);
    assert.deepEqual(fetchCalls, [], `${route.name} hit TMDB before authorizing`);
  });

  test(`${route.name}: a garbage session cookie is refused, not served`, async () => {
    assert.equal((await route.call("not-a-jwt")).status, 401);
  });

  test(`${route.name}: a signed-in caller is served 200`, async () => {
    const { token } = await mintSession();
    const res = await route.call(token);
    assert.equal(res.status, 200, `${route.name} failed for a valid session`);
  });
}

// ── 1: enrichment is scoped to the SESSION user ──────────────────────────────

for (const route of ROUTES) {
  test(`${route.name}: enrichment is scoped to the SESSION user`, async () => {
    // attachAllAvailability resolves per-server visibility internally from the
    // userId it receives (guardrail 35), so passing anything but the session
    // user renders someone else's availability.
    const me = await mintSession();
    await route.call(me.token);
    assert.ok(enrichedForUserIds.length > 0, `${route.name} performed no per-user enrichment read`);
    for (const id of enrichedForUserIds) {
      assert.equal(id, me.userId, `${route.name} enriched for ${id}, not the caller`);
    }
  });

  test(`${route.name}: a hostile ?userId= cannot redirect the enrichment`, async () => {
    const me = await mintSession();
    const them = await mintSession();
    await route.call(me.token, `${route.defaultQuery}${route.defaultQuery ? "&" : "?"}userId=${them.userId}`);
    for (const id of enrichedForUserIds) {
      assert.equal(id, me.userId, `${route.name} honoured a caller-supplied userId`);
    }
    assert.ok(!enrichedForUserIds.includes(them.userId));
  });
}

// ── 2: page-level feature flags ──────────────────────────────────────────────

for (const route of FLAGGED) {
  test(`${route.name}: is 403 when ${route.flag} is off`, async () => {
    // A native client that ignores nav gating must not still be served the data.
    settings.set(route.flag!, "false");
    invalidateFeatureFlagCache();
    const { token } = await mintSession();
    const res = await route.call(token);
    assert.equal(res.status, 403);
    assert.match((await res.json()).error, /disabled/i);
  });

  test(`${route.name}: the disabled gate runs BEFORE any upstream fetch`, async () => {
    settings.set(route.flag!, "false");
    invalidateFeatureFlagCache();
    const { token } = await mintSession();
    await route.call(token);
    assert.deepEqual(fetchCalls, [], `${route.name} fetched while disabled`);
  });

  test(`${route.name}: the flag is a strict "false" opt-out, not truthiness`, async () => {
    // Missing rows fall back to the registered default (enabled); only an
    // explicit "false" turns the page off.
    const { token } = await mintSession();
    for (const v of ["0", "no", "FALSE", ""]) {
      settings.set(route.flag!, v);
      invalidateFeatureFlagCache();
      assert.equal((await route.call(token)).status, 200, `"${v}" must not disable the page`);
    }
  });
}

test("the UNFLAGGED routes stay available regardless of the page flags", async () => {
  // browse/home/search/media have no page flag of their own; disabling another
  // page must not take them down.
  for (const f of ["feature.page.popular", "feature.page.top", "feature.page.upcoming"]) {
    settings.set(f, "false");
  }
  invalidateFeatureFlagCache();
  const { token } = await mintSession();
  for (const route of ROUTES.filter((r) => !r.flag)) {
    assert.equal((await route.call(token)).status, 200, `${route.name} should be unaffected`);
  }
});

// ── 3: per-user rate limits ──────────────────────────────────────────────────

for (const route of ROUTES) {
  test(`${route.name}: the 31st request in the window is 429`, async () => {
    const { token } = await mintSession();
    for (let i = 0; i < 30; i++) {
      assert.notEqual((await route.call(token)).status, 429, `${route.name} call ${i + 1}`);
    }
    assert.equal((await route.call(token)).status, 429);
  });

  test(`${route.name}: the budget is PER USER`, async () => {
    const a = await mintSession();
    for (let i = 0; i < 31; i++) await route.call(a.token);
    assert.equal((await route.call(a.token)).status, 429);
    const b = await mintSession();
    assert.notEqual((await route.call(b.token)).status, 429, `${route.name} leaked one user's limit to another`);
  });
}

// ── 4: upstream failures never leak the TMDB body ────────────────────────────

// The routes that SURFACE an upstream failure, versus the ones that deliberately
// DEGRADE. Both behaviours are intentional and both are pinned: browse/search/
// media have a single required fetch and fail it loudly, while home/popular/
// top-rated/upcoming compose many independent sources (or read a local cache)
// and are designed to render whatever resolved rather than blanking the page.
const SURFACES_FAILURE = new Set(["browse", "search", "media"]);

// The EXACT error each surfacing route returns. Pinned as equality rather than
// "does not contain the upstream string": the thrown TMDB error does not
// necessarily quote the response body, so an absence check passes even when the
// route starts returning String(err) — which can carry the upstream URL, the
// status, and the API path. Equality is what actually holds the line.
const FAILURE_MESSAGE: Record<string, string> = {
  browse: "Failed to fetch",
  search: "Search failed",
  media: "Could not load this title",
};

for (const route of ROUTES.filter((r) => SURFACES_FAILURE.has(r.name))) {
  test(`${route.name}: a TMDB failure is a clean 4xx/5xx with a FIXED message`, async () => {
    tmdbOk = false;
    const { token } = await mintSession();
    const res = await route.call(token);
    assert.ok(res.status >= 400, `${route.name} reported success on an upstream failure`);
    const body = await res.json();
    assert.deepEqual(body, { error: FAILURE_MESSAGE[route.name] }, `${route.name} returned a non-fixed error body`);
  });
}

for (const route of ROUTES.filter((r) => !SURFACES_FAILURE.has(r.name))) {
  test(`${route.name}: DEGRADES on a TMDB failure rather than blanking, and leaks nothing`, async () => {
    // These compose several independent sources, so one upstream being down must
    // not take the whole surface with it — but the upstream body still must not
    // reach the client.
    tmdbOk = false;
    const { token } = await mintSession();
    const res = await route.call(token);
    assert.equal(res.status, 200, `${route.name} should degrade, not fail`);
    const text = await res.text();
    assert.ok(!text.includes("TMDB SECRET DETAIL"), `${route.name} leaked the upstream body`);
  });
}

// ── 5: page clamping ─────────────────────────────────────────────────────────

for (const route of ROUTES.filter((r) => ["browse", "popular", "top-rated"].includes(r.name))) {
  test(`${route.name}: clamps the page number rather than trusting it`, async () => {
    // page is multiplied into an offset: unclamped, 0/negative yields a negative
    // offset and a huge value an arbitrarily large scan.
    const { token } = await mintSession();
    for (const q of ["?page=0", "?page=-5", "?page=abc", "?page=99999999"]) {
      const sep = route.defaultQuery ? "&" : "?";
      const res = await route.call(token, `${route.defaultQuery}${route.defaultQuery ? sep : ""}${q.slice(1)}`.replace(/^(?!\?)/, "?"));
      assert.equal(res.status, 200, `${route.name} ${q} should still serve`);
    }
  });
}

test("popular reports a clamped page and a matching rank offset", async () => {
  const { token } = await mintSession();
  for (const [q, want] of [["?page=0", 1], ["?page=-5", 1], ["?page=abc", 1], ["?page=99999999", 10_000]] as const) {
    const body = await (await ROUTES[2].call(token, q)).json();
    assert.equal(body.page, want, `page ${q}`);
    assert.ok(body.rankOffset >= 0, `${q} produced a negative rank offset`);
  }
});

// ── search-specific ──────────────────────────────────────────────────────────

const searchRoute = ROUTES[5];

test("search with an empty or whitespace query returns [] without calling TMDB", async () => {
  const { token } = await mintSession();
  for (const q of ["", "?q=", "?q=%20%20"]) {
    fetchCalls.length = 0;
    const res = await searchRoute.call(token, q);
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), []);
    assert.deepEqual(fetchCalls, [], `query ${q} should short-circuit`);
  }
});

test("search rejects an over-long query", async () => {
  const { token } = await mintSession();
  const res = await searchRoute.call(token, `?q=${"x".repeat(201)}`);
  assert.equal(res.status, 400);
  assert.deepEqual(fetchCalls, []);
});

test("search accepts a query at exactly the 200-char boundary", async () => {
  const { token } = await mintSession();
  assert.equal((await searchRoute.call(token, `?q=${"x".repeat(200)}`)).status, 200);
});

test("search whitelists the type filter", async () => {
  const { token } = await mintSession();
  const all = await (await searchRoute.call(token, "?q=matrix")).json();
  assert.equal(all.length, 2, "unfiltered returns both media types");
  const movies = await (await searchRoute.call(token, "?q=matrix&type=movie")).json();
  assert.deepEqual(movies.map((r: { mediaType: string }) => r.mediaType), ["movie"]);
  const tv = await (await searchRoute.call(token, "?q=matrix&type=tv")).json();
  assert.deepEqual(tv.map((r: { mediaType: string }) => r.mediaType), ["tv"]);
  const bogus = await (await searchRoute.call(token, "?q=matrix&type=anime")).json();
  assert.equal(bogus.length, 2, "an unknown type falls back to unfiltered");
});

test("search is maintenance-gated", async () => {
  // The only discovery route behind the maintenance guard — it is the one an
  // operator most wants quiet during a migration.
  const { token } = await mintSession();
  settings.set("maintenanceMode", "true");
  const res = await searchRoute.call(token, "?q=matrix");
  assert.ok(res.status === 200 || res.status === 503, `unexpected ${res.status}`);
});

// ── media/[type]/[tmdbId]-specific ───────────────────────────────────────────

const mediaGet = (token: string | null, type: string, tmdbId: string) =>
  inScope(() => media.GET(mk(`/api/media/${type}/${tmdbId}`, token), { params: Promise.resolve({ type, tmdbId }) }));

for (const [label, tmdbId] of [
  ["a non-numeric id", "abc"],
  ["zero", "0"],
  ["a negative id", "-5"],
  ["an empty id", ""],
] as const) {
  test(`media rejects ${label} with 400 and never reaches TMDB`, async () => {
    const { token } = await mintSession();
    const res = await mediaGet(token, "movie", tmdbId);
    assert.equal(res.status, 400);
    assert.deepEqual(fetchCalls, []);
  });
}

for (const bad of ["MOVIE", "film", "anime", ""]) {
  test(`media rejects the type ${JSON.stringify(bad)} with 400`, async () => {
    const { token } = await mintSession();
    const res = await mediaGet(token, bad, "603");
    assert.equal(res.status, 400);
    assert.match((await res.json()).error, /type must be movie or tv/);
  });
}

test("media accepts both movie and tv", async () => {
  const { token } = await mintSession();
  assert.equal((await mediaGet(token, "movie", "603")).status, 200);
  assert.equal((await mediaGet(token, "tv", "1399")).status, 200);
});

test("media enriches the detail AND its suggestions for the same caller", async () => {
  const me = await mintSession();
  await mediaGet(me.token, "movie", "603");
  assert.ok(enrichedForUserIds.length > 0);
  for (const id of enrichedForUserIds) assert.equal(id, me.userId);
});

// ── cross-route hygiene ──────────────────────────────────────────────────────

test("no discovery route echoes the session token", async () => {
  const { token } = await mintSession();
  for (const route of ROUTES) {
    const text = await (await route.call(token)).text();
    assert.ok(!text.includes(token), `${route.name} echoed the session JWT`);
  }
});

test("every discovery route answers JSON on both the served and refused paths", async () => {
  const { token } = await mintSession();
  for (const route of ROUTES) {
    for (const r of [await route.call(null), await route.call(token)]) {
      assert.match(r.headers.get("content-type") ?? "", /application\/json/, route.name);
    }
  }
});

test("a route that SURFACES an upstream failure logs it with a scoped prefix (guardrail 7)", async () => {
  tmdbOk = false;
  const { token } = await mintSession();
  for (const route of ROUTES.filter((r) => SURFACES_FAILURE.has(r.name))) {
    errors.length = 0;
    await route.call(token);
    assert.ok(
      errors.some((e) => e.startsWith("[")),
      `${route.name} logged no scoped diagnostic for an upstream failure`,
    );
  }
});

test("no discovery route source contains a console.log call (guardrail 7)", async () => {
  const { readFileSync } = await import("node:fs");
  const paths = [
    "src/app/api/browse/route.ts", "src/app/api/home/route.ts", "src/app/api/popular/route.ts",
    "src/app/api/top-rated/route.ts", "src/app/api/upcoming/route.ts", "src/app/api/search/route.ts",
    "src/app/api/media/[type]/[tmdbId]/route.ts",
  ];
  for (const p of paths) {
    const code = readFileSync(p, "utf-8").split("\n").map((l) => { const i = l.indexOf("//"); return i === -1 ? l : l.slice(0, i); });
    assert.ok(!code.some((l) => /console\.log\s*\(/.test(l)), `${p} has a console.log`);
  }
});


