// C015 (audit fix, unit "release"): the title manager's Remove keeps the
// guardrail-14b `cleanedUpAt` stamps when the DELETE's outcome is UNKNOWN — a
// timeout, a dropped connection, a gateway's 502/504 — even when a re-read
// still lists the title: the arr may be holding the DELETE behind its database
// lock and finish it after the GET answered. Only a definite refusal followed
// by a re-read that still lists it unstamps (tests/arr-title-lifecycle.test.mts
// pins that half with a 500).
//
// Harness: copied from tests/arr-title-lifecycle.test.mts.
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
  if (v && typeof v === "object" && !(v instanceof Date) && "in" in (v as object)) return ((v as { in: unknown[] }).in).includes((r as unknown as Record<string, unknown>)[k]);
  if (v && typeof v === "object" && !(v instanceof Date) && "not" in (v as object)) return (r as unknown as Record<string, unknown>)[k] !== (v as { not: unknown }).not;
  return (r as unknown as Record<string, unknown>)[k] === v;
});
shadowPrismaModel(prisma, "mediaRequest", {
  updateManyAndReturn: async (args: { where: Record<string, unknown>; data: { cleanedUpAt: Date | null } }) => {
    const hit = requests.filter((x) => matches(x, args.where));
    for (const r of hit) r.cleanedUpAt = args.data.cleanedUpAt;
    return hit.map((r) => ({ id: r.id }));
  },
  groupBy: async (args: { where: Record<string, unknown> }) => {
    const by = new Map<string, number>();
    for (const r of requests.filter((x) => matches(x, args.where))) by.set(r.status, (by.get(r.status) ?? 0) + 1);
    return [...by].map(([status, n]) => ({ status, _count: { _all: n } }));
  },
  // Honours `select` — resolveTvdbToTmdb's MediaRequest step reads { tvdbId, tmdbId }.
  findMany: async (args: { where: Record<string, unknown>; select?: Record<string, boolean> }) => {
    const rows = requests.filter((x) => matches(x, args.where)).map((r) =>
      Object.fromEntries(Object.keys(args.select ?? { id: true }).map((k) => [k, (r as unknown as Record<string, unknown>)[k]])));
    return rows;
  },
  updateMany: async (args: { where: Record<string, unknown>; data: { cleanedUpAt: Date | null } }) => {
    const hit = requests.filter((x) => matches(x, args.where));
    for (const r of hit) r.cleanedUpAt = args.data.cleanedUpAt;
    return { count: hit.length };
  },
});
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

const REMOVE = { service: "radarr", id: 11, deleteFiles: true, addImportExclusion: false, execute: true, confirm: 11 };
const AVAILABLE = (): Req => ({ id: "a", tmdbId: 603, tvdbId: null, mediaType: "MOVIE", arrInstance: "", status: "AVAILABLE", cleanedUpAt: null });

for (const [label, fail] of [
  ["a timeout", () => { throw Object.assign(new Error("The operation was aborted due to timeout"), { name: "TimeoutError" }); }],
  ["a dropped connection", () => { throw new TypeError("fetch failed"); }],
  ["a gateway 504", () => json({ message: "gateway timeout" }, 504)],
  ["a gateway 502", () => json({ message: "bad gateway" }, 502)],
] as const) {
  test(`C015 remove: ${label} with the title STILL listed keeps the stamp — the arr may finish the delete later`, async () => {
    const token = await mintSession();
    requests = [AVAILABLE()];
    responder = both((c) => (c.origin === RADARR && c.method === "DELETE" ? fail() : undefined), radarrBase);
    const res = await call(removeRoute.POST, token, "/admin/arr/title/remove", { method: "POST", body: REMOVE });
    assert.notEqual(res.status, 200);
    assert.ok(calls.some((c) => c.method === "GET" && c.path === "/api/v3/movie/11" && calls.indexOf(c) > calls.findIndex((d) => d.method === "DELETE")), "the title was re-read after the delete");
    assert.ok(requests[0].cleanedUpAt instanceof Date, "an unstamp would let the sync re-push a title the arr went on to delete");
    assert.equal(audits.length, 0, "an unknown outcome is not audited as a removal");
  });
}

test("C015 remove control: a definite refusal (500, 503) with the title still listed removes the stamp", async () => {
  for (const status of [500, 503]) {
    const token = await mintSession();
    requests = [AVAILABLE()];
    responder = both((c) => (c.method === "DELETE" ? json({ message: "boom" }, status) : undefined), radarrBase);
    const res = await call(removeRoute.POST, token, "/admin/arr/title/remove", { method: "POST", body: REMOVE });
    assert.notEqual(res.status, 200, String(status));
    assert.equal(requests[0].cleanedUpAt, null, `${status}: unstamped — the arr answered and the title is still there`);
  }
});

test("C015 arrWriteOutcomeUnknown: timeouts, network failures and 502/504 are unknown; the arr's own answers and a 503 are definite", async () => {
  const { arrWriteOutcomeUnknown, ArrResponseError } = await import("../src/lib/arr.ts");
  const { SafeFetchError } = await import("../src/lib/safe-fetch.ts");
  assert.equal(arrWriteOutcomeUnknown(new SafeFetchError("timeout", "http://x", "t")), true);
  assert.equal(arrWriteOutcomeUnknown(new SafeFetchError("network", "http://x", "n")), true);
  for (const reason of ["ssrf-blocked", "redirect", "size"] as const) {
    assert.equal(arrWriteOutcomeUnknown(new SafeFetchError(reason, "http://x", reason)), false, reason);
  }
  for (const s of [502, 504]) assert.equal(arrWriteOutcomeUnknown(new ArrResponseError(s, "")), true, String(s));
  for (const s of [400, 401, 403, 404, 408, 409, 500, 503]) assert.equal(arrWriteOutcomeUnknown(new ArrResponseError(s, "")), false, String(s));
  assert.equal(arrWriteOutcomeUnknown(Object.assign(new Error("t"), { name: "TimeoutError" })), true);
  assert.equal(arrWriteOutcomeUnknown(new Error("Radarr is not configured")), false);
});
