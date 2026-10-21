// "Instant, then live" on the SERVER side: which admin Radarr/Sonarr reads keep
// their last answer (`snapshotted`, src/lib/arr-snapshot.ts) and how.
//
// What is pinned:
//   1. Every listed READ's GET goes through `snapshotted` INSIDE `withAdmin`
//      (`withAdmin(snapshotted(…))`) — the gate runs before a snapshot is
//      served, so `?cached=1` is ADMIN-only exactly like the live read. Only
//      the GET: no write is ever wrapped.
//   2. Nothing else is wrapped: no release search (its handles are single-use
//      and bound to one search), not the command watch, not a rename preview,
//      not the request "Why?" status, nothing outside /api/admin.
//   3. A real route (storage): a live read is kept, `cached=1` answers the same
//      body + X-Summonarr-Snapshot-At without reaching Radarr/Sonarr, a
//      non-ADMIN caller is 403 on it too, and a background-job poll through a
//      wrapped GET still answers the job and is never kept.
//   4. The spec documents `cached` + the 204 on exactly the wrapped GETs.
//
// Harness: the same as tests/arr-manage-routes.test.mts.
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import dns from "node:dns/promises";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { createRequire } from "node:module";
import { AsyncLocalStorage } from "node:async_hooks";

(globalThis as { AsyncLocalStorage?: unknown }).AsyncLocalStorage = AsyncLocalStorage;

process.env.TOKEN_ENCRYPTION_KEY = "ab".repeat(32);
process.env.NEXTAUTH_SECRET = "arr-snapshot-routes-test-secret-0123456789ab";
process.env.AUTH_URL = "http://localhost:3000";
process.env.TRUST_PROXY = "true";
delete process.env.TMDB_READ_TOKEN;
(process.env as Record<string, string | undefined>).NODE_ENV = "test";

const fakeLookup = async () => [{ address: "10.0.0.250", family: 4 }];
(dns as { lookup: unknown }).lookup = fakeLookup;
if ((dns as { lookup: unknown }).lookup !== fakeLookup) throw new Error("could not stub dns.lookup");

console.warn = () => {};
console.error = () => {};

// ── 1 + 2: structure ─────────────────────────────────────────────────────────

const ROOT = new URL("..", import.meta.url).pathname;
const API = join(ROOT, "src", "app", "api");

/** The admin Radarr/Sonarr reads that keep their last answer — paths under src/app/api. */
const WRAPPED = [
  "admin/queue",
  "admin/arr-health",
  "admin/missing",
  "admin/missing/episodes",
  "admin/arr/history",
  "admin/arr/blocklist",
  "admin/arr/calendar",
  "admin/arr/tasks",
  "admin/arr/providers",
  "admin/arr/storage",
  "admin/arr/title",
  "admin/arr/title/episodes",
  "admin/arr/title/files",
  "admin/arr/title/history",
];

function routeFiles(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) out.push(...routeFiles(p));
    else if (name === "route.ts") out.push(p);
  }
  return out;
}
const routeDir = (file: string) => relative(API, file).split(sep).slice(0, -1).join("/");
const source = (dir: string) => readFileSync(join(API, dir, "route.ts"), "utf8");

/** Each exported handler's own source, by method. */
function handlerSlices(src: string): Map<string, string> {
  const out = new Map<string, string>();
  const marks = [...src.matchAll(/^export const (GET|POST|PATCH|DELETE|PUT) =/gm)];
  marks.forEach((m, i) => out.set(m[1], src.slice(m.index, marks[i + 1]?.index ?? src.length)));
  return out;
}

test("every listed read's GET is withAdmin(snapshotted(…)) — the gate first — and no other method of it is wrapped", () => {
  for (const dir of WRAPPED) {
    const src = source(dir);
    assert.match(src, /^import \{ snapshotted \} from "@\/lib\/arr-snapshot";$/m, `${dir}: imports snapshotted`);
    const slices = handlerSlices(src);
    assert.match(slices.get("GET") ?? "", /^export const GET = withAdmin\(snapshotted\(async /, `${dir}: GET is withAdmin(snapshotted(…))`);
    assert.match(slices.get("GET") ?? "", /\n\}\)\);\s*(\/\/[^\n]*\n\s*)*$/, `${dir}: the wrapper closes the GET`);
    for (const [method, body] of slices) {
      if (method !== "GET") assert.doesNotMatch(body, /snapshotted/, `${dir}: ${method} must never replay an answer`);
    }
    assert.doesNotMatch(src, /snapshotted\(\s*with(Admin|Auth|Permission|IssueAdmin)/, `${dir}: a snapshot served before the auth check`);
  }
});

test("nothing else keeps an answer: no release search, command watch, rename preview, Why? status, or anything outside /api/admin", () => {
  // A CALL or an import — the spec mentions the name in prose.
  const users = routeFiles(API)
    .filter((f) => /\bsnapshotted\(|import \{[^}]*\bsnapshotted\b/.test(readFileSync(f, "utf8")))
    .map(routeDir)
    .sort();
  assert.deepEqual(users, [...WRAPPED].sort(), "a new snapshotted route must be judged safe to replay and listed here");
  for (const dir of users) {
    assert.ok(dir.startsWith("admin/"), `${dir} is outside /api/admin`);
    assert.doesNotMatch(dir, /(^|\/)releases($|\/)|^admin\/arr\/commands$|\/rename$|arr-status/, `${dir} must never be replayed`);
  }
  // The routes named as never-wrapped exist (so the check above is not vacuous).
  for (const dir of ["admin/arr/commands", "admin/arr/title/releases", "admin/arr/title/rename", "requests/[id]/releases", "requests/[id]/arr-status", "issues/[id]/releases"]) {
    assert.doesNotMatch(source(dir), /\bsnapshotted\(|arr-snapshot/, dir);
  }
});

// ── 3 + 4: a real route, and the spec ────────────────────────────────────────

const SONARR = "http://10.0.0.7:8989";
type Call = { origin: string; method: string; path: string };
let calls: Call[] = [];
let responder: (c: Call) => Response | undefined = () => undefined;
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
  const url = new URL(String(input));
  const call = { origin: url.origin, method: init?.method ?? "GET", path: url.pathname };
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
const { SNAPSHOT_HEADER, arrSnapshotStats, clearArrSnapshots } = await import("../src/lib/arr-snapshot.ts");

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
    id: userId, name: `User ${sessionSeq}`, role, permissions: BigInt(permissions), mediaServer: null, sessionsRevokedAt: null,
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

const storageRoute = await import("../src/app/api/admin/arr/storage/route.ts");
const filesRoute = await import("../src/app/api/admin/arr/title/files/route.ts");
const openapiRoute = await import("../src/app/api/openapi/route.ts");

function inScope<T>(fn: () => Promise<T>): Promise<T> {
  const workStore = { route: "/arr-snapshot-routes.test", forceStatic: false, dynamicShouldError: false, afterContext: { after: () => {} } };
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
const get = (handler: unknown, token: string | null, path: string) =>
  inScope(() => (handler as Handler)(
    new NextRequest(`http://localhost:3000/api${path}`, {
      headers: { "accept-language": "en", ...(token ? { cookie: `${COOKIE}=${token}` } : {}) },
    }),
    undefined,
  ));
const arrCalls = () => calls.filter((c) => c.origin !== "http://localhost:3000");

beforeEach(() => {
  calls = [];
  clearArrSnapshots();
  settings.clear();
  for (const [k, v] of Object.entries({ sonarrUrl: SONARR, sonarrApiKey: "sonarr-key", "feature.integration.radarr": "false" })) settings.set(k, v);
  invalidateFeatureFlagCache();
  responder = (c) => {
    if (c.origin !== SONARR || c.method !== "GET") return undefined;
    if (c.path === "/api/v3/rootfolder") return json([{ id: 1, path: "/tv/", accessible: true, freeSpace: 5e11, unmappedFolders: [] }]);
    if (c.path === "/api/v3/diskspace") return json([{ path: "/", label: "root", freeSpace: 1e10, totalSpace: 1e11 }]);
    return undefined;
  };
});

test("storage: a live read is kept; cached=1 answers the same body + its read time WITHOUT reaching Sonarr; non-ADMIN is refused on it too", async () => {
  const admin = await mintSession();
  const empty = await get(storageRoute.GET, admin, "/admin/arr/storage?cached=1");
  assert.equal(empty.status, 204, "nothing kept yet");
  assert.deepEqual(arrCalls(), [], "a snapshot read never reaches the arr");

  const live = await get(storageRoute.GET, admin, "/admin/arr/storage");
  assert.equal(live.status, 200);
  assert.equal(live.headers.get(SNAPSHOT_HEADER), null, "a live answer is not marked as a snapshot");
  const liveText = await live.text();
  assert.ok(arrCalls().length > 0, "the live read asked Sonarr");
  assert.equal((JSON.parse(liveText) as { results: unknown[] }).results.length, 1);

  calls = [];
  responder = () => undefined; // Sonarr is gone: any call would throw
  const snap = await get(storageRoute.GET, admin, "/admin/arr/storage?cached=1");
  assert.equal(snap.status, 200);
  assert.equal(await snap.text(), liveText, "the SAME body, byte for byte (response shapes stay additive — guardrail 25)");
  const at = snap.headers.get(SNAPSHOT_HEADER);
  assert.ok(at && !Number.isNaN(Date.parse(at)), "stamped with when it was read");
  assert.deepEqual(arrCalls(), []);

  const manager = await mintSession({ role: "USER", permissions: Permission.MANAGE_REQUESTS | Permission.MANAGE_ISSUES });
  const refused = await get(storageRoute.GET, manager, "/admin/arr/storage?cached=1");
  assert.equal(refused.status, 403, "the gate runs before a snapshot is served");
  assert.doesNotMatch(await refused.text(), /rootFolders|\/tv\//);
  assert.equal((await get(storageRoute.GET, null, "/admin/arr/storage?cached=1")).status, 401);
  assert.deepEqual(arrCalls(), []);
});

test("title files: a job poll through the wrapped GET still answers the job, and is never kept", async () => {
  const admin = await mintSession();
  const job = "0123456789abcdef0123456789abcdef";
  const before = arrSnapshotStats().entries;
  const poll = await get(filesRoute.GET, admin, `/admin/arr/title/files?job=${job}`);
  assert.equal(poll.status, 404, "an unknown job is the 'gone' answer — the handler ran");
  assert.equal(arrSnapshotStats().entries, before, "a job poll answers the job, not the page");
  assert.equal((await get(filesRoute.GET, admin, `/admin/arr/title/files?job=${job}&cached=1`)).status, 204);
  assert.deepEqual(arrCalls(), []);
});

type Op = { parameters?: Array<{ name: string; in: string }>; responses: Record<string, { description?: string }> };

test("the spec documents `cached` and the 204 on exactly the wrapped GETs", async () => {
  const res = await get(openapiRoute.GET, await mintSession(), "/openapi");
  assert.equal(res.status, 200);
  const spec = (await res.json()) as { paths: Record<string, Record<string, Op>> };
  const documented: string[] = [];
  for (const [path, methods] of Object.entries(spec.paths)) {
    for (const [method, op] of Object.entries(methods)) {
      const cached = (op.parameters ?? []).filter((p) => p.name === "cached");
      if (cached.length === 0) continue;
      assert.equal(cached.length, 1, `${method} ${path}: one cached param`);
      assert.equal(cached[0].in, "query");
      assert.match(op.responses["204"]?.description ?? "", /cached=1/, `${method} ${path}: documents the 204`);
      documented.push(`${method} ${path}`);
    }
  }
  assert.deepEqual(documented.sort(), WRAPPED.map((d) => `get /${d}`).sort());
});
