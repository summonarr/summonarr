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
//   6. A task run names one of the instance's own scheduled tasks; a
//      library-wide search sends `monitored: true`.
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
    if (c.path !== "/api/v3/calendar") return undefined;
    if (c.origin === RADARR_4K) return new Response("down", { status: 503 });
    if (c.origin === RADARR) {
      return json([{ id: 11, tmdbId: 603, title: "The Matrix", monitored: true, hasFile: false, inCinemas: "2026-10-02T00:00:00Z", digitalRelease: "2026-10-03T00:00:00Z", physicalRelease: "2027-01-01T00:00:00Z" }]);
    }
    return json([
      { id: 202, seriesId: 21, seasonNumber: 2, episodeNumber: 2, title: "Grilled", airDateUtc: "2026-10-04T02:00:00Z", monitored: true, hasFile: false, series: { title: "Breaking Bad", tvdbId: 81189, monitored: true } },
      { id: 203, seriesId: 21, seasonNumber: 2, episodeNumber: 3, title: "Bit by a Dead Bee", airDateUtc: "2099-10-04T02:00:00Z", monitored: true, hasFile: false, series: { title: "Breaking Bad", tvdbId: 81189, monitored: true } },
    ]);
  };
  tmdbCacheRows.set("tvdb-to-tmdb:81189", JSON.stringify({ tmdbId: 1396 }));
  const res = await call(calendarRoute.GET, token, "/admin/arr/calendar?start=2026-10-01T00:00:00Z&end=2026-11-30T00:00:00Z");
  assert.equal(res.status, 200);
  const body = await res.json() as { errors: Array<{ service: string; instance: string }>; entries: Array<{ kind: string; status: string; tmdbId: number | null }> };
  assert.deepEqual(body.errors.map((e) => `${e.service}:${e.instance}`), ["radarr:4k"]);
  assert.deepEqual(body.entries.map((e) => [e.kind, e.status]), [
    ["cinema", "released"],
    ["digital", "missing"],
    ["episode", "missing"],
    ["episode", "upcoming"],
  ]);
  assert.equal(body.entries[2].tmdbId, 1396, "the series' TMDB id is filled from the tvdb→tmdb map");

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
  responder = (c) => {
    if (c.path === "/api/v3/indexer") return json([INDEXER]);
    if (c.path === "/api/v3/indexerstatus") return json([{ indexerId: 3, disabledTill: "2026-10-10T12:00:00Z", mostRecentFailure: "2026-10-10T11:00:00Z" }]);
    if (c.path === "/api/v3/downloadclient") return json([CLIENT]);
    return undefined;
  };
  const text = await (await call(providersRoute.GET, token, "/admin/arr/providers")).text();
  assert.ok(!text.includes(APIKEY));
  assert.ok(!text.includes("nzbgeek.info"));
  const result = (JSON.parse(text) as { results: Array<{ indexers: Array<{ status: { disabledTill: string } | null }>; downloadClients: unknown[] }> }).results[0];
  assert.equal(result.indexers[0].status?.disabledTill, "2026-10-10T12:00:00.000Z");
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
  assert.deepEqual(((await all.json()) as { results: unknown[] }).results, [{ id: 1, ok: true, messages: [] }]);

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
