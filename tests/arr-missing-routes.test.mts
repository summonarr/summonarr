// Route-level tests for Admin → Missing (/api/admin/missing and
// /api/admin/missing/episodes). What is pinned:
//
//   1. ADMIN ONLY (guardrail 6a): anonymous 401, a plain USER or a delegated
//      manager 403 — and none of them reaches Radarr/Sonarr.
//   2. EVERY CONFIGURED INSTANCE is read (guardrail 32), each on its own URL;
//      a failed instance is named in `errors` and the others still report.
//   3. The rules reach the wire: only released-without-file movies and series
//      with an aired, monitored, regular-season episode missing.
//   4. An integration switched off reads NOTHING.
//   5. The episode route only ever talks to a CONFIGURED Sonarr instance — an
//      unknown slug is refused before any fetch — and maps Sonarr's 404 / outage.
//   6. SEARCH queues exactly what is missing, on the row's own instance, after
//      re-judging it live: MoviesSearch for one movie; for a series a
//      SeasonSearch per season with no file, an EpisodeSearch for the rest, and
//      never SeriesSearch. A title with nothing missing any more is 409 and
//      queues nothing. Same ADMIN gate and configured-instance rule.
//
// Harness: the tests/library-cleanup-routes.test.mts idiom — real withAdmin
// handlers with a signed session JWT inside a synthetic request scope, over
// in-memory prisma stubs, with Radarr/Sonarr scripted on RFC1918 literals.
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import dns from "node:dns/promises";
import { createRequire } from "node:module";
import { AsyncLocalStorage } from "node:async_hooks";

(globalThis as { AsyncLocalStorage?: unknown }).AsyncLocalStorage = AsyncLocalStorage;

process.env.TOKEN_ENCRYPTION_KEY = "ab".repeat(32);
process.env.NEXTAUTH_SECRET = "missing-route-test-secret-0123456789abcdef";
process.env.AUTH_URL = "http://localhost:3000";
process.env.TRUST_PROXY = "true";
(process.env as Record<string, string | undefined>).NODE_ENV = "test";

const fakeLookup = async () => [{ address: "10.0.0.250", family: 4 }];
(dns as { lookup: unknown }).lookup = fakeLookup;
if ((dns as { lookup: unknown }).lookup !== fakeLookup) throw new Error("could not stub dns.lookup");

console.warn = () => {};
console.error = () => {};

// ── scripted Radarr/Sonarr ───────────────────────────────────────────────────
const RADARR = "http://10.0.0.5:7878";
const RADARR_4K = "http://10.0.0.6:7878";
const SONARR = "http://10.0.0.7:8989";
type Call = { origin: string; method: string; path: string; query: string; body: unknown };
let calls: Call[] = [];
let radarrMovies: Record<string, unknown[]> = {};
let sonarrSeries: unknown[] = [];
let sonarrEpisodes: Record<string, unknown[]> = {};
let status: (origin: string, path: string) => number = () => 200;

globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
  const url = new URL(String(input));
  const method = init?.method ?? "GET";
  const body = typeof init?.body === "string" ? JSON.parse(init.body) : undefined;
  calls.push({ origin: url.origin, method, path: url.pathname, query: url.search, body });
  const s = status(url.origin, url.pathname);
  if (s !== 200) return new Response("nope", { status: s });
  if (method === "POST" && url.pathname === "/api/v3/command") return Response.json({ id: calls.length, status: "queued", ...body }, { status: 201 });
  if (method !== "GET") throw new Error(`unexpected ${method} ${url}`);
  const movieById = /^\/api\/v3\/movie\/(\d+)$/.exec(url.pathname);
  if (movieById) {
    const row = (radarrMovies[url.origin] ?? []).find((m) => (m as { id: number }).id === Number(movieById[1]));
    return row ? Response.json(row) : new Response("not found", { status: 404 });
  }
  if (url.pathname === "/api/v3/movie") return Response.json(radarrMovies[url.origin] ?? []);
  if (url.pathname === "/api/v3/series") return Response.json(sonarrSeries);
  if (url.pathname === "/api/v3/episode") return Response.json(sonarrEpisodes[url.searchParams.get("seriesId") ?? ""] ?? []);
  throw new Error(`unexpected fetch ${url}`);
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
const { shadowPrismaModel } = await import("./_helpers.mts");
const { signSessionJwt } = await import("../src/lib/session-jwt.ts");
const { getSessionCookieName } = await import("../src/lib/session-cookie.ts");
const { Permission } = await import("../src/lib/permissions.ts");
const { invalidateFeatureFlagCache } = await import("../src/lib/features.ts");

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
    const u = usersById.get(args.where.id);
    return u ? { ...u } : null;
  },
  update: async () => ({}),
});
let sessionSeq = 0;
async function mintSession(opts: { role?: string; permissions?: bigint } = {}): Promise<string> {
  sessionSeq++;
  const userId = `admin-${sessionSeq}`;
  const sessionId = `sess-${sessionSeq}`;
  const role = opts.role ?? "ADMIN";
  const permissions = (opts.permissions ?? Permission.ADMIN).toString();
  usersById.set(userId, {
    role, permissions: BigInt(permissions), mediaServer: null, sessionsRevokedAt: null,
    passwordChangedAt: null, deactivatedAt: null, email: `a${sessionSeq}@example.com`, notificationEmail: null,
  });
  sessionRows.add(sessionId);
  const iat = Math.floor(Date.now() / 1000);
  return signSessionJwt(
    { id: userId, role, permissions, provider: "credentials", sessionId, expiresAt: iat + 86_400 },
    { expiresInSeconds: 7_200, iat },
  );
}
const COOKIE = getSessionCookieName();

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
let corePosters: Array<{ tmdbId: number; mediaType: string; posterPath: string | null }> = [];
let coreReads: Array<{ mediaType: string; ids: number[] }> = [];
shadowPrismaModel(prisma, "tmdbMediaCore", {
  findMany: async (args: { where: { mediaType: string; tmdbId: { in: number[] } } }) => {
    coreReads.push({ mediaType: args.where.mediaType, ids: [...args.where.tmdbId.in] });
    return corePosters.filter((p) => p.mediaType === args.where.mediaType && args.where.tmdbId.in.includes(p.tmdbId));
  },
});

const report = await import("../src/app/api/admin/missing/route.ts");
const episodesRoute = await import("../src/app/api/admin/missing/episodes/route.ts");
const searchRoute = await import("../src/app/api/admin/missing/search/route.ts");

// ── request scope ────────────────────────────────────────────────────────────
function inScope<T>(fn: () => Promise<T>): Promise<T> {
  const workStore = { route: "/missing.test", forceStatic: false, dynamicShouldError: false, afterContext: { after: () => {} } };
  const h = new Headers();
  const requestStore = {
    type: "request", phase: "render",
    headers: HeadersAdapter.seal(h),
    cookies: RequestCookiesAdapter.seal(new RequestCookies(h)),
    usedDynamic: false,
  };
  return workAsyncStorage.run(workStore, () => workUnitAsyncStorage.run(requestStore, fn));
}
const post = (token: string | null, body: unknown) =>
  inScope(() => (searchRoute.POST as unknown as (r: unknown, c: unknown) => Promise<Response>)(
    new NextRequest("http://localhost:3000/api/admin/missing/search", {
      method: "POST",
      headers: { "content-type": "application/json", ...(token ? { cookie: `${COOKIE}=${token}` } : {}) },
      body: typeof body === "string" ? body : JSON.stringify(body),
    }),
    undefined,
  ));
const commands = () => calls.filter((c) => c.method === "POST").map((c) => ({ origin: c.origin, body: c.body }));
const get = (handler: unknown, token: string | null, path: string) =>
  inScope(() => (handler as (r: unknown, c: unknown) => Promise<Response>)(
    new NextRequest(`http://localhost:3000/api/admin/missing${path}`, { headers: token ? { cookie: `${COOKIE}=${token}` } : {} }),
    undefined,
  ));

// ── fixture ──────────────────────────────────────────────────────────────────
const DAY = 86_400_000;
const ago = (d: number) => new Date(Date.now() - d * DAY).toISOString();
const ahead = (d: number) => new Date(Date.now() + d * DAY).toISOString();

beforeEach(() => {
  calls = [];
  coreReads = [];
  status = () => 200;
  settings.clear();
  for (const [k, v] of Object.entries({
    radarrUrl: RADARR, radarrApiKey: "radarr-key",
    radarr4kUrl: RADARR_4K, radarr4kApiKey: "radarr4k-key",
    sonarrUrl: SONARR, sonarrApiKey: "sonarr-key",
  })) settings.set(k, v);
  invalidateFeatureFlagCache();
  radarrMovies = {
    [RADARR]: [
      { id: 1, tmdbId: 101, title: "Released, no file", year: 2026, monitored: true, hasFile: false, digitalRelease: ago(5),
        images: [{ coverType: "poster", remoteUrl: "https://image.tmdb.org/t/p/original/own.jpg" }] },
      { id: 2, tmdbId: 102, title: "In cinemas only", monitored: true, hasFile: false, inCinemas: ago(10), digitalRelease: ahead(20) },
      { id: 3, tmdbId: 103, title: "Has file", monitored: true, hasFile: true, physicalRelease: ago(100) },
      { id: 4, tmdbId: 104, title: "Unmonitored", monitored: false, hasFile: false, physicalRelease: ago(200) },
    ],
    [RADARR_4K]: [{ id: 9, tmdbId: 101, title: "Released, no file", monitored: true, hasFile: false, physicalRelease: ago(2) }],
  };
  sonarrSeries = [
    { id: 31, tmdbId: 301, tvdbId: 3001, title: "Behind", monitored: true, status: "continuing", previousAiring: ago(1),
      seasons: [{ seasonNumber: 0, statistics: { episodeCount: 2, episodeFileCount: 0 } }, { seasonNumber: 1, statistics: { episodeCount: 8, episodeFileCount: 6 } }] },
    { id: 32, tmdbId: 302, tvdbId: 3002, title: "Complete", monitored: true, status: "continuing",
      seasons: [{ seasonNumber: 1, statistics: { episodeCount: 8, episodeFileCount: 8, totalEpisodeCount: 12 } }] },
    { id: 33, tmdbId: 303, tvdbId: 3003, title: "Not aired yet", monitored: true, status: "upcoming",
      seasons: [{ seasonNumber: 1, statistics: { episodeCount: 0, episodeFileCount: 0, totalEpisodeCount: 10 } }] },
    { id: 34, tmdbId: 304, tvdbId: 3004, title: "Specials only", monitored: true, status: "ended",
      seasons: [{ seasonNumber: 0, statistics: { episodeCount: 3, episodeFileCount: 0 } }, { seasonNumber: 1, statistics: { episodeCount: 5, episodeFileCount: 5 } }] },
  ];
  sonarrEpisodes = {
    "31": [
      { id: 107, seasonNumber: 1, episodeNumber: 7, title: "Seven", airDateUtc: ago(8), monitored: true, hasFile: false },
      { id: 108, seasonNumber: 1, episodeNumber: 8, title: "Eight", airDateUtc: ago(1), monitored: true, hasFile: false },
      { id: 106, seasonNumber: 1, episodeNumber: 6, title: "Six", airDateUtc: ago(15), monitored: true, hasFile: true },
      { id: 109, seasonNumber: 1, episodeNumber: 9, title: "Nine", airDateUtc: ahead(6), monitored: true, hasFile: false },
      { id: 100, seasonNumber: 0, episodeNumber: 1, title: "Special", airDateUtc: ago(30), monitored: true, hasFile: false },
    ],
  };
  corePosters = [{ tmdbId: 301, mediaType: "TV", posterPath: "/behind.jpg" }];
});

// ── 1: auth ──────────────────────────────────────────────────────────────────

test("anonymous is 401 on every route, and nothing reaches Radarr/Sonarr", async () => {
  assert.equal((await get(report.GET, null, "?service=radarr")).status, 401);
  assert.equal((await get(episodesRoute.GET, null, "/episodes?seriesId=31")).status, 401);
  assert.equal((await post(null, { service: "radarr", instance: "", arrId: 1 })).status, 401);
  assert.deepEqual(calls, []);
});

for (const [label, role, permissions] of [
  ["a plain USER", "USER", 0n],
  ["a MANAGE_REQUESTS delegate", "USER", Permission.MANAGE_REQUESTS],
  ["an ISSUE_ADMIN", "ISSUE_ADMIN", Permission.MANAGE_ISSUES],
] as const) {
  test(`${label} is refused 403 on every route, and nothing reaches Radarr/Sonarr`, async () => {
    const token = await mintSession({ role, permissions });
    assert.equal((await get(report.GET, token, "?service=sonarr")).status, 403);
    assert.equal((await get(episodesRoute.GET, token, "/episodes?seriesId=31")).status, 403);
    assert.equal((await post(token, { service: "sonarr", instance: "", arrId: 31 })).status, 403);
    assert.deepEqual(calls, []);
  });
}

test("a missing or unknown service is 400, before any upstream call", async () => {
  const token = await mintSession();
  for (const qs of ["", "?service=lidarr", "?service=RADARR"]) {
    assert.equal((await get(report.GET, token, qs)).status, 400, qs);
  }
  assert.deepEqual(calls, []);
});

// ── 2/3: the reports ─────────────────────────────────────────────────────────

test("radarr: every configured instance is read; only released movies without a file come back, unmonitored ones flagged", async () => {
  const res = await get(report.GET, await mintSession(), "?service=radarr");
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.service, "radarr");
  assert.equal(body.enabled, true);
  assert.deepEqual(body.instances.map((i: { slug: string }) => i.slug).sort(), ["", "4k"]);
  assert.deepEqual(body.errors, []);
  assert.deepEqual(
    calls.map((c) => `${c.origin}${c.path}`).sort(),
    [`${RADARR}/api/v3/movie`, `${RADARR_4K}/api/v3/movie`],
  );
  const got = body.items.map((m: { instance: string; arrId: number; monitored: boolean }) => `${m.instance}:${m.arrId}:${m.monitored}`);
  assert.deepEqual(got, ["4k:9:true", ":1:true", ":4:false"], "most recently released first; cinema-only and file-bearing movies absent");
  const own = body.items.find((m: { arrId: number }) => m.arrId === 1);
  assert.equal(own.posterPath, "/own.jpg");
  assert.equal(own.daysMissing, 5);
});

test("sonarr: a series is listed only when an aired, monitored, regular-season episode is missing; posters from the TMDB cache", async () => {
  const res = await get(report.GET, await mintSession(), "?service=sonarr");
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.deepEqual(calls.map((c) => `${c.origin}${c.path}`), [`${SONARR}/api/v3/series`]);
  assert.deepEqual(body.items.map((s: { arrId: number }) => s.arrId), [31], "complete, not-yet-aired and specials-only series are absent");
  const s = body.items[0];
  assert.equal(s.missing, 2);
  assert.equal(s.aired, 8);
  assert.deepEqual(s.seasons.map((x: { seasonNumber: number; missing: number }) => [x.seasonNumber, x.missing]), [[1, 2]]);
  assert.equal(s.posterPath, "/behind.jpg");
  assert.deepEqual(coreReads, [{ mediaType: "TV", ids: [301] }]);
});

test("a failing instance is named in errors and the others still report", async () => {
  status = (origin) => (origin === RADARR_4K ? 503 : 200);
  const body = await (await get(report.GET, await mintSession(), "?service=radarr")).json();
  assert.equal(body.errors.length, 1);
  assert.equal(body.errors[0].instance, "4k");
  assert.match(body.errors[0].error, /503/);
  assert.ok(!JSON.stringify(body.errors).includes("10.0.0.6"), "the instance URL is not echoed");
  assert.deepEqual(body.items.map((m: { arrId: number }) => m.arrId), [1, 4]);
});

test("a failed poster lookup is cosmetic — the report still answers", async () => {
  shadowPrismaModel(prisma, "tmdbMediaCore", { findMany: async () => { throw new Error("db down"); } });
  try {
    const res = await get(report.GET, await mintSession(), "?service=sonarr");
    assert.equal(res.status, 200);
    assert.equal((await res.json()).items[0].posterPath, null);
  } finally {
    shadowPrismaModel(prisma, "tmdbMediaCore", {
      findMany: async (args: { where: { mediaType: string; tmdbId: { in: number[] } } }) =>
        corePosters.filter((p) => p.mediaType === args.where.mediaType && args.where.tmdbId.in.includes(p.tmdbId)),
    });
  }
});

// ── 4: integration off ───────────────────────────────────────────────────────

test("with the integration switched off nothing is read and the report says so", async () => {
  settings.set("feature.integration.radarr", "false");
  invalidateFeatureFlagCache();
  const body = await (await get(report.GET, await mintSession(), "?service=radarr")).json();
  assert.equal(body.enabled, false);
  assert.deepEqual(body.items, []);
  assert.deepEqual(calls, []);
});

// ── 5: episodes ──────────────────────────────────────────────────────────────

test("episodes: the series' aired, monitored, regular-season episodes without a file, in order", async () => {
  const res = await get(episodesRoute.GET, await mintSession(), "/episodes?seriesId=31");
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.deepEqual(body.episodes.map((e: { episodeNumber: number }) => e.episodeNumber), [7, 8]);
  assert.deepEqual(calls.map((c) => `${c.origin}${c.path}${c.query}`), [`${SONARR}/api/v3/episode?seriesId=31`]);
});

test("episodes: a slug the registry doesn't list is 404 and never becomes a fetch — even with its Setting rows left behind", async () => {
  // A de-registered instance's connection keys can outlive it; the registry,
  // not the presence of a URL, decides what may be addressed.
  settings.set("sonarrAnimeUrl", "http://10.0.0.9:8989");
  settings.set("sonarrAnimeApiKey", "orphan-key");
  const token = await mintSession();
  for (const slug of ["anime", "4k", "hd", "../x"]) {
    assert.equal((await get(episodesRoute.GET, token, `/episodes?seriesId=31&instance=${encodeURIComponent(slug)}`)).status, 404, slug);
  }
  assert.deepEqual(calls, []);
});

test("episodes: a malformed seriesId is 400 before any fetch", async () => {
  const token = await mintSession();
  for (const id of ["", "0", "-3", "1.5", "abc", "31;x", "99999999999"]) {
    assert.equal((await get(episodesRoute.GET, token, `/episodes?seriesId=${encodeURIComponent(id)}`)).status, 400, id);
  }
  assert.deepEqual(calls, []);
});

test("episodes: Sonarr off is 404 with no fetch; Sonarr's own 404 is 404; an outage is 502", async () => {
  const token = await mintSession();
  settings.set("feature.integration.sonarr", "false");
  invalidateFeatureFlagCache();
  assert.equal((await get(episodesRoute.GET, token, "/episodes?seriesId=31")).status, 404);
  assert.deepEqual(calls, []);

  settings.delete("feature.integration.sonarr");
  invalidateFeatureFlagCache();
  status = () => 404;
  assert.equal((await get(episodesRoute.GET, token, "/episodes?seriesId=31")).status, 404);
  status = () => 500;
  const res = await get(episodesRoute.GET, token, "/episodes?seriesId=31");
  assert.equal(res.status, 502);
  assert.ok(!(await res.text()).includes("10.0.0.7"), "the instance URL is not echoed");
});

// ── 6: search ────────────────────────────────────────────────────────────────

test("search radarr: re-reads the movie on ITS instance, then queues MoviesSearch for exactly that id", async () => {
  const res = await post(await mintSession(), { service: "radarr", instance: "4k", arrId: 9 });
  assert.equal(res.status, 202);
  assert.deepEqual(await res.json(), { commands: 1, seasons: [], episodes: 0 });
  assert.deepEqual(calls.filter((c) => c.method === "GET").map((c) => `${c.origin}${c.path}`), [`${RADARR_4K}/api/v3/movie/9`]);
  assert.deepEqual(commands(), [{ origin: RADARR_4K, body: { name: "MoviesSearch", movieIds: [9] } }]);
});

test("search radarr: a movie that gained a file, or isn't released, is 409 and queues nothing", async () => {
  const token = await mintSession();
  assert.equal((await post(token, { service: "radarr", instance: "", arrId: 3 })).status, 409, "has a file");
  assert.equal((await post(token, { service: "radarr", instance: "", arrId: 2 })).status, 409, "cinema-only");
  assert.deepEqual(commands(), []);
});

test("search radarr: a movie Radarr no longer has is 404 and queues nothing", async () => {
  const res = await post(await mintSession(), { service: "radarr", instance: "", arrId: 777 });
  assert.equal(res.status, 404);
  assert.deepEqual(commands(), []);
});

test("search sonarr: SeasonSearch for a season with no file, EpisodeSearch for the rest — never SeriesSearch", async () => {
  sonarrEpisodes["31"] = [
    { id: 1, seasonNumber: 1, episodeNumber: 1, airDateUtc: ago(40), monitored: true, hasFile: true },
    { id: 2, seasonNumber: 1, episodeNumber: 2, airDateUtc: ago(39), monitored: true, hasFile: false },
    { id: 3, seasonNumber: 1, episodeNumber: 3, airDateUtc: ago(38), monitored: true, hasFile: false },
    { id: 4, seasonNumber: 2, episodeNumber: 1, airDateUtc: ago(10), monitored: true, hasFile: false },
    { id: 5, seasonNumber: 2, episodeNumber: 2, airDateUtc: ago(3), monitored: true, hasFile: false },
    { id: 6, seasonNumber: 2, episodeNumber: 3, airDateUtc: ahead(4), monitored: true, hasFile: false },
    { id: 7, seasonNumber: 0, episodeNumber: 1, airDateUtc: ago(50), monitored: true, hasFile: false },
  ];
  const res = await post(await mintSession(), { service: "sonarr", arrId: 31 });
  assert.equal(res.status, 202);
  assert.deepEqual(await res.json(), { commands: 2, seasons: [2], episodes: 2 });
  assert.deepEqual(commands(), [
    { origin: SONARR, body: { name: "SeasonSearch", seriesId: 31, seasonNumber: 2 } },
    { origin: SONARR, body: { name: "EpisodeSearch", episodeIds: [2, 3] } },
  ]);
  assert.ok(!calls.some((c) => (c.body as { name?: string } | undefined)?.name === "SeriesSearch"));
});

test("search sonarr: a series with nothing missing any more is 409 and queues nothing", async () => {
  sonarrEpisodes["31"] = [{ id: 1, seasonNumber: 1, episodeNumber: 1, airDateUtc: ago(4), monitored: true, hasFile: true }];
  const res = await post(await mintSession(), { service: "sonarr", instance: "", arrId: 31 });
  assert.equal(res.status, 409);
  assert.deepEqual(commands(), []);
});

test("search: a slug the registry doesn't list is 404 and never becomes a fetch", async () => {
  settings.set("radarrAnimeUrl", "http://10.0.0.9:7878");
  settings.set("radarrAnimeApiKey", "orphan-key");
  const token = await mintSession();
  for (const instance of ["anime", "hd", "../x"]) {
    assert.equal((await post(token, { service: "radarr", instance, arrId: 1 })).status, 404, instance);
  }
  assert.deepEqual(calls, []);
});

test("search: a malformed body is 400 before any fetch", async () => {
  const token = await mintSession();
  for (const body of [
    {}, [], "not json", { service: "lidarr", arrId: 1 }, { service: "radarr" }, { service: "radarr", arrId: 0 },
    { service: "radarr", arrId: 1.5 }, { service: "radarr", arrId: "1" }, { service: "radarr", arrId: 1, instance: 4 },
    { service: "radarr", arrId: 1, instance: "x".repeat(101) },
  ]) {
    assert.equal((await post(token, body)).status, 400, JSON.stringify(body));
  }
  assert.deepEqual(calls, []);
});

test("search: integration off is 404 with no fetch; a command Sonarr refuses is 502 without echoing the URL", async () => {
  const token = await mintSession();
  settings.set("feature.integration.sonarr", "false");
  invalidateFeatureFlagCache();
  assert.equal((await post(token, { service: "sonarr", arrId: 31 })).status, 404);
  assert.deepEqual(calls, []);

  settings.delete("feature.integration.sonarr");
  invalidateFeatureFlagCache();
  status = (_origin, path) => (path === "/api/v3/command" ? 500 : 200);
  const res = await post(token, { service: "sonarr", arrId: 31 });
  assert.equal(res.status, 502);
  assert.equal(commands().length, 1, "the refused command was attempted once");
  assert.ok(!(await res.text()).includes("10.0.0.7"));
});
