// Request moderation audit rows name the requester by id, never by email
// (review finding R10 of the 2026-10-20 audit fix).
//
// REQUEST_APPROVE / REQUEST_DECLINE / REQUEST_DELETE are written under a
// `request:<rid>` target, so the purge's `user:<id>` scrub never reached them,
// and they carried `requestedBy`: the requester's display name, falling back to
// the EMAIL. Pinned here:
//
//   1. PATCH (approve, decline) and DELETE on /api/requests/[id] write
//      `requesterId` plus `requestedBy` ONLY when the requester has a display
//      name — the email is never in the row. The wire contract is unchanged.
//   2. Every logAudit call under src/app/api/requests keeps "email" out of its
//      details (a source scan, so a new writer is held to it too), and the bulk
//      route's on-behalf row names the account by `targetUserId` (+ the name).
//
// The purge/retention side (scrubRequesterPii, `requestedBy` in the scrubbed
// keys) is pinned in tests/audit-2026-10-20-purge-pii.test.mts and
// tests/audit-scrub.test.mts.
//
// Harness: the tests/requests-mutation-routes.test.mts one, cut down — real
// wrapped handlers, a genuinely signed session JWT, a synthetic Next request
// scope, in-memory prisma stubs. No DB, no network.
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { AsyncLocalStorage } from "node:async_hooks";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import dns from "node:dns/promises";

(globalThis as { AsyncLocalStorage?: unknown }).AsyncLocalStorage = AsyncLocalStorage;

process.env.TOKEN_ENCRYPTION_KEY = "ab".repeat(32);
process.env.NEXTAUTH_SECRET = "request-requester-2026-10-20-secret-0123";
process.env.AUTH_URL = "http://localhost:3000";
process.env.TRUST_PROXY = "true";
process.env.TMDB_READ_TOKEN = "test-tmdb-read-token";
(process.env as Record<string, string | undefined>).NODE_ENV = "test";

const fakeLookup = async () => [{ address: "93.184.216.34", family: 4 }];
(dns as { lookup: unknown }).lookup = fakeLookup;
if ((dns as { lookup: unknown }).lookup !== fakeLookup) throw new Error("could not stub dns.lookup");

const errors: string[] = [];
console.warn = () => {};
console.error = (...args: unknown[]) => { errors.push(args.map(String).join(" ")); };

// Radarr accepts every add; anything else answers an empty object.
globalThis.fetch = (async (input: RequestInfo | URL) => {
  const url = new URL(String(input));
  const json = (b: unknown, s = 200) => new Response(JSON.stringify(b), { status: s, headers: { "content-type": "application/json" } });
  if (url.pathname.includes("/api/v3/qualityprofile")) return json([{ id: 1, name: "HD-1080p" }]);
  if (url.pathname.includes("/api/v3/rootfolder")) return json([{ path: "/media" }]);
  if (url.pathname.includes("/lookup")) {
    const tmdbId = Number((url.searchParams.get("term") ?? "").replace(/^tmdb:/, "")) || 0;
    return json([{ tmdbId, title: "The Matrix", year: 1999, titleSlug: "the-matrix", images: [] }]);
  }
  if (url.pathname.includes("/api/v3/movie")) return json({ id: 1 });
  return json({});
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
const { shadowPrismaModel, shadowPrismaClientMethod } = await import("./_helpers.mts");
const { signSessionJwt } = await import("../src/lib/session-jwt.ts");
const { getSessionCookieName } = await import("../src/lib/session-cookie.ts");
const { Permission } = await import("../src/lib/permissions.ts");

// ── fixtures ─────────────────────────────────────────────────────────────────
type AppUser = Record<string, unknown> & { id: string; email: string; name: string | null };
let appUsers: AppUser[] = [];
const sessionRows = new Set<string>();
type Written = { action: string; target: string; details: Record<string, unknown> | null };
let written: Written[] = [];

shadowPrismaModel(prisma, "authSession", {
  findUnique: async (args: { where: { sessionId: string } }) =>
    sessionRows.has(args.where.sessionId) ? { id: `row-${args.where.sessionId}`, sessionId: args.where.sessionId } : null,
  update: async () => ({}),
});
shadowPrismaModel(prisma, "user", {
  findUnique: async (args: { where: { id: string } }) => {
    const u = appUsers.find((x) => x.id === args.where.id);
    return u ? { ...u } : null;
  },
  findMany: async (args: { where?: { id?: { in?: string[] } } } = {}) => {
    const ids = args.where?.id?.in;
    return (ids ? appUsers.filter((u) => ids.includes(u.id)) : appUsers).map((u) => ({ ...u }));
  },
  update: async () => ({}),
  count: async () => appUsers.length,
});

type ReqRow = Record<string, unknown> & { id: string; requestedBy: string; status: string };
let reqRows: ReqRow[] = [];
function matchReq(r: ReqRow, where: Record<string, unknown> | undefined): boolean {
  for (const [k, v] of Object.entries(where ?? {})) if (r[k] !== v) return false;
  return true;
}
// The route reads the request with its requester (`include: { user }`).
const withUser = (r: ReqRow) => {
  const u = appUsers.find((x) => x.id === r.requestedBy)!;
  return { ...r, user: { name: u.name, email: u.email } };
};
shadowPrismaModel(prisma, "mediaRequest", {
  findUnique: async (args: { where: { id: string } }) => {
    const r = reqRows.find((x) => x.id === args.where.id);
    return r ? withUser(r) : null;
  },
  findFirst: async () => null,
  findMany: async () => [],
  updateMany: async (args: { where: Record<string, unknown>; data: Record<string, unknown> }) => {
    let count = 0;
    for (const r of reqRows) if (matchReq(r, args.where)) { Object.assign(r, args.data); count++; }
    return { count };
  },
  deleteMany: async (args: { where: Record<string, unknown> }) => {
    const before = reqRows.length;
    reqRows = reqRows.filter((r) => !matchReq(r, args.where));
    return { count: before - reqRows.length };
  },
  count: async () => 0,
});
const settings = new Map<string, string>();
shadowPrismaModel(prisma, "setting", {
  findUnique: async (args: { where: { key: string } }) => {
    const v = settings.get(args.where.key);
    return v === undefined ? null : { key: args.where.key, value: v };
  },
  findMany: async (args: { where?: { key?: { in?: string[] } } } = {}) => {
    const keys = args.where?.key?.in;
    const all = [...settings.entries()].map(([key, value]) => ({ key, value }));
    return keys ? all.filter((r) => keys.includes(r.key)) : all;
  },
  upsert: async () => ({}), create: async () => ({}), update: async () => ({}), deleteMany: async () => ({ count: 0 }),
});
shadowPrismaModel(prisma, "auditLog", {
  create: async (args: { data: { action: string; target: string; details: string | null } }) => {
    written.push({ ...args.data, details: args.data.details ? JSON.parse(args.data.details) as Record<string, unknown> : null });
    return { id: "a1" };
  },
});
for (const m of ["notification", "notificationAgent", "pushSubscription", "issue", "deletionVote", "plexLibraryItem", "jellyfinLibraryItem", "tmdbCache", "tmdbMediaCore", "radarrWantedItem", "sonarrWantedItem"]) {
  shadowPrismaModel(prisma, m, {
    findMany: async () => [], findUnique: async () => null, findFirst: async () => null, count: async () => 0,
    create: async () => ({}), createMany: async () => ({ count: 0 }), update: async () => ({}),
    updateMany: async () => ({ count: 0 }), deleteMany: async () => ({ count: 0 }), upsert: async () => ({}),
  });
}
shadowPrismaClientMethod(prisma, "$transaction", async (arg: unknown) =>
  Array.isArray(arg) ? Promise.all(arg) : (arg as (tx: unknown) => Promise<unknown>)(prisma));
shadowPrismaClientMethod(prisma, "$queryRaw", async () => []);
shadowPrismaClientMethod(prisma, "$queryRawUnsafe", async () => []);
shadowPrismaClientMethod(prisma, "$executeRaw", async () => 1);
shadowPrismaClientMethod(prisma, "$executeRawUnsafe", async () => 1);

const idRoute = await import("../src/app/api/requests/[id]/route.ts");

function inScope<T>(fn: () => Promise<T>): Promise<T> {
  const workStore = {
    route: "/audit-2026-10-20-request-requester.test", forceStatic: false, dynamicShouldError: false,
    afterContext: { after: () => {} },
  };
  const reqHeaders = new Headers();
  const requestStore = {
    type: "request", phase: "render",
    headers: HeadersAdapter.seal(reqHeaders),
    cookies: RequestCookiesAdapter.seal(new RequestCookies(reqHeaders)),
    usedDynamic: false,
  };
  return workAsyncStorage.run(workStore, () => workUnitAsyncStorage.run(requestStore, fn));
}

async function mintManager(): Promise<string> {
  const id = "manager-1";
  const sessionId = "manager-sess-1";
  appUsers.push({
    id, name: "Manager", email: "manager@example.com", role: "USER", permissions: Permission.MANAGE_REQUESTS,
    mediaServer: null, sessionsRevokedAt: null, passwordChangedAt: null, deactivatedAt: null, notificationEmail: null,
  });
  sessionRows.add(sessionId);
  const iat = Math.floor(Date.now() / 1000);
  return signSessionJwt(
    { id, role: "USER", permissions: Permission.MANAGE_REQUESTS.toString(), provider: "credentials", sessionId, expiresAt: iat + 86_400 },
    { expiresInSeconds: 7_200, iat },
  );
}

function seedRequester(id: string, name: string | null, email: string): void {
  appUsers.push({
    id, name, email, role: "USER", permissions: 0n, mediaServer: null, sessionsRevokedAt: null,
    passwordChangedAt: null, deactivatedAt: null, notificationEmail: null, emailOnApproved: false, emailOnDeclined: false,
  });
  reqRows.push({
    id: `req-${id}`, requestedBy: id, status: "PENDING", tmdbId: 603, mediaType: "MOVIE", arrInstance: "",
    title: "The Matrix", posterPath: null, releaseYear: "1999", permanentlyDeclined: false, adminNote: null,
    pendingNotifyAt: null, availableAt: null, qualityProfileId: null, tvdbId: null, createdAt: new Date(), approvedAt: null,
  });
}

function mk(path: string, token: string, method: string, body?: unknown) {
  return new NextRequest(`http://localhost:3000${path}`, {
    method,
    headers: { cookie: `${getSessionCookieName()}=${token}`, "content-type": "application/json" },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
}
async function settle(): Promise<void> {
  // logAudit is fire-and-forget (guardrail 26).
  for (let i = 0; i < 10; i++) await new Promise((r) => setImmediate(r));
}
const patch = async (token: string, id: string, body: unknown) => {
  const res = await inScope(() => idRoute.PATCH(mk(`/api/requests/${id}`, token, "PATCH", body), { params: Promise.resolve({ id }) }));
  await settle();
  return res;
};
const del = async (token: string, id: string) => {
  const res = await inScope(() => idRoute.DELETE(mk(`/api/requests/${id}`, token, "DELETE"), { params: Promise.resolve({ id }) }));
  await settle();
  return res;
};

function onlyRow(action: string): Written & { details: Record<string, unknown> } {
  const rows = written.filter((w) => w.action === action);
  assert.equal(rows.length, 1, `one ${action} row`);
  return rows[0] as Written & { details: Record<string, unknown> };
}

beforeEach(() => {
  appUsers = [];
  reqRows = [];
  written = [];
  errors.length = 0;
  sessionRows.clear();
  settings.clear();
  settings.set("radarrUrl", "http://10.0.0.2:7878");
  settings.set("radarrApiKey", "radarr-key");
});

// ── 1. the [id] route's rows ─────────────────────────────────────────────────

const CASES = [
  { label: "a named requester", id: "u-named", name: "Alice Example" as string | null, email: "alice@example.com" },
  { label: "a requester with no display name", id: "u-anon", name: null as string | null, email: "anon@example.com" },
];
const named = (c: (typeof CASES)[number]) => (c.name ? { requestedBy: c.name } : {});

for (const c of CASES) {
  test(`REQUEST_APPROVE for ${c.label}: requesterId (+ the name only when set), never the email`, async () => {
    const token = await mintManager();
    seedRequester(c.id, c.name, c.email);
    const res = await patch(token, `req-${c.id}`, { status: "APPROVED" });
    assert.equal(res.status, 200);
    const row = onlyRow("REQUEST_APPROVE");
    assert.equal(row.target, `request:req-${c.id}`);
    assert.deepEqual(row.details, {
      title: "The Matrix", mediaType: "MOVIE", year: "1999", requesterId: c.id, ...named(c),
      before: { status: "PENDING" }, after: { status: "APPROVED" },
    });
    assert.ok(!JSON.stringify(row.details).includes(c.email), "the email is never written");
  });

  test(`REQUEST_DECLINE for ${c.label}: requesterId (+ the name only when set), never the email`, async () => {
    const token = await mintManager();
    seedRequester(c.id, c.name, c.email);
    assert.equal((await patch(token, `req-${c.id}`, { status: "DECLINED", adminNote: "no" })).status, 200);
    const row = onlyRow("REQUEST_DECLINE");
    assert.deepEqual(row.details, {
      title: "The Matrix", mediaType: "MOVIE", year: "1999", requesterId: c.id, ...named(c), adminNote: "no",
      before: { status: "PENDING" }, after: { status: "DECLINED" },
    });
    assert.ok(!JSON.stringify(row.details).includes(c.email));
  });

  test(`REQUEST_DELETE for ${c.label}: requesterId (+ the name only when set), never the email`, async () => {
    const token = await mintManager();
    seedRequester(c.id, c.name, c.email);
    const res = await del(token, `req-${c.id}`);
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { ok: true }, "wire contract unchanged");
    const row = onlyRow("REQUEST_DELETE");
    assert.deepEqual(row.details, {
      title: "The Matrix", mediaType: "MOVIE", year: "1999", requesterId: c.id, ...named(c), before: { status: "PENDING" },
    });
    assert.ok(!JSON.stringify(row.details).includes(c.email));
  });
}

// ── 2. every request-route audit writer ──────────────────────────────────────

const ROOT = new URL("..", import.meta.url).pathname;
function routeFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((f) => {
    const p = join(dir, f);
    return statSync(p).isDirectory() ? routeFiles(p) : p.endsWith(".ts") ? [p] : [];
  });
}
// Each `logAudit({ … })` call's argument, by brace matching.
function auditCalls(src: string): string[] {
  const out: string[] = [];
  for (let at = src.indexOf("logAudit({"); at >= 0; at = src.indexOf("logAudit({", at + 1)) {
    let depth = 0;
    let i = at + "logAudit(".length;
    for (; i < src.length; i++) {
      if (src[i] === "{") depth++;
      else if (src[i] === "}" && --depth === 0) break;
    }
    out.push(src.slice(at, i + 1));
  }
  return out;
}

test("no audit writer under src/app/api/requests puts an email in its details", () => {
  const files = routeFiles(join(ROOT, "src/app/api/requests"));
  let calls = 0;
  for (const file of files) {
    for (const call of auditCalls(readFileSync(file, "utf8"))) {
      calls++;
      const details = call.slice(call.indexOf("details:"));
      assert.ok(call.includes("details:"), `${relative(ROOT, file)}: ${call.slice(0, 80)}`);
      assert.doesNotMatch(details.split("auditContext(")[0], /email/i, `${relative(ROOT, file)}: ${call}`);
    }
  }
  assert.ok(calls >= 8, `found ${calls} audit writers`);
});

test("bulk: the on-behalf row names the account by targetUserId, and the display name only when it has one", () => {
  const src = readFileSync(join(ROOT, "src/app/api/requests/bulk/route.ts"), "utf8");
  const call = auditCalls(src).find((c) => c.includes('"REQUEST_ON_BEHALF"'));
  assert.ok(call, "the on-behalf audit write");
  assert.match(call, /target: `user:\$\{targetUserId\}`/);
  assert.match(call, /details: \{ targetUserId, \.\.\.\(target\.name \? \{ targetUser: target\.name \} : \{\}\)/);
});

test("nothing was logged as an error on the way", () => {
  assert.deepEqual(errors, []);
});
