// Audit fixes (cross-unit, C010): the issue Replace grab
// (POST /api/issues/[id]/releases) hands its claimed release handle back when
// the grab failed BEFORE POST /api/v3/release was sent — the title lookup that
// precedes it (a network error, a gateway 503). Nothing reached the arr, so a
// retry must not cost a whole new indexer search. A failure DURING the grab
// (no answer) still spends the handle: the arr may have taken it, and the
// release is never sent twice. The same rule the request Pick release and the
// title manager grabs follow (tests/audit-fix-title-lib.test.mts).
//
// Harness: tests/audit-fix-release.test.mts — the real wrapped handler with a
// signed session JWT in a synthetic request scope, in-memory prisma stubs,
// Radarr/Sonarr scripted behind a fetch stub.
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import dns from "node:dns/promises";
import { createRequire } from "node:module";
import { AsyncLocalStorage } from "node:async_hooks";

(globalThis as { AsyncLocalStorage?: unknown }).AsyncLocalStorage = AsyncLocalStorage;

process.env.TOKEN_ENCRYPTION_KEY = "ab".repeat(32);
process.env.NEXTAUTH_SECRET = "audit-fix-cross-issue-grab-secret-0123456789";
process.env.AUTH_URL = "http://localhost:3000";
process.env.TRUST_PROXY = "true";
(process.env as Record<string, string | undefined>).NODE_ENV = "test";

const fakeLookup = async () => [{ address: "10.0.0.250", family: 4 }];
(dns as { lookup: unknown }).lookup = fakeLookup;
if ((dns as { lookup: unknown }).lookup !== fakeLookup) throw new Error("could not stub dns.lookup");

console.warn = () => {};
console.error = () => {};

// ── scripted Radarr/Sonarr ───────────────────────────────────────────────────
type Call = { method: string; path: string; query: URLSearchParams };
let calls: Call[] = [];
type Responder = (c: Call) => Response | Promise<Response> | undefined;
let responder: Responder = () => undefined;
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
  const url = new URL(String(input));
  const method = init?.method ?? "GET";
  const call = { method, path: url.pathname, query: url.searchParams };
  calls.push(call);
  const res = await responder(call);
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
  findMany: async () => [],
  update: async () => ({}),
});
let sessionSeq = 0;
async function mintSession(): Promise<string> {
  sessionSeq++;
  const userId = `user-${sessionSeq}`;
  const sessionId = `sess-${sessionSeq}`;
  usersById.set(userId, {
    role: "ADMIN", permissions: Permission.ADMIN, mediaServer: null, sessionsRevokedAt: null,
    passwordChangedAt: null, deactivatedAt: null, email: `u${sessionSeq}@example.com`, notificationEmail: null,
  });
  sessionRows.add(sessionId);
  const iat = Math.floor(Date.now() / 1000);
  return signSessionJwt(
    { id: userId, role: "ADMIN", permissions: Permission.ADMIN.toString(), provider: "credentials", sessionId, expiresAt: iat + 86_400 },
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
shadowPrismaModel(prisma, "notificationAgent", { findMany: async () => [] });
shadowPrismaModel(prisma, "pushSubscription", { findMany: async () => [] });

type IssueRow = { id: string; status: string; reportedBy: string; title: string; mediaType: "MOVIE" | "TV"; tmdbId: number; tvdbId: number | null; scope: string; seasonNumber: number | null; episodeNumber: number | null };
let issueRow: IssueRow | null = null;
shadowPrismaModel(prisma, "issue", {
  findUnique: async () => (issueRow ? { ...issueRow } : null),
  updateMany: async (args: { data: Record<string, unknown> }) => {
    if (issueRow && issueRow.status !== "RESOLVED") {
      Object.assign(issueRow, args.data);
      return { count: 1 };
    }
    return { count: 0 };
  },
});
let grabRows = 0;
shadowPrismaModel(prisma, "issueGrab", {
  create: async (args: { data: Record<string, unknown> }) => ({ id: `grab-${++grabRows}`, ...args.data }),
  updateMany: async () => ({ count: 0 }),
  findMany: async () => [],
});
shadowPrismaModel(prisma, "auditLog", { create: async () => ({}) });

const issueReleases = await import("../src/app/api/issues/[id]/releases/route.ts");

// ── request scope ────────────────────────────────────────────────────────────
function inScope<T>(fn: () => Promise<T>): Promise<T> {
  const workStore = { route: "/audit-fix-cross-issue-grab.test", forceStatic: false, dynamicShouldError: false, afterContext: { after: () => {} } };
  const h = new Headers();
  const requestStore = {
    type: "request", phase: "render",
    headers: HeadersAdapter.seal(h),
    cookies: RequestCookiesAdapter.seal(new RequestCookies(h)),
    usedDynamic: false,
  };
  return workAsyncStorage.run(workStore, () => workUnitAsyncStorage.run(requestStore, fn));
}
type Handler = (req: InstanceType<typeof NextRequest>, ctx: { params: Promise<{ id: string }> }) => Promise<Response>;
async function call(handler: unknown, token: string, path: string, id: string, init: { method?: string; body?: unknown } = {}): Promise<Response> {
  const req = new NextRequest(`http://localhost:3000/api${path}`, {
    method: init.method ?? "GET",
    headers: { cookie: `${COOKIE}=${token}`, "content-type": "application/json", origin: "http://localhost:3000" },
    ...(init.body !== undefined ? { body: JSON.stringify(init.body) } : {}),
  });
  return inScope(() => (handler as Handler)(req, { params: Promise.resolve({ id }) }));
}

// ── fixtures ─────────────────────────────────────────────────────────────────
// Every test gets its own Radarr/Sonarr origin: arr.ts caches a quality
// profile per (url, profile id).
let originSeq = 0;
const RELEASE = {
  guid: "http://indexer.example/details/1", title: "The.Matrix.1999.1080p", size: 1e9, indexerId: 3, indexer: "NZBgeek", qualityWeight: 10,
  protocol: "usenet", quality: { quality: { id: 7, name: "Bluray-1080p" }, revision: { version: 1 } }, age: 2, rejected: false, rejections: [],
  downloadAllowed: true,
};
const movieIssue = (): IssueRow => ({
  id: "issue-1", status: "OPEN", reportedBy: "r", title: "The Matrix", mediaType: "MOVIE", tmdbId: 603, tvdbId: null,
  scope: "FULL", seasonNumber: null, episodeNumber: null,
});
const episodeIssue = (): IssueRow => ({
  id: "issue-2", status: "OPEN", reportedBy: "r", title: "Show", mediaType: "TV", tmdbId: 1399, tvdbId: 121361,
  scope: "EPISODE", seasonNumber: 1, episodeNumber: 2,
});

beforeEach(() => {
  originSeq++;
  settings.clear();
  settings.set("radarrUrl", `http://10.0.${originSeq}.5:7878`);
  settings.set("radarrApiKey", "radarr-key");
  settings.set("sonarrUrl", `http://10.0.${originSeq}.7:8989`);
  settings.set("sonarrApiKey", "sonarr-key");
  calls = [];
  grabRows = 0;
  issueRow = null;
  _resetReleaseHandlesForTests();
});

const grabPosts = () => calls.filter((c) => c.method === "POST" && c.path === "/api/v3/release");

test("C010: issue Replace (movie) — the title lookup before the grab fails (network, then a gateway 503): the handle is handed back and the retry grabs", async () => {
  issueRow = movieIssue();
  let lookup: "ok" | "network" | "503" = "ok";
  responder = (c) => {
    if (c.method === "GET" && c.path === "/api/v3/movie") {
      if (lookup === "network") throw new TypeError("fetch failed");
      if (lookup === "503") return json({ message: "busy" }, 503);
      return json([{ id: 44, tmdbId: 603 }]);
    }
    if (c.method === "GET" && c.path === "/api/v3/release") return json([RELEASE]);
    if (c.method === "POST" && c.path === "/api/v3/release") return json({});
    return undefined;
  };
  const token = await mintSession();
  const [rel] = await (await call(issueReleases.GET, token, "/issues/issue-1/releases", "issue-1")).json() as Array<{ guid: string }>;
  const grab = () => call(issueReleases.POST, token, "/issues/issue-1/releases", "issue-1", { method: "POST", body: { guid: rel.guid, indexerId: 3 } });

  lookup = "network";
  assert.notEqual((await grab()).status, 200);
  lookup = "503";
  assert.notEqual((await grab()).status, 200);
  assert.equal(grabPosts().length, 0, "nothing reached the arr's grab");
  lookup = "ok";
  assert.equal((await grab()).status, 200, "the handle was handed back — no second indexer search");
  assert.equal(grabPosts().length, 1);
  assert.equal((await grab()).status, 410, "spent once the grab was accepted");
  assert.equal(grabPosts().length, 1);
});

test("C010: issue Replace (episode) — the series lookup before the grab fails: the handle is handed back and the retry grabs", async () => {
  issueRow = episodeIssue();
  let lookupFails = false;
  responder = (c) => {
    if (c.method === "GET" && c.path === "/api/v3/series") {
      if (lookupFails) throw new TypeError("fetch failed");
      return json([{ id: 21, tvdbId: 121361 }]);
    }
    if (c.method === "GET" && c.path === "/api/v3/episode") return json([{ id: 201, seasonNumber: 1, episodeNumber: 2 }]);
    if (c.method === "GET" && c.path === "/api/v3/release") return json([RELEASE]);
    if (c.method === "POST" && c.path === "/api/v3/release") return json({});
    return undefined;
  };
  const token = await mintSession();
  const [rel] = await (await call(issueReleases.GET, token, "/issues/issue-2/releases", "issue-2")).json() as Array<{ guid: string }>;
  const grab = () => call(issueReleases.POST, token, "/issues/issue-2/releases", "issue-2", { method: "POST", body: { guid: rel.guid, indexerId: 3 } });

  lookupFails = true;
  assert.notEqual((await grab()).status, 200);
  assert.equal(grabPosts().length, 0);
  lookupFails = false;
  assert.equal((await grab()).status, 200, "the handle was handed back");
  assert.equal(grabPosts().length, 1);
});

test("C010: issue Replace — a failure DURING the grab (no answer) still spends the handle", async () => {
  issueRow = movieIssue();
  responder = (c) => {
    if (c.method === "GET" && c.path === "/api/v3/movie") return json([{ id: 44, tmdbId: 603 }]);
    if (c.method === "GET" && c.path === "/api/v3/release") return json([RELEASE]);
    if (c.method === "POST" && c.path === "/api/v3/release") throw new TypeError("fetch failed");
    return undefined;
  };
  const token = await mintSession();
  const [rel] = await (await call(issueReleases.GET, token, "/issues/issue-1/releases", "issue-1")).json() as Array<{ guid: string }>;
  const grab = () => call(issueReleases.POST, token, "/issues/issue-1/releases", "issue-1", { method: "POST", body: { guid: rel.guid, indexerId: 3 } });
  assert.notEqual((await grab()).status, 200);
  assert.equal((await grab()).status, 410, "the arr may have taken it — never sent twice");
  assert.equal(grabPosts().length, 1);
});

test("C010: issue Replace (episode) — a failure DURING the grab still spends the handle (the progress reaches the series grab too)", async () => {
  issueRow = episodeIssue();
  responder = (c) => {
    if (c.method === "GET" && c.path === "/api/v3/series") return json([{ id: 21, tvdbId: 121361 }]);
    if (c.method === "GET" && c.path === "/api/v3/episode") return json([{ id: 201, seasonNumber: 1, episodeNumber: 2 }]);
    if (c.method === "GET" && c.path === "/api/v3/release") return json([RELEASE]);
    if (c.method === "POST" && c.path === "/api/v3/release") return json({ message: "gateway gave up" }, 504);
    return undefined;
  };
  const token = await mintSession();
  const [rel] = await (await call(issueReleases.GET, token, "/issues/issue-2/releases", "issue-2")).json() as Array<{ guid: string }>;
  const grab = () => call(issueReleases.POST, token, "/issues/issue-2/releases", "issue-2", { method: "POST", body: { guid: rel.guid, indexerId: 3 } });
  assert.notEqual((await grab()).status, 200);
  assert.equal((await grab()).status, 410, "the arr may have taken it — never sent twice");
  assert.equal(grabPosts().length, 1);
});
