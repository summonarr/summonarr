// Two issue routes from the 2026-10-20 audit.
//
// F002/F004 — PATCH /api/issues/[id] { refetch: true } is rate-limited per caller.
// Why: Refetch is reachable by a role=USER MANAGE_ISSUES delegate, queues an
// automatic search across every indexer (a FULL TV issue sends SeriesSearch), and
// records an IssueGrab row per call that nothing prunes. Its siblings (Replace
// release, Replace file) were bounded; Refetch had no limit at all, so a loop
// grew the table without bound and churned arr commands.
// Pinned: 10 refetches a minute per caller; the 11th is a 429 with Retry-After,
// with no Radarr/Sonarr call and no IssueGrab row; another caller keeps their
// own budget; a refused RESOLVED issue or a malformed instance spends no token.
//
// F003 — the Replace file background job JOINS only an identical request.
// Why: the join key was the issue alone and was checked before the body, so a
// second async POST naming another instance, other files or another follow-up
// was answered 202 with the FIRST job's id — its client polled that job and
// rendered its counts as its own answer while the files it named were never
// touched. Pinned: while a replace runs, the same body (file order aside) joins
// the same job; a different file set, follow-up or instance gets the explicit
// 409 "already running" with nothing deleted; the job still ends once.
//
// Harness: tests/issue-replace-file.test.mts's request scope, session fixture
// and scripted Sonarr, cut down, plus a scripted Radarr for the refetch.
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import dns from "node:dns/promises";
import { createRequire } from "node:module";
import { AsyncLocalStorage } from "node:async_hooks";

(globalThis as { AsyncLocalStorage?: unknown }).AsyncLocalStorage = AsyncLocalStorage;

process.env.TOKEN_ENCRYPTION_KEY = "ab".repeat(32);
process.env.NEXTAUTH_SECRET = "issue-routes-2026-10-20-secret-0123456789abcdef";
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
const SONARR_4K = "http://10.0.0.8:8989";
type Call = { origin: string; method: string; path: string; query: URLSearchParams; body: unknown };
let calls: Call[] = [];
type Responder = (c: Call) => Response | Promise<Response> | undefined;
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
const { arrSettingKey } = await import("../src/lib/arr-instances.ts");
const { _resetReleaseSearchJobsForTests } = await import("../src/lib/release-search-jobs.ts");

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
  findMany: async () => [],
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
// A role=USER delegate holding MANAGE_ISSUES — who Refetch admits.
const issueDelegate = () => mintSession({ role: "USER", permissions: Permission.MANAGE_ISSUES });
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
  findMany: async () => [],
  upsert: async () => ({}),
  deleteMany: async () => ({ count: 0 }),
});
let issueRow: Record<string, unknown> | null = null;
shadowPrismaModel(prisma, "issue", {
  findUnique: async () => (issueRow ? { ...issueRow } : null),
  updateMany: async (args: { where: { status?: { not?: string } }; data: Record<string, unknown> }) => {
    const refused = args.where.status?.not !== undefined && issueRow?.status === args.where.status.not;
    if (!issueRow || refused) return { count: 0 };
    Object.assign(issueRow, args.data);
    return { count: 1 };
  },
});
const grabs: Array<Record<string, unknown>> = [];
shadowPrismaModel(prisma, "issueGrab", {
  create: async (args: { data: Record<string, unknown> }) => {
    grabs.push(args.data);
    return { id: `grab-${grabs.length}`, createdAt: new Date(), ...args.data };
  },
  updateMany: async () => ({ count: 0 }),
});
shadowPrismaModel(prisma, "auditLog", { create: async () => ({}) });
shadowPrismaModel(prisma, "notificationAgent", { findMany: async () => [], update: async () => ({}) });

const issueRoute = await import("../src/app/api/issues/[id]/route.ts");
const filesRoute = await import("../src/app/api/issues/[id]/files/route.ts");

function inScope<T>(fn: () => Promise<T>): Promise<T> {
  const workStore = { route: "/audit-2026-10-20-issue-routes.test", forceStatic: false, dynamicShouldError: false, afterContext: { after: () => {} } };
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
const ctx = (id: string) => ({ params: Promise.resolve({ id }) });
const send = (handler: unknown, method: string, path: string, token: string, body?: unknown) =>
  inScope(() => (handler as Handler)(
    new NextRequest(`http://localhost:3000${path}`, {
      method,
      headers: { cookie: `${COOKIE}=${token}`, "content-type": "application/json" },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    }),
    ctx("issue-1"),
  ));
const refetch = (token: string, body: Record<string, unknown> = {}) =>
  send(issueRoute.PATCH, "PATCH", "/api/issues/issue-1", token, { refetch: true, ...body });
const postFiles = (token: string, body: unknown) => send(filesRoute.POST, "POST", "/api/issues/issue-1/files", token, body);
const getFiles = (token: string, query: string) => send(filesRoute.GET, "GET", `/api/issues/issue-1/files${query}`, token);
const arrCalls = () => calls.filter((c) => c.origin !== "http://localhost:3000");
const deletes = () => arrCalls().filter((c) => c.method === "DELETE");

// ── fixtures ─────────────────────────────────────────────────────────────────
const radarr: Responder = (c) => {
  if (c.origin !== RADARR) return undefined;
  if (c.method === "GET" && c.path === "/api/v3/movie") return json([{ id: 42, tmdbId: 603 }]);
  if (c.method === "POST" && c.path === "/api/v3/command") return json({ id: 1001, name: "MoviesSearch", status: "queued" }, 201);
  return undefined;
};
const series = {
  id: 21, tvdbId: 81189, tmdbId: 1396, title: "Breaking Bad", monitored: true, path: "/tv/Breaking Bad",
  seasons: [{ seasonNumber: 2, monitored: true, statistics: { episodeCount: 2, episodeFileCount: 2 } }],
};
const EPISODES = [
  { id: 201, seriesId: 21, seasonNumber: 2, episodeNumber: 1, title: "Seven Thirty-Seven", monitored: true, hasFile: true, episodeFileId: 503, airDateUtc: "2009-03-09T02:00:00Z" },
  { id: 202, seriesId: 21, seasonNumber: 2, episodeNumber: 2, title: "Grilled", monitored: true, hasFile: true, episodeFileId: 504, airDateUtc: "2009-03-16T02:00:00Z" },
];
const EPISODE_FILES = [
  { id: 503, seriesId: 21, seasonNumber: 2, relativePath: "Season 02/S02E01.mkv", path: "/tv/Breaking Bad/Season 02/S02E01.mkv", size: 2e9, quality: { quality: { name: "Bluray-1080p" } } },
  { id: 504, seriesId: 21, seasonNumber: 2, relativePath: "Season 02/S02E02.mkv", path: "/tv/Breaking Bad/Season 02/S02E02.mkv", size: 2e9, quality: { quality: { name: "Bluray-1080p" } } },
];
// Per Sonarr instance: what it has deleted this test.
let deleted = new Map<string, Set<number>>();
const gone = (origin: string) => deleted.get(origin) ?? new Set<number>();
const liveEpisodes = (origin: string) =>
  EPISODES.map((e) => (gone(origin).has(e.episodeFileId) ? { ...e, hasFile: false, episodeFileId: 0 } : { ...e }));
const sonarr: Responder = (c) => {
  if (c.origin !== SONARR && c.origin !== SONARR_4K) return undefined;
  if (c.method === "GET") {
    if (c.path === "/api/v3/series" && c.query.get("tvdbId") === "81189") return json([series]);
    if (c.path === "/api/v3/series/21") return json(series);
    if (c.path === "/api/v3/episode" && c.query.get("seriesId") === "21") {
      const season = c.query.get("seasonNumber");
      return json(liveEpisodes(c.origin).filter((e) => season === null || String(e.seasonNumber) === season));
    }
    if (c.path === "/api/v3/episodefile") return json(EPISODE_FILES.filter((f) => !gone(c.origin).has(f.id)));
    if (c.path === "/api/v3/history/series") return json([]);
    if (c.path === "/api/v3/config/downloadclient") return json({ autoRedownloadFailed: true });
  }
  if (c.method === "DELETE" && c.path === "/api/v3/episodefile/bulk") {
    const set = deleted.get(c.origin) ?? new Set<number>();
    for (const id of (c.body as { episodeFileIds: number[] }).episodeFileIds) set.add(id);
    deleted.set(c.origin, set);
    return new Response("", { status: 200 });
  }
  if (c.method === "POST" && c.path === "/api/v3/command") return json({ id: 6 }, 201);
  return undefined;
};
const MOVIE_ISSUE = {
  id: "issue-1", status: "OPEN", reportedBy: "reporter-1", title: "The Matrix", mediaType: "MOVIE", tmdbId: 603,
  tvdbId: null, scope: "FULL", seasonNumber: null, episodeNumber: null,
};
const SEASON_ISSUE = {
  id: "issue-1", status: "OPEN", reportedBy: "reporter-1", title: "Breaking Bad", mediaType: "TV", tmdbId: 1396,
  tvdbId: null, scope: "SEASON", seasonNumber: 2, episodeNumber: null,
};

beforeEach(() => {
  calls = [];
  grabs.length = 0;
  deleted = new Map();
  responder = (c) => radarr(c) ?? sonarr(c);
  issueRow = null;
  _resetReleaseSearchJobsForTests();
  tmdbCacheRows.clear();
  tmdbCacheRows.set("tmdb-to-tvdb:1396", JSON.stringify({ tvdbId: 81189 }));
  settings.clear();
  settings.set("radarrUrl", RADARR);
  settings.set("radarrApiKey", "radarr-key");
  settings.set("sonarrUrl", SONARR);
  settings.set("sonarrApiKey", "sonarr-key");
  settings.set(arrSettingKey("sonarr", "4k", "Url"), SONARR_4K);
  settings.set(arrSettingKey("sonarr", "4k", "ApiKey"), "sonarr-4k-key");
  invalidateFeatureFlagCache();
});

// ── F002: Refetch is rate-limited per caller ────────────────────────────────

test("Refetch: 10 a minute per caller — the 11th is a 429 with Retry-After, reaching no arr and recording no IssueGrab", async () => {
  const token = await issueDelegate();
  issueRow = { ...MOVIE_ISSUE };
  for (let i = 0; i < 10; i++) {
    const res = await refetch(token);
    assert.equal(res.status, 200, `refetch ${i + 1}`);
    assert.equal(((await res.json()) as { arrError: unknown }).arrError, null);
  }
  assert.equal(grabs.length, 10);
  const searchesBefore = arrCalls().length;
  const refused = await refetch(token);
  assert.equal(refused.status, 429);
  assert.equal(refused.headers.get("retry-after"), "60");
  assert.match(((await refused.json()) as { error: string }).error, /Too many requests/);
  assert.equal(arrCalls().length, searchesBefore, "no Radarr/Sonarr call");
  assert.equal(grabs.length, 10, "no IssueGrab row");
  // Another caller has their own budget.
  assert.equal((await refetch(await issueDelegate())).status, 200);
  assert.equal(grabs.length, 11);
});

test("Refetch: a refused RESOLVED issue or a malformed instance spends no token", async () => {
  const token = await issueDelegate();
  issueRow = { ...MOVIE_ISSUE, status: "RESOLVED" };
  for (let i = 0; i < 12; i++) assert.equal((await refetch(token)).status, 409);
  issueRow = { ...MOVIE_ISSUE };
  for (let i = 0; i < 12; i++) assert.equal((await refetch(token, { instance: "Bad Slug" })).status, 400);
  assert.deepEqual(arrCalls(), []);
  assert.equal((await refetch(token)).status, 200, "the budget is untouched");
});

// ── F003: the Replace file job joins only an identical request ──────────────

// Parks the DEFAULT Sonarr's file delete until `open()`, so a replace stays running.
function parkDefaultDelete(): { open: () => void } {
  let open!: () => void;
  const gate = new Promise<void>((r) => { open = r; });
  responder = (c) => (c.origin === SONARR && c.method === "DELETE" && c.path === "/api/v3/episodefile/bulk"
    ? gate.then(() => sonarr(c) as Response)
    : radarr(c) ?? sonarr(c));
  return { open };
}
// Bounded: a mutant must fail, never hang on the gate.
async function until(cond: () => boolean): Promise<boolean> {
  for (let i = 0; i < 500 && !cond(); i++) await new Promise((r) => setImmediate(r));
  return cond();
}

test("Replace file: while a replace runs, the identical body joins its job; another file set, follow-up or instance is 409 — nothing deleted", async () => {
  const token = await mintSession();
  issueRow = { ...SEASON_ISSUE };
  const { open } = parkDefaultDelete();
  let job = "";
  try {
    const first = await postFiles(token, { instance: "", fileIds: [504, 503], then: "search", async: true });
    assert.equal(first.status, 202);
    ({ job } = (await first.json()) as { job: string });
    assert.ok(await until(() => deletes().length === 1), "the first replace reached its delete");

    // An identical retry (a reload, a double submit) joins — file order aside — and reads nothing.
    const readsBefore = arrCalls().length;
    const again = await postFiles(token, { instance: " ", fileIds: [503, 504], then: "search", async: true });
    assert.equal(again.status, 202);
    assert.equal(((await again.json()) as { job: string }).job, job);
    assert.equal(arrCalls().length, readsBefore, "joining reads nothing");

    // A different request is refused explicitly, never handed the first job.
    for (const body of [
      { instance: "", fileIds: [503], then: "search", async: true },
      { instance: "", fileIds: [503, 504], then: "markFailed", async: true },
      { instance: "4k", fileIds: [503, 504], then: "search", async: true },
    ]) {
      const res = await postFiles(token, body);
      const answer = (await res.json()) as { job?: string; error?: string };
      assert.equal(res.status, 409, JSON.stringify(body));
      assert.equal(answer.job, undefined, JSON.stringify(body));
      assert.match(String(answer.error), /already running/);
    }
    assert.equal(deletes().length, 1, "no second delete, on either instance");
    assert.ok(!arrCalls().some((c) => c.origin === SONARR_4K && c.method !== "GET"), "nothing written to the 4K Sonarr");
  } finally {
    open();
  }

  // The one job still ends — with its own answer, its files deleted once.
  let poll!: Response;
  for (let i = 0; i < 500; i++) {
    poll = await getFiles(token, `?job=${job}`);
    if (poll.status !== 202) break;
    await new Promise((r) => setImmediate(r));
  }
  assert.equal(poll.status, 200);
  assert.equal(((await poll.json()) as { deleted: number; requested: number }).deleted, 2);
  assert.equal(deletes().length, 1);
});

test("Replace file: once the replace has ended, a different body for the issue runs as its own job", async () => {
  const token = await mintSession();
  issueRow = { ...SEASON_ISSUE };
  const first = await postFiles(token, { instance: "", fileIds: [503, 504], then: "search", async: true });
  assert.equal(first.status, 202);
  const { job } = (await first.json()) as { job: string };
  let poll!: Response;
  for (let i = 0; i < 500; i++) {
    poll = await getFiles(token, `?job=${job}`);
    if (poll.status !== 202) break;
    await new Promise((r) => setImmediate(r));
  }
  assert.equal(poll.status, 200);
  deleted = new Map(); // the files are back (re-imported)
  const second = await postFiles(token, { instance: "", fileIds: [503, 504], then: "markFailed", async: true });
  assert.equal(second.status, 202);
  assert.notEqual(((await second.json()) as { job: string }).job, job);
});
