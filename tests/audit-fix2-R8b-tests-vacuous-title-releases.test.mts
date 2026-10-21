// The admin title manager's interactive search and grab,
// GET/POST /api/admin/arr/title/releases — pinned BEHAVIOURALLY where the
// earlier pins were source scans that could pass without looking:
//
//   C112 — a Sonarr search names a season or an episode, never a series alone
//          (`/api/v3/release?seriesId=` by itself is the indexers' RSS feed —
//          other shows' episodes, grabbable). The title manager builds that
//          query apart from the path (arr-title-data.ts `releaseQuery` →
//          arr.ts `searchReleasesByArrId`'s `/api/v3/release?${query}`), out
//          of reach of a scan for the path literal.
//   C026 — a grab answered 502/504 (a gateway that gave up while the arr was
//          still handing the release to the download client) SPENDS the
//          handle: a retry is 410 and the release went out once. Only a
//          definite refusal hands it back. The other two grab routes have
//          this pin in tests/audit-fix-release.test.mts.
//
// Harness: the tests/arr-manage-routes.test.mts one, trimmed to the routes
// and stubs these read.
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import dns from "node:dns/promises";
import { createRequire } from "node:module";
import { AsyncLocalStorage } from "node:async_hooks";

(globalThis as { AsyncLocalStorage?: unknown }).AsyncLocalStorage = AsyncLocalStorage;

process.env.TOKEN_ENCRYPTION_KEY = "ab".repeat(32);
process.env.NEXTAUTH_SECRET = "audit-fix2-title-releases-secret-0123456789";
process.env.AUTH_URL = "http://localhost:3000";
process.env.TRUST_PROXY = "true";
delete process.env.TMDB_READ_TOKEN;
(process.env as Record<string, string | undefined>).NODE_ENV = "test";

const fakeLookup = async () => [{ address: "10.0.0.250", family: 4 }];
(dns as { lookup: unknown }).lookup = fakeLookup;
if ((dns as { lookup: unknown }).lookup !== fakeLookup) throw new Error("could not stub dns.lookup");

console.warn = () => {};
console.error = () => {};

// ── scripted Radarr/Sonarr ───────────────────────────────────────────────────
const RADARR = "http://10.0.0.5:7878";
const SONARR = "http://10.0.0.7:8989";
type Call = { origin: string; method: string; path: string; query: URLSearchParams };
let calls: Call[] = [];
type Responder = (c: Call) => Response | undefined;
let responder: Responder = () => undefined;
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
  const url = new URL(String(input));
  const call = { origin: url.origin, method: init?.method ?? "GET", path: url.pathname, query: url.searchParams };
  calls.push(call);
  const res = responder(call);
  if (res) return res;
  throw new Error(`unexpected ${call.method} ${url}`);
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
const { searchTitleReleases, NotOnTitleError } = await import("../src/lib/arr-title-data.ts");

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
async function mintSession(): Promise<string> {
  sessionSeq++;
  const userId = `user-${sessionSeq}`;
  const sessionId = `sess-${sessionSeq}`;
  const permissions = Permission.ADMIN.toString();
  usersById.set(userId, {
    role: "ADMIN", permissions: BigInt(permissions), mediaServer: null, sessionsRevokedAt: null,
    passwordChangedAt: null, deactivatedAt: null, email: `u${sessionSeq}@example.com`, notificationEmail: null,
  });
  sessionRows.add(sessionId);
  const iat = Math.floor(Date.now() / 1000);
  return signSessionJwt(
    { id: userId, role: "ADMIN", permissions, provider: "credentials", sessionId, expiresAt: iat + 86_400 },
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
shadowPrismaModel(prisma, "tmdbCache", {
  findUnique: async () => null,
  findMany: async () => [],
  upsert: async () => ({}),
  deleteMany: async () => ({ count: 0 }),
});
shadowPrismaModel(prisma, "tmdbMediaCore", { findMany: async () => [] });
const audits: string[] = [];
shadowPrismaModel(prisma, "auditLog", {
  create: async (args: { data: { action: string } }) => {
    audits.push(args.data.action);
    return {};
  },
});

const releasesRoute = await import("../src/app/api/admin/arr/title/releases/route.ts");

// ── request scope ────────────────────────────────────────────────────────────
function inScope<T>(fn: () => Promise<T>): Promise<T> {
  const workStore = { route: "/audit-fix2-title-releases.test", forceStatic: false, dynamicShouldError: false, afterContext: { after: () => {} } };
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
const call = (handler: unknown, token: string, path: string, body?: unknown) =>
  inScope(() => (handler as Handler)(
    new NextRequest(`http://localhost:3000/api${path}`, {
      method: body === undefined ? "GET" : "POST",
      headers: { cookie: `${COOKIE}=${token}`, ...(body !== undefined ? { "content-type": "application/json" } : {}) },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    }),
    undefined,
  ));

// ── fixtures ─────────────────────────────────────────────────────────────────
const PROFILES = [{ id: 1, name: "HD-1080p", items: [{ quality: { id: 7 }, allowed: true }] }];
const movie = () => ({ id: 11, tmdbId: 603, title: "The Matrix", year: 1999, monitored: true, qualityProfileId: 1, rootFolderPath: "/movies/", path: "/movies/The Matrix (1999)", tags: [], hasFile: true });
const series = () => ({
  id: 21, tvdbId: 81189, tmdbId: 1396, title: "Breaking Bad", year: 2008, monitored: true, qualityProfileId: 1,
  rootFolderPath: "/tv/", path: "/tv/Breaking Bad", tags: [], seriesType: "standard", seasonFolder: true,
  seasons: [
    { seasonNumber: 1, monitored: true, statistics: { episodeCount: 2, episodeFileCount: 2, totalEpisodeCount: 2 } },
    { seasonNumber: 2, monitored: true, statistics: { episodeCount: 2, episodeFileCount: 1, totalEpisodeCount: 2 } },
  ],
});
const EPISODES = [
  { id: 101, seriesId: 21, seasonNumber: 1, episodeNumber: 1, title: "Pilot", monitored: true, hasFile: true, episodeFileId: 501, airDateUtc: "2008-01-20T02:00:00Z" },
  { id: 901, seriesId: 99, seasonNumber: 1, episodeNumber: 1, title: "Elsewhere", monitored: true, hasFile: false, episodeFileId: 0, airDateUtc: "2010-01-01T00:00:00Z" },
];
const RELEASE = {
  guid: "indexer-guid-1", title: "The.Matrix.1999.1080p", size: 5e9, indexerId: 3, indexer: "NZBgeek",
  quality: { quality: { id: 7, name: "Bluray-1080p" }, revision: { version: 1 } }, qualityWeight: 100, releaseWeight: 0,
  protocol: "usenet", age: 10, rejected: false, rejections: [], downloadAllowed: true,
};
let grabStatus = 200;
let posts = 0;
const base: Responder = (c) => {
  if (c.path === "/api/v3/release" && c.method === "GET") return json([RELEASE]);
  if (c.path === "/api/v3/release" && c.method === "POST") {
    posts++;
    return grabStatus === 200 ? json({}) : new Response("bad gateway", { status: grabStatus });
  }
  if (c.method !== "GET") return undefined;
  if (c.path === "/api/v3/qualityprofile") return json(PROFILES);
  if (c.origin === RADARR && c.path === "/api/v3/movie/11") return json(movie());
  if (c.origin === SONARR && c.path === "/api/v3/series/21") return json(series());
  const ep = /^\/api\/v3\/episode\/(\d+)$/.exec(c.path);
  if (c.origin === SONARR && ep) {
    const row = EPISODES.find((e) => String(e.id) === ep[1]);
    return row ? json(row) : new Response("{}", { status: 404 });
  }
  return undefined;
};
const releaseReads = () => calls.filter((c) => c.path === "/api/v3/release" && c.method === "GET");

beforeEach(() => {
  calls = [];
  audits.length = 0;
  grabStatus = 200;
  posts = 0;
  responder = base;
  _resetReleaseHandlesForTests();
  settings.clear();
  for (const [k, v] of Object.entries({
    radarrUrl: RADARR, radarrApiKey: "radarr-key",
    sonarrUrl: SONARR, sonarrApiKey: "sonarr-key",
  })) settings.set(k, v);
  invalidateFeatureFlagCache();
});

// ═══════════════════ C112 — a season or an episode, never the series ═════════

test("C112: a season search sends ONE /api/v3/release read naming the series AND the season", async () => {
  const res = await call(releasesRoute.GET, await mintSession(), "/admin/arr/title/releases?service=sonarr&id=21&season=2");
  assert.equal(res.status, 200);
  assert.equal(releaseReads().length, 1);
  const q = releaseReads()[0].query;
  assert.equal(q.get("seriesId"), "21");
  assert.equal(q.get("seasonNumber"), "2", "a series-only query is the indexers' RSS feed");
});

test("C112: an episode search names the episode and no series", async () => {
  const res = await call(releasesRoute.GET, await mintSession(), "/admin/arr/title/releases?service=sonarr&id=21&episodeId=101");
  assert.equal(res.status, 200);
  assert.equal(releaseReads().length, 1);
  const q = releaseReads()[0].query;
  assert.equal(q.get("episodeId"), "101");
  assert.equal(q.get("seriesId"), null);
});

test("C112: a season the series doesn't have, another series' episode, or no scope at all reaches no release search", async () => {
  const token = await mintSession();
  for (const scope of ["&season=7", "&episodeId=901", ""]) {
    calls = [];
    const res = await call(releasesRoute.GET, token, `/admin/arr/title/releases?service=sonarr&id=21${scope}`);
    assert.ok(res.status >= 400 && res.status < 500, `${scope || "no scope"}: ${res.status}`);
    assert.deepEqual(releaseReads(), [], `${scope || "no scope"}: no /api/v3/release read`);
  }
});

test("C112: searchTitleReleases itself refuses a series with no scope — NotOnTitleError, no release search", async () => {
  await assert.rejects(searchTitleReleases("sonarr", "", 21, null), (e: unknown) => e instanceof NotOnTitleError);
  assert.deepEqual(releaseReads(), []);
  // A movie needs no scope: its search is the movie's own.
  await searchTitleReleases("radarr", "", 11, null);
  assert.equal(releaseReads()[0]?.query.get("movieId"), "11");
});

// ═══════════════════ C026 — a gateway 5xx spends the handle ══════════════════

const search = async (token: string) =>
  ((await (await call(releasesRoute.GET, token, "/admin/arr/title/releases?service=radarr&id=11")).json()) as { releases: Array<{ guid: string }> }).releases[0].guid;
const grab = (token: string, release: string) =>
  call(releasesRoute.POST, token, "/admin/arr/title/releases", { service: "radarr", id: 11, release });

for (const status of [502, 504]) {
  test(`C026: a gateway ${status} on the title manager's grab spends the handle — a retry is 410 and the release went out once`, async () => {
    const token = await mintSession();
    const handle = await search(token);
    grabStatus = status;
    const first = await grab(token, handle);
    assert.notEqual(first.status, 200);
    grabStatus = 200;
    const again = await grab(token, handle);
    assert.equal(again.status, 410, "spent: the arr may have taken it — never send it twice");
    assert.equal(posts, 1);
    assert.deepEqual(audits, [], "nothing audited for a grab of unknown outcome");
  });
}

test("C026: a definite refusal (409) still hands the title manager's handle back", async () => {
  const token = await mintSession();
  const handle = await search(token);
  grabStatus = 409;
  assert.equal((await grab(token, handle)).status, 409);
  grabStatus = 200;
  assert.equal((await grab(token, handle)).status, 200);
  assert.equal(posts, 2);
});
