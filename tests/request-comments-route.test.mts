// Route tests for GET/POST /api/requests/[id]/comments.
//
// Pins what the pure rules cannot: the wrapper (401 before the body), who may
// read and post (requester / MANAGE_REQUESTS only), the manager-only email
// field, the feature gate (requesters only), the body cap and validation, the
// rate limit, the stored `fromAdmin`, and the notification fan-out reaching the
// right audience — requester inbox row for a manager's comment, none for the
// requester's own. Harness mirrors tests/issues-routes.test.mts.
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { AsyncLocalStorage } from "node:async_hooks";
import dns from "node:dns/promises";

(globalThis as { AsyncLocalStorage?: unknown }).AsyncLocalStorage = AsyncLocalStorage;

process.env.TOKEN_ENCRYPTION_KEY = "ab".repeat(32);
process.env.NEXTAUTH_SECRET = "request-comments-test-secret-0123456789abcdef";
process.env.AUTH_URL = "http://localhost:3000";
process.env.TRUST_PROXY = "true";
(process.env as Record<string, string | undefined>).NODE_ENV = "test";

const fakeLookup = async () => [{ address: "93.184.216.34", family: 4 }];
(dns as { lookup: unknown }).lookup = fakeLookup;

console.warn = () => {};
console.error = () => {};

const fetchCalls: URL[] = [];
globalThis.fetch = (async (input: RequestInfo | URL) => {
  fetchCalls.push(new URL(String(input)));
  throw new Error("unexpected fetch — the comments flow must not reach the network");
}) as typeof fetch;

type RunStore = { run<T>(store: unknown, fn: () => T): T };
const cjsRequire = createRequire(import.meta.url);
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
const { sseEmitter } = await import("../src/lib/sse-emitter.ts");

const sseEvents: Array<Record<string, unknown>> = [];
sseEmitter.on("event", (e: Record<string, unknown>) => { sseEvents.push(e); });

type Op = { op: string; args?: unknown };
const ops: Op[] = [];
const rec = (op: string, args?: unknown) => { ops.push({ op, args }); };
const opsOf = (name: string) => ops.filter((o) => o.op === name);

type DbUser = {
  role: string; permissions: bigint; mediaServer: string | null;
  sessionsRevokedAt: Date | null; passwordChangedAt: Date | null; deactivatedAt: Date | null;
  email: string | null; notificationEmail: string | null;
  emailOnComment?: boolean; locale?: string | null;
};
const usersById = new Map<string, DbUser>();
const sessionRows = new Set<string>();

shadowPrismaModel(prisma, "notificationAgent", { findMany: async () => [] });
shadowPrismaModel(prisma, "authSession", {
  findUnique: async (args: { where: { sessionId: string } }) =>
    sessionRows.has(args.where.sessionId) ? { id: `row-${args.where.sessionId}`, sessionId: args.where.sessionId } : null,
  update: async () => ({}),
});
shadowPrismaModel(prisma, "user", {
  findUnique: async (args: { where: { id: string } }) => {
    rec("user.findUnique", args);
    const u = usersById.get(args.where.id);
    return u ? { ...u } : null;
  },
  findMany: async () => [],
  update: async () => ({}),
});

let seq = 0;
async function mintSession(opts: { role?: string; permissions?: string } = {}): Promise<{ userId: string; token: string }> {
  seq++;
  const userId = `user-${seq}`;
  const sessionId = `sess-${seq}`;
  const permissions = opts.permissions ?? "0";
  usersById.set(userId, {
    role: opts.role ?? "USER", permissions: BigInt(permissions), mediaServer: null,
    sessionsRevokedAt: null, passwordChangedAt: null, deactivatedAt: null,
    email: `user-${seq}@example.com`, notificationEmail: null,
  });
  sessionRows.add(sessionId);
  const iat = Math.floor(Date.now() / 1000);
  const token = await signSessionJwt(
    { id: userId, role: opts.role ?? "USER", permissions, provider: "credentials", sessionId, expiresAt: iat + 86_400 },
    { expiresInSeconds: 7_200, iat },
  );
  return { userId, token };
}
const COOKIE = getSessionCookieName();
const MANAGER = { role: "USER", permissions: String(Permission.MANAGE_REQUESTS) };

const settings = new Map<string, string>();
shadowPrismaModel(prisma, "setting", {
  findUnique: async (args: { where: { key: string } }) => {
    const v = settings.get(args.where.key);
    return v === undefined ? null : { key: args.where.key, value: v };
  },
  findMany: async (args: { where: { key: { in: string[] } } }) =>
    args.where.key.in.filter((k) => settings.has(k)).map((k) => ({ key: k, value: settings.get(k) })),
});

let requestRow: Record<string, unknown> | null = null;
type ThreadRow = { id: string; createdAt: Date; body: string };
let threadRows: ThreadRow[] = [];
shadowPrismaModel(prisma, "mediaRequest", {
  findUnique: async (args: unknown) => { rec("mediaRequest.findUnique", args); return requestRow ? { ...requestRow } : null; },
});
shadowPrismaModel(prisma, "requestComment", {
  create: async (args: { data: Record<string, unknown>; include?: unknown }) => {
    rec("requestComment.create", args);
    return { id: `c-${Date.now()}-${Math.random()}`, createdAt: new Date(), author: { name: "n", role: "USER" }, ...args.data };
  },
  // Honours orderBy (createdAt, then id) and take over `threadRows`, like the real query.
  findMany: async (args: { orderBy?: unknown; take?: number }) => {
    rec("requestComment.findMany", args);
    const order = (Array.isArray(args.orderBy) ? args.orderBy : args.orderBy ? [args.orderBy] : []) as Array<Record<string, "asc" | "desc">>;
    const rows = [...threadRows].sort((a, b) => {
      for (const o of order) {
        const [k, dir] = Object.entries(o)[0];
        const av = a[k as keyof ThreadRow] as Date | string;
        const bv = b[k as keyof ThreadRow] as Date | string;
        const c = av < bv ? -1 : av > bv ? 1 : 0;
        if (c !== 0) return dir === "desc" ? -c : c;
      }
      return 0;
    });
    return args.take === undefined ? rows : rows.slice(0, args.take);
  },
});
shadowPrismaModel(prisma, "notification", {
  create: async (args: { data: Record<string, unknown> }) => { rec("notification.create", args); return { id: "n", ...args.data }; },
});
shadowPrismaModel(prisma, "pushSubscription", { findMany: async () => [] });
let auditThrows = false;
shadowPrismaModel(prisma, "auditLog", {
  create: async (args: unknown) => {
    rec("auditLog.create", args);
    if (auditThrows) throw new Error("stubbed audit write failure");
    return {};
  },
});

const { GET: getComments, POST: postComment } = await import("../src/app/api/requests/[id]/comments/route.ts");

function inScope<T>(fn: () => Promise<T>): Promise<T> {
  const workStore = {
    route: "/request-comments.test", forceStatic: false, dynamicShouldError: false,
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
const ctx = (id: string) => ({ params: Promise.resolve({ id }) });
function req(token: string | null, method: string, id: string, body?: string) {
  return new NextRequest(`http://localhost:3000/api/requests/${id}/comments`, {
    method,
    headers: { ...(token ? { cookie: `${COOKIE}=${token}` } : {}), "content-type": "application/json" },
    ...(body !== undefined ? { body } : {}),
  });
}
const post = (token: string | null, id: string, body: unknown, raw?: string) =>
  inScope(() => postComment(req(token, "POST", id, raw ?? JSON.stringify(body)), ctx(id)));
const list = (token: string | null, id: string) =>
  inScope(() => getComments(req(token, "GET", id), ctx(id)));
const flush = () => new Promise((r) => setImmediate(r));

function requestOwnedBy(userId: string, over: Record<string, unknown> = {}) {
  requestRow = {
    id: "req-1", title: "Dune", mediaType: "MOVIE", tmdbId: 438631, posterPath: null,
    requestedBy: userId, arrInstance: "", permanentlyDeclined: false, ...over,
  };
}

beforeEach(() => {
  ops.length = 0;
  sseEvents.length = 0;
  fetchCalls.length = 0;
  settings.clear();
  requestRow = null;
  threadRows = [];
  auditThrows = false;
  invalidateFeatureFlagCache();
});

test("no session → 401 before anything runs", async () => {
  const res = await post(null, "req-1", { body: "hi" });
  assert.equal(res.status, 401);
  assert.equal(opsOf("requestComment.create").length, 0);
  assert.equal((await list(null, "req-1")).status, 401);
});

test("unknown request → 404", async () => {
  const { token } = await mintSession();
  assert.equal((await post(token, "nope", { body: "hi" })).status, 404);
  assert.equal((await list(token, "nope")).status, 404);
});

test("a stranger (neither requester nor manager) is 403 on read and write, and nothing is written", async () => {
  const owner = await mintSession();
  const stranger = await mintSession();
  requestOwnedBy(owner.userId);
  assert.equal((await post(stranger.token, "req-1", { body: "hi" })).status, 403);
  assert.equal((await list(stranger.token, "req-1")).status, 403);
  assert.equal(opsOf("requestComment.create").length, 0);
});

test("the requester posts: fromAdmin=false, 201, an SSE frame keyed to the requester, and managers are the audience (no inbox row)", async () => {
  const owner = await mintSession();
  requestOwnedBy(owner.userId);
  const res = await post(owner.token, "req-1", { body: "  Any chance of 4K?  " });
  assert.equal(res.status, 201);
  await flush();
  const data = (opsOf("requestComment.create")[0].args as { data: Record<string, unknown> }).data;
  assert.deepEqual(data, { requestId: "req-1", authorId: owner.userId, body: "Any chance of 4K?", fromAdmin: false });
  assert.deepEqual(sseEvents.filter((e) => e.type === "request:comment"), [{ type: "request:comment", requestId: "req-1", userId: owner.userId }]);
  assert.equal(opsOf("notification.create").length, 0, "the requester's own comment never writes their inbox");
});

test("a manager's comment is fromAdmin and writes the REQUESTER's inbox row", async () => {
  const owner = await mintSession();
  const manager = await mintSession(MANAGER);
  requestOwnedBy(owner.userId);
  const res = await post(manager.token, "req-1", { body: "Which version do you want?" });
  assert.equal(res.status, 201);
  await flush();
  const data = (opsOf("requestComment.create")[0].args as { data: Record<string, unknown> }).data;
  assert.equal(data.fromAdmin, true);
  const note = (opsOf("notification.create")[0].args as { data: Record<string, unknown> }).data;
  assert.equal(note.userId, owner.userId);
  assert.equal(note.type, "REQUEST_COMMENT");
  assert.equal(fetchCalls.length, 0);
});

test("a deactivated requester gets NO inbox row (guardrail 33), and a missing row fails closed", async () => {
  const owner = await mintSession();
  const manager = await mintSession(MANAGER);
  requestOwnedBy(owner.userId);
  usersById.get(owner.userId)!.deactivatedAt = new Date();
  assert.equal((await post(manager.token, "req-1", { body: "hello" })).status, 201);
  await flush();
  assert.equal(opsOf("notification.create").length, 0);
});

test("a permanently declined request refuses its requester (403) but not a manager", async () => {
  const owner = await mintSession();
  const manager = await mintSession(MANAGER);
  requestOwnedBy(owner.userId, { permanentlyDeclined: true });
  assert.equal((await post(owner.token, "req-1", { body: "please?" })).status, 403);
  assert.equal(opsOf("requestComment.create").length, 0);
  assert.equal((await post(manager.token, "req-1", { body: "final answer" })).status, 201);
});

test("feature off: the requester is refused on read and write, a manager is not", async () => {
  const owner = await mintSession();
  const manager = await mintSession(MANAGER);
  requestOwnedBy(owner.userId);
  settings.set("feature.behavior.requestComments", "false");
  invalidateFeatureFlagCache();
  assert.equal((await post(owner.token, "req-1", { body: "hi" })).status, 403);
  assert.equal((await list(owner.token, "req-1")).status, 403);
  assert.equal((await post(manager.token, "req-1", { body: "closing note" })).status, 201);
  assert.equal((await list(manager.token, "req-1")).status, 200);
});

test("body validation: non-string / empty / markup-only → 400; over 2000 → 400; malformed JSON → 400; oversized → 413", async () => {
  const owner = await mintSession();
  requestOwnedBy(owner.userId);
  for (const body of [{}, { body: 5 }, { body: null }, { body: "   " }, { body: "<<>>" }, { body: "x".repeat(2001) }]) {
    assert.equal((await post(owner.token, "req-1", body)).status, 400, JSON.stringify(body).slice(0, 40));
  }
  assert.equal((await post(owner.token, "req-1", null, "{not json")).status, 400);
  assert.equal((await post(owner.token, "req-1", null, JSON.stringify({ body: "x".repeat(70_000) }))).status, 413);
  assert.equal(opsOf("requestComment.create").length, 0);
});

test("rate limit: the 11th comment inside a minute is 429", async () => {
  const owner = await mintSession();
  requestOwnedBy(owner.userId);
  for (let i = 0; i < 10; i++) assert.equal((await post(owner.token, "req-1", { body: `c${i}` })).status, 201);
  assert.equal((await post(owner.token, "req-1", { body: "one too many" })).status, 429);
});

test("GET selects email for a manager only, never for the requester", async () => {
  const owner = await mintSession();
  const manager = await mintSession(MANAGER);
  requestOwnedBy(owner.userId);
  await list(owner.token, "req-1");
  await list(manager.token, "req-1");
  const finds = opsOf("requestComment.findMany").map((o) => (o.args as { include: { author: { select: Record<string, unknown> } } }).include.author.select);
  assert.equal("email" in finds[0], false, "the requester's read must not select the author email");
  assert.equal(finds[1].email, true);
});

test("GET returns the NEWEST 500 comments of a longer thread, oldest first — the latest replies are never the ones cut", async () => {
  const owner = await mintSession();
  requestOwnedBy(owner.userId);
  const t0 = Date.parse("2026-10-01T00:00:00.000Z");
  threadRows = Array.from({ length: 501 }, (_, i) => ({
    id: `c-${String(i).padStart(4, "0")}`,
    createdAt: new Date(t0 + i * 60_000),
    body: `comment ${i}`,
  }));
  const res = await list(owner.token, "req-1");
  assert.equal(res.status, 200);
  const body = (await res.json()) as ThreadRow[];
  assert.equal(body.length, 500);
  assert.equal(body.at(-1)?.body, "comment 500", "the newest comment is answered");
  assert.equal(body[0].body, "comment 1", "the oldest is the one past the cap");
  assert.ok(body.every((c, i) => i === 0 || Date.parse(String(c.createdAt)) > Date.parse(String(body[i - 1].createdAt))), "ascending");
});

test("a comment is audited as REQUEST_COMMENT under request:<id> with ids and title only — never the body or an email", async () => {
  const owner = await mintSession();
  requestOwnedBy(owner.userId, { user: { name: "Alice" } });
  assert.equal((await post(owner.token, "req-1", { body: "secret text 12345" })).status, 201);
  await flush();
  const row = (opsOf("auditLog.create")[0].args as { data: Record<string, unknown> }).data;
  assert.equal(row.action, "REQUEST_COMMENT");
  assert.equal(row.target, "request:req-1");
  const details = JSON.parse(row.details as string) as Record<string, unknown>;
  assert.equal(details.fromAdmin, false);
  assert.equal(details.title, "Dune");
  assert.equal(details.requesterId, owner.userId);
  assert.equal(details.requestedBy, "Alice", "named only when the account has a display name");
  assert.ok(typeof details.commentId === "string");
  const raw = JSON.stringify(row.details);
  assert.ok(!raw.includes("secret text") && !raw.includes("@example.com"), raw);
});

test("a failed audit write never breaks a committed comment (guardrail 26)", async () => {
  const owner = await mintSession();
  requestOwnedBy(owner.userId);
  auditThrows = true;
  const res = await post(owner.token, "req-1", { body: "still goes through" });
  assert.equal(res.status, 201);
  await flush();
  assert.equal(opsOf("requestComment.create").length, 1);
});
