// Route-level tests for the admin "Add to Radarr/Sonarr" and "Remove from
// Radarr/Sonarr" (src/app/api/admin/arr/title/{add,remove}/route.ts,
// src/lib/arr-title-lifecycle.ts). What is pinned:
//   - an add only sends values the instance offers, only the listed fields,
//     and never re-adds a title the instance has;
//   - a removal is refused while an APPROVED request on that instance would
//     make the sync put it back, stamps the AVAILABLE requests on that
//     instance (guardrail 14b) BEFORE the delete and unstamps on failure,
//     sends both flags explicitly, and needs the dry run's id echoed;
//   - both are audited after the arr accepted them.
//
// Harness: the same as tests/arr-manage-routes.test.mts.
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import dns from "node:dns/promises";
import { createRequire } from "node:module";
import { AsyncLocalStorage } from "node:async_hooks";

(globalThis as { AsyncLocalStorage?: unknown }).AsyncLocalStorage = AsyncLocalStorage;

process.env.TOKEN_ENCRYPTION_KEY = "ab".repeat(32);
process.env.NEXTAUTH_SECRET = "arr-manage-route-test-secret-0123456789abcdef";
process.env.AUTH_URL = "http://localhost:3000";
process.env.TRUST_PROXY = "true";
delete process.env.TMDB_READ_TOKEN;
(process.env as Record<string, string | undefined>).NODE_ENV = "test";

const fakeLookup = async () => [{ address: "10.0.0.250", family: 4 }];
(dns as { lookup: unknown }).lookup = fakeLookup;
if ((dns as { lookup: unknown }).lookup !== fakeLookup) throw new Error("could not stub dns.lookup");

let warnLines: string[] = [];
console.warn = (...a: unknown[]) => { warnLines.push(a.map(String).join(" ")); };
console.error = () => {};

// ── scripted Radarr/Sonarr ───────────────────────────────────────────────────
const RADARR = "http://10.0.0.5:7878";
const RADARR_4K = "http://10.0.0.6:7878";
const SONARR = "http://10.0.0.7:8989";
type Call = { origin: string; method: string; path: string; query: URLSearchParams; body: unknown };
let calls: Call[] = [];
type Responder = (c: Call) => Response | undefined;
let responder: Responder = () => undefined;
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
  const url = new URL(String(input));
  const method = init?.method ?? "GET";
  let body: unknown;
  if (typeof init?.body === "string" && init.body !== "") {
    try { body = JSON.parse(init.body); } catch { body = init.body; }
  }
  const call = { origin: url.origin, method, path: url.pathname, query: url.searchParams, body };
  calls.push(call);
  const res = responder(call);
  if (res) return res;
  throw new Error(`unexpected ${method} ${url}`);
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
const { _resetReleaseHandlesForTests } = await import("../src/lib/release-handles.ts");

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
  const userId = `user-${sessionSeq}`;
  const sessionId = `sess-${sessionSeq}`;
  const role = opts.role ?? "ADMIN";
  const permissions = (opts.permissions ?? Permission.ADMIN).toString();
  usersById.set(userId, {
    role, permissions: BigInt(permissions), mediaServer: null, sessionsRevokedAt: null,
    passwordChangedAt: null, deactivatedAt: null, email: `u${sessionSeq}@example.com`, notificationEmail: null,
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
  upsert: async () => ({}),
});
const tmdbCacheRows = new Map<string, string>();
const future = new Date(Date.now() + 86_400_000);
shadowPrismaModel(prisma, "tmdbCache", {
  findUnique: async (args: { where: { key: string } }) => {
    const data = tmdbCacheRows.get(args.where.key);
    return data === undefined ? null : { key: args.where.key, data, expiresAt: future };
  },
  findMany: async (args: { where: { key: { in: string[] } } }) =>
    args.where.key.in.filter((k) => tmdbCacheRows.has(k)).map((key) => ({ key, data: tmdbCacheRows.get(key), expiresAt: future })),
  upsert: async () => ({}),
  deleteMany: async () => ({ count: 0 }),
});
shadowPrismaModel(prisma, "tmdbMediaCore", { findMany: async () => [] });
const audits: Array<{ action: string; target: string | null; details: unknown }> = [];
shadowPrismaModel(prisma, "auditLog", {
  create: async (args: { data: { action: string; target?: string | null; details?: unknown } }) => {
    audits.push({ action: args.data.action, target: args.data.target ?? null, details: args.data.details });
    return {};
  },
});

type Req = { id: string; tmdbId: number; tvdbId: number | null; mediaType: string; arrInstance: string; status: string; cleanedUpAt: Date | null };
let requests: Req[] = [];
const matches = (r: Req, where: Record<string, unknown>): boolean => Object.entries(where).every(([k, v]) => {
  if (k === "OR") return (v as Array<Record<string, unknown>>).some((w) => matches(r, w));
  if (k === "id" && v && typeof v === "object" && "in" in (v as object)) return ((v as { in: string[] }).in).includes(r.id);
  if (v && typeof v === "object" && !(v instanceof Date) && "not" in (v as object)) return (r as unknown as Record<string, unknown>)[k] !== (v as { not: unknown }).not;
  return (r as unknown as Record<string, unknown>)[k] === v;
});
shadowPrismaModel(prisma, "mediaRequest", {
  groupBy: async (args: { where: Record<string, unknown> }) => {
    const by = new Map<string, number>();
    for (const r of requests.filter((x) => matches(x, args.where))) by.set(r.status, (by.get(r.status) ?? 0) + 1);
    return [...by].map(([status, n]) => ({ status, _count: { _all: n } }));
  },
  findMany: async (args: { where: Record<string, unknown> }) => requests.filter((x) => matches(x, args.where)).map((r) => ({ id: r.id })),
  updateMany: async (args: { where: Record<string, unknown>; data: { cleanedUpAt: Date | null } }) => {
    const hit = requests.filter((x) => matches(x, args.where));
    for (const r of hit) r.cleanedUpAt = args.data.cleanedUpAt;
    return { count: hit.length };
  },
});
const addRoute = await import("../src/app/api/admin/arr/title/add/route.ts");
const removeRoute = await import("../src/app/api/admin/arr/title/remove/route.ts");

// ── request scope ────────────────────────────────────────────────────────────
function inScope<T>(fn: () => Promise<T>): Promise<T> {
  const workStore = { route: "/arr-manage.test", forceStatic: false, dynamicShouldError: false, afterContext: { after: () => {} } };
  const h = new Headers();
  const requestStore = {
    type: "request", phase: "render",
    headers: HeadersAdapter.seal(h),
    cookies: RequestCookiesAdapter.seal(new RequestCookies(h)),
    usedDynamic: false,
  };
  return workAsyncStorage.run(workStore, () => workUnitAsyncStorage.run(requestStore, fn));
}
type Handler = (r: unknown, c: unknown) => Promise<Response>;
const call = (handler: unknown, token: string | null, path: string, init: { method?: string; body?: unknown } = {}) =>
  inScope(() => (handler as Handler)(
    new NextRequest(`http://localhost:3000/api${path}`, {
      method: init.method ?? "GET",
      headers: {
        ...(token ? { cookie: `${COOKIE}=${token}` } : {}),
        ...(init.body !== undefined ? { "content-type": "application/json" } : {}),
      },
      ...(init.body !== undefined ? { body: JSON.stringify(init.body) } : {}),
    }),
    undefined,
  ));
const arrCalls = () => calls.filter((c) => c.origin !== "http://localhost:3000");
const writes = () => arrCalls().filter((c) => c.method !== "GET");

// ── fixtures ─────────────────────────────────────────────────────────────────
const PROFILES = [{ id: 1, name: "HD-1080p" }, { id: 2, name: "Ultra-HD" }];
const ROOTS = [{ id: 1, path: "/movies/", freeSpace: 1e12, accessible: true }, { id: 2, path: "/movies-4k/", freeSpace: 2e12, accessible: true }];
const TV_ROOTS = [{ id: 1, path: "/tv/", freeSpace: 1e12 }, { id: 2, path: "/anime/", freeSpace: 1e12 }];
const TAGS = [{ id: 1, label: "kids" }, { id: 2, label: "requested" }];
const movie = (over: Record<string, unknown> = {}) => ({
  id: 11, tmdbId: 603, title: "The Matrix", year: 1999, monitored: true, qualityProfileId: 1,
  rootFolderPath: "/movies/", path: "/movies/The Matrix (1999)", tags: [1], hasFile: true,
  minimumAvailability: "released", status: "released", sizeOnDisk: 4e9, ...over,
});
const series = (over: Record<string, unknown> = {}) => ({
  id: 21, tvdbId: 81189, tmdbId: 1396, title: "Breaking Bad", year: 2008, monitored: true, qualityProfileId: 1,
  rootFolderPath: "/tv/", path: "/tv/Breaking Bad", tags: [], seriesType: "standard", seasonFolder: true,
  unknownFieldSonarrSent: { keep: "me" },
  seasons: [
    { seasonNumber: 0, monitored: false, statistics: { episodeCount: 0, episodeFileCount: 0, totalEpisodeCount: 3 } },
    { seasonNumber: 1, monitored: true, statistics: { episodeCount: 2, episodeFileCount: 2, totalEpisodeCount: 2 } },
    { seasonNumber: 2, monitored: true, statistics: { episodeCount: 2, episodeFileCount: 1, totalEpisodeCount: 2 } },
  ],
  ...over,
});
const EPISODES = [
  { id: 101, seriesId: 21, seasonNumber: 1, episodeNumber: 1, title: "Pilot", monitored: true, hasFile: true, episodeFileId: 501, airDateUtc: "2008-01-20T02:00:00Z" },
  { id: 102, seriesId: 21, seasonNumber: 1, episodeNumber: 2, title: "Cat's in the Bag", monitored: true, hasFile: true, episodeFileId: 502, airDateUtc: "2008-01-27T02:00:00Z" },
  { id: 201, seriesId: 21, seasonNumber: 2, episodeNumber: 1, title: "Seven Thirty-Seven", monitored: true, hasFile: true, episodeFileId: 503, airDateUtc: "2009-03-09T02:00:00Z" },
  { id: 202, seriesId: 21, seasonNumber: 2, episodeNumber: 2, title: "Grilled", monitored: true, hasFile: false, episodeFileId: 0, airDateUtc: "2009-03-16T02:00:00Z" },
];
// Another series' episode, reachable by id — the per-id check must refuse it.
const OTHER_SERIES_EPISODES = [
  { id: 901, seriesId: 99, seasonNumber: 1, episodeNumber: 1, title: "Elsewhere", monitored: true, hasFile: false, episodeFileId: 0, airDateUtc: "2010-01-01T00:00:00Z" },
];
const radarrBase: Responder = (c) => {
  if (c.origin !== RADARR || c.method !== "GET") return undefined;
  if (c.path === "/api/v3/movie" && c.query.get("tmdbId") === "603") return json([movie()]);
  if (c.path === "/api/v3/movie/11") return json(movie());
  if (c.path === "/api/v3/qualityprofile") return json(PROFILES);
  if (c.path === "/api/v3/rootfolder") return json(ROOTS);
  if (c.path === "/api/v3/tag") return json(TAGS);
  return undefined;
};
const sonarrBase: Responder = (c) => {
  if (c.origin !== SONARR || c.method !== "GET") return undefined;
  if (c.path === "/api/v3/series" && c.query.get("tvdbId") === "81189") return json([series()]);
  if (c.path === "/api/v3/series/21") return json(series());
  if (c.path === "/api/v3/episode" && c.query.get("seriesId") === "21") {
    const season = c.query.get("seasonNumber");
    return json(season === null ? EPISODES : EPISODES.filter((e) => String(e.seasonNumber) === season));
  }
  const oneEpisode = /^\/api\/v3\/episode\/(\d+)$/.exec(c.path);
  if (oneEpisode) {
    const ep = [...EPISODES, ...OTHER_SERIES_EPISODES].find((e) => String(e.id) === oneEpisode[1]);
    return ep ? json(ep) : new Response("{}", { status: 404 });
  }
  if (c.path === "/api/v3/qualityprofile") return json(PROFILES);
  if (c.path === "/api/v3/rootfolder") return json(TV_ROOTS);
  if (c.path === "/api/v3/tag") return json(TAGS);
  return undefined;
};
const both = (...rs: Responder[]): Responder => (c) => {
  for (const r of rs) {
    const res = r(c);
    if (res) return res;
  }
  return undefined;
};

beforeEach(() => {
  calls = [];
  audits.length = 0;
  warnLines = [];
  _resetReleaseHandlesForTests();
  responder = both(radarrBase, sonarrBase);
  tmdbCacheRows.clear();
  tmdbCacheRows.set("tmdb-to-tvdb:1396", JSON.stringify({ tvdbId: 81189 }));
  settings.clear();
  for (const [k, v] of Object.entries({
    radarrUrl: RADARR, radarrApiKey: "radarr-key",
    radarr4kUrl: RADARR_4K, radarr4kApiKey: "radarr4k-key",
    sonarrUrl: SONARR, sonarrApiKey: "sonarr-key",
  })) settings.set(k, v);
  invalidateFeatureFlagCache();
});


beforeEach(() => {
  requests = [];
});

const LOOKUP_MOVIE = [
  { tmdbId: 999, title: "Some Other Film", year: 2001, titleSlug: "other", images: [] },
  { tmdbId: 27205, title: "Inception", year: 2010, titleSlug: "inception-27205", images: [{ coverType: "poster" }], overview: "dreams" },
];
const addResponder: Responder = (c) => {
  if (c.origin !== RADARR) return undefined;
  if (c.method === "GET" && c.path === "/api/v3/movie" && c.query.get("tmdbId") === "27205") return json([]);
  if (c.method === "GET" && c.path === "/api/v3/movie/lookup") return json(LOOKUP_MOVIE);
  if (c.method === "POST" && c.path === "/api/v3/movie") return json({ id: 77 }, 201);
  return undefined;
};

test("add: the instance's own choices and configured defaults; a title it already has names its arr id", async () => {
  const token = await mintSession();
  settings.set("radarrQualityProfileId", "2");
  settings.set("radarrRootFolder", "/movies-4k/");
  responder = both(addResponder, radarrBase);
  const res = await call(addRoute.GET, token, "/admin/arr/title/add?service=radarr&tmdbId=27205");
  assert.equal(res.status, 200);
  const body = (await res.json()) as { presentArrId: number | null; preview: { title: string }; qualityProfiles: unknown[]; defaults: { qualityProfileId: number; rootFolderPath: string } };
  assert.equal(body.presentArrId, null);
  assert.equal(body.preview.title, "Inception", "the lookup row naming THIS id, not the first row");
  assert.equal(body.qualityProfiles.length, 2);
  assert.deepEqual([body.defaults.qualityProfileId, body.defaults.rootFolderPath], [2, "/movies-4k/"]);

  const present = (await (await call(addRoute.GET, token, "/admin/arr/title/add?service=radarr&tmdbId=603")).json()) as { presentArrId: number };
  assert.equal(present.presentArrId, 11);
});

test("add: ONE POST with only the listed fields and the admin's choices; audited after", async () => {
  const token = await mintSession();
  responder = both(addResponder, radarrBase);
  const res = await call(addRoute.POST, token, "/admin/arr/title/add", { method: "POST", body: {
    service: "radarr", tmdbId: 27205, qualityProfileId: 2, rootFolderPath: "/movies-4k/", tags: [2], monitored: true, search: false, minimumAvailability: "released",
  } });
  assert.equal(res.status, 201);
  assert.deepEqual(await res.json(), { arrId: 77, title: "Inception" });
  assert.deepEqual(writes().map((c) => [c.method, c.path, c.body]), [["POST", "/api/v3/movie", {
    tmdbId: 27205, title: "Inception", year: 2010, titleSlug: "inception-27205", images: [{ coverType: "poster" }],
    rootFolderPath: "/movies-4k/", qualityProfileId: 2, minimumAvailability: "released", tags: [2], monitored: true,
    addOptions: { searchForMovie: false },
  }]], "never the whole lookup row (overview etc.)");
  assert.equal(audits[0].action, "ARR_TITLE_ADD");
});

test("add: a root folder, profile or tag the instance doesn't have is 400 with NOTHING written; one it already has is 409 with its id", async () => {
  const token = await mintSession();
  responder = both(addResponder, radarrBase);
  const post = (over: Record<string, unknown>) => call(addRoute.POST, token, "/admin/arr/title/add", { method: "POST", body: {
    service: "radarr", tmdbId: 27205, qualityProfileId: 1, rootFolderPath: "/movies/", tags: [], monitored: true, search: true, ...over,
  } });
  assert.equal((await post({ rootFolderPath: "/etc/" })).status, 400);
  assert.equal((await post({ qualityProfileId: 9 })).status, 400);
  assert.equal((await post({ tags: [42] })).status, 400);
  assert.equal((await post({ monitor: "all" })).status, 400, "a Sonarr field on a Radarr add");
  assert.deepEqual(writes(), []);
  const dup = await post({ tmdbId: 603 });
  assert.equal(dup.status, 409);
  assert.equal(((await dup.json()) as { arrId: number }).arrId, 11);
  assert.deepEqual(writes(), []);
  assert.equal(audits.length, 0);
});

test("add (Sonarr): resolves through the series lookup and sends the monitor option and the admin's choices", async () => {
  const token = await mintSession();
  responder = both((c) => {
    if (c.origin !== SONARR) return undefined;
    if (c.method === "GET" && c.path === "/api/v3/series" && c.query.get("tvdbId") === "121361") return json([]);
    if (c.method === "GET" && c.path === "/api/v3/series/lookup" && c.query.get("term") === "tmdb:1399") {
      return json([{ tmdbId: 1399, tvdbId: 121361, title: "Game of Thrones", year: 2011, titleSlug: "got", images: [], seasons: [{ seasonNumber: 0 }, { seasonNumber: 1 }] }]);
    }
    if (c.method === "GET" && c.path === "/api/v3/languageprofile") return json({}, 404);
    if (c.method === "POST" && c.path === "/api/v3/series") return json({ id: 31 }, 201);
    return undefined;
  }, sonarrBase);
  tmdbCacheRows.set("tmdb-to-tvdb:1399", JSON.stringify({ tvdbId: 121361 }));
  const res = await call(addRoute.POST, token, "/admin/arr/title/add", { method: "POST", body: {
    service: "sonarr", tmdbId: 1399, qualityProfileId: 1, rootFolderPath: "/anime/", tags: [], monitor: "future", search: false, seriesType: "anime",
  } });
  assert.equal(res.status, 201);
  const post = writes().find((c) => c.path === "/api/v3/series")!.body as Record<string, unknown>;
  assert.deepEqual(post.addOptions, { monitor: "future", searchForMissingEpisodes: false });
  assert.deepEqual(post.seasons, [{ seasonNumber: 0, monitored: false }, { seasonNumber: 1, monitored: true }]);
  assert.equal(post.seriesType, "anime");
  assert.equal(post.monitored, true);
});

test("add: putting a title back withdraws THIS instance's removal stamps (by tmdb or tvdb id), never another instance's", async () => {
  const token = await mintSession();
  const stamp = new Date("2026-09-01T00:00:00Z");
  requests = [
    { id: "here", tmdbId: 1399, tvdbId: null, mediaType: "TV", arrInstance: "", status: "AVAILABLE", cleanedUpAt: stamp },
    { id: "byTvdb", tmdbId: 5555, tvdbId: 121361, mediaType: "TV", arrInstance: "", status: "AVAILABLE", cleanedUpAt: stamp },
    { id: "otherInstance", tmdbId: 1399, tvdbId: null, mediaType: "TV", arrInstance: "4k", status: "AVAILABLE", cleanedUpAt: stamp },
    { id: "otherTitle", tmdbId: 1400, tvdbId: null, mediaType: "TV", arrInstance: "", status: "AVAILABLE", cleanedUpAt: stamp },
  ];
  responder = both((c) => {
    if (c.origin !== SONARR) return undefined;
    if (c.method === "GET" && c.path === "/api/v3/series" && c.query.get("tvdbId") === "121361") return json([]);
    if (c.method === "GET" && c.path === "/api/v3/series/lookup" && c.query.get("term") === "tmdb:1399") {
      return json([{ tmdbId: 1399, tvdbId: 121361, title: "Game of Thrones", year: 2011, titleSlug: "got", images: [], seasons: [{ seasonNumber: 1 }] }]);
    }
    if (c.method === "GET" && c.path === "/api/v3/languageprofile") return json({}, 404);
    if (c.method === "POST" && c.path === "/api/v3/series") return json({ id: 31 }, 201);
    return undefined;
  }, sonarrBase);
  tmdbCacheRows.set("tmdb-to-tvdb:1399", JSON.stringify({ tvdbId: 121361 }));
  const res = await call(addRoute.POST, token, "/admin/arr/title/add", { method: "POST", body: {
    service: "sonarr", tmdbId: 1399, qualityProfileId: 1, rootFolderPath: "/tv/", tags: [], monitor: "all", search: false, seasonFolder: false,
  } });
  assert.equal(res.status, 201);
  assert.equal((writes().find((c) => c.path === "/api/v3/series")!.body as Record<string, unknown>).seasonFolder, false, "the admin's season-folder choice is sent");
  const stampOf = (id: string) => requests.find((r) => r.id === id)!.cleanedUpAt;
  assert.equal(stampOf("here"), null);
  assert.equal(stampOf("byTvdb"), null, "a request linked by its tvdb id alone is this title's too");
  assert.equal(stampOf("otherInstance"), stamp, "the title is still gone from the 4K instance");
  assert.equal(stampOf("otherTitle"), stamp);
});

test("add: a refused add clears no stamp", async () => {
  const token = await mintSession();
  const stamp = new Date("2026-09-01T00:00:00Z");
  requests = [{ id: "a", tmdbId: 27205, tvdbId: null, mediaType: "MOVIE", arrInstance: "", status: "AVAILABLE", cleanedUpAt: stamp }];
  responder = both((c) => (c.method === "POST" && c.path === "/api/v3/movie" ? json([{ errorMessage: "Path is not valid" }], 400) : undefined), addResponder, radarrBase);
  const res = await call(addRoute.POST, token, "/admin/arr/title/add", { method: "POST", body: {
    service: "radarr", tmdbId: 27205, qualityProfileId: 1, rootFolderPath: "/movies/", tags: [], monitored: true, search: false,
  } });
  assert.notEqual(res.status, 201);
  assert.equal(requests[0].cleanedUpAt, stamp);
});

test("remove: the dry run counts this instance's requests and changes nothing", async () => {
  const token = await mintSession();
  requests = [
    { id: "a", tmdbId: 603, tvdbId: null, mediaType: "MOVIE", arrInstance: "", status: "AVAILABLE", cleanedUpAt: null },
    { id: "b", tmdbId: 603, tvdbId: null, mediaType: "MOVIE", arrInstance: "4k", status: "APPROVED", cleanedUpAt: null },
  ];
  const res = await call(removeRoute.POST, token, "/admin/arr/title/remove", { method: "POST", body: { service: "radarr", id: 11, deleteFiles: true, addImportExclusion: false } });
  assert.equal(res.status, 200);
  const plan = (await res.json()) as { requests: { approved: number; available: number } };
  assert.deepEqual([plan.requests.approved, plan.requests.available], [0, 1], "the 4K request is another instance's");
  assert.deepEqual(writes(), []);
  assert.equal(requests[0].cleanedUpAt, null);
});

test("remove: an APPROVED request linked only by the series' tvdb id still refuses it", async () => {
  const token = await mintSession();
  // TMDB's id for the request and Sonarr's disagree; the tvdb id it was pushed with is the link.
  requests = [{ id: "a", tmdbId: 9999, tvdbId: 81189, mediaType: "TV", arrInstance: "", status: "APPROVED", cleanedUpAt: null }];
  const res = await call(removeRoute.POST, token, "/admin/arr/title/remove", { method: "POST", body: { service: "sonarr", id: 21, deleteFiles: false, addImportExclusion: false, execute: true, confirm: 21 } });
  assert.equal(res.status, 409);
  assert.deepEqual(writes(), []);
});

test("remove: an APPROVED request on this instance refuses it (the sync would re-add it) — nothing stamped or deleted", async () => {
  const token = await mintSession();
  requests = [
    { id: "a", tmdbId: 603, tvdbId: null, mediaType: "MOVIE", arrInstance: "", status: "APPROVED", cleanedUpAt: null },
    { id: "b", tmdbId: 603, tvdbId: null, mediaType: "MOVIE", arrInstance: "", status: "AVAILABLE", cleanedUpAt: null },
  ];
  const res = await call(removeRoute.POST, token, "/admin/arr/title/remove", { method: "POST", body: { service: "radarr", id: 11, deleteFiles: true, addImportExclusion: true, execute: true, confirm: 11 } });
  assert.equal(res.status, 409);
  assert.equal(((await res.json()) as { approved: number }).approved, 1);
  assert.deepEqual(writes(), []);
  assert.equal(requests[1].cleanedUpAt, null);
  assert.equal(audits.length, 0);
});

test("remove: stamps this instance's AVAILABLE requests FIRST, sends both flags explicitly, audits after", async () => {
  const token = await mintSession();
  requests = [
    { id: "a", tmdbId: 603, tvdbId: null, mediaType: "MOVIE", arrInstance: "", status: "AVAILABLE", cleanedUpAt: null },
    { id: "k", tmdbId: 603, tvdbId: null, mediaType: "MOVIE", arrInstance: "4k", status: "AVAILABLE", cleanedUpAt: null },
  ];
  // Widened by hand: assigned inside the responder, which TS doesn't see.
  let stampedAtDelete = null as Date | null;
  responder = both((c) => {
    if (c.method === "DELETE" && c.path === "/api/v3/movie/11") {
      stampedAtDelete = requests[0].cleanedUpAt;
      return new Response("", { status: 200 });
    }
    return undefined;
  }, radarrBase);
  const res = await call(removeRoute.POST, token, "/admin/arr/title/remove", { method: "POST", body: { service: "radarr", id: 11, deleteFiles: false, addImportExclusion: true, execute: true, confirm: 11 } });
  assert.equal(res.status, 200);
  assert.ok(stampedAtDelete instanceof Date, "stamped before the delete went out");
  assert.equal(requests[1].cleanedUpAt, null, "another instance's request is not this removal's");
  const del = writes().find((c) => c.method === "DELETE")!;
  assert.deepEqual([del.query.get("deleteFiles"), del.query.get("addImportExclusion")], ["false", "true"]);
  assert.equal(audits[0].action, "ARR_TITLE_DELETE");
});

test("remove: a failed delete removes the stamps it wrote; the execute needs the dry run's id; Sonarr's flag is addImportListExclusion", async () => {
  const token = await mintSession();
  requests = [{ id: "a", tmdbId: 603, tvdbId: null, mediaType: "MOVIE", arrInstance: "", status: "AVAILABLE", cleanedUpAt: null }];
  responder = both((c) => (c.method === "DELETE" ? json({ message: "boom" }, 500) : undefined), radarrBase);
  const bad = await call(removeRoute.POST, token, "/admin/arr/title/remove", { method: "POST", body: { service: "radarr", id: 11, deleteFiles: true, addImportExclusion: true, execute: true, confirm: 11 } });
  assert.equal(bad.status, 502);
  assert.equal(requests[0].cleanedUpAt, null, "unstamped again — the title is still there");
  assert.equal(audits.length, 0);

  calls = [];
  assert.equal((await call(removeRoute.POST, token, "/admin/arr/title/remove", { method: "POST", body: { service: "radarr", id: 11, deleteFiles: true, addImportExclusion: true, execute: true } })).status, 400);
  assert.equal((await call(removeRoute.POST, token, "/admin/arr/title/remove", { method: "POST", body: { service: "radarr", id: 11, addImportExclusion: true, execute: true, confirm: 11 } })).status, 400, "an omitted flag is refused, never defaulted");
  assert.deepEqual(writes(), []);

  responder = both((c) => (c.method === "DELETE" && c.path === "/api/v3/series/21" ? new Response("", { status: 200 }) : undefined), sonarrBase);
  assert.equal((await call(removeRoute.POST, token, "/admin/arr/title/remove", { method: "POST", body: { service: "sonarr", id: 21, deleteFiles: true, addImportExclusion: true, execute: true, confirm: 21 } })).status, 200);
  const del = writes().find((c) => c.method === "DELETE")!;
  assert.deepEqual([del.query.get("deleteFiles"), del.query.get("addImportListExclusion")], ["true", "true"]);
});
