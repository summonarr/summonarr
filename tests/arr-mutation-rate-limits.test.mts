// Every admin Radarr/Sonarr route that changes the arr's state has a per-admin
// budget: past it the answer is 429 with Retry-After and NOTHING reaches the
// arr. The budget is checked after the body is validated, so a malformed
// request spends nothing.
//   /api/admin/arr/title/rename POST, /api/admin/arr/blocklist DELETE,
//   /api/admin/arr/title/files DELETE, /api/admin/arr/title/episodes PATCH,
//   /api/admin/arr/title/releases POST (before the release handle is claimed).
//
// Harness: tests/arr-fix-system.test.mts's (in-memory prisma, a scripted arr
// behind a fetch stub, a synthetic request scope). The arr answers every call
// with a 500, so each call under the budget reaches it and fails there.
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import dns from "node:dns/promises";
import { createRequire } from "node:module";
import { AsyncLocalStorage } from "node:async_hooks";

(globalThis as { AsyncLocalStorage?: unknown }).AsyncLocalStorage = AsyncLocalStorage;

process.env.TOKEN_ENCRYPTION_KEY = "ab".repeat(32);
process.env.NEXTAUTH_SECRET = "arr-mutation-rate-limit-secret-0123456789abcdef";
process.env.AUTH_URL = "http://localhost:3000";
process.env.TRUST_PROXY = "true";
delete process.env.TMDB_READ_TOKEN;
(process.env as Record<string, string | undefined>).NODE_ENV = "test";

const fakeLookup = async () => [{ address: "10.0.0.250", family: 4 }];
(dns as { lookup: unknown }).lookup = fakeLookup;
if ((dns as { lookup: unknown }).lookup !== fakeLookup) throw new Error("could not stub dns.lookup");

console.warn = () => {};
console.error = () => {};

const RADARR = "http://10.0.0.5:7878";
const SONARR = "http://10.0.0.7:8989";
let arrCalls = 0;
globalThis.fetch = (async () => {
  arrCalls++;
  return new Response(JSON.stringify({ message: "down" }), { status: 500, headers: { "content-type": "application/json" } });
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
  const userId = `rl-user-${sessionSeq}`;
  const sessionId = `rl-sess-${sessionSeq}`;
  const permissions = Permission.ADMIN.toString();
  usersById.set(userId, {
    role: "ADMIN", permissions: BigInt(permissions), mediaServer: null, sessionsRevokedAt: null,
    passwordChangedAt: null, deactivatedAt: null, email: `rl${sessionSeq}@example.com`, notificationEmail: null,
  });
  sessionRows.add(sessionId);
  const iat = Math.floor(Date.now() / 1000);
  return signSessionJwt(
    { id: userId, role: "ADMIN", permissions, provider: "credentials", sessionId, expiresAt: iat + 86_400 },
    { expiresInSeconds: 7_200, iat },
  );
}
const COOKIE = getSessionCookieName();

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
shadowPrismaModel(prisma, "auditLog", { create: async () => ({}) });

const renameRoute = await import("../src/app/api/admin/arr/title/rename/route.ts");
const blocklistRoute = await import("../src/app/api/admin/arr/blocklist/route.ts");
const filesRoute = await import("../src/app/api/admin/arr/title/files/route.ts");
const episodesRoute = await import("../src/app/api/admin/arr/title/episodes/route.ts");
const releasesRoute = await import("../src/app/api/admin/arr/title/releases/route.ts");

function inScope<T>(fn: () => Promise<T>): Promise<T> {
  const workStore = { route: "/arr-mutation-rate-limits.test", forceStatic: false, dynamicShouldError: false, afterContext: { after: () => {} } };
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
const call = (handler: unknown, token: string, path: string, init: { method?: string; body?: unknown } = {}) =>
  inScope(() => (handler as Handler)(
    new NextRequest(`http://localhost:3000/api${path}`, {
      method: init.method ?? "GET",
      headers: { cookie: `${COOKIE}=${token}`, ...(init.body !== undefined ? { "content-type": "application/json" } : {}) },
      ...(init.body !== undefined ? { body: JSON.stringify(init.body) } : {}),
    }),
    undefined,
  ));

beforeEach(() => {
  arrCalls = 0;
  settings.clear();
  for (const [k, v] of Object.entries({ radarrUrl: RADARR, radarrApiKey: "radarr-key", sonarrUrl: SONARR, sonarrApiKey: "sonarr-key" })) settings.set(k, v);
  invalidateFeatureFlagCache();
});

type Case = {
  name: string;
  limit: number;
  /** Whether a call under the budget reaches the arr (a grab with an unknown handle never does). */
  reachesArr: boolean;
  send: (token: string) => Promise<Response>;
  malformed: (token: string) => Promise<Response>;
};
const HANDLE = "0123456789abcdef0123456789abcdef";
const CASES: Case[] = [
  {
    name: "rename",
    limit: 10,
    reachesArr: true,
    send: (tk) => call(renameRoute.POST, tk, "/admin/arr/title/rename", { method: "POST", body: { service: "radarr", id: 11, fileIds: [7] } }),
    malformed: (tk) => call(renameRoute.POST, tk, "/admin/arr/title/rename", { method: "POST", body: { service: "radarr", id: 11, fileIds: "x" } }),
  },
  {
    name: "blocklist remove",
    limit: 30,
    reachesArr: true,
    send: (tk) => call(blocklistRoute.DELETE, tk, "/admin/arr/blocklist?service=radarr&ids=3", { method: "DELETE" }),
    malformed: (tk) => call(blocklistRoute.DELETE, tk, "/admin/arr/blocklist?service=radarr&ids=x", { method: "DELETE" }),
  },
  {
    name: "file delete",
    limit: 30,
    reachesArr: true,
    send: (tk) => call(filesRoute.DELETE, tk, "/admin/arr/title/files?service=radarr&id=11", { method: "DELETE", body: { fileIds: [7] } }),
    malformed: (tk) => call(filesRoute.DELETE, tk, "/admin/arr/title/files?service=radarr&id=11", { method: "DELETE", body: { fileIds: [] } }),
  },
  {
    name: "episode monitoring",
    limit: 60,
    reachesArr: true,
    send: (tk) => call(episodesRoute.PATCH, tk, "/admin/arr/title/episodes", { method: "PATCH", body: { service: "sonarr", id: 21, episodeIds: [101], monitored: false } }),
    malformed: (tk) => call(episodesRoute.PATCH, tk, "/admin/arr/title/episodes", { method: "PATCH", body: { service: "sonarr", id: 21, episodeIds: [101] } }),
  },
  {
    name: "release grab",
    limit: 20,
    reachesArr: false,
    send: (tk) => call(releasesRoute.POST, tk, "/admin/arr/title/releases", { method: "POST", body: { service: "radarr", id: 11, release: HANDLE } }),
    malformed: (tk) => call(releasesRoute.POST, tk, "/admin/arr/title/releases", { method: "POST", body: { service: "radarr", id: 11, release: "nope" } }),
  },
];

for (const c of CASES) {
  test(`${c.name}: past ${c.limit} a minute per admin is 429 with Retry-After, and nothing reaches the arr`, async () => {
    const token = await mintSession();
    for (let i = 0; i < c.limit; i++) {
      const before = arrCalls;
      const res = await c.send(token);
      assert.notEqual(res.status, 429, `call ${i + 1} is within the budget`);
      if (c.reachesArr) assert.ok(arrCalls > before, `call ${i + 1} reached the arr`);
    }
    const before = arrCalls;
    const over = await c.send(token);
    assert.equal(over.status, 429);
    assert.equal(over.headers.get("Retry-After"), "60");
    assert.equal(arrCalls, before, "the refused call sent nothing");
    // The budget is per admin: another admin is unaffected.
    assert.notEqual((await c.send(await mintSession())).status, 429);
  });

  test(`${c.name}: a malformed request is refused before the budget and spends none of it`, async () => {
    const token = await mintSession();
    for (let i = 0; i < c.limit + 5; i++) assert.equal((await c.malformed(token)).status, 400);
    assert.notEqual((await c.send(token)).status, 429, "the budget is untouched");
  });
}

test("release grab: the budget is checked BEFORE the handle is claimed, so a refused grab leaves the release pickable", async () => {
  const { issueReleaseHandles, claimReleaseHandle } = await import("../src/lib/release-handles.ts");
  const token = await mintSession();
  // The route's own scope for a Radarr movie on the default instance.
  const scope = ["title", "radarr", "", 11, ""].join("\u0000");
  const [issued] = issueReleaseHandles(scope, [{ guid: "guid-1", indexerId: 4, title: "Movie.2024.1080p" }], { owner: "rl-owner" });
  for (let i = 0; i < 20; i++) await call(releasesRoute.POST, token, "/admin/arr/title/releases", { method: "POST", body: { service: "radarr", id: 11, release: HANDLE } });
  const over = await call(releasesRoute.POST, token, "/admin/arr/title/releases", { method: "POST", body: { service: "radarr", id: 11, release: issued.guid } });
  assert.equal(over.status, 429);
  const claim = claimReleaseHandle(scope, issued.guid);
  assert.ok(typeof claim === "object", `the handle is still free to grab (got ${String(claim)})`);
});
