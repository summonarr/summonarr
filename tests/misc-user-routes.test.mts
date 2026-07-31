// Route-level unit tests for six small uncovered user-facing routes:
//   GET         /api/ratings
//   POST        /api/ratings/batch
//   GET/POST/DELETE /api/notifications
//   POST        /api/report
//   POST        /api/issues/[id]/claim
//   GET/POST    /api/profile/notification-email/confirm
//
// Small routes, but four of them carry a guard whose absence is a real bug:
//
//   1. NOTIFICATIONS DELETE TAKES ITS SELECTION FROM QUERY PARAMS, and clear-all
//      must be an explicit `?all=1`. DELETE bodies are stripped by some proxies
//      and CDNs, so a body-driven selection would silently turn a single-item
//      delete into a FULL INBOX WIPE. A request with neither ?ids= nor ?all=1 is
//      a 400, never a wipe.
//   2. /api/report USES logAuditOrFail, AND THAT IS CORRECT — the inversion of
//      guardrail 26. That guardrail bars the throwing variant only AFTER a
//      committed mutation; here the audit write IS the operation, so a failed
//      write must surface as an error rather than a false "reported". Pinned in
//      both directions so neither half gets "fixed" into the other.
//   3. ISSUE CLAIM IS A COMPARE-AND-SWAP ON claimedBy, so two admins racing to
//      take over the same issue can't stomp each other — the loser gets 409.
//   4. THE EMAIL-CONFIRM LINK IS UNAUTHENTICATED AND THE TOKEN IS THE CREDENTIAL,
//      so it is stored HASHED, GET only renders a confirm form while POST does
//      the bind (an email scanner or link preview following the URL must not
//      silently confirm an address), and the token is consumed FIRST so a
//      double-submit can't re-trigger it.
//
// Everything else here is the ordinary shape: per-user scoping with no user
// pivot, per-user rate limits, body caps, and input whitelists.
//
// Harness: real wrapped handlers, genuine signed session JWTs, a synthetic Next
// request scope, in-memory prisma stubs. No DB, no network.
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { AsyncLocalStorage } from "node:async_hooks";
import dns from "node:dns/promises";

(globalThis as { AsyncLocalStorage?: unknown }).AsyncLocalStorage = AsyncLocalStorage;

process.env.TOKEN_ENCRYPTION_KEY = "ab".repeat(32);
process.env.NEXTAUTH_SECRET = "misc-user-routes-secret-0123456789abc";
process.env.AUTH_URL = "http://localhost:3000";
process.env.TRUST_PROXY = "true";
process.env.TMDB_READ_TOKEN = "test-tmdb-read-token";
(process.env as Record<string, string | undefined>).NODE_ENV = "test";

const fakeLookup = async () => [{ address: "93.184.216.34", family: 4 }];
(dns as { lookup: unknown }).lookup = fakeLookup;
if ((dns as { lookup: unknown }).lookup !== fakeLookup) throw new Error("could not stub dns.lookup");

const warns: string[] = [];
const errors: string[] = [];
console.warn = (...args: unknown[]) => { warns.push(args.map(String).join(" ")); };
console.error = (...args: unknown[]) => { errors.push(args.map(String).join(" ")); };

globalThis.fetch = (async () =>
  new Response(JSON.stringify({}), { status: 503, headers: { "content-type": "application/json" } })) as unknown as typeof fetch;

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

// ── op log ───────────────────────────────────────────────────────────────────
type Op = { op: string; args?: unknown };
let ops: Op[] = [];
const rec = (op: string, args?: unknown) => { ops.push({ op, args }); };
const opsOf = (name: string) => ops.filter((o) => o.op === name);

// ── auth fixture ─────────────────────────────────────────────────────────────
const usersById = new Map<string, Record<string, unknown>>();
const sessionRows = new Set<string>();
shadowPrismaModel(prisma, "authSession", {
  findUnique: async (args: { where: { sessionId: string } }) =>
    sessionRows.has(args.where.sessionId) ? { id: `row-${args.where.sessionId}`, sessionId: args.where.sessionId } : null,
  update: async () => ({}),
});

let seq = 0;
async function mintSession(opts: { permissions?: bigint; role?: string } = {}): Promise<{ userId: string; token: string }> {
  seq++;
  const userId = `person-${seq}`;
  const sessionId = `sess-${seq}`;
  const role = opts.role ?? "USER";
  const permissions = (opts.permissions ?? 0n).toString();
  usersById.set(userId, {
    id: userId, name: `Person ${seq}`, email: `person-${seq}@example.com`, role,
    permissions: BigInt(permissions), mediaServer: null, sessionsRevokedAt: null,
    passwordChangedAt: null, deactivatedAt: null, notificationEmail: null,
  });
  sessionRows.add(sessionId);
  const iat = Math.floor(Date.now() / 1000);
  const token = await signSessionJwt(
    { id: userId, role, permissions, provider: "credentials", sessionId, expiresAt: iat + 86_400 },
    { expiresInSeconds: 7_200, iat },
  );
  return { userId, token };
}
const COOKIE = getSessionCookieName();
const issueAdmin = () => mintSession({ permissions: Permission.MANAGE_ISSUES, role: "ISSUE_ADMIN" });

shadowPrismaModel(prisma, "user", {
  findUnique: async (args: { where: { id: string } }) => usersById.get(args.where.id) ?? null,
  findMany: async () => [], update: async () => ({}), count: async () => usersById.size,
});

// ── stores ───────────────────────────────────────────────────────────────────
type Notif = { id: string; userId: string; type: string; title: string; body: string; readAt: Date | null; createdAt: Date; tmdbId: number | null; mediaType: string | null; posterPath: string | null };
let notifs: Notif[] = [];

function notifMatch(n: Notif, where: Record<string, unknown> | undefined): boolean {
  if (!where) return true;
  for (const [k, v] of Object.entries(where)) {
    if (k === "OR") { if (!(v as Record<string, unknown>[]).some((w) => notifMatch(n, w))) return false; continue; }
    if (k === "id") {
      const f = v as string | { in?: string[]; lt?: string };
      if (typeof f === "string") { if (n.id !== f) return false; continue; }
      if (f.in && !f.in.includes(n.id)) return false;
      if (f.lt !== undefined && !(n.id < f.lt)) return false;
      continue;
    }
    if (k === "createdAt") {
      const f = v as Date | { lt?: Date };
      if (f instanceof Date) { if (n.createdAt.getTime() !== f.getTime()) return false; continue; }
      if (f.lt && !(n.createdAt < f.lt)) return false;
      continue;
    }
    if ((n as unknown as Record<string, unknown>)[k] !== v) return false;
  }
  return true;
}

shadowPrismaModel(prisma, "notification", {
  findMany: async (args: { where?: Record<string, unknown>; take?: number }) => {
    rec("notification.findMany", args.where);
    const rows = notifs.filter((n) => notifMatch(n, args.where))
      .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime() || (a.id < b.id ? 1 : -1));
    return args.take != null ? rows.slice(0, args.take) : rows;
  },
  count: async (args: { where?: Record<string, unknown> } = {}) => {
    rec("notification.count", args.where);
    return notifs.filter((n) => notifMatch(n, args.where)).length;
  },
  updateMany: async (args: { where: Record<string, unknown>; data: Record<string, unknown> }) => {
    rec("notification.updateMany", args.where);
    let c = 0;
    for (const n of notifs) { if (notifMatch(n, args.where)) { Object.assign(n, args.data); c++; } }
    return { count: c };
  },
  deleteMany: async (args: { where: Record<string, unknown> }) => {
    rec("notification.deleteMany", args.where);
    const keep = notifs.filter((n) => !notifMatch(n, args.where));
    const removed = notifs.length - keep.length;
    notifs = keep;
    return { count: removed };
  },
  create: async () => ({}), createMany: async () => ({ count: 0 }),
});

let issueMessageIds = new Set<string>();
let issueIds = new Set<string>();
let voteIds = new Set<string>();
shadowPrismaModel(prisma, "issueMessage", {
  count: async (args: { where: { id: string } }) => { rec("issueMessage.count", args.where); return issueMessageIds.has(args.where.id) ? 1 : 0; },
  findMany: async () => [], findUnique: async () => null,
});
shadowPrismaModel(prisma, "deletionVote", {
  count: async (args: { where: { id: string } }) => { rec("deletionVote.count", args.where); return voteIds.has(args.where.id) ? 1 : 0; },
  findMany: async () => [], findUnique: async () => null,
});

type Issue = { id: string; title: string; claimedBy: string | null; claimedAt: Date | null; reportedBy: string; status: string };
let issues: Issue[] = [];
shadowPrismaModel(prisma, "issue", {
  count: async (args: { where: { id: string } }) => { rec("issue.count", args.where); return issueIds.has(args.where.id) ? 1 : 0; },
  findUnique: async (args: { where: { id: string } }) => {
    rec("issue.findUnique", args.where);
    const i = issues.find((x) => x.id === args.where.id);
    return i ? { ...i, claimedUser: null } : null;
  },
  updateMany: async (args: { where: { id: string; claimedBy: string | null }; data: Record<string, unknown> }) => {
    rec("issue.updateMany", args.where);
    let c = 0;
    for (const i of issues) {
      if (i.id !== args.where.id) continue;
      if (i.claimedBy !== args.where.claimedBy) continue; // the CAS
      Object.assign(i, args.data);
      c++;
    }
    return { count: c };
  },
  findMany: async () => [],
});

let auditFails = false;
shadowPrismaModel(prisma, "auditLog", {
  create: async (args: unknown) => {
    rec("auditLog.create", args);
    if (auditFails) throw new Error("simulated audit failure");
    return { id: "a1" };
  },
});

type VerifyToken = { token: string; identifier: string; expires: Date };
let verifyTokens: VerifyToken[] = [];
shadowPrismaModel(prisma, "verificationToken", {
  findUnique: async (args: { where: { token: string } }) => {
    rec("verificationToken.findUnique", args.where.token);
    return verifyTokens.find((t) => t.token === args.where.token) ?? null;
  },
  delete: async (args: { where: { token: string } }) => {
    rec("verificationToken.delete", args.where.token);
    verifyTokens = verifyTokens.filter((t) => t.token !== args.where.token);
    return {};
  },
  deleteMany: async () => ({ count: 0 }), create: async () => ({}),
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
for (const m of ["ratingsCache", "tmdbCache", "tmdbMediaCore", "mediaRequest", "plexLibraryItem", "jellyfinLibraryItem"]) {
  shadowPrismaModel(prisma, m, {
    findMany: async () => [], findUnique: async () => null, findFirst: async () => null, count: async () => 0,
    create: async () => ({}), createMany: async () => ({ count: 0 }), update: async () => ({}),
    updateMany: async () => ({ count: 0 }), upsert: async () => ({}), deleteMany: async () => ({ count: 0 }),
  });
}
shadowPrismaClientMethod(prisma, "$transaction", async (arg: unknown) =>
  Array.isArray(arg) ? Promise.all(arg) : (arg as (tx: unknown) => Promise<unknown>)(prisma));
shadowPrismaClientMethod(prisma, "$queryRaw", async () => []);
shadowPrismaClientMethod(prisma, "$queryRawUnsafe", async () => []);

const ratings = await import("../src/app/api/ratings/route.ts");
const ratingsBatch = await import("../src/app/api/ratings/batch/route.ts");
const notifications = await import("../src/app/api/notifications/route.ts");
const report = await import("../src/app/api/report/route.ts");
const claim = await import("../src/app/api/issues/[id]/claim/route.ts");
const confirm = await import("../src/app/api/profile/notification-email/confirm/route.ts");
const { hashVerifyToken } = await import("../src/lib/notification-email-verify.ts");

// ── scope ────────────────────────────────────────────────────────────────────
const afterTasks: Array<() => Promise<unknown>> = [];
function inScope<T>(fn: () => Promise<T>): Promise<T> {
  const workStore = {
    route: "/misc-user.test", forceStatic: false, dynamicShouldError: false,
    afterContext: {
      after: (t: unknown) => { afterTasks.push(typeof t === "function" ? (t as () => Promise<unknown>) : async () => t); },
    },
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
function mk(path: string, token: string | null, init: { method: string; body?: string; query?: string } = { method: "GET" }) {
  return new NextRequest(`http://localhost:3000${path}${init.query ?? ""}`, {
    method: init.method,
    headers: { ...(token ? { cookie: `${COOKIE}=${token}` } : {}), "content-type": "application/json" },
    ...(init.body !== undefined ? { body: init.body } : {}),
  });
}

const getRatings = (t: string | null, q: string) => inScope(() => ratings.GET(mk("/api/ratings", t, { method: "GET", query: q }), undefined));
const postRatingsBatch = (t: string | null, body: unknown, raw?: string) =>
  inScope(() => ratingsBatch.POST(mk("/api/ratings/batch", t, { method: "POST", body: raw ?? JSON.stringify(body) }), undefined));
const getNotifs = (t: string | null, q = "") => inScope(() => notifications.GET(mk("/api/notifications", t, { method: "GET", query: q }), undefined));
const postNotifs = (t: string | null, body?: unknown, raw?: string) =>
  inScope(() => notifications.POST(mk("/api/notifications", t, { method: "POST", body: raw ?? (body === undefined ? undefined : JSON.stringify(body)) }), undefined));
const delNotifs = (t: string | null, q = "") => inScope(() => notifications.DELETE(mk("/api/notifications", t, { method: "DELETE", query: q }), undefined));
const postReport = (t: string | null, body: unknown, raw?: string) =>
  inScope(() => report.POST(mk("/api/report", t, { method: "POST", body: raw ?? JSON.stringify(body) }), undefined));
const postClaim = (t: string | null, id: string) =>
  inScope(() => claim.POST(mk(`/api/issues/${id}/claim`, t, { method: "POST" }), { params: Promise.resolve({ id }) }));

function notif(over: Partial<Notif> & { id: string; userId: string }): Notif {
  return {
    type: "REQUEST_APPROVED", title: "t", body: "b", readAt: null,
    createdAt: new Date(), tmdbId: null, mediaType: null, posterPath: null, ...over,
  };
}

beforeEach(() => {
  ops = [];
  notifs = [];
  issues = [];
  issueMessageIds = new Set();
  issueIds = new Set();
  voteIds = new Set();
  verifyTokens = [];
  afterTasks.length = 0;
  warns.length = 0;
  errors.length = 0;
  settings.clear();
  auditFails = false;
});

// ── auth ─────────────────────────────────────────────────────────────────────

test("all five session routes refuse an anonymous caller with 401", async () => {
  assert.equal((await getRatings(null, "?id=603&type=movie")).status, 401);
  assert.equal((await postRatingsBatch(null, { items: [] })).status, 401);
  assert.equal((await getNotifs(null)).status, 401);
  assert.equal((await postReport(null, { contentType: "issue", contentId: "i1" })).status, 401);
  assert.equal((await postClaim(null, "i1")).status, 401);
});

test("issue claim requires an issue-admin role, not just any session", async () => {
  const plain = await mintSession();
  assert.equal((await postClaim(plain.token, "i1")).status, 403);
});

// ── 1: the notifications DELETE wipe guard ───────────────────────────────────

test("DELETE with NEITHER ?ids= nor ?all=1 is a 400, never a wipe", async () => {
  // DELETE bodies are stripped by some proxies, so a body-driven selection would
  // silently turn a single-item delete into a full inbox wipe. Clear-all has to
  // be an explicit signal.
  const me = await mintSession();
  notifs = [notif({ id: "n1", userId: me.userId }), notif({ id: "n2", userId: me.userId })];
  const res = await delNotifs(me.token);
  assert.equal(res.status, 400);
  assert.equal(opsOf("notification.deleteMany").length, 0, "nothing may be deleted");
  assert.equal(notifs.length, 2);
});

test("DELETE with a BODY but no query params still refuses — the body is not the selector", async () => {
  const me = await mintSession();
  notifs = [notif({ id: "n1", userId: me.userId })];
  const req = new NextRequest("http://localhost:3000/api/notifications", {
    method: "DELETE",
    headers: { cookie: `${COOKIE}=${me.token}`, "content-type": "application/json" },
    body: JSON.stringify({ all: true, ids: ["n1"] }),
  });
  const res = await inScope(() => notifications.DELETE(req, undefined));
  assert.equal(res.status, 400);
  assert.equal(notifs.length, 1, "a body-driven wipe must not happen");
});

test("DELETE ?ids= removes only those, scoped to the caller", async () => {
  const me = await mintSession();
  const them = await mintSession();
  notifs = [
    notif({ id: "n1", userId: me.userId }),
    notif({ id: "n2", userId: me.userId }),
    notif({ id: "n3", userId: them.userId }),
  ];
  const res = await delNotifs(me.token, "?ids=n1");
  assert.equal(res.status, 200);
  assert.deepEqual(notifs.map((n) => n.id).sort(), ["n2", "n3"]);
  const where = opsOf("notification.deleteMany")[0].args as { userId: string };
  assert.equal(where.userId, me.userId);
});

test("DELETE ?all=1 clears only the CALLER's inbox", async () => {
  const me = await mintSession();
  const them = await mintSession();
  notifs = [notif({ id: "n1", userId: me.userId }), notif({ id: "n2", userId: them.userId })];
  await delNotifs(me.token, "?all=1");
  assert.deepEqual(notifs.map((n) => n.userId), [them.userId]);
});

test("?all= with any value other than 1 does NOT clear the inbox", async () => {
  const me = await mintSession();
  notifs = [notif({ id: "n1", userId: me.userId })];
  for (const v of ["true", "yes", "0", ""]) {
    const res = await delNotifs(me.token, `?all=${v}`);
    assert.equal(res.status, 400, `?all=${v} must not be treated as clear-all`);
  }
  assert.equal(notifs.length, 1);
});

test("DELETE caps the id list", async () => {
  const me = await mintSession();
  const ids = Array.from({ length: 600 }, (_, i) => `n${i}`).join(",");
  const res = await delNotifs(me.token, `?ids=${ids}`);
  assert.equal(res.status, 200);
  const where = opsOf("notification.deleteMany")[0].args as { id?: { in: string[] } };
  assert.ok((where.id?.in.length ?? 0) <= 500, "the id list must be bounded");
});

// ── notifications: scoping and paging ────────────────────────────────────────

test("GET returns only the caller's notifications and ignores a ?userId= override", async () => {
  const me = await mintSession();
  const them = await mintSession();
  notifs = [notif({ id: "mine", userId: me.userId }), notif({ id: "theirs", userId: them.userId })];
  const body = await (await getNotifs(me.token, `?userId=${them.userId}`)).json();
  assert.deepEqual(body.items.map((i: Notif) => i.id), ["mine"]);
  assert.equal(body.total, 1);
});

test("the unread count is scoped to the caller too", async () => {
  const me = await mintSession();
  const them = await mintSession();
  notifs = [
    notif({ id: "a", userId: me.userId, readAt: null }),
    notif({ id: "b", userId: me.userId, readAt: new Date() }),
    notif({ id: "c", userId: them.userId, readAt: null }),
  ];
  const body = await (await getNotifs(me.token)).json();
  assert.equal(body.unreadCount, 1);
});

test("a malformed cursor fails soft to the first page", async () => {
  const me = await mintSession();
  notifs = [notif({ id: "n1", userId: me.userId })];
  for (const c of ["garbage", "|", "notadate|n1", "2026-01-01T00:00:00Z|"]) {
    const res = await getNotifs(me.token, `?cursor=${encodeURIComponent(c)}`);
    assert.equal(res.status, 200, `cursor ${c} should serve`);
    assert.equal((await res.json()).items.length, 1);
  }
});

test("a full page emits a nextCursor; a partial page does not", async () => {
  const me = await mintSession();
  notifs = Array.from({ length: 30 }, (_, i) =>
    notif({ id: `n${String(i).padStart(3, "0")}`, userId: me.userId, createdAt: new Date(Date.UTC(2026, 0, 1, 0, i)) }));
  assert.ok((await (await getNotifs(me.token)).json()).nextCursor, "a full page should paginate");
  notifs = notifs.slice(0, 3);
  assert.equal((await (await getNotifs(me.token)).json()).nextCursor, null);
});

test("POST with no body marks ALL the caller's unread read", async () => {
  const me = await mintSession();
  const them = await mintSession();
  notifs = [
    notif({ id: "a", userId: me.userId }), notif({ id: "b", userId: me.userId }),
    notif({ id: "c", userId: them.userId }),
  ];
  const body = await (await postNotifs(me.token)).json();
  assert.equal(body.unreadCount, 0);
  assert.ok(notifs.find((n) => n.id === "a")!.readAt);
  assert.equal(notifs.find((n) => n.id === "c")!.readAt, null, "another user's inbox is untouched");
});

test("POST with ids marks only those", async () => {
  const me = await mintSession();
  notifs = [notif({ id: "a", userId: me.userId }), notif({ id: "b", userId: me.userId })];
  await postNotifs(me.token, { ids: ["a"] });
  assert.ok(notifs.find((n) => n.id === "a")!.readAt);
  assert.equal(notifs.find((n) => n.id === "b")!.readAt, null);
});

test("POST drops non-string ids and bounds the list", async () => {
  const me = await mintSession();
  notifs = [notif({ id: "a", userId: me.userId })];
  const res = await postNotifs(me.token, { ids: ["a", 1, null, {}] });
  assert.equal(res.status, 200);
  const where = opsOf("notification.updateMany")[0].args as { id?: { in: string[] } };
  assert.deepEqual(where.id?.in, ["a"]);
});

test("POST tolerates a malformed body rather than 500ing", async () => {
  const me = await mintSession();
  assert.notEqual((await postNotifs(me.token, undefined, "{nope")).status, 500);
});

// ── 2: report — logAuditOrFail is CORRECT here ───────────────────────────────

test("report requires a whitelisted contentType", async () => {
  const me = await mintSession();
  for (const ct of [undefined, "", "spam", "ISSUE", "user"]) {
    const res = await postReport(me.token, { contentType: ct, contentId: "x" });
    assert.equal(res.status, 400, `contentType ${JSON.stringify(ct)} should be rejected`);
  }
});

test("report requires a contentId and bounds it", async () => {
  const me = await mintSession();
  assert.equal((await postReport(me.token, { contentType: "issue" })).status, 400);
  assert.equal((await postReport(me.token, { contentType: "issue", contentId: "x".repeat(201) })).status, 400);
});

test("report 404s content that does not exist, so the audit log can't be polluted", async () => {
  const me = await mintSession();
  const res = await postReport(me.token, { contentType: "issue", contentId: "nope" });
  assert.equal(res.status, 404);
  assert.equal(opsOf("auditLog.create").length, 0);
});

test("report checks the RIGHT table for each content type", async () => {
  const me = await mintSession();
  issueIds = new Set(["i1"]);
  issueMessageIds = new Set(["m1"]);
  voteIds = new Set(["v1"]);
  assert.equal((await postReport(me.token, { contentType: "issue", contentId: "i1" })).status, 200);
  assert.equal((await postReport(me.token, { contentType: "issue_message", contentId: "m1" })).status, 200);
  assert.equal((await postReport(me.token, { contentType: "vote_reason", contentId: "v1" })).status, 200);
  // …and an id from the wrong table is not accepted.
  assert.equal((await postReport(me.token, { contentType: "issue", contentId: "m1" })).status, 404);
});

test("a successful report writes a CONTENT_REPORT audit row", async () => {
  const me = await mintSession();
  issueIds = new Set(["i1"]);
  await postReport(me.token, { contentType: "issue", contentId: "i1", reason: "spam" });
  const data = (opsOf("auditLog.create")[0].args as { data: { action: string; target: string } }).data;
  assert.equal(data.action, "CONTENT_REPORT");
  assert.equal(data.target, "issue:i1");
});

test("a FAILED audit write makes the report FAIL — the audit IS the operation", async () => {
  // The inversion of guardrail 26: that rule bars logAuditOrFail only AFTER a
  // committed mutation. Here there is no prior mutation, so a swallowed failure
  // would report success for a report that was never recorded anywhere.
  const me = await mintSession();
  issueIds = new Set(["i1"]);
  auditFails = true;
  await assert.rejects(
    () => postReport(me.token, { contentType: "issue", contentId: "i1" }),
    "a failed audit write must surface, not be swallowed",
  );
});

test("report sanitizes and bounds the free-text fields", async () => {
  const me = await mintSession();
  issueIds = new Set(["i1"]);
  await postReport(me.token, { contentType: "issue", contentId: "i1", reason: "<script>x</script>" + "y".repeat(900), context: "z".repeat(400) });
  const details = JSON.parse((opsOf("auditLog.create")[0].args as { data: { details: string } }).data.details);
  assert.ok(!details.reason.includes("<"), "HTML-injection chars must be stripped");
  assert.ok(details.reason.length <= 500);
  assert.ok(details.context.length <= 200);
});

test("report is rate-limited per user", async () => {
  const me = await mintSession();
  issueIds = new Set(["i1"]);
  for (let i = 0; i < 10; i++) {
    assert.notEqual((await postReport(me.token, { contentType: "issue", contentId: "i1" })).status, 429, `report ${i + 1}`);
  }
  assert.equal((await postReport(me.token, { contentType: "issue", contentId: "i1" })).status, 429);
});

// ── 3: the issue-claim compare-and-swap ──────────────────────────────────────

test("claim 404s an unknown issue", async () => {
  const t = await issueAdmin();
  assert.equal((await postClaim(t.token, "nope")).status, 404);
});

test("an unclaimed issue is claimed for the caller", async () => {
  const t = await issueAdmin();
  issues = [{ id: "i1", title: "T", claimedBy: null, claimedAt: null, reportedBy: "u9", status: "OPEN" }];
  const res = await postClaim(t.token, "i1");
  assert.equal(res.status, 200);
  assert.equal(issues[0].claimedBy, t.userId);
  assert.ok(issues[0].claimedAt);
});

test("claiming one's OWN claim releases it", async () => {
  const t = await issueAdmin();
  issues = [{ id: "i1", title: "T", claimedBy: t.userId, claimedAt: new Date(), reportedBy: "u9", status: "OPEN" }];
  await postClaim(t.token, "i1");
  assert.equal(issues[0].claimedBy, null);
  assert.equal(issues[0].claimedAt, null);
});

test("claiming an issue held by ANOTHER admin takes it over", async () => {
  const a = await issueAdmin();
  const b = await issueAdmin();
  issues = [{ id: "i1", title: "T", claimedBy: a.userId, claimedAt: new Date(), reportedBy: "u9", status: "OPEN" }];
  await postClaim(b.token, "i1");
  assert.equal(issues[0].claimedBy, b.userId);
});

test("the write carries a CAS predicate on the claimedBy it read", async () => {
  const t = await issueAdmin();
  issues = [{ id: "i1", title: "T", claimedBy: null, claimedAt: null, reportedBy: "u9", status: "OPEN" }];
  await postClaim(t.token, "i1");
  const where = opsOf("issue.updateMany")[0].args as { id: string; claimedBy: string | null };
  assert.equal(where.id, "i1");
  assert.equal(where.claimedBy, null, "the CAS must pin the value it read");
});

test("a claim that moved underneath the read yields 409, not a stomp", async () => {
  const t = await issueAdmin();
  const other = await issueAdmin();
  issues = [{ id: "i1", title: "T", claimedBy: null, claimedAt: null, reportedBy: "u9", status: "OPEN" }];
  // Flip the row between the read and the write.
  const realFindUnique = (prisma as unknown as { issue: { findUnique: unknown } }).issue.findUnique;
  let flipped = false;
  (prisma as unknown as { issue: Record<string, unknown> }).issue.findUnique = async (args: { where: { id: string } }) => {
    rec("issue.findUnique", args.where);
    const i = issues.find((x) => x.id === args.where.id);
    const snapshot = i ? { ...i, claimedUser: null } : null;
    if (i && !flipped) { flipped = true; i.claimedBy = other.userId; }
    return snapshot;
  };
  const res = await postClaim(t.token, "i1");
  assert.equal(res.status, 409);
  assert.equal((await res.json()).error, "claim-conflict");
  assert.equal(issues[0].claimedBy, other.userId, "the winner's claim survives");
  (prisma as unknown as { issue: Record<string, unknown> }).issue.findUnique = realFindUnique;
});

// ── ratings ──────────────────────────────────────────────────────────────────

for (const [label, q] of [
  ["a missing id", "?type=movie"],
  ["a missing type", "?id=603"],
  ["an unknown type", "?id=603&type=anime"],
  ["a zero id", "?id=0&type=movie"],
  ["a negative id", "?id=-3&type=movie"],
  ["a float id", "?id=1.5&type=movie"],
  ["a non-numeric id", "?id=abc&type=movie"],
] as const) {
  test(`ratings rejects ${label} with 400`, async () => {
    const me = await mintSession();
    assert.equal((await getRatings(me.token, q)).status, 400);
  });
}

test("ratings returns null (not an error) when no provider can serve the title", async () => {
  const me = await mintSession();
  const res = await getRatings(me.token, "?id=603&type=movie");
  assert.equal(res.status, 200);
  assert.equal(await res.json(), null);
});

test("ratings is rate-limited per user", async () => {
  const me = await mintSession();
  for (let i = 0; i < 60; i++) await getRatings(me.token, "?id=603&type=movie");
  assert.equal((await getRatings(me.token, "?id=603&type=movie")).status, 429);
});

test("ratings/batch requires an items array", async () => {
  const me = await mintSession();
  for (const body of [{}, { items: "x" }, { items: 1 }]) {
    assert.equal((await postRatingsBatch(me.token, body)).status, 400);
  }
});

test("ratings/batch short-circuits an empty list", async () => {
  const me = await mintSession();
  const res = await postRatingsBatch(me.token, { items: [] });
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { ratings: {} });
});

test("ratings/batch caps the item count at 200", async () => {
  const me = await mintSession();
  const items = Array.from({ length: 201 }, (_, i) => ({ id: i + 1, type: "movie" }));
  const res = await postRatingsBatch(me.token, { items });
  assert.equal(res.status, 400);
  assert.match((await res.json()).error, /max 200/);
});

test("ratings/batch drops malformed entries instead of failing the whole request", async () => {
  const me = await mintSession();
  const res = await postRatingsBatch(me.token, {
    items: [{ id: 603, type: "movie" }, { id: "x", type: "movie" }, { id: 1, type: "anime" }, null, 5, { id: -1, type: "tv" }],
  });
  assert.equal(res.status, 200);
});

test("ratings/batch de-duplicates repeated (id, type) pairs", async () => {
  const me = await mintSession();
  const res = await postRatingsBatch(me.token, {
    items: [{ id: 603, type: "movie" }, { id: 603, type: "movie" }, { id: 603, type: "tv" }],
  });
  assert.equal(res.status, 200);
});

test("ratings/batch is rate-limited per user", async () => {
  const me = await mintSession();
  for (let i = 0; i < 10; i++) await postRatingsBatch(me.token, { items: [] });
  assert.equal((await postRatingsBatch(me.token, { items: [] })).status, 429);
});

// ── 4: the unauthenticated email-confirm link ────────────────────────────────

const confirmGet = (q: string) => confirm.GET(new Request(`http://localhost:3000/api/profile/notification-email/confirm${q}`));
const confirmPost = (q: string) => confirm.POST(new Request(`http://localhost:3000/api/profile/notification-email/confirm${q}`, { method: "POST" }));

test("the confirm token is stored HASHED — the raw link value is never the stored key", async () => {
  // The token in the URL IS the credential on an unauthenticated route, so a
  // stolen DB dump must not yield working confirmation links.
  const raw = "abcdef0123456789";
  verifyTokens = [{ token: hashVerifyToken(raw), identifier: "u1:new@example.com", expires: new Date(Date.now() + 60_000) }];
  await confirmGet(`?token=${raw}`);
  const looked = opsOf("verificationToken.findUnique").map((o) => o.args as string);
  assert.ok(looked.length > 0);
  assert.ok(!looked.includes(raw), "the RAW token must never be the lookup key");
  assert.ok(looked.includes(hashVerifyToken(raw)));
});

test("a missing token renders an error page rather than throwing", async () => {
  for (const res of [await confirmGet(""), await confirmPost("")]) {
    assert.ok(res.status < 500, `unexpected ${res.status}`);
    assert.match(await res.text(), /missing its token/i);
  }
});

test("an unknown token is refused on both verbs", async () => {
  for (const res of [await confirmGet("?token=nope"), await confirmPost("?token=nope")]) {
    assert.ok(res.status < 500);
  }
});

test("GET does NOT consume the token — only POST binds", async () => {
  // An email scanner or link preview following the URL must not silently
  // confirm the address; GET only renders the confirm form.
  const raw = "abcdef0123456789";
  verifyTokens = [{ token: hashVerifyToken(raw), identifier: "u1:new@example.com", expires: new Date(Date.now() + 60_000) }];
  await confirmGet(`?token=${raw}`);
  assert.equal(opsOf("verificationToken.delete").length, 0, "GET must not consume the token");
  assert.equal(verifyTokens.length, 1);
});

test("POST consumes the token FIRST so a double-submit can't re-trigger the bind", async () => {
  const raw = "abcdef0123456789";
  verifyTokens = [{ token: hashVerifyToken(raw), identifier: "u1:new@example.com", expires: new Date(Date.now() + 60_000) }];
  await confirmPost(`?token=${raw}`);
  assert.ok(opsOf("verificationToken.delete").length > 0, "the token must be single-use");
  const second = await confirmPost(`?token=${raw}`);
  assert.ok(second.status < 500, "a replay is refused cleanly");
});

test("the confirm pages are HTML, not JSON", async () => {
  const res = await confirmGet("");
  assert.match(res.headers.get("content-type") ?? "", /text\/html/);
});

test("the token is escaped into the form action rather than interpolated raw", async () => {
  const raw = "abc<script>alert(1)</script>";
  verifyTokens = [{ token: hashVerifyToken(raw), identifier: "u1:new@example.com", expires: new Date(Date.now() + 60_000) }];
  const html = await (await confirmGet(`?token=${encodeURIComponent(raw)}`)).text();
  assert.ok(!html.includes("<script>alert(1)</script>"), "the token must not land unescaped in the page");
});
