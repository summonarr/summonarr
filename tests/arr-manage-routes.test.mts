// Route-level tests for the admin Radarr/Sonarr management surfaces:
//   /api/admin/arr/title{,/episodes,/files,/rename,/history,/command,/releases}  (title manager)
//   /api/admin/arr/history{,/failed}, /api/admin/arr/blocklist{,/clear}          (Download History)
//   /api/admin/arr/calendar                                                      (Calendar)
//   /api/admin/arr/{tasks,providers,providers/test,storage}                      (Arr System)
//
// What is pinned:
//   1. ADMIN ONLY (guardrail 6a) — a delegated manager is 403 and nothing
//      reaches Radarr/Sonarr; a slug naming no configured instance is refused
//      before any upstream call (guardrail 32).
//   2. An edit only ever sends values the INSTANCE offers: an unknown root
//      folder (Radarr/Sonarr would MOVE the files there), profile, tag or
//      season is 400 with nothing written. The editor body carries exactly
//      the edited fields; a season flip PUTs back the arr's own series with
//      only that season changed.
//   3. Every id the browser sends — file, episode, history record, rename,
//      season — must be the title's own as the arr reports it now; anything
//      else is 409 with nothing deleted, renamed, or marked.
//   4. No secret leaves the server: a history record's downloadUrl/guid, an
//      indexer's or client's `fields`, a release guid (opaque handles), and
//      credentials inside upstream messages (masked).
//   5. Writes are audited after the arr accepted them, never before.
//   6. A task run names one of the instance's own scheduled tasks; a Sonarr
//      library-wide search sends `monitored: true` (Radarr's take no such
//      field — tests/arr-fix-system.test.mts).
//
// Harness: the same as tests/arr-ops-routes.test.mts.
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
const { _resetMarkClaimsForTests } = await import("../src/lib/arr-title-data.ts");

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

const titleRoute = await import("../src/app/api/admin/arr/title/route.ts");
const episodesRoute = await import("../src/app/api/admin/arr/title/episodes/route.ts");
const filesRoute = await import("../src/app/api/admin/arr/title/files/route.ts");
const renameRoute = await import("../src/app/api/admin/arr/title/rename/route.ts");
const titleHistoryRoute = await import("../src/app/api/admin/arr/title/history/route.ts");
const commandRoute = await import("../src/app/api/admin/arr/title/command/route.ts");
const releasesRoute = await import("../src/app/api/admin/arr/title/releases/route.ts");
const historyRoute = await import("../src/app/api/admin/arr/history/route.ts");
const failedRoute = await import("../src/app/api/admin/arr/history/failed/route.ts");
const blocklistRoute = await import("../src/app/api/admin/arr/blocklist/route.ts");
const clearRoute = await import("../src/app/api/admin/arr/blocklist/clear/route.ts");
const calendarRoute = await import("../src/app/api/admin/arr/calendar/route.ts");
const tasksRoute = await import("../src/app/api/admin/arr/tasks/route.ts");
const providersRoute = await import("../src/app/api/admin/arr/providers/route.ts");
const testRoute = await import("../src/app/api/admin/arr/providers/test/route.ts");
const storageRoute = await import("../src/app/api/admin/arr/storage/route.ts");

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
  _resetMarkClaimsForTests();
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

// ── 1: auth and instances ────────────────────────────────────────────────────

test("anonymous is 401 and a delegated manager 403 on every route — nothing reaches Radarr/Sonarr", async () => {
  const manager = await mintSession({ role: "USER", permissions: Permission.MANAGE_REQUESTS | Permission.MANAGE_ISSUES });
  const t = "service=radarr&instance=&id=11";
  for (const token of [null, manager]) {
    const expected = token === null ? 401 : 403;
    const cases: Array<[unknown, string, { method?: string; body?: unknown }?]> = [
      [titleRoute.GET, `/admin/arr/title?${t}`],
      [titleRoute.PATCH, "/admin/arr/title", { method: "PATCH", body: { service: "radarr", id: 11, monitored: false } }],
      [episodesRoute.GET, "/admin/arr/title/episodes?service=sonarr&id=21&season=1"],
      [episodesRoute.PATCH, "/admin/arr/title/episodes", { method: "PATCH", body: { service: "sonarr", id: 21, episodeIds: [101], monitored: false } }],
      [filesRoute.GET, `/admin/arr/title/files?${t}`],
      [filesRoute.DELETE, `/admin/arr/title/files?${t}&fileIds=1`, { method: "DELETE" }],
      [renameRoute.GET, `/admin/arr/title/rename?${t}`],
      [renameRoute.POST, "/admin/arr/title/rename", { method: "POST", body: { service: "radarr", id: 11, fileIds: [1] } }],
      [titleHistoryRoute.GET, `/admin/arr/title/history?${t}`],
      [commandRoute.POST, "/admin/arr/title/command", { method: "POST", body: { service: "radarr", id: 11, action: "search" } }],
      [releasesRoute.GET, `/admin/arr/title/releases?${t}`],
      [releasesRoute.POST, "/admin/arr/title/releases", { method: "POST", body: { service: "radarr", id: 11, release: "a".repeat(32) } }],
      [historyRoute.GET, "/admin/arr/history?service=radarr"],
      [failedRoute.POST, "/admin/arr/history/failed", { method: "POST", body: { service: "radarr", arrId: 11, historyId: 1 } }],
      [blocklistRoute.GET, "/admin/arr/blocklist?service=radarr"],
      [blocklistRoute.DELETE, "/admin/arr/blocklist?service=radarr&ids=1", { method: "DELETE" }],
      [clearRoute.POST, "/admin/arr/blocklist/clear", { method: "POST", body: { service: "radarr" } }],
      [calendarRoute.GET, "/admin/arr/calendar?start=2026-10-01T00:00:00Z&end=2026-10-08T00:00:00Z"],
      [tasksRoute.GET, "/admin/arr/tasks"],
      [tasksRoute.POST, "/admin/arr/tasks", { method: "POST", body: { service: "radarr", task: "RssSync" } }],
      [tasksRoute.DELETE, "/admin/arr/tasks?service=radarr&commandId=1", { method: "DELETE" }],
      [providersRoute.GET, "/admin/arr/providers"],
      [providersRoute.PATCH, "/admin/arr/providers", { method: "PATCH", body: { service: "radarr", kind: "downloadClient", id: 1, enable: false } }],
      [testRoute.POST, "/admin/arr/providers/test", { method: "POST", body: { service: "radarr", kind: "indexer" } }],
      [storageRoute.GET, "/admin/arr/storage"],
    ];
    for (const [handler, path, init] of cases) {
      assert.equal((await call(handler, token, path, init)).status, expected, `${init?.method ?? "GET"} ${path}`);
    }
  }
  assert.deepEqual(arrCalls(), []);
  assert.equal(audits.length, 0);
});

test("a slug naming no configured instance is 404 before any upstream call; a switched-off integration is 404 too", async () => {
  const token = await mintSession();
  assert.equal((await call(titleRoute.GET, token, "/admin/arr/title?service=radarr&instance=anime&id=11")).status, 404);
  assert.equal((await call(filesRoute.DELETE, token, "/admin/arr/title/files?service=radarr&instance=anime&id=11&fileIds=1", { method: "DELETE" })).status, 404);
  assert.deepEqual(arrCalls(), []);
  settings.set("feature.integration.radarr", "false");
  invalidateFeatureFlagCache();
  assert.equal((await call(titleRoute.GET, token, "/admin/arr/title?service=radarr&id=11")).status, 404);
  assert.deepEqual(arrCalls(), []);
});

// ── 2: the title and editing it ──────────────────────────────────────────────

test("title GET resolves a TMDB id on the instance and returns the title with the instance's own choices", async () => {
  const token = await mintSession();
  const res = await call(titleRoute.GET, token, "/admin/arr/title?service=radarr&instance=&tmdbId=603");
  assert.equal(res.status, 200);
  const body = await res.json() as { title: { arrId: number; title: string; rootFolderPath: string; tags: number[] }; qualityProfiles: unknown[]; rootFolders: Array<{ path: string }>; tags: Array<{ id: number; name: string }> };
  assert.equal(body.title.arrId, 11);
  assert.equal(body.title.rootFolderPath, "/movies/");
  assert.deepEqual(body.rootFolders.map((r) => r.path), ["/movies/", "/movies-4k/"]);
  assert.deepEqual(body.tags, [{ id: 1, name: "kids" }, { id: 2, name: "requested" }]);
  assert.ok(arrCalls().every((c) => c.origin === RADARR));
});

test("a Sonarr title resolves through TMDB's TVDB cross-reference, and a title the instance lacks is 404", async () => {
  const token = await mintSession();
  const res = await call(titleRoute.GET, token, "/admin/arr/title?service=sonarr&tmdbId=1396");
  assert.equal(res.status, 200);
  const body = await res.json() as { title: { arrId: number; seasons: Array<{ seasonNumber: number }>; episodeCount: number; episodeFileCount: number } };
  assert.equal(body.title.arrId, 21);
  assert.deepEqual(body.title.seasons.map((s) => s.seasonNumber), [0, 1, 2]);
  // Specials excluded from the series totals (guardrail 14a).
  assert.deepEqual([body.title.episodeCount, body.title.episodeFileCount], [4, 3]);

  responder = both((c) => (c.path === "/api/v3/series/lookup" ? json([]) : undefined), radarrBase, sonarrBase);
  const miss = await call(titleRoute.GET, token, "/admin/arr/title?service=sonarr&tmdbId=9999");
  assert.equal(miss.status, 404);
});

test("an edit naming a root folder, profile or tag the instance doesn't have is 400 with NOTHING written", async () => {
  const token = await mintSession();
  for (const bad of [
    { rootFolderPath: "/etc/", moveFiles: true },
    { qualityProfileId: 99 },
    { tags: [1, 77] },
  ]) {
    calls = [];
    const res = await call(titleRoute.PATCH, token, "/admin/arr/title", { method: "PATCH", body: { service: "radarr", instance: "", id: 11, ...bad } });
    assert.equal(res.status, 400, JSON.stringify(bad));
    assert.deepEqual(writes(), [], JSON.stringify(bad));
  }
  assert.equal(audits.length, 0);
});

test("a field the other service has, or a malformed value, is 400 before any upstream call", async () => {
  const token = await mintSession();
  for (const body of [
    { service: "radarr", id: 11, seriesType: "anime" },
    { service: "sonarr", id: 21, minimumAvailability: "released" },
    { service: "radarr", id: 11, minimumAvailability: "whenever" },
    { service: "radarr", id: 11, monitored: "yes" },
    { service: "radarr", id: 11 },
  ]) {
    assert.equal((await call(titleRoute.PATCH, token, "/admin/arr/title", { method: "PATCH", body })).status, 400, JSON.stringify(body));
  }
  assert.deepEqual(arrCalls(), []);
});

test("a valid edit is ONE editor PUT carrying exactly the edited fields, tags replaced, then audited", async () => {
  const token = await mintSession();
  responder = both((c) => (c.method === "PUT" && c.path === "/api/v3/movie/editor" ? json([movie({ monitored: false })], 202) : undefined), radarrBase);
  const res = await call(titleRoute.PATCH, token, "/admin/arr/title", {
    method: "PATCH",
    body: { service: "radarr", instance: "", id: 11, monitored: false, qualityProfileId: 2, minimumAvailability: "inCinemas", rootFolderPath: "/movies-4k/", moveFiles: true, tags: [2] },
  });
  assert.equal(res.status, 200);
  const puts = writes();
  assert.equal(puts.length, 1);
  assert.deepEqual(puts[0].body, {
    movieIds: [11], monitored: false, qualityProfileId: 2, minimumAvailability: "inCinemas",
    rootFolderPath: "/movies-4k/", moveFiles: true, tags: [2], applyTags: "replace",
  });
  assert.equal(audits.length, 1);
  assert.equal(audits[0].action, "ARR_TITLE_EDIT");
  assert.deepEqual((JSON.parse(audits[0].details as string) as { fields: string[] }).fields.sort(), ["minimumAvailability", "monitored", "qualityProfileId", "rootFolderPath", "tags"]);
});

test("the current root folder is never re-sent (no pointless move) nor audited, and a refused edit is not audited", async () => {
  const token = await mintSession();
  responder = both((c) => (c.method === "PUT" ? json([], 202) : undefined), radarrBase);
  await call(titleRoute.PATCH, token, "/admin/arr/title", { method: "PATCH", body: { service: "radarr", id: 11, rootFolderPath: "/movies/", moveFiles: true, monitored: true } });
  assert.deepEqual(writes()[0].body, { movieIds: [11], monitored: true, moveFiles: false });
  assert.deepEqual((JSON.parse(audits[0].details as string) as { fields: string[] }).fields, ["monitored"]);
  calls = [];
  audits.length = 0;
  await call(titleRoute.PATCH, token, "/admin/arr/title", { method: "PATCH", body: { service: "radarr", id: 11, rootFolderPath: "/movies/" } });
  assert.deepEqual(writes(), [], "nothing changed, nothing written");
  assert.equal(audits.length, 0, "nothing written, nothing audited");

  calls = [];
  audits.length = 0;
  responder = both((c) => (c.method === "PUT" ? json([{ errorMessage: "Path is invalid token=abc123" }], 400) : undefined), radarrBase);
  const res = await call(titleRoute.PATCH, token, "/admin/arr/title", { method: "PATCH", body: { service: "radarr", id: 11, monitored: false } });
  assert.equal(res.status, 400);
  const err = await res.json() as { error: string };
  assert.ok(err.error.includes("Path is invalid"));
  assert.ok(!err.error.includes("abc123"), "credentials in the arr's refusal are masked");
  assert.equal(audits.length, 0);
});

test("a season flip PUTs back Sonarr's own series with ONLY that season changed", async () => {
  const token = await mintSession();
  responder = both((c) => (c.method === "PUT" && c.path === "/api/v3/series/21" ? json(series()) : undefined), sonarrBase);
  const res = await call(titleRoute.PATCH, token, "/admin/arr/title", {
    method: "PATCH", body: { service: "sonarr", instance: "", id: 21, seasons: [{ seasonNumber: 2, monitored: false }] },
  });
  assert.equal(res.status, 200);
  const puts = writes();
  assert.equal(puts.length, 1, "no editor call when only seasons change");
  const expected = series();
  (expected.seasons[2] as { monitored: boolean }).monitored = false;
  assert.deepEqual(puts[0].body, expected);

  calls = [];
  const bad = await call(titleRoute.PATCH, token, "/admin/arr/title", { method: "PATCH", body: { service: "sonarr", id: 21, seasons: [{ seasonNumber: 9, monitored: true }] } });
  assert.equal(bad.status, 400);
  assert.deepEqual(writes(), []);
});

test("episode monitoring refuses an episode of another series (409, nothing written) and audits a real change", async () => {
  const token = await mintSession();
  const foreign = await call(episodesRoute.PATCH, token, "/admin/arr/title/episodes", { method: "PATCH", body: { service: "sonarr", id: 21, episodeIds: [101, 999], monitored: false } });
  assert.equal(foreign.status, 409);
  assert.deepEqual(writes(), []);

  responder = both((c) => (c.method === "PUT" && c.path === "/api/v3/episode/monitor" ? json([]) : undefined), sonarrBase);
  const ok = await call(episodesRoute.PATCH, token, "/admin/arr/title/episodes", { method: "PATCH", body: { service: "sonarr", id: 21, episodeIds: [101, 102], monitored: false } });
  assert.equal(ok.status, 200);
  assert.deepEqual(writes().map((c) => c.body), [{ episodeIds: [101, 102], monitored: false }]);
  assert.equal(audits[0].action, "ARR_TITLE_EDIT");

  const season = await call(episodesRoute.GET, token, "/admin/arr/title/episodes?service=sonarr&id=21&season=2");
  assert.deepEqual(((await season.json()) as { episodes: Array<{ id: number }> }).episodes.map((e) => e.id), [201, 202]);
});

// ── 3: files, renames, history ───────────────────────────────────────────────

const EPISODE_FILES = [
  { id: 501, seasonNumber: 1, relativePath: "Season 01/S01E01.mkv", path: "/tv/Breaking Bad/Season 01/S01E01.mkv", size: 1e9, quality: { quality: { name: "Bluray-1080p" }, revision: { version: 2 } }, mediaInfo: { videoCodec: "x265", audioChannels: 5.1 } },
  { id: 502, seasonNumber: 1, relativePath: "Season 01/S01E02.mkv", size: 1e9, quality: { quality: { name: "Bluray-1080p" } } },
  { id: 503, seasonNumber: 2, relativePath: "Season 02/S02E01.mkv", size: 1e9, quality: { quality: { name: "HDTV-720p" } }, qualityCutoffNotMet: true },
];
const fileResponder: Responder = (c) => {
  if (c.method === "GET" && c.path === "/api/v3/episodefile") return json(EPISODE_FILES);
  if (c.method === "GET" && c.path === "/api/v3/moviefile") return json([{ id: 7, relativePath: "The Matrix.mkv", size: 4e9, quality: { quality: { name: "Remux-1080p" } } }]);
  if (c.method === "DELETE") return new Response("", { status: 200 });
  return undefined;
};

test("files list each file with the episodes it holds", async () => {
  const token = await mintSession();
  responder = both(fileResponder, sonarrBase);
  const res = await call(filesRoute.GET, token, "/admin/arr/title/files?service=sonarr&id=21");
  const files = ((await res.json()) as { files: Array<{ id: number; episodes: unknown[]; qualityTags: string[]; media: { videoCodec: string } | null }> }).files;
  assert.deepEqual(files.map((f) => [f.id, f.episodes]), [
    [501, [{ seasonNumber: 1, episodeNumber: 1 }]],
    [502, [{ seasonNumber: 1, episodeNumber: 2 }]],
    [503, [{ seasonNumber: 2, episodeNumber: 1 }]],
  ]);
  assert.deepEqual(files[0].qualityTags, ["proper"]);
  assert.equal(files[0].media?.videoCodec, "x265");
});

test("deleting a file that is not the title's is 409 with NOTHING deleted; a real delete is one bulk call, then audited", async () => {
  const token = await mintSession();
  responder = both(fileResponder, sonarrBase);
  const foreign = await call(filesRoute.DELETE, token, "/admin/arr/title/files?service=sonarr&id=21&fileIds=501,999", { method: "DELETE" });
  assert.equal(foreign.status, 409);
  assert.deepEqual(writes(), []);
  assert.equal(audits.length, 0);

  const ok = await call(filesRoute.DELETE, token, "/admin/arr/title/files?service=sonarr&id=21&fileIds=501,503", { method: "DELETE" });
  assert.equal(ok.status, 200);
  assert.deepEqual(writes().map((c) => [c.method, c.path, c.body]), [["DELETE", "/api/v3/episodefile/bulk", { episodeFileIds: [501, 503] }]]);
  assert.equal(audits[0].action, "ARR_FILE_DELETE");

  calls = [];
  responder = both(fileResponder, radarrBase);
  assert.equal((await call(filesRoute.DELETE, token, "/admin/arr/title/files?service=radarr&id=11&fileIds=7", { method: "DELETE" })).status, 200);
  assert.deepEqual(writes().map((c) => [c.method, c.path]), [["DELETE", "/api/v3/moviefile/7"]]);
});

test("a rename only renames files the arr's preview, re-read now, still lists", async () => {
  const token = await mintSession();
  responder = both((c) => {
    if (c.method === "GET" && c.path === "/api/v3/rename") return json([{ movieId: 11, movieFileId: 7, existingPath: "matrix.mkv", newPath: "The Matrix (1999).mkv" }]);
    if (c.method === "POST" && c.path === "/api/v3/command") return json({ id: 1 }, 201);
    return undefined;
  }, radarrBase);
  const preview = await call(renameRoute.GET, token, "/admin/arr/title/rename?service=radarr&id=11");
  assert.deepEqual(((await preview.json()) as { files: Array<{ fileId: number }> }).files.map((f) => f.fileId), [7]);
  const stale = await call(renameRoute.POST, token, "/admin/arr/title/rename", { method: "POST", body: { service: "radarr", id: 11, fileIds: [7, 8] } });
  assert.equal(stale.status, 409);
  assert.deepEqual(writes(), []);
  const ok = await call(renameRoute.POST, token, "/admin/arr/title/rename", { method: "POST", body: { service: "radarr", id: 11, fileIds: [7] } });
  assert.equal(ok.status, 202);
  assert.deepEqual(writes().map((c) => c.body), [{ name: "RenameFiles", movieId: 11, files: [7] }]);
  assert.equal(audits[0].action, "ARR_FILE_RENAME");
});

test("C048: a long show's rename preview (every file pre-ticked) is renamed in ONE command — the cap is the delete's, not 2,000", async () => {
  const token = await mintSession();
  // 9,000 seven-digit ids: past the old 2,000-id cap AND the old 64 KB body cap.
  const ids = Array.from({ length: 9_000 }, (_, i) => 1_000_000 + i);
  responder = both((c) => {
    if (c.method === "GET" && c.path === "/api/v3/rename") {
      return json(ids.map((id) => ({ seriesId: 21, episodeFileId: id, seasonNumber: 1, episodeNumbers: [1], existingPath: `e${id}.mkv`, newPath: `E${id}.mkv` })));
    }
    if (c.method === "POST" && c.path === "/api/v3/command") return json({ id: 5 }, 201);
    return undefined;
  }, sonarrBase);
  const preview = (await (await call(renameRoute.GET, token, "/admin/arr/title/rename?service=sonarr&id=21")).json()) as { files: Array<{ fileId: number }> };
  assert.equal(preview.files.length, ids.length);
  const res = await call(renameRoute.POST, token, "/admin/arr/title/rename", { method: "POST", body: { service: "sonarr", id: 21, fileIds: preview.files.map((f) => f.fileId) } });
  assert.equal(res.status, 202);
  const sent = writes();
  assert.equal(sent.length, 1);
  assert.deepEqual((sent[0].body as { files: number[] }).files, ids);
  // Still capped (guardrail 30): one id past the shared limit is refused, nothing sent.
  calls = [];
  const over = await call(renameRoute.POST, token, "/admin/arr/title/rename", { method: "POST", body: { service: "sonarr", id: 21, fileIds: Array.from({ length: 10_001 }, (_, i) => i + 1) } });
  assert.equal(over.status, 400);
  assert.deepEqual(writes(), []);
});

const APIKEY = "s3cr3t-indexer-apikey";
const HISTORY = [
  {
    id: 900, movieId: 11, eventType: "grabbed", date: "2026-10-01T10:00:00Z", sourceTitle: "The.Matrix.1999.1080p",
    downloadId: "abc", quality: { quality: { name: "Bluray-1080p" } },
    data: { indexer: "NZBgeek", downloadClientName: "SAB", protocol: "1", size: "8000000000",
      downloadUrl: `https://indexer.example/getnzb?id=1&apikey=${APIKEY}`, guid: `https://indexer.example/details/1?apikey=${APIKEY}`, nzbInfoUrl: `https://indexer.example/?r=${APIKEY}` },
  },
  { id: 901, movieId: 11, eventType: "downloadFolderImported", date: "2026-10-01T11:00:00Z", sourceTitle: "The.Matrix.1999.1080p", data: { importedPath: "/movies/The Matrix (1999)/m.mkv" } },
  { id: 902, movieId: 11, eventType: "downloadFailed", date: "2026-09-01T11:00:00Z", sourceTitle: "x", data: { message: `Download failed: https://indexer.example/api?apikey=${APIKEY}` } },
];

test("history never carries a release's download URL, guid or info URL, and masks credentials in messages", async () => {
  const token = await mintSession();
  responder = both((c) => (c.path === "/api/v3/history/movie" ? json(HISTORY) : undefined), radarrBase);
  const res = await call(titleHistoryRoute.GET, token, "/admin/arr/title/history?service=radarr&id=11");
  const text = await res.text();
  assert.equal(res.status, 200);
  assert.ok(!text.includes(APIKEY), "no apikey anywhere in the response");
  assert.ok(!text.includes("getnzb"), "no download URL");
  const events = (JSON.parse(text) as { events: Array<{ id: number; kind: string; indexer: string | null; protocol: string; size: number | null; message: string | null }> }).events;
  assert.deepEqual(events.map((e) => [e.id, e.kind]), [[901, "imported"], [900, "grabbed"], [902, "failed"]]);
  const grab = events.find((e) => e.id === 900)!;
  assert.deepEqual([grab.indexer, grab.protocol, grab.size], ["NZBgeek", "usenet", 8e9]);
  assert.ok(events.find((e) => e.id === 902)!.message!.includes("apikey=••••••••"));
});

test("mark failed refuses a record that is not a grab, or not this title's — and marks a real grab once, audited", async () => {
  const token = await mintSession();
  responder = both((c) => {
    if (c.path === "/api/v3/history/movie") return json(HISTORY);
    if (c.method === "POST" && c.path === "/api/v3/history/failed/900") return json({});
    return undefined;
  }, radarrBase);
  assert.equal((await call(failedRoute.POST, token, "/admin/arr/history/failed", { method: "POST", body: { service: "radarr", arrId: 11, historyId: 901 } })).status, 409);
  assert.equal((await call(failedRoute.POST, token, "/admin/arr/history/failed", { method: "POST", body: { service: "radarr", arrId: 11, historyId: 12345 } })).status, 409);
  assert.deepEqual(writes(), []);
  assert.equal(audits.length, 0);
  assert.equal((await call(failedRoute.POST, token, "/admin/arr/history/failed", { method: "POST", body: { service: "radarr", arrId: 11, historyId: 900 } })).status, 200);
  assert.deepEqual(writes().map((c) => [c.method, c.path]), [["POST", "/api/v3/history/failed/900"]]);
  assert.equal(audits[0].action, "ARR_MARK_FAILED");
  assert.ok(!JSON.stringify(audits).includes(APIKEY));
});

// ── 4: searching ─────────────────────────────────────────────────────────────

const commandResponder: Responder = (c) => (c.method === "POST" && c.path === "/api/v3/command" ? json({ id: 5 }, 201) : undefined);

test("title commands: Radarr search/refresh, Sonarr season and episode searches check the series' own seasons and episodes", async () => {
  const token = await mintSession();
  responder = both(commandResponder, radarrBase, sonarrBase);
  const post = (body: Record<string, unknown>) => call(commandRoute.POST, token, "/admin/arr/title/command", { method: "POST", body });
  assert.equal((await post({ service: "radarr", id: 11, action: "search" })).status, 202);
  assert.equal((await post({ service: "radarr", id: 11, action: "refresh" })).status, 202);
  assert.equal((await post({ service: "radarr", id: 11, action: "searchSeason", seasonNumber: 1 })).status, 400);
  assert.equal((await post({ service: "sonarr", id: 21, action: "search" })).status, 400, "Sonarr has no whole-series search here");
  assert.equal((await post({ service: "sonarr", id: 21, action: "searchSeason", seasonNumber: 7 })).status, 409);
  assert.equal((await post({ service: "sonarr", id: 21, action: "searchEpisodes", episodeIds: [101, 999] })).status, 409);
  assert.equal((await post({ service: "sonarr", id: 21, action: "searchSeason", seasonNumber: 2 })).status, 202);
  assert.equal((await post({ service: "sonarr", id: 21, action: "searchEpisodes", episodeIds: [202] })).status, 202);
  assert.deepEqual(writes().map((c) => c.body), [
    { name: "MoviesSearch", movieIds: [11] },
    { name: "RefreshMovie", movieIds: [11] },
    { name: "SeasonSearch", seriesId: 21, seasonNumber: 2 },
    { name: "EpisodeSearch", episodeIds: [202] },
  ]);
  assert.ok(!writes().some((c) => (c.body as { name?: string }).name === "SeriesSearch"));
});

test("Sonarr 'search missing' queues exactly the missing episodes, never SeriesSearch", async () => {
  const token = await mintSession();
  responder = both(commandResponder, sonarrBase);
  const res = await call(commandRoute.POST, token, "/admin/arr/title/command", { method: "POST", body: { service: "sonarr", id: 21, action: "searchMissing" } });
  assert.equal(res.status, 202);
  assert.deepEqual(writes().map((c) => c.body), [{ name: "EpisodeSearch", episodeIds: [202] }]);
});

const RELEASE = {
  guid: `https://indexer.example/details/9?apikey=${APIKEY}`, title: "The.Matrix.1999.2160p", size: 5e10, indexerId: 3, indexer: "NZBgeek",
  quality: { quality: { id: 19, name: "Bluray-2160p" }, revision: { version: 1 } }, qualityWeight: 100, protocol: "usenet",
  age: 10, rejected: false, rejections: [], downloadAllowed: true, downloadUrl: `https://indexer.example/getnzb?apikey=${APIKEY}`,
};

test("interactive search hands out opaque handles, never the guid; the grab redeems its own handle only", async () => {
  const token = await mintSession();
  responder = both((c) => {
    if (c.path === "/api/v3/release" && c.method === "GET") return json([RELEASE]);
    if (c.path === "/api/v3/release" && c.method === "POST") return json({});
    return undefined;
  }, radarrBase, sonarrBase);
  const res = await call(releasesRoute.GET, token, "/admin/arr/title/releases?service=radarr&id=11");
  const text = await res.text();
  assert.equal(res.status, 200);
  assert.ok(!text.includes(APIKEY));
  const handle = (JSON.parse(text) as { releases: Array<{ guid: string }> }).releases[0].guid;
  assert.match(handle, /^[0-9a-f]{32}$/);
  assert.equal(calls.find((c) => c.path === "/api/v3/release")?.query.get("movieId"), "11");

  // Sonarr: a series-only search is refused (it would be the RSS feed).
  assert.equal((await call(releasesRoute.GET, token, "/admin/arr/title/releases?service=sonarr&id=21")).status, 400);
  // The handle is bound to its title: another title's grab can't redeem it.
  assert.equal((await call(releasesRoute.POST, token, "/admin/arr/title/releases", { method: "POST", body: { service: "radarr", id: 12, release: handle } })).status, 410);
  assert.deepEqual(writes(), []);
  assert.equal((await call(releasesRoute.POST, token, "/admin/arr/title/releases", { method: "POST", body: { service: "radarr", id: 11, release: handle } })).status, 200);
  assert.deepEqual(writes().map((c) => c.body), [{ guid: RELEASE.guid, indexerId: 3, movieId: 11 }]);
  assert.equal(audits[0].action, "ARR_RELEASE_GRAB");
  assert.ok(!JSON.stringify(audits).includes(APIKEY));
});

// ── 5: history page and blocklist ────────────────────────────────────────────

test("the History page's event filter is translated PER SERVICE (the enums differ past 4), one id each", async () => {
  const token = await mintSession();
  responder = (c) => (c.path === "/api/v3/history" ? json({ page: 1, pageSize: 50, totalRecords: 0, records: [] }) : undefined);
  await call(historyRoute.GET, token, "/admin/arr/history?service=radarr&kind=deleted");
  await call(historyRoute.GET, token, "/admin/arr/history?service=sonarr&kind=deleted");
  await call(historyRoute.GET, token, "/admin/arr/history?service=sonarr&kind=imported");
  assert.deepEqual(arrCalls().map((c) => [c.origin, c.query.getAll("eventType")]), [
    [RADARR, ["6"]],
    [SONARR, ["5"]],
    [SONARR, ["3"]],
  ]);
  assert.equal((await call(historyRoute.GET, token, "/admin/arr/history?service=radarr&kind=bogus")).status, 400);
  assert.equal((await call(historyRoute.GET, token, "/admin/arr/history?service=radarr&pageSize=1000")).status, 400);
});

test("the blocklist names titles the arr didn't embed, removes in ONE bulk call, clears via the arr's command — all audited", async () => {
  const token = await mintSession();
  responder = both((c) => {
    if (c.path === "/api/v3/blocklist" && c.method === "GET") {
      return json({ page: 1, pageSize: 50, totalRecords: 1, records: [{ id: 3, movieId: 11, sourceTitle: "The.Matrix.CAM", protocol: "torrent", message: `Rejected ?passkey=${APIKEY}` }] });
    }
    if (c.path === "/api/v3/blocklist/bulk" && c.method === "DELETE") return new Response("", { status: 200 });
    if (c.path === "/api/v3/command" && c.method === "POST") return json({ id: 1 }, 201);
    return undefined;
  }, radarrBase);
  const page = await call(blocklistRoute.GET, token, "/admin/arr/blocklist?service=radarr");
  const text = await page.text();
  assert.ok(!text.includes(APIKEY));
  const rec = (JSON.parse(text) as { records: Array<{ mediaTitle: string; tmdbId: number; protocol: string }> }).records[0];
  assert.deepEqual([rec.mediaTitle, rec.tmdbId, rec.protocol], ["The Matrix", 603, "torrent"]);

  // An id the blocklist no longer has (a stale page) refuses the whole removal.
  assert.equal((await call(blocklistRoute.DELETE, token, "/admin/arr/blocklist?service=radarr&ids=3,4", { method: "DELETE" })).status, 409);
  assert.deepEqual(writes(), []);
  assert.equal((await call(blocklistRoute.DELETE, token, "/admin/arr/blocklist?service=radarr&ids=3", { method: "DELETE" })).status, 200);
  assert.equal((await call(clearRoute.POST, token, "/admin/arr/blocklist/clear", { method: "POST", body: { service: "radarr" } })).status, 202);
  assert.deepEqual(writes().map((c) => [c.method, c.path, c.body]), [
    ["DELETE", "/api/v3/blocklist/bulk", { ids: [3] }],
    ["POST", "/api/v3/command", { name: "ClearBlocklist" }],
  ]);
  assert.deepEqual(audits.map((a) => a.action), ["ARR_BLOCKLIST_CHANGE", "ARR_BLOCKLIST_CHANGE"]);
  assert.equal((await call(blocklistRoute.DELETE, token, "/admin/arr/blocklist?service=radarr&ids=3,x", { method: "DELETE" })).status, 400);
});

// ── 6: calendar ──────────────────────────────────────────────────────────────

test("the calendar reads every instance, names a failed one, and judges each entry's status", async () => {
  const token = await mintSession();
  responder = (c) => {
    // Sonarr's queue holds episode 204; Radarr's can't be read at all (the
    // stub throws) — its entries keep the statuses the calendar gives them.
    if (c.path === "/api/v3/queue" && c.origin === SONARR) {
      return json({ page: 1, pageSize: 250, totalRecords: 2, records: [
        { id: 1, seriesId: 21, episodeId: 204, size: 1000, sizeleft: 250, status: "downloading", trackedDownloadState: "downloading" },
        { id: 2, seriesId: 21, episodeId: 202, size: 1000, sizeleft: 0, status: "completed", trackedDownloadState: "failedPending" },
      ] });
    }
    if (c.path !== "/api/v3/calendar") return undefined;
    if (c.origin === RADARR_4K) return new Response("down", { status: 503 });
    if (c.origin === RADARR) {
      return json([{ id: 11, tmdbId: 603, title: "The Matrix", monitored: true, hasFile: false, inCinemas: "2026-10-02T00:00:00Z", digitalRelease: "2026-10-03T00:00:00Z", physicalRelease: "2027-01-01T00:00:00Z" }]);
    }
    return json([
      { id: 202, seriesId: 21, seasonNumber: 2, episodeNumber: 2, title: "Grilled", airDateUtc: "2026-10-04T02:00:00Z", monitored: true, hasFile: false, series: { title: "Breaking Bad", tvdbId: 81189, monitored: true, runtime: 47 } },
      { id: 204, seriesId: 21, seasonNumber: 2, episodeNumber: 4, title: "Down", airDateUtc: "2026-10-05T02:00:00Z", monitored: true, hasFile: false, series: { title: "Breaking Bad", tvdbId: 81189, monitored: true, runtime: 47 } },
      { id: 203, seriesId: 21, seasonNumber: 2, episodeNumber: 3, title: "Bit by a Dead Bee", airDateUtc: "2099-10-04T02:00:00Z", monitored: true, hasFile: false, series: { title: "Breaking Bad", tvdbId: 81189, monitored: true, runtime: 47 } },
    ]);
  };
  tmdbCacheRows.set("tvdb-to-tmdb:81189", JSON.stringify({ tmdbId: 1396 }));
  const res = await call(calendarRoute.GET, token, "/admin/arr/calendar?start=2026-10-01T00:00:00Z&end=2026-11-30T00:00:00Z");
  assert.equal(res.status, 200);
  const body = await res.json() as {
    errors: Array<{ service: string; instance: string; kind: string }>;
    entries: Array<{ kind: string; status: string; tmdbId: number | null; progress: number | null }>;
    now: string;
  };
  assert.deepEqual(body.errors.map((e) => `${e.service}:${e.instance}:${e.kind}`), ["radarr:4k:unreachable"], "a failed instance is named with the KIND of failure the page translates");
  assert.deepEqual(body.entries.map((e) => [e.kind, e.status]), [
    ["cinema", "released"],
    ["digital", "missing"],
    ["episode", "missing"],
    ["episode", "downloading"],
    ["episode", "upcoming"],
  ], "a failed download (202) is not on its way; an unreadable queue (Radarr) leaves statuses alone");
  assert.equal(body.entries[3].progress, 0.75);
  assert.equal(body.entries[2].tmdbId, 1396, "the series' TMDB id is filled from the tvdb→tmdb map");
  assert.ok(Number.isFinite(Date.parse(body.now)), "the report carries the server's clock");

  // The window asked of each arr: Radarr's padded a day either side (a release
  // DATE is midnight UTC, the page's window is local days); Sonarr's padded 14 h
  // either side (v3 parses the query date as the host's LOCAL time), with the
  // series (title, runtime, monitored) included.
  const calendarQuery = (origin: string) => {
    const c = calls.find((x) => x.path === "/api/v3/calendar" && x.origin === origin);
    assert.ok(c, origin);
    return Object.fromEntries(c.query);
  };
  assert.deepEqual(calendarQuery(RADARR), { start: "2026-09-30T00:00:00.000Z", end: "2026-12-01T00:00:00.000Z", unmonitored: "false" });
  assert.deepEqual(calendarQuery(SONARR), {
    start: "2026-09-30T10:00:00.000Z", end: "2026-11-30T14:00:00.000Z", unmonitored: "false",
    includeSeries: "true", includeEpisodeFile: "false", includeEpisodeImages: "false",
  });

  assert.equal((await call(calendarRoute.GET, token, "/admin/arr/calendar?start=2026-01-01T00:00:00Z&end=2026-06-01T00:00:00Z")).status, 400, "longer than the window cap");
});

// ── 7: system ────────────────────────────────────────────────────────────────

test("a task run names one of the instance's OWN scheduled tasks; a library-wide search sends monitored:true and is audited", async () => {
  const token = await mintSession();
  responder = both((c) => {
    if (c.path === "/api/v3/system/task") return json([{ id: 1, name: "RSS Sync", taskName: "RssSync", interval: 15, lastDuration: "00:00:02.5" }]);
    if (c.path === "/api/v3/command" && c.method === "GET") return json([{ id: 4, name: "Rss Sync", commandName: "RSS Sync", status: "completed", body: { secretPath: "/x" } }, { id: 5, commandName: "Backup", status: "queued" }]);
    if (c.path === "/api/v3/command" && c.method === "POST") return json({ id: 6 }, 201);
    if (c.path === "/api/v3/command/5" && c.method === "DELETE") return new Response("", { status: 200 });
    return undefined;
  }, sonarrBase);
  const post = (body: Record<string, unknown>) => call(tasksRoute.POST, token, "/admin/arr/tasks", { method: "POST", body });
  assert.equal((await post({ service: "sonarr", task: "ApplicationUpdate" })).status, 400, "not a scheduled task");
  assert.equal((await post({ service: "sonarr", task: "Rss Sync; rm" })).status, 400);
  assert.deepEqual(writes(), []);
  assert.equal((await post({ service: "sonarr", task: "RssSync" })).status, 202);
  assert.equal((await post({ service: "sonarr", action: "searchMissing" })).status, 202);
  assert.equal((await post({ service: "sonarr", action: "searchCutoff" })).status, 202);
  assert.deepEqual(writes().map((c) => c.body), [
    { name: "RssSync" },
    { name: "MissingEpisodeSearch", monitored: true },
    { name: "CutoffUnmetEpisodeSearch", monitored: true },
  ]);
  assert.deepEqual(audits.map((a) => a.action), ["ARR_COMMAND", "ARR_COMMAND", "ARR_COMMAND"], "task runs and library-wide searches are audited");

  calls = [];
  assert.equal((await call(tasksRoute.DELETE, token, "/admin/arr/tasks?service=sonarr&commandId=4", { method: "DELETE" })).status, 409, "completed, not queued");
  assert.equal((await call(tasksRoute.DELETE, token, "/admin/arr/tasks?service=sonarr&commandId=5", { method: "DELETE" })).status, 200);
  assert.deepEqual(writes().map((c) => [c.method, c.path]), [["DELETE", "/api/v3/command/5"]]);
});

test("the tasks read never sends a command's body", async () => {
  settings.set("feature.integration.radarr", "false");
  invalidateFeatureFlagCache();
  const token = await mintSession();
  responder = (c) => {
    if (c.path === "/api/v3/system/task") return json([{ taskName: "RssSync", name: "RSS Sync", interval: 15 }]);
    if (c.path === "/api/v3/command") return json([{ id: 4, commandName: "Manual Import", status: "completed", body: { files: [{ path: "/secret/path.mkv" }] } }]);
    return undefined;
  };
  const text = await (await call(tasksRoute.GET, token, "/admin/arr/tasks")).text();
  assert.ok(!text.includes("/secret/path.mkv"));
});

const INDEXER = {
  id: 3, name: "NZBgeek", implementationName: "Newznab", protocol: "usenet", priority: 25,
  enableRss: true, enableAutomaticSearch: true, enableInteractiveSearch: true, tags: [],
  fields: [{ name: "baseUrl", value: "https://api.nzbgeek.info" }, { name: "apiKey", value: APIKEY }],
};
const CLIENT = { id: 1, name: "SAB", implementationName: "SABnzbd", protocol: "usenet", priority: 1, enable: true, fields: [{ name: "password", value: APIKEY }] };

test("indexers and download clients never reach the browser with their settings (fields)", async () => {
  settings.set("feature.integration.sonarr", "false");
  invalidateFeatureFlagCache();
  const token = await mintSession();
  // Neither arr has an /api/v3/indexerstatus endpoint; which indexers are
  // failing is the health panel's (tests/arr-fix-system.test.mts).
  responder = (c) => {
    if (c.path === "/api/v3/indexer") return json([INDEXER]);
    if (c.path === "/api/v3/downloadclient") return json([CLIENT]);
    if (c.path === "/api/v3/tag") return json([]);
    return undefined;
  };
  const text = await (await call(providersRoute.GET, token, "/admin/arr/providers")).text();
  assert.ok(!text.includes(APIKEY));
  assert.ok(!text.includes("nzbgeek.info"));
  const result = (JSON.parse(text) as { results: Array<{ indexers: unknown[]; downloadClients: unknown[] }> }).results[0];
  assert.equal(result.indexers.length, 1);
  assert.equal(result.downloadClients.length, 1);
});

test("switching a provider reads it from the arr and saves it back with ONLY the flags changed; a refusal is masked, not audited", async () => {
  const token = await mintSession();
  responder = (c) => {
    if (c.origin !== RADARR) return undefined;
    if (c.path === "/api/v3/indexer/3" && c.method === "GET") return json(INDEXER);
    if (c.path === "/api/v3/indexer/3" && c.method === "PUT") return json({ ...(c.body as object) });
    return undefined;
  };
  const res = await call(providersRoute.PATCH, token, "/admin/arr/providers", { method: "PATCH", body: { service: "radarr", kind: "indexer", id: 3, enableRss: false } });
  assert.equal(res.status, 200);
  assert.ok(!(await res.text()).includes(APIKEY));
  assert.deepEqual(writes().map((c) => c.body), [{ ...INDEXER, enableRss: false }]);
  assert.equal(writes()[0].query.get("forceSave"), "true", "switching a use OFF skips the arr's re-test");
  assert.equal(audits[0].action, "ARR_PROVIDER_CHANGE");

  // A client takes `enable`, an indexer never does.
  assert.equal((await call(providersRoute.PATCH, token, "/admin/arr/providers", { method: "PATCH", body: { service: "radarr", kind: "indexer", id: 3, enable: false } })).status, 400);

  calls = [];
  audits.length = 0;
  responder = (c) => {
    if (c.path === "/api/v3/indexer/3" && c.method === "GET") return json(INDEXER);
    if (c.path === "/api/v3/indexer/3" && c.method === "PUT") return json([{ errorMessage: `Unable to connect: https://api.nzbgeek.info/api?t=caps&apikey=${APIKEY}` }], 400);
    return undefined;
  };
  const refused = await call(providersRoute.PATCH, token, "/admin/arr/providers", { method: "PATCH", body: { service: "radarr", kind: "indexer", id: 3, enableRss: true } });
  assert.equal(refused.status, 400);
  assert.equal(writes()[0].query.get("forceSave"), null, "switching ON lets the arr test it");
  const refusedText = await refused.text();
  assert.ok(refusedText.includes("Unable to connect"));
  assert.ok(!refusedText.includes(APIKEY));
  assert.equal(audits.length, 0);
});

test("testing one provider sends the arr's own resource to its test endpoint server-side; results are masked", async () => {
  const token = await mintSession();
  responder = (c) => {
    if (c.path === "/api/v3/indexer/3" && c.method === "GET") return json(INDEXER);
    if (c.path === "/api/v3/indexer/test") return json([{ errorMessage: `Invalid API Key apikey=${APIKEY}` }], 400);
    if (c.path === "/api/v3/downloadclient/testall") return json([{ id: 1, isValid: true, validationFailures: [] }]);
    // Test All is a 400 when any provider failed — its body is still the list.
    if (c.path === "/api/v3/indexer/testall") return json([{ id: 3, isValid: false, validationFailures: [{ errorMessage: `Invalid key apikey=${APIKEY}` }] }, { id: 4, isValid: true, validationFailures: [] }], 400);
    return undefined;
  };
  const one = await call(testRoute.POST, token, "/admin/arr/providers/test", { method: "POST", body: { service: "radarr", kind: "indexer", id: 3 } });
  const text = await one.text();
  assert.equal(one.status, 200);
  assert.ok(!text.includes(APIKEY));
  assert.deepEqual((JSON.parse(text) as { results: Array<{ ok: boolean }> }).results.map((r) => r.ok), [false]);
  assert.deepEqual(writes().map((c) => [c.path, c.body]), [["/api/v3/indexer/test", INDEXER]]);

  const all = await call(testRoute.POST, token, "/admin/arr/providers/test", { method: "POST", body: { service: "radarr", kind: "downloadClient" } });
  assert.deepEqual(((await all.json()) as { results: unknown[] }).results, [{ id: 1, ok: true, warning: false, messages: [] }]);

  const mixed = await call(testRoute.POST, token, "/admin/arr/providers/test", { method: "POST", body: { service: "radarr", kind: "indexer" } });
  assert.equal(mixed.status, 200, "one failing indexer is a result, not a refusal");
  const mixedText = await mixed.text();
  assert.ok(!mixedText.includes(APIKEY));
  assert.deepEqual((JSON.parse(mixedText) as { results: Array<{ id: number; ok: boolean }> }).results.map((r) => [r.id, r.ok]), [[3, false], [4, true]]);
});

test("mark failed falls back to the body forms older v3 builds use (form field, then JSON number)", async () => {
  const token = await mintSession();
  let formAccepted = true;
  responder = both((c) => {
    if (c.path === "/api/v3/history/movie") return json(HISTORY);
    if (c.method === "POST" && c.path === "/api/v3/history/failed/900") return new Response("", { status: 405 });
    if (c.method === "POST" && c.path === "/api/v3/history/failed") {
      if (typeof c.body === "string") return formAccepted ? json({}) : new Response("", { status: 415 });
      return json({});
    }
    return undefined;
  }, radarrBase);
  const mark = () => call(failedRoute.POST, token, "/admin/arr/history/failed", { method: "POST", body: { service: "radarr", arrId: 11, historyId: 900 } });
  assert.equal((await mark()).status, 200);
  assert.deepEqual(writes().map((c) => [c.path, c.body]), [["/api/v3/history/failed/900", undefined], ["/api/v3/history/failed", "id=900"]]);
  calls = [];
  formAccepted = false;
  // The same grab again, as a fresh arr would see it: the first mark's claim
  // (C095) would otherwise refuse it.
  _resetMarkClaimsForTests();
  assert.equal((await mark()).status, 200);
  assert.deepEqual(writes().map((c) => [c.path, c.body]), [["/api/v3/history/failed/900", undefined], ["/api/v3/history/failed", "id=900"], ["/api/v3/history/failed", 900]]);
});

test("a season pack is marked failed ONCE — another episode's grab of the same download is 409", async () => {
  const token = await mintSession();
  const pack = [
    { id: 70, seriesId: 21, eventType: "grabbed", date: "2026-10-01T10:00:00Z", sourceTitle: "Breaking.Bad.S02.1080p", downloadId: "PACK", episode: { seasonNumber: 2, episodeNumber: 1 } },
    { id: 71, seriesId: 21, eventType: "grabbed", date: "2026-10-01T10:00:00Z", sourceTitle: "Breaking.Bad.S02.1080p", downloadId: "PACK", episode: { seasonNumber: 2, episodeNumber: 2 } },
    { id: 72, seriesId: 21, eventType: "downloadFailed", date: "2026-10-01T11:00:00Z", sourceTitle: "Breaking.Bad.S02.1080p", downloadId: "PACK", data: { message: "Manually marked as failed" } },
  ];
  responder = both((c) => {
    if (c.path === "/api/v3/history/series") return json(pack);
    if (c.method === "POST") return json({});
    return undefined;
  }, sonarrBase);
  const res = await call(failedRoute.POST, token, "/admin/arr/history/failed", { method: "POST", body: { service: "sonarr", arrId: 21, historyId: 71 } });
  assert.equal(res.status, 409);
  assert.deepEqual(writes(), []);
  assert.equal(audits.length, 0);
});

// C095: two marks of one download at once (two tabs, two admins, the History
// page beside an issue's Replace file) both read a history with no failure yet.
const PACK_GRABS = [
  { id: 70, seriesId: 21, eventType: "grabbed", date: "2026-10-01T10:00:00Z", sourceTitle: "Breaking.Bad.S02.1080p", downloadId: "PACK", episodeId: 201 },
  { id: 71, seriesId: 21, eventType: "grabbed", date: "2026-10-01T10:00:00Z", sourceTitle: "Breaking.Bad.S02.1080p", downloadId: "PACK", episodeId: 202 },
];
const markSonarr = (token: string, historyId: number) =>
  call(failedRoute.POST, token, "/admin/arr/history/failed", { method: "POST", body: { service: "sonarr", arrId: 21, historyId } });
const markPosts = () => writes().filter((c) => c.path.startsWith("/api/v3/history/failed"));

test("C095: two marks of one pack racing each other send ONE mark — the second is 409 with nothing sent", async () => {
  const token = await mintSession();
  let open: (() => void) | null = null;
  const gate = new Promise<void>((r) => { open = r; });
  responder = both(((c: Call) => {
    if (c.path === "/api/v3/history/series") return json(PACK_GRABS);
    if (c.method === "POST" && c.path.startsWith("/api/v3/history/failed")) return gate.then(() => json({}));
    return undefined;
  }) as unknown as Responder, sonarrBase);
  const first = markSonarr(token, 70);
  for (let i = 0; i < 50 && markPosts().length === 0; i++) await new Promise((r) => setTimeout(r, 2));
  assert.equal(markPosts().length, 1, "the first mark is in flight");
  // The racing mark must answer at once; open the gate whatever happened, so
  // one that reached the arr fails the test instead of parking it forever.
  const racing = markSonarr(token, 71);
  const second = await Promise.race([racing, new Promise<"parked">((r) => setTimeout(() => r("parked"), 1_000))]);
  (open as unknown as () => void)();
  assert.notEqual(second, "parked", "the racing mark reached the arr");
  assert.equal((second as Response).status, 409);
  assert.equal((await first).status, 200);
  assert.equal(markPosts().length, 1, "the download was failed once");
  assert.equal(audits.filter((a) => a.action === "ARR_MARK_FAILED").length, 1);
});

test("C095: a definite refusal hands the mark's claim back; no answer keeps it; a re-grab of the same download after the failure is a new mark", async () => {
  const token = await mintSession();
  let history: unknown[] = PACK_GRABS;
  let markStatus: number | "network" = 400;
  responder = both((c) => {
    if (c.path === "/api/v3/history/series") return json(history);
    if (c.method === "POST" && c.path.startsWith("/api/v3/history/failed")) {
      if (markStatus === "network") throw new TypeError("fetch failed");
      return markStatus === 200 ? json({}) : json({ message: "refused" }, markStatus);
    }
    return undefined;
  }, sonarrBase);
  assert.notEqual((await markSonarr(token, 70)).status, 200);
  markStatus = 200;
  assert.equal((await markSonarr(token, 70)).status, 200, "the arr refused it outright — the same mark may be tried again");
  assert.equal(markPosts().length, 2);

  // The arr wrote its failure; the same torrent (same info hash) was grabbed
  // again later — marking THAT grab is a new mark, not the old download's.
  history = [...PACK_GRABS, { id: 72, seriesId: 21, eventType: "downloadFailed", sourceTitle: "Breaking.Bad.S02.1080p", downloadId: "PACK", episodeId: 201 },
    { id: 73, seriesId: 21, eventType: "grabbed", sourceTitle: "Breaking.Bad.S02.1080p", downloadId: "PACK", episodeId: 201 }];
  calls = [];
  assert.equal((await markSonarr(token, 73)).status, 200);
  assert.equal(markPosts().length, 1);

  // No answer at all (the arr may have taken it): the claim holds, so a second
  // mark of that download sends nothing even before the arr's record shows up.
  _resetMarkClaimsForTests();
  history = PACK_GRABS;
  markStatus = "network";
  calls = [];
  assert.notEqual((await markSonarr(token, 70)).status, 200);
  markStatus = 200;
  assert.equal((await markSonarr(token, 71)).status, 409);
  assert.equal(markPosts().length, 1);
});

test("a mark whose outcome is unknown holds its claim only briefly — after it, the fresh history decides, so a mark that never landed is sent", async () => {
  const token = await mintSession();
  let history: unknown[] = PACK_GRABS;
  let markStatus: number | "network" = "network";
  responder = both((c) => {
    if (c.path === "/api/v3/history/series") return json(history);
    if (c.method === "POST" && c.path.startsWith("/api/v3/history/failed")) {
      if (markStatus === "network") throw new TypeError("fetch failed");
      return markStatus === 200 ? json({}) : json({ message: "unavailable" }, markStatus);
    }
    return undefined;
  }, sonarrBase);
  const realNow = Date.now;
  let offset = 0;
  Date.now = () => realNow() + offset;
  try {
    for (const failure of ["network", 503] as const) {
      _resetMarkClaimsForTests();
      history = PACK_GRABS;
      calls = [];
      offset = 0;
      markStatus = failure;
      assert.notEqual((await markSonarr(token, 70)).status, 200);
      markStatus = 200;
      // Straight after: the first mark may still be landing — nothing sent.
      assert.equal((await markSonarr(token, 71)).status, 409, `${failure}: inside the hold`);
      assert.equal(markPosts().length, 1);
      // Two minutes on, the history still shows no failure: the first mark
      // never reached the arr, and this one is sent.
      offset = 2 * 60_000;
      assert.equal((await markSonarr(token, 71)).status, 200, `${failure}: the history decides after the hold`);
      assert.equal(markPosts().length, 2);
    }
    // A mark that DID land is refused by the history itself, hold or not.
    _resetMarkClaimsForTests();
    history = PACK_GRABS;
    calls = [];
    offset = 0;
    markStatus = "network";
    assert.notEqual((await markSonarr(token, 70)).status, 200);
    history = [...PACK_GRABS, { id: 72, seriesId: 21, eventType: "downloadFailed", sourceTitle: "Breaking.Bad.S02.1080p", downloadId: "PACK", episodeId: 201 }];
    offset = 2 * 60_000;
    markStatus = 200;
    assert.equal((await markSonarr(token, 71)).status, 409);
    assert.equal(markPosts().length, 1);
    // An ACCEPTED mark keeps its claim for the full TTL, history or not.
    _resetMarkClaimsForTests();
    history = PACK_GRABS;
    calls = [];
    offset = 0;
    assert.equal((await markSonarr(token, 70)).status, 200);
    offset = 2 * 60_000;
    assert.equal((await markSonarr(token, 71)).status, 409);
    assert.equal(markPosts().length, 1);
  } finally {
    Date.now = realNow;
  }
});

test("C095: a grab with no downloadId (a Blackhole client) is already failed by a newer failure naming the same release and episode", async () => {
  const token = await mintSession();
  const grabs = [
    // One pack, recorded per episode with no download id: each record is its own download to the arr.
    { id: 80, seriesId: 21, eventType: "grabbed", sourceTitle: "Breaking.Bad.S02.1080p", episodeId: 201 },
    { id: 81, seriesId: 21, eventType: "grabbed", sourceTitle: "Breaking.Bad.S02.1080p", episodeId: 202 },
    { id: 82, seriesId: 21, eventType: "downloadFailed", sourceTitle: "Breaking.Bad.S02.1080p", episodeId: 201, data: { message: "Manually marked as failed" } },
  ];
  responder = both((c) => {
    if (c.path === "/api/v3/history/series") return json(grabs);
    if (c.method === "POST" && c.path.startsWith("/api/v3/history/failed")) return json({});
    return undefined;
  }, sonarrBase);
  assert.equal((await markSonarr(token, 80)).status, 409);
  assert.deepEqual(writes(), [], "nothing sent: blocklisting and searching it twice is the 5c/5e trap");
  assert.equal((await markSonarr(token, 81)).status, 200, "another episode's record is its own download (the arr fails one record when there is no id)");
  assert.equal(markPosts().length, 1);
});

test("storage lists root folders (free space, unmapped folders) and disks for every instance", async () => {
  settings.set("feature.integration.radarr", "false");
  invalidateFeatureFlagCache();
  const token = await mintSession();
  responder = (c) => {
    if (c.path === "/api/v3/rootfolder") return json([{ id: 1, path: "/tv/", accessible: true, freeSpace: 5e11, unmappedFolders: [{ name: "Old Show", path: "/tv/Old Show" }] }]);
    if (c.path === "/api/v3/diskspace") return json([{ path: "/", label: "root", freeSpace: 1e10, totalSpace: 1e11 }]);
    return undefined;
  };
  const body = await (await call(storageRoute.GET, token, "/admin/arr/storage")).json() as { results: Array<{ service: string; rootFolders: Array<{ unmappedCount: number }>; disks: unknown[] }> };
  assert.deepEqual(body.results.map((r) => [r.service, r.rootFolders[0].unmappedCount, r.disks.length]), [["sonarr", 1, 1]]);
});

// ── 8: review fixes (title manager, releases, error wording) ─────────────────

test("an upstream failure is worded by KIND — the API key, a timeout, an unreachable host — and a 409 relays the arr's own reason, masked", async () => {
  const token = await mintSession();
  const get = () => call(titleRoute.GET, token, "/admin/arr/title?service=radarr&id=11");
  responder = (c) => (c.path === "/api/v3/movie/11" ? json({ message: "Unauthorized" }, 401) : radarrBase(c));
  const auth = await get();
  assert.equal(auth.status, 502);
  assert.match(((await auth.json()) as { error: string }).error, /API key/);

  responder = (c) => {
    if (c.path === "/api/v3/movie/11") throw Object.assign(new Error("The operation was aborted due to timeout"), { name: "TimeoutError" });
    return radarrBase(c);
  };
  const slow = await get();
  assert.equal(slow.status, 504);
  assert.match(((await slow.json()) as { error: string }).error, /in time/);

  responder = (c) => {
    if (c.path === "/api/v3/movie/11") throw new TypeError("fetch failed");
    return radarrBase(c);
  };
  const down = await get();
  assert.equal(down.status, 502);
  assert.match(((await down.json()) as { error: string }).error, /reach/);

  responder = both((c) => (c.method === "POST" && c.path === "/api/v3/command" ? json({ message: `Unable to cancel task apikey=${APIKEY}` }, 409) : undefined), radarrBase);
  const refused = await call(commandRoute.POST, token, "/admin/arr/title/command", { method: "POST", body: { service: "radarr", id: 11, action: "search" } });
  assert.equal(refused.status, 409);
  const text = await refused.text();
  assert.match(text, /Unable to cancel task/);
  assert.ok(!text.includes(APIKEY));
});

test("the calendar's missing-only episode search skips episodes that have a file or haven't aired, and is 409 when none is left", async () => {
  const token = await mintSession();
  responder = both(commandResponder, sonarrBase);
  const post = (episodeIds: number[]) => call(commandRoute.POST, token, "/admin/arr/title/command", { method: "POST", body: { service: "sonarr", id: 21, action: "searchEpisodes", episodeIds, missingOnly: true } });
  assert.equal((await post([201, 202])).status, 202);
  assert.deepEqual(writes().map((c) => c.body), [{ name: "EpisodeSearch", episodeIds: [202] }], "201 has a file — an upgrade search nobody asked for");
  calls = [];
  assert.equal((await post([201])).status, 409);
  assert.deepEqual(writes(), []);
});

test("a single-episode action checks that ONE episode (no whole-series read) and refuses another series' episode", async () => {
  const token = await mintSession();
  responder = both(commandResponder, sonarrBase);
  const post = (episodeIds: number[]) => call(commandRoute.POST, token, "/admin/arr/title/command", { method: "POST", body: { service: "sonarr", id: 21, action: "searchEpisodes", episodeIds } });
  assert.equal((await post([901])).status, 409, "an episode of series 99, reached by id, is not series 21's");
  assert.deepEqual(writes(), []);
  calls = [];
  assert.equal((await post([202])).status, 202);
  assert.ok(!arrCalls().some((c) => c.path === "/api/v3/episode" && c.query.has("seriesId")), "no full episode list for one id");
  assert.ok(arrCalls().some((c) => c.path === "/api/v3/episode/202"));
});

test("episode monitoring answers the re-read series, so its counts follow monitoring", async () => {
  const token = await mintSession();
  let unmonitored = false;
  responder = both((c) => {
    if (c.method === "PUT" && c.path === "/api/v3/episode/monitor") {
      unmonitored = true;
      return json([]);
    }
    if (c.path === "/api/v3/series/21" && unmonitored) {
      // Sonarr's count drops the unmonitored, unaired-or-missing episode: season 2 reads complete.
      return json(series({ seasons: [
        { seasonNumber: 1, monitored: true, statistics: { episodeCount: 2, episodeFileCount: 2, totalEpisodeCount: 2 } },
        { seasonNumber: 2, monitored: true, statistics: { episodeCount: 1, episodeFileCount: 1, totalEpisodeCount: 2 } },
      ] }));
    }
    return undefined;
  }, sonarrBase);
  const res = await call(episodesRoute.PATCH, token, "/admin/arr/title/episodes", { method: "PATCH", body: { service: "sonarr", id: 21, episodeIds: [202], monitored: false } });
  assert.equal(res.status, 200);
  const body = (await res.json()) as { updated: number; title: { episodeCount: number; episodeFileCount: number } };
  assert.equal(body.updated, 1);
  assert.deepEqual([body.title.episodeFileCount, body.title.episodeCount], [3, 3]);
});

test("season monitoring combined with any other field is 400 — two writes, so a half-applied edit couldn't be audited honestly", async () => {
  const token = await mintSession();
  const res = await call(titleRoute.PATCH, token, "/admin/arr/title", { method: "PATCH", body: { service: "sonarr", id: 21, monitored: false, seasons: [{ seasonNumber: 1, monitored: false }] } });
  assert.equal(res.status, 400);
  assert.deepEqual(arrCalls(), []);
});

test("the title GET by TMDB id reuses the resource it found (no second read), and a failing choice list doesn't stop it opening", async () => {
  const token = await mintSession();
  responder = (c) => (c.path === "/api/v3/tag" ? json({ message: "boom" }, 500) : radarrBase(c));
  const res = await call(titleRoute.GET, token, "/admin/arr/title?service=radarr&tmdbId=603");
  assert.equal(res.status, 200);
  const body = (await res.json()) as { title: { arrId: number }; tags: unknown; qualityProfiles: unknown[] };
  assert.equal(body.title.arrId, 11);
  assert.equal(body.tags, null, "an unreadable list is null — the form disables that field");
  assert.equal(body.qualityProfiles.length, 2);
  assert.ok(!arrCalls().some((c) => c.path === "/api/v3/movie/11"), "the tmdbId read already returned the movie");
});

test("files: ids ride in a JSON body, a row naming another title is dropped, and a Radarr delete that stops part-way audits what it deleted", async () => {
  const token = await mintSession();
  responder = both((c) => {
    if (c.method === "GET" && c.path === "/api/v3/moviefile") {
      return json([
        { id: 7, movieId: 11, relativePath: "a.mkv", size: 1 },
        { id: 8, movieId: 11, relativePath: "b.mkv", size: 1 },
        { id: 9, movieId: 12, relativePath: "someone-else.mkv", size: 1 },
      ]);
    }
    if (c.method === "DELETE" && c.path === "/api/v3/moviefile/7") return new Response("", { status: 200 });
    if (c.method === "DELETE" && c.path === "/api/v3/moviefile/8") return json({ message: "locked" }, 500);
    return undefined;
  }, radarrBase);
  const list = (await (await call(filesRoute.GET, token, "/admin/arr/title/files?service=radarr&id=11")).json()) as { files: Array<{ id: number }> };
  assert.deepEqual(list.files.map((f) => f.id).sort(), [7, 8], "a file of movie 12 is not this movie's");
  assert.equal((await call(filesRoute.DELETE, token, "/admin/arr/title/files?service=radarr&id=11", { method: "DELETE", body: { fileIds: [9] } })).status, 409);
  assert.deepEqual(writes(), []);

  const res = await call(filesRoute.DELETE, token, "/admin/arr/title/files?service=radarr&id=11", { method: "DELETE", body: { fileIds: [7, 8] } });
  assert.equal(res.status, 502);
  assert.equal(((await res.json()) as { deleted: number }).deleted, 1);
  assert.equal(audits.length, 1);
  assert.deepEqual((JSON.parse(audits[0].details as string) as { fileIds: number[] }).fileIds, [7], "exactly what was deleted is audited");
});

test("a rename preview row naming another title is never renamed into this one", async () => {
  const token = await mintSession();
  responder = both((c) => {
    if (c.method === "GET" && c.path === "/api/v3/rename") {
      return json([
        { movieId: 11, movieFileId: 7, existingPath: "matrix.mkv", newPath: "The Matrix (1999).mkv" },
        { movieId: 12, movieFileId: 70, existingPath: "other.mkv", newPath: "The Matrix (1999).mkv" },
      ]);
    }
    if (c.method === "POST" && c.path === "/api/v3/command") return json({ id: 1 }, 201);
    return undefined;
  }, radarrBase);
  const preview = (await (await call(renameRoute.GET, token, "/admin/arr/title/rename?service=radarr&id=11")).json()) as { files: Array<{ fileId: number }> };
  assert.deepEqual(preview.files.map((f) => f.fileId), [7]);
  assert.equal((await call(renameRoute.POST, token, "/admin/arr/title/rename", { method: "POST", body: { service: "radarr", id: 11, fileIds: [70] } })).status, 409);
  assert.deepEqual(writes(), []);
});

test("Sonarr v4's per-series history (no embedded episode) gets its S/E from the episode list; another series' record is dropped", async () => {
  const token = await mintSession();
  responder = both((c) => {
    if (c.path === "/api/v3/history/series") {
      return json([
        { id: 80, seriesId: 21, episodeId: 202, eventType: "grabbed", date: "2026-10-02T10:00:00Z", sourceTitle: "Breaking.Bad.S02E02", downloadId: "X" },
        { id: 81, seriesId: 99, episodeId: 901, eventType: "grabbed", date: "2026-10-02T11:00:00Z", sourceTitle: "Elsewhere.S01E01", downloadId: "Y" },
      ]);
    }
    return undefined;
  }, sonarrBase);
  const res = await call(titleHistoryRoute.GET, token, "/admin/arr/title/history?service=sonarr&id=21");
  const events = ((await res.json()) as { events: Array<{ id: number; episode: { seasonNumber: number; episodeNumber: number } | null }> }).events;
  assert.deepEqual(events.map((e) => [e.id, e.episode?.seasonNumber, e.episode?.episodeNumber]), [[80, 2, 2]]);
});

test("a torrent grabbed again after an earlier failure (same info hash) can still be marked failed", async () => {
  const token = await mintSession();
  const history = [
    { id: 50, seriesId: 21, eventType: "grabbed", date: "2026-09-01T10:00:00Z", sourceTitle: "Breaking.Bad.S02E02", downloadId: "HASH" },
    { id: 51, seriesId: 21, eventType: "downloadFailed", date: "2026-09-01T11:00:00Z", sourceTitle: "Breaking.Bad.S02E02", downloadId: "HASH" },
    { id: 60, seriesId: 21, eventType: "grabbed", date: "2026-10-01T10:00:00Z", sourceTitle: "Breaking.Bad.S02E02", downloadId: "HASH" },
  ];
  responder = both((c) => {
    if (c.path === "/api/v3/history/series") return json(history);
    if (c.method === "POST" && c.path === "/api/v3/history/failed/60") return json({});
    return undefined;
  }, sonarrBase);
  const res = await call(failedRoute.POST, token, "/admin/arr/history/failed", { method: "POST", body: { service: "sonarr", arrId: 21, historyId: 60 } });
  assert.equal(res.status, 200);
  assert.deepEqual(writes().map((c) => c.path), ["/api/v3/history/failed/60"]);
  // The OLD grab, whose failure came after it, is still refused.
  calls = [];
  assert.equal((await call(failedRoute.POST, token, "/admin/arr/history/failed", { method: "POST", body: { service: "sonarr", arrId: 21, historyId: 50 } })).status, 409);
});

test("interactive search keeps the arr's own ranking (releaseWeight), and projects score, formats and languages by NAME", async () => {
  const token = await mintSession();
  const rel = (guid: string, over: Record<string, unknown>) => ({ ...RELEASE, guid, title: guid, ...over });
  responder = both((c) => (c.path === "/api/v3/release" && c.method === "GET"
    ? json([
      rel("low-score", { qualityWeight: 500, seeders: 900, releaseWeight: 2, customFormatScore: -100 }),
      rel("arr-pick", { qualityWeight: 100, seeders: 1, releaseWeight: 0, customFormatScore: 1500, customFormats: [{ id: 1, name: "HDR10+" }], languages: [{ id: 1, name: "English" }] }),
      rel("middle", { qualityWeight: 300, seeders: 50, releaseWeight: 1 }),
    ])
    : undefined), radarrBase);
  const res = await call(releasesRoute.GET, token, "/admin/arr/title/releases?service=radarr&id=11");
  const releases = ((await res.json()) as { releases: Array<{ title: string; customFormatScore: number | null; customFormats: string[]; languages: string[]; releaseWeight: number | null }> }).releases;
  assert.deepEqual(releases.map((r) => r.title), ["arr-pick", "middle", "low-score"], "the arr's order, not qualityWeight/seeders");
  assert.deepEqual([releases[0].customFormatScore, releases[0].customFormats, releases[0].languages], [1500, ["HDR10+"], ["English"]]);
});

test("a grab the arr refuses says what to do: 410 search again (its 30-minute cache), 409 with its reason; a used handle can't grab twice", async () => {
  const token = await mintSession();
  let grabStatus = 404;
  responder = both((c) => {
    if (c.path === "/api/v3/release" && c.method === "GET") return json([RELEASE]);
    if (c.path === "/api/v3/release" && c.method === "POST") {
      return grabStatus === 200 ? json({}) : json({ message: grabStatus === 409 ? "Getting release from indexer failed" : "Couldn't find requested release in cache" }, grabStatus);
    }
    return undefined;
  }, radarrBase);
  const search = async () => ((await (await call(releasesRoute.GET, token, "/admin/arr/title/releases?service=radarr&id=11")).json()) as { releases: Array<{ guid: string }> }).releases[0].guid;
  const grab = (release: string) => call(releasesRoute.POST, token, "/admin/arr/title/releases", { method: "POST", body: { service: "radarr", id: 11, release } });

  const expired = await grab(await search());
  assert.equal(expired.status, 410);
  assert.match(((await expired.json()) as { error: string }).error, /search again/i);
  grabStatus = 409;
  const refused = await grab(await search());
  assert.equal(refused.status, 409);
  assert.match(((await refused.json()) as { error: string }).error, /Getting release from indexer failed/);
  assert.equal(audits.length, 0);

  grabStatus = 200;
  const handle = await search();
  assert.equal((await grab(handle)).status, 200);
  assert.equal((JSON.parse(audits[0].details as string) as { release: string }).release, RELEASE.title, "the audit names the release (never the guid)");
  assert.equal((await grab(handle)).status, 410, "the handle was spent");
});

test("a handle grabs ONCE: a second grab racing the first is 409 with nothing sent; a refusal hands it back, an unknown outcome spends it", async () => {
  const token = await mintSession();
  let open: (() => void) | null = null;
  let gate = new Promise<void>((r) => { open = r; });
  let grabStatus = 200;
  let posts = 0;
  responder = both(((c: Call) => {
    if (c.path === "/api/v3/release" && c.method === "GET") return json([RELEASE]);
    if (c.path === "/api/v3/release" && c.method === "POST") {
      posts++;
      if (grabStatus === 0) return gate.then(() => Promise.reject(new TypeError("fetch failed")));
      return gate.then(() => (grabStatus === 200 ? json({}) : json({ message: "Download client refused it" }, grabStatus)));
    }
    return undefined;
  }) as unknown as Responder, radarrBase);
  const search = async () => ((await (await call(releasesRoute.GET, token, "/admin/arr/title/releases?service=radarr&id=11")).json()) as { releases: Array<{ guid: string }> }).releases[0].guid;
  const grab = (release: string) => call(releasesRoute.POST, token, "/admin/arr/title/releases", { method: "POST", body: { service: "radarr", id: 11, release } });

  // Two grabs of one handle in flight: the first parks inside the arr call.
  const handle = await search();
  const first = grab(handle);
  for (let i = 0; i < 50 && posts === 0; i++) await new Promise((r) => setTimeout(r, 2));
  // The racing grab must answer at once. Give it a short window, then open the
  // gate whatever happened, so a grab that reached the arr fails the test
  // instead of parking it forever.
  const racing = grab(handle);
  const second = await Promise.race([racing, new Promise<"parked">((r) => setTimeout(() => r("parked"), 1_000))]);
  (open as unknown as () => void)();
  assert.notEqual(second, "parked", "the racing grab reached the arr instead of answering 409");
  const secondRes = second as Response;
  assert.equal(secondRes.status, 409);
  assert.match(((await secondRes.json()) as { error: string }).error, /already being grabbed/i);
  assert.equal((await first).status, 200);
  assert.equal(posts, 1, "the racing grab sent nothing — the client never fetches it twice");

  // The arr refused it: the handle is handed back, so the same release can be tried again.
  gate = Promise.resolve();
  grabStatus = 409;
  const refusedHandle = await search();
  assert.equal((await grab(refusedHandle)).status, 409);
  grabStatus = 200;
  assert.equal((await grab(refusedHandle)).status, 200, "handed back after a definite refusal");

  // No answer at all (the arr may well have taken it): spent, never re-sent.
  grabStatus = 0;
  const lostHandle = await search();
  posts = 0;
  assert.notEqual((await grab(lostHandle)).status, 200);
  grabStatus = 200;
  assert.equal((await grab(lostHandle)).status, 410);
  assert.equal(posts, 1);
});

test("C010: a grab that failed BEFORE the release was sent (the title read) hands the handle back; the retry reaches the arr", async () => {
  const token = await mintSession();
  // The title read before the grab: no answer at all, then a gateway 503 —
  // neither is a definite refusal of the GRAB, but nothing was sent.
  let titleRead: "network" | "503" | "ok" = "ok";
  let posts = 0;
  responder = both((c) => {
    if (c.path === "/api/v3/release" && c.method === "GET") return json([RELEASE]);
    if (c.path === "/api/v3/release" && c.method === "POST") {
      posts++;
      return json({});
    }
    if (c.path === "/api/v3/movie/11" && titleRead === "network") throw new TypeError("fetch failed");
    if (c.path === "/api/v3/movie/11" && titleRead === "503") return json({ message: "busy" }, 503);
    return undefined;
  }, radarrBase);
  const search = async () => ((await (await call(releasesRoute.GET, token, "/admin/arr/title/releases?service=radarr&id=11")).json()) as { releases: Array<{ guid: string }> }).releases[0].guid;
  const grab = (release: string) => call(releasesRoute.POST, token, "/admin/arr/title/releases", { method: "POST", body: { service: "radarr", id: 11, release } });

  const handle = await search();
  titleRead = "network";
  assert.notEqual((await grab(handle)).status, 200);
  titleRead = "503";
  assert.notEqual((await grab(handle)).status, 200);
  assert.equal(posts, 0, "nothing reached the arr's grab");
  titleRead = "ok";
  assert.equal((await grab(handle)).status, 200, "the handle was handed back, not spent — no second indexer search");
  assert.equal(posts, 1);
  assert.equal((await grab(handle)).status, 410, "spent once the grab was accepted");
});

test("a background interactive search answers 202 with a job, joins a running one, and only its owner can read it", async () => {
  const token = await mintSession();
  const other = await mintSession();
  let release: (() => void) | null = null;
  const gate = new Promise<void>((r) => { release = r; });
  let searches = 0;
  responder = both(((c: Call) => {
    if (c.path === "/api/v3/release" && c.method === "GET") {
      searches++;
      return gate.then(() => json([RELEASE]));
    }
    return undefined;
  }) as unknown as Responder, radarrBase);
  const start = await call(releasesRoute.GET, token, "/admin/arr/title/releases?service=radarr&id=11&async=1");
  assert.equal(start.status, 202);
  const { job } = (await start.json()) as { job: string };
  assert.match(job, /^[0-9a-f]{32}$/);
  const again = await call(releasesRoute.GET, token, "/admin/arr/title/releases?service=radarr&id=11&async=1");
  assert.equal(((await again.json()) as { job: string }).job, job, "the same search while it runs is joined");
  const running = await call(releasesRoute.GET, token, `/admin/arr/title/releases?job=${job}`);
  assert.equal(running.status, 202);
  assert.equal((await call(releasesRoute.GET, other, `/admin/arr/title/releases?job=${job}`)).status, 404, "another admin can't read it");

  (release as unknown as () => void)();
  for (let i = 0; i < 50; i++) {
    const poll = await call(releasesRoute.GET, token, `/admin/arr/title/releases?job=${job}`);
    if (poll.status === 202) {
      await new Promise((r) => setTimeout(r, 5));
      continue;
    }
    assert.equal(poll.status, 200);
    const body = (await poll.json()) as { releases: Array<{ guid: string }> };
    assert.match(body.releases[0].guid, /^[0-9a-f]{32}$/, "the job's answer carries handles, never the guid");
    break;
  }
  assert.equal(searches, 1, "joining cost no second indexer search");
  assert.equal((await call(releasesRoute.GET, token, `/admin/arr/title/releases?job=${"0".repeat(32)}`)).status, 404);
});

// ── audit fixes (title-lib) ──────────────────────────────────────────────────

// A delete that THROWS may still have deleted files (Sonarr's bulk delete stops
// at the first file it can't delete; any delete can outlast the timeout). The
// title's files are re-read, and what is gone is audited — never nothing.
const timeoutError = () => new DOMException("The operation was aborted due to timeout", "TimeoutError");
function deletingFiles(service: "sonarr" | "radarr", onDelete: (c: Call, files: Array<{ id: number }>) => Response | "throw") {
  const files: Array<Record<string, unknown> & { id: number }> = service === "sonarr"
    ? EPISODE_FILES.map((f) => ({ ...f, seriesId: 21 }))
    : [{ id: 7, movieId: 11, relativePath: "a.mkv", size: 1 }, { id: 8, movieId: 11, relativePath: "b.mkv", size: 1 }];
  return both((c) => {
    if (c.method === "GET" && (c.path === "/api/v3/episodefile" || c.path === "/api/v3/moviefile")) return json(files);
    if (c.method === "DELETE") {
      const res = onDelete(c, files);
      if (res === "throw") throw timeoutError();
      return res;
    }
    return undefined;
  }, service === "sonarr" ? sonarrBase : radarrBase);
}
const dropFile = (files: Array<{ id: number }>, id: number) => {
  const i = files.findIndex((f) => f.id === id);
  if (i >= 0) files.splice(i, 1);
};
const auditedFileIds = () => audits.filter((a) => a.action === "ARR_FILE_DELETE").map((a) => (JSON.parse(a.details as string) as { fileIds: number[] }).fileIds);

test("a Sonarr bulk delete that fails part-way audits exactly the files it removed and answers 502", async () => {
  const token = await mintSession();
  responder = deletingFiles("sonarr", (c, files) => {
    // Sonarr deletes file by file: 501 and 502 go, then 503 fails.
    dropFile(files, 501);
    dropFile(files, 502);
    return json({ message: "recycle bin unavailable" }, 500);
  });
  const res = await call(filesRoute.DELETE, token, "/admin/arr/title/files?service=sonarr&id=21", { method: "DELETE", body: { fileIds: [501, 502, 503] } });
  assert.equal(res.status, 502);
  assert.equal(((await res.json()) as { deleted: number }).deleted, 2);
  assert.deepEqual(auditedFileIds(), [[501, 502]], "the removed files are audited, the one still on disk is not");
});

test("the browser's file delete runs as a background job: 202 { job } at once, the DELETE's own answer on the poll, audited once; the same delete again joins it", async () => {
  const token = await mintSession();
  const files = EPISODE_FILES.map((f) => ({ ...f, seriesId: 21 }));
  let open: () => void = () => {};
  const gate = new Promise<void>((r) => { open = r; });
  responder = both(((c: Call) => {
    if (c.method === "GET" && c.path === "/api/v3/episodefile") return json(files);
    if (c.method === "DELETE") {
      // A recycle bin on another disk: the arr answers only once the copy is done.
      return gate.then(() => {
        dropFile(files, 501);
        dropFile(files, 503);
        return new Response("", { status: 200 });
      });
    }
    return undefined;
  }) as unknown as Responder, sonarrBase);
  const path = "/admin/arr/title/files?service=sonarr&id=21";
  const starting = call(filesRoute.DELETE, token, path, { method: "DELETE", body: { fileIds: [503, 501], async: true } });
  const parked = await Promise.race([starting, new Promise<"parked">((r) => setTimeout(() => r("parked"), 1_000))]);
  if (parked === "parked") {
    open();
    await starting;
    assert.fail("the browser's delete was held open until the arr finished");
  }
  const started = parked;
  assert.equal(started.status, 202, "answered while the arr is still deleting");
  const { job } = (await started.json()) as { job: string };
  assert.match(job, /^[0-9a-f]{32}$/);
  const again = await call(filesRoute.DELETE, token, path, { method: "DELETE", body: { fileIds: [501, 503], async: true } });
  assert.equal(((await again.json()) as { job: string }).job, job, "the same delete joins the running job");
  assert.equal((await call(filesRoute.GET, token, `${path}&job=${job}`)).status, 202);
  open();
  let poll: Response | null = null;
  for (let i = 0; i < 50; i++) {
    poll = await call(filesRoute.GET, token, `${path}&job=${job}`);
    if (poll.status !== 202) break;
    await new Promise((r) => setTimeout(r, 2));
  }
  assert.equal(poll?.status, 200);
  assert.deepEqual(await poll!.json(), { deleted: 2 });
  assert.equal(writes().filter((c) => c.method === "DELETE").length, 1, "one delete reached the arr");
  assert.deepEqual(auditedFileIds().map((ids) => [...ids].sort((a, b) => a - b)), [[501, 503]], "audited once, by the job");
  const gone = await call(filesRoute.GET, token, `${path}&job=${"0".repeat(32)}`);
  assert.equal(gone.status, 404);
  assert.match(((await gone.json()) as { error: string }).error, /reload the files/);
});

test("a Sonarr bulk delete that times out after removing every file is a success, audited", async () => {
  const token = await mintSession();
  responder = deletingFiles("sonarr", (_c, files) => {
    dropFile(files, 501);
    dropFile(files, 503);
    return "throw";
  });
  const res = await call(filesRoute.DELETE, token, "/admin/arr/title/files?service=sonarr&id=21", { method: "DELETE", body: { fileIds: [501, 503] } });
  assert.equal(res.status, 200);
  assert.equal(((await res.json()) as { deleted: number }).deleted, 2);
  assert.deepEqual(auditedFileIds(), [[501, 503]]);
});

test("a Radarr delete whose FIRST call times out after removing the file audits it, and stops there", async () => {
  const token = await mintSession();
  responder = deletingFiles("radarr", (c, files) => {
    if (c.path === "/api/v3/moviefile/7") {
      dropFile(files, 7);
      return "throw";
    }
    return new Response("", { status: 200 });
  });
  const res = await call(filesRoute.DELETE, token, "/admin/arr/title/files?service=radarr&id=11", { method: "DELETE", body: { fileIds: [7, 8] } });
  assert.equal(res.status, 502);
  assert.equal(((await res.json()) as { deleted: number }).deleted, 1);
  assert.deepEqual(auditedFileIds(), [[7]]);
  assert.deepEqual(writes().map((c) => c.path), ["/api/v3/moviefile/7"], "nothing past the failed call is attempted");
});

test("a delete refused with nothing removed is still the arr's failure — no audit", async () => {
  const token = await mintSession();
  responder = deletingFiles("sonarr", () => json({ message: "Episode file is locked" }, 409));
  const res = await call(filesRoute.DELETE, token, "/admin/arr/title/files?service=sonarr&id=21", { method: "DELETE", body: { fileIds: [501] } });
  assert.equal(res.status, 409);
  assert.equal(audits.length, 0);
  responder = deletingFiles("radarr", () => "throw");
  const timedOut = await call(filesRoute.DELETE, token, "/admin/arr/title/files?service=radarr&id=11", { method: "DELETE", body: { fileIds: [7] } });
  assert.equal(timedOut.status, 504);
  assert.equal(audits.length, 0);
});

test("more than 10 episode ids read the series' list, and a row there naming ANOTHER series is not this one's (409, nothing written)", async () => {
  const token = await mintSession();
  const own = Array.from({ length: 10 }, (_, i) => ({ id: 1_000 + i, seriesId: 21, seasonNumber: 3, episodeNumber: i + 1, title: `E${i + 1}`, monitored: true, hasFile: false, episodeFileId: 0 }));
  const foreign = { id: 1_010, seriesId: 99, seasonNumber: 1, episodeNumber: 1, title: "Elsewhere", monitored: true, hasFile: false, episodeFileId: 0 };
  responder = both((c) => {
    // An arr that ignored the seriesId filter answers another series' episode too.
    if (c.method === "GET" && c.path === "/api/v3/episode" && c.query.get("seriesId") === "21" && c.query.get("seasonNumber") === null) return json([...own, foreign]);
    if (c.method === "PUT" && c.path === "/api/v3/episode/monitor") return json([]);
    return undefined;
  }, sonarrBase);
  const ids = [...own.map((e) => e.id), foreign.id];
  const res = await call(episodesRoute.PATCH, token, "/admin/arr/title/episodes", { method: "PATCH", body: { service: "sonarr", id: 21, episodeIds: ids, monitored: false } });
  assert.equal(res.status, 409);
  assert.deepEqual(writes(), []);
  assert.ok(!calls.some((c) => /^\/api\/v3\/episode\/\d+$/.test(c.path)), "the bulk path, not one read per id");

  const ok = await call(episodesRoute.PATCH, token, "/admin/arr/title/episodes", { method: "PATCH", body: { service: "sonarr", id: 21, episodeIds: [...own.map((e) => e.id), 101], monitored: false } });
  assert.equal(ok.status, 409, "101 is not in this list either");
});

test("a Sonarr lookup's lone UNTAGGED row is never taken as the title — it picks what deletes and edits act on", async () => {
  const token = await mintSession();
  // No TVDB cross-reference for 84503; Sonarr v3 degrades `term=tmdb:84503`
  // into a search that answers with the library series whose tvdbId is 84503.
  let lookupRows: unknown[] = [{ id: 21, tvdbId: 84503, title: "Breaking Bad" }];
  responder = both((c) => (c.path === "/api/v3/series/lookup" && c.query.get("term") === "tmdb:84503" ? json(lookupRows) : undefined), sonarrBase);
  const miss = await call(titleRoute.GET, token, "/admin/arr/title?service=sonarr&tmdbId=84503");
  assert.equal(miss.status, 404);
  assert.ok(!calls.some((c) => c.path === "/api/v3/series/21"), "the other series is never opened");

  // A row that NAMES the tmdbId is this title.
  lookupRows = [{ id: 21, tvdbId: 81189, tmdbId: 84503, title: "Breaking Bad" }];
  const hit = await call(titleRoute.GET, token, "/admin/arr/title?service=sonarr&tmdbId=84503");
  assert.equal(hit.status, 200);
  assert.equal(((await hit.json()) as { title: { arrId: number } }).title.arrId, 21);
});

test("mark failed reads only what its checks need: no embedded episodes, no episode-list join that could fail the write", async () => {
  const token = await mintSession();
  responder = both((c) => {
    // Sonarr v4: the records name their episode by id only.
    if (c.path === "/api/v3/history/series") {
      return json([{ id: 80, seriesId: 21, episodeId: 202, eventType: "grabbed", date: "2026-10-02T10:00:00Z", sourceTitle: "Breaking.Bad.S02E02", downloadId: "X" }]);
    }
    // Sonarr under import load: the episode list is unavailable.
    if (c.path === "/api/v3/episode") return new Response("busy", { status: 503 });
    if (c.method === "POST" && c.path === "/api/v3/history/failed/80") return json({});
    return undefined;
  }, sonarrBase);
  const res = await call(failedRoute.POST, token, "/admin/arr/history/failed", { method: "POST", body: { service: "sonarr", arrId: 21, historyId: 80 } });
  assert.equal(res.status, 200);
  assert.deepEqual(writes().map((c) => c.path), ["/api/v3/history/failed/80"]);
  assert.ok(!calls.some((c) => c.path === "/api/v3/episode"), "no episode-list read on the write path");
  const read = calls.find((c) => c.path === "/api/v3/history/series");
  assert.equal(read?.query.get("includeEpisode"), "false", "no embedded episodes on the mark's history read");
  assert.equal((JSON.parse(audits[0].details as string) as { release: string }).release, "Breaking.Bad.S02E02");

  // The History tab still joins the S/E.
  calls = [];
  responder = both((c) => (c.path === "/api/v3/history/series"
    ? json([{ id: 80, seriesId: 21, episodeId: 202, eventType: "grabbed", date: "2026-10-02T10:00:00Z", sourceTitle: "Breaking.Bad.S02E02", downloadId: "X" }])
    : undefined), sonarrBase);
  const tab = await call(titleHistoryRoute.GET, token, "/admin/arr/title/history?service=sonarr&id=21");
  assert.equal(((await tab.json()) as { events: Array<{ episode: { episodeNumber: number } | null }> }).events[0].episode?.episodeNumber, 2);
  assert.equal(calls.find((c) => c.path === "/api/v3/history/series")?.query.get("includeEpisode"), "true");
});

test("edits of one title are serialized: a season flip never PUTs back a series read before another edit's editor PUT", async () => {
  const token = await mintSession();
  let state: Record<string, unknown> = series();
  let seriesReads = 0;
  let release: () => void = () => {};
  const gate = new Promise<void>((r) => { release = r; });
  const order: string[] = [];
  responder = both(((c: Call) => {
    if (c.origin !== SONARR) return undefined;
    if (c.method === "GET" && c.path === "/api/v3/series/21") {
      // The arr reads the series when the request ARRIVES; the second read's
      // answer is held until the editor PUT has landed.
      seriesReads++;
      order.push(`GET#${seriesReads}`);
      const snap = structuredClone(state);
      return seriesReads === 2 ? gate.then(() => json(snap)) : json(snap);
    }
    // A slow root-folder scan holds the Settings save before its editor PUT.
    if (c.method === "GET" && c.path === "/api/v3/rootfolder") return new Promise((r) => setTimeout(() => r(json(TV_ROOTS)), 10));
    if (c.method === "PUT" && c.path === "/api/v3/series/editor") {
      order.push("editor");
      state = { ...state, qualityProfileId: (c.body as { qualityProfileId: number }).qualityProfileId };
      setTimeout(release, 10);
      return json([]);
    }
    if (c.method === "PUT" && c.path === "/api/v3/series/21") {
      order.push("seasons");
      state = c.body as Record<string, unknown>;
      return json(state);
    }
    return undefined;
  }) as unknown as Responder, sonarrBase);
  const settingsSave = call(titleRoute.PATCH, token, "/admin/arr/title", { method: "PATCH", body: { service: "sonarr", instance: "", id: 21, qualityProfileId: 2 } });
  const seasonFlip = call(titleRoute.PATCH, token, "/admin/arr/title", { method: "PATCH", body: { service: "sonarr", instance: "", id: 21, seasons: [{ seasonNumber: 2, monitored: false }] } });
  const [a, b] = await Promise.all([settingsSave, seasonFlip]);
  assert.equal(a.status, 200);
  assert.equal(b.status, 200);
  const seasonPut = writes().find((c) => c.path === "/api/v3/series/21");
  assert.equal((seasonPut?.body as { qualityProfileId: number }).qualityProfileId, 2, `the season PUT carries the profile the editor set (order: ${order.join(", ")})`);
  assert.equal(state.qualityProfileId, 2, "the Settings save is not reverted");
  assert.ok(order.indexOf("editor") < order.lastIndexOf("seasons"));

  // A failed edit doesn't block the next one.
  calls = [];
  responder = both((c) => (c.method === "PUT" && c.path === "/api/v3/series/editor" ? json({ message: "boom" }, 500) : undefined), sonarrBase);
  assert.equal((await call(titleRoute.PATCH, token, "/admin/arr/title", { method: "PATCH", body: { service: "sonarr", id: 21, qualityProfileId: 2 } })).status, 502);
  responder = both((c) => (c.method === "PUT" && c.path === "/api/v3/series/21" ? json(series()) : undefined), sonarrBase);
  assert.equal((await call(titleRoute.PATCH, token, "/admin/arr/title", { method: "PATCH", body: { service: "sonarr", id: 21, seasons: [{ seasonNumber: 2, monitored: false }] } })).status, 200);
});
