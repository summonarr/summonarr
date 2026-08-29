// Route-level unit tests for /api/admin/blacklist (GET / POST / DELETE) — the
// admin-managed request blacklist. A blacklisted (tmdbId, mediaType) pair is
// hidden from discovery and rejected at the request chokepoint, so this route
// is a privileged write surface over a security-relevant deny list.
//
// The pins that matter, each with its own shipped-bug class behind it:
//
//   1. ROLE (guardrail 6a). All three verbs are withAdmin. A plain USER — and
//      notably an ISSUE_ADMIN, who holds a real admin-ish role but not the
//      ADMIN bit — must be refused 403, and refused BEFORE any write. Anonymous
//      is 401, not 403: the wrapper's contract is 401 for missing/expired,
//      403 only for wrong role.
//   2. VALIDATION runs before the upsert. tmdbId must be a real positive
//      integer (a JSON body's declared type is a compile-time claim only — a
//      client sending a string or a float reaches the DB otherwise), mediaType
//      is whitelisted to the two enum literals, and the free-text fields are
//      length-bounded.
//   3. BODY CAP (guardrail 30). The route reads through readJsonCapped, so an
//      oversized body is rejected rather than parsed.
//   4. AUDIT IS POST-COMMIT AND SWALLOWING (guardrail 26). The upsert/delete has
//      already committed with no enclosing transaction, so a failing audit write
//      must NOT turn a successful destructive op into a 500 — logAuditOrFail
//      here would 500 on a completed delete and leave the caller retrying
//      against a row that's already gone.
//   5. CACHE INVALIDATION. The blacklist is cached in-process; a write that
//      doesn't invalidate leaves discovery serving the pre-write deny list for
//      the cache's lifetime.
//   6. DELETE takes QUERY PARAMS, not a body — DELETE bodies are stripped by
//      some proxies — and reports the removed count without 404ing a no-op.
//
// Harness: the tests/votes-route.test.mts idiom — the real withAdmin-wrapped
// handlers invoked with a NextRequest carrying a genuine signed session JWT,
// inside a synthetic workAsyncStorage + workUnitAsyncStorage scope, over
// in-memory prisma stubs. No DB, no network.
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { AsyncLocalStorage } from "node:async_hooks";

(globalThis as { AsyncLocalStorage?: unknown }).AsyncLocalStorage = AsyncLocalStorage;

process.env.TOKEN_ENCRYPTION_KEY = "ab".repeat(32);
process.env.NEXTAUTH_SECRET = "blacklist-route-test-secret-0123456789abc";
process.env.AUTH_URL = "http://localhost:3000";
process.env.TRUST_PROXY = "true";
(process.env as Record<string, string | undefined>).NODE_ENV = "test";

globalThis.fetch = (() => {
  throw new Error("unexpected network call from blacklist route tests");
}) as unknown as typeof fetch;

console.warn = () => {};
console.error = () => {};

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

// ── op log ───────────────────────────────────────────────────────────────────
type Op = { op: string; args?: unknown };
let ops: Op[] = [];
const rec = (op: string, args?: unknown) => { ops.push({ op, args }); };
const opsOf = (name: string) => ops.filter((o) => o.op === name);

// ── auth fixture ─────────────────────────────────────────────────────────────
type DbUser = {
  role: string;
  permissions: bigint;
  mediaServer: string | null;
  sessionsRevokedAt: Date | null;
  passwordChangedAt: Date | null;
  deactivatedAt: Date | null;
  email: string | null;
  notificationEmail: string | null;
};
const usersById = new Map<string, DbUser>();
const sessionRows = new Set<string>();

shadowPrismaModel(prisma, "authSession", {
  findUnique: async (args: { where: { sessionId: string } }) =>
    sessionRows.has(args.where.sessionId)
      ? { id: `row-${args.where.sessionId}`, sessionId: args.where.sessionId }
      : null,
  update: async () => ({}),
});
shadowPrismaModel(prisma, "user", {
  findUnique: async (args: { where: { id: string } }) => {
    const u = usersById.get(args.where.id);
    return u ? { ...u } : null;
  },
  update: async () => ({}),
});

let seq = 0;
async function mintSession(opts: { role?: string; permissions?: bigint } = {}): Promise<string> {
  seq++;
  const userId = `admin-${seq}`;
  const sessionId = `sess-${seq}`;
  const role = opts.role ?? "ADMIN";
  const permissions = (opts.permissions ?? Permission.ADMIN).toString();
  usersById.set(userId, {
    role,
    permissions: BigInt(permissions),
    mediaServer: null,
    sessionsRevokedAt: null,
    passwordChangedAt: null,
    deactivatedAt: null,
    email: `admin-${seq}@example.com`,
    notificationEmail: null,
  });
  sessionRows.add(sessionId);
  const iat = Math.floor(Date.now() / 1000);
  return signSessionJwt(
    { id: userId, role, permissions, provider: "credentials", sessionId, expiresAt: iat + 86_400 },
    { expiresInSeconds: 7_200, iat },
  );
}

const COOKIE = getSessionCookieName();

// ── business-model stubs ─────────────────────────────────────────────────────
type BlItem = { id: string; tmdbId: number; mediaType: string; title: string | null; reason: string | null; addedBy: string; createdAt: Date };
let items: BlItem[] = [];

shadowPrismaModel(prisma, "blacklistItem", {
  findMany: async (args: { orderBy?: unknown; take?: number }) => {
    rec("blacklistItem.findMany", args);
    const sorted = [...items].sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());
    return args.take != null ? sorted.slice(0, args.take) : sorted;
  },
  upsert: async (args: Record<string, unknown>) => {
    rec("blacklistItem.upsert", args);
    const where = (args.where as { tmdbId_mediaType: { tmdbId: number; mediaType: string } }).tmdbId_mediaType;
    const existing = items.find((i) => i.tmdbId === where.tmdbId && i.mediaType === where.mediaType);
    if (existing) {
      Object.assign(existing, args.update as Partial<BlItem>);
      return existing;
    }
    const created = { id: `bl-${items.length + 1}`, createdAt: new Date(), ...(args.create as object) } as BlItem;
    items.push(created);
    return created;
  },
  deleteMany: async (args: { where: { tmdbId: number; mediaType: string } }) => {
    rec("blacklistItem.deleteMany", args);
    const before = items.length;
    items = items.filter((i) => !(i.tmdbId === args.where.tmdbId && i.mediaType === args.where.mediaType));
    return { count: before - items.length };
  },
});

// The audit write. `auditFails` flips it to a rejecting stub so the guardrail-26
// "a failed audit must never break the triggering request" pin is behavioural.
let auditFails = false;
shadowPrismaModel(prisma, "auditLog", {
  create: async (args: unknown) => {
    rec("auditLog.create", args);
    if (auditFails) throw new Error("simulated audit write failure");
    return { id: "audit-1" };
  },
});
shadowPrismaModel(prisma, "setting", {
  findUnique: async () => null,
  findMany: async () => [],
});

const { GET, POST, DELETE } = await import("../src/app/api/admin/blacklist/route.ts");

// ── synthetic request scope ──────────────────────────────────────────────────
const afterTasks: Array<() => Promise<unknown>> = [];
function inScope<T>(fn: () => Promise<T>): Promise<T> {
  const workStore = {
    route: "/blacklist.test",
    forceStatic: false,
    dynamicShouldError: false,
    afterContext: {
      after: (task: unknown) => {
        afterTasks.push(typeof task === "function" ? (task as () => Promise<unknown>) : async () => task);
      },
    },
  };
  const reqHeaders = new Headers();
  const requestStore = {
    type: "request",
    phase: "render",
    headers: HeadersAdapter.seal(reqHeaders),
    cookies: RequestCookiesAdapter.seal(new RequestCookies(reqHeaders)),
    usedDynamic: false,
  };
  return workAsyncStorage.run(workStore, () => workUnitAsyncStorage.run(requestStore, fn));
}

function req(token: string | null, init: { method: string; body?: string; query?: string }) {
  return new NextRequest(`http://localhost:3000/api/admin/blacklist${init.query ?? ""}`, {
    method: init.method,
    headers: {
      ...(token ? { cookie: `${COOKIE}=${token}` } : {}),
      "content-type": "application/json",
    },
    ...(init.body !== undefined ? { body: init.body } : {}),
  });
}

const list = (token: string | null) => inScope(() => GET(req(token, { method: "GET" }), undefined));
const add = (token: string | null, body: unknown, raw?: string) =>
  inScope(() => POST(req(token, { method: "POST", body: raw ?? JSON.stringify(body) }), undefined));
const remove = (token: string | null, query: string) =>
  inScope(() => DELETE(req(token, { method: "DELETE", query }), undefined));

// Drain the after()-enqueued audit tasks the way the runtime would, so a
// swallowed rejection surfaces here as "no throw" rather than being invisible.
async function drainAfter(): Promise<void> {
  const tasks = [...afterTasks];
  afterTasks.length = 0;
  for (const t of tasks) await t();
}

beforeEach(() => {
  ops = [];
  items = [];
  afterTasks.length = 0;
  auditFails = false;
});

// ── role gating (guardrail 6a) ───────────────────────────────────────────────

test("anonymous GET is 401, not 403", async () => {
  assert.equal((await list(null)).status, 401);
});

test("anonymous POST is 401 and writes nothing", async () => {
  const res = await add(null, { tmdbId: 1, mediaType: "MOVIE" });
  assert.equal(res.status, 401);
  assert.equal(opsOf("blacklistItem.upsert").length, 0);
});

test("anonymous DELETE is 401 and deletes nothing", async () => {
  const res = await remove(null, "?tmdbId=1&mediaType=MOVIE");
  assert.equal(res.status, 401);
  assert.equal(opsOf("blacklistItem.deleteMany").length, 0);
});

for (const verb of ["GET", "POST", "DELETE"] as const) {
  test(`a plain USER is refused 403 on ${verb} and reaches no query`, async () => {
    const token = await mintSession({ role: "USER", permissions: 0n });
    const res =
      verb === "GET" ? await list(token)
      : verb === "POST" ? await add(token, { tmdbId: 1, mediaType: "MOVIE" })
      : await remove(token, "?tmdbId=1&mediaType=MOVIE");
    assert.equal(res.status, 403);
    assert.equal(opsOf("blacklistItem.upsert").length, 0);
    assert.equal(opsOf("blacklistItem.deleteMany").length, 0);
    assert.equal(opsOf("blacklistItem.findMany").length, 0);
  });
}

test("an ISSUE_ADMIN is refused — this is withAdmin, not withIssueAdmin", async () => {
  const token = await mintSession({ role: "ISSUE_ADMIN", permissions: Permission.MANAGE_ISSUES });
  assert.equal((await list(token)).status, 403);
  assert.equal((await add(token, { tmdbId: 1, mediaType: "MOVIE" })).status, 403);
  assert.equal((await remove(token, "?tmdbId=1&mediaType=MOVIE")).status, 403);
});

test("an ADMIN passes all three verbs", async () => {
  const token = await mintSession();
  assert.equal((await list(token)).status, 200);
  assert.equal((await add(token, { tmdbId: 603, mediaType: "MOVIE" })).status, 201);
  assert.equal((await remove(token, "?tmdbId=603&mediaType=MOVIE")).status, 200);
});

// ── GET ──────────────────────────────────────────────────────────────────────

test("GET returns the list newest-first", async () => {
  items = [
    { id: "a", tmdbId: 1, mediaType: "MOVIE", title: "Old", reason: null, addedBy: "x", createdAt: new Date("2026-01-01") },
    { id: "b", tmdbId: 2, mediaType: "MOVIE", title: "New", reason: null, addedBy: "x", createdAt: new Date("2026-06-01") },
  ];
  const body = await (await list(await mintSession())).json();
  assert.deepEqual(body.items.map((i: BlItem) => i.title), ["New", "Old"]);
});

test("GET caps the page at 1000 rows", async () => {
  await list(await mintSession());
  assert.equal((opsOf("blacklistItem.findMany")[0].args as { take: number }).take, 1000);
});

test("GET on an empty blacklist returns an empty array, not null", async () => {
  const body = await (await list(await mintSession())).json();
  assert.deepEqual(body, { items: [] });
});

// ── POST validation ──────────────────────────────────────────────────────────

for (const [label, body] of [
  ["a missing tmdbId", { mediaType: "MOVIE" }],
  ["a string tmdbId", { tmdbId: "603", mediaType: "MOVIE" }],
  ["a float tmdbId", { tmdbId: 60.3, mediaType: "MOVIE" }],
  ["a zero tmdbId", { tmdbId: 0, mediaType: "MOVIE" }],
  ["a negative tmdbId", { tmdbId: -1, mediaType: "MOVIE" }],
  ["a null tmdbId", { tmdbId: null, mediaType: "MOVIE" }],
] as const) {
  test(`POST with ${label} is 400 and never upserts`, async () => {
    const res = await add(await mintSession(), body);
    assert.equal(res.status, 400);
    assert.equal((await res.json()).error, "tmdbId must be a positive integer");
    assert.equal(opsOf("blacklistItem.upsert").length, 0);
  });
}

for (const [label, mediaType] of [
  ["a missing mediaType", undefined],
  ["a lowercase mediaType", "movie"],
  ["an unknown mediaType", "ANIME"],
  ["a numeric mediaType", 1],
  ["a null mediaType", null],
] as const) {
  test(`POST with ${label} is 400 and never upserts`, async () => {
    const res = await add(await mintSession(), { tmdbId: 603, mediaType });
    assert.equal(res.status, 400);
    assert.equal((await res.json()).error, "mediaType must be MOVIE or TV");
    assert.equal(opsOf("blacklistItem.upsert").length, 0);
  });
}

test("POST accepts TV as well as MOVIE", async () => {
  assert.equal((await add(await mintSession(), { tmdbId: 1399, mediaType: "TV" })).status, 201);
});

test("POST rejects an over-long title without writing", async () => {
  const res = await add(await mintSession(), { tmdbId: 603, mediaType: "MOVIE", title: "x".repeat(501) });
  assert.equal(res.status, 400);
  assert.equal(opsOf("blacklistItem.upsert").length, 0);
});

test("POST rejects an over-long reason without writing", async () => {
  const res = await add(await mintSession(), { tmdbId: 603, mediaType: "MOVIE", reason: "y".repeat(501) });
  assert.equal(res.status, 400);
  assert.equal(opsOf("blacklistItem.upsert").length, 0);
});

test("POST accepts title and reason at exactly the 500-char boundary", async () => {
  const res = await add(await mintSession(), {
    tmdbId: 603, mediaType: "MOVIE", title: "x".repeat(500), reason: "y".repeat(500),
  });
  assert.equal(res.status, 201);
});

test("POST rejects a non-string title with a 400 rather than throwing a 500", async () => {
  // The type in the body signature is a compile-time claim only; a client
  // sending a number previously reached .replace and 500'd.
  const res = await add(await mintSession(), { tmdbId: 603, mediaType: "MOVIE", title: 123 });
  assert.equal(res.status, 400);
});

test("POST with a malformed JSON body is a 400, not a 500", async () => {
  const res = await add(await mintSession(), undefined, "{not json");
  assert.equal(res.status, 400);
  assert.equal(opsOf("blacklistItem.upsert").length, 0);
});

test("POST with an oversized body is rejected by the guardrail-30 cap", async () => {
  // The padding sits in a key the route never validates, and every other field
  // is a valid create — so readJsonCapped is the ONLY thing that can reject
  // this. Padding `reason` instead would be caught by its own length rule, and
  // the pin would then survive the cap being raised or dropped.
  const huge = JSON.stringify({ tmdbId: 603, mediaType: "MOVIE", note: "z".repeat(20_000) });
  const res = await add(await mintSession(), undefined, huge);
  assert.equal(res.status, 413, `expected a cap rejection, got ${res.status}`);
  assert.equal(opsOf("blacklistItem.upsert").length, 0);
});

// ── POST behaviour ───────────────────────────────────────────────────────────

test("POST creates the row keyed on the (tmdbId, mediaType) compound", async () => {
  await add(await mintSession(), { tmdbId: 603, mediaType: "MOVIE", title: "The Matrix" });
  const args = opsOf("blacklistItem.upsert")[0].args as { where: { tmdbId_mediaType: unknown } };
  assert.deepEqual(args.where.tmdbId_mediaType, { tmdbId: 603, mediaType: "MOVIE" });
});

test("POST stamps the acting admin as addedBy on both create and update", async () => {
  await add(await mintSession(), { tmdbId: 603, mediaType: "MOVIE" });
  const args = opsOf("blacklistItem.upsert")[0].args as {
    create: { addedBy: string };
    update: { addedBy: string };
  };
  assert.ok(args.create.addedBy.startsWith("admin-"));
  assert.equal(args.update.addedBy, args.create.addedBy);
});

test("a repeat POST for the same pair updates rather than duplicating", async () => {
  const token = await mintSession();
  await add(token, { tmdbId: 603, mediaType: "MOVIE", title: "First" });
  await add(token, { tmdbId: 603, mediaType: "MOVIE", title: "Second" });
  assert.equal(items.length, 1);
  assert.equal(items[0].title, "Second");
});

test("the same tmdbId under MOVIE and TV are independent entries", async () => {
  const token = await mintSession();
  await add(token, { tmdbId: 88, mediaType: "MOVIE" });
  await add(token, { tmdbId: 88, mediaType: "TV" });
  assert.equal(items.length, 2);
});

test("an omitted title/reason is stored as null, not undefined", async () => {
  await add(await mintSession(), { tmdbId: 603, mediaType: "MOVIE" });
  const args = opsOf("blacklistItem.upsert")[0].args as { create: { title: unknown; reason: unknown } };
  assert.equal(args.create.title, null);
  assert.equal(args.create.reason, null);
});

test("title and reason are sanitized: HTML-injection chars and control chars are stripped", async () => {
  await add(await mintSession(), {
    tmdbId: 603,
    mediaType: "MOVIE",
    title: "<script>alert(1)</script>Matrix\u0007",
    reason: "why\u0000not\u202Eevil",
  });
  const args = opsOf("blacklistItem.upsert")[0].args as { create: { title: string; reason: string } };
  for (const ch of ["<", ">", "\u0000", "\u0007", "\u202E"]) {
    assert.ok(!args.create.title.includes(ch) && !args.create.reason.includes(ch), `${JSON.stringify(ch)} survived sanitization`);
  }
  assert.ok(args.create.title.includes("Matrix"), "the legible text must survive");
});

test("newlines inside a reason are deliberately preserved — sanitizeText strips control chars, not line breaks", async () => {
  // Pinned so a future "tighten the sanitizer" change is a conscious decision:
  // a multi-line reason is legitimate here, and the log-injection defence lives
  // on the audit record's own sanitizeText pass over target/userName.
  await add(await mintSession(), { tmdbId: 603, mediaType: "MOVIE", reason: "line one\nline two" });
  const args = opsOf("blacklistItem.upsert")[0].args as { create: { reason: string } };
  assert.equal(args.create.reason, "line one\nline two");
});

test("surrounding whitespace is trimmed from title and reason", async () => {
  await add(await mintSession(), { tmdbId: 603, mediaType: "MOVIE", title: "  Matrix  ", reason: "\treason\t" });
  const args = opsOf("blacklistItem.upsert")[0].args as { create: { title: string; reason: string } };
  assert.equal(args.create.title, "Matrix");
  assert.equal(args.create.reason, "reason");
});

test("a whitespace-only title collapses to null rather than an empty string", async () => {
  await add(await mintSession(), { tmdbId: 603, mediaType: "MOVIE", title: "   " });
  const args = opsOf("blacklistItem.upsert")[0].args as { create: { title: unknown } };
  assert.equal(args.create.title, null);
});

test("POST returns 201 with the stored item", async () => {
  const res = await add(await mintSession(), { tmdbId: 603, mediaType: "MOVIE", title: "The Matrix" });
  assert.equal(res.status, 201);
  const body = await res.json();
  assert.equal(body.item.tmdbId, 603);
  assert.equal(body.item.title, "The Matrix");
});

// ── DELETE ───────────────────────────────────────────────────────────────────

for (const [label, query] of [
  ["a missing tmdbId", "?mediaType=MOVIE"],
  ["a missing mediaType", "?tmdbId=603"],
  ["a non-numeric tmdbId", "?tmdbId=abc&mediaType=MOVIE"],
  ["a zero tmdbId", "?tmdbId=0&mediaType=MOVIE"],
  ["a negative tmdbId", "?tmdbId=-3&mediaType=MOVIE"],
  ["an unknown mediaType", "?tmdbId=603&mediaType=ANIME"],
  ["a lowercase mediaType", "?tmdbId=603&mediaType=movie"],
] as const) {
  test(`DELETE with ${label} is 400 and deletes nothing`, async () => {
    const res = await remove(await mintSession(), query);
    assert.equal(res.status, 400);
    assert.equal(opsOf("blacklistItem.deleteMany").length, 0);
  });
}

test("DELETE removes the matching pair and reports the count", async () => {
  items = [{ id: "a", tmdbId: 603, mediaType: "MOVIE", title: null, reason: null, addedBy: "x", createdAt: new Date() }];
  const res = await remove(await mintSession(), "?tmdbId=603&mediaType=MOVIE");
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { ok: true, removed: 1 });
  assert.equal(items.length, 0);
});

test("DELETE of an absent pair is a 200 no-op, not a 404", async () => {
  const res = await remove(await mintSession(), "?tmdbId=999&mediaType=TV");
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { ok: true, removed: 0 });
});

test("DELETE is mediaType-scoped — removing the MOVIE leaves the TV entry", async () => {
  items = [
    { id: "a", tmdbId: 88, mediaType: "MOVIE", title: null, reason: null, addedBy: "x", createdAt: new Date() },
    { id: "b", tmdbId: 88, mediaType: "TV", title: null, reason: null, addedBy: "x", createdAt: new Date() },
  ];
  await remove(await mintSession(), "?tmdbId=88&mediaType=MOVIE");
  assert.deepEqual(items.map((i) => i.mediaType), ["TV"]);
});

test("DELETE reads its arguments from the query string, never a body", async () => {
  // DELETE bodies are stripped by some proxies, so a body-carried id must not
  // be what the route acts on.
  items = [{ id: "a", tmdbId: 603, mediaType: "MOVIE", title: null, reason: null, addedBy: "x", createdAt: new Date() }];
  const r = new NextRequest("http://localhost:3000/api/admin/blacklist?tmdbId=603&mediaType=MOVIE", {
    method: "DELETE",
    headers: { cookie: `${COOKIE}=${await mintSession()}`, "content-type": "application/json" },
    body: JSON.stringify({ tmdbId: 999, mediaType: "TV" }),
  });
  const res = await inScope(() => DELETE(r, undefined));
  assert.equal(res.status, 200);
  assert.equal((opsOf("blacklistItem.deleteMany")[0].args as { where: { tmdbId: number } }).where.tmdbId, 603);
});

// ── audit (guardrail 26) ─────────────────────────────────────────────────────

test("a successful POST audits with the add op and the pair as target", async () => {
  await add(await mintSession(), { tmdbId: 603, mediaType: "MOVIE", title: "The Matrix" });
  await drainAfter();
  const audits = opsOf("auditLog.create");
  assert.equal(audits.length, 1);
  const data = (audits[0].args as { data: { action: string; target: string; details: string } }).data;
  assert.equal(data.action, "BLACKLIST_CHANGE");
  assert.equal(data.target, "blacklist:MOVIE:603");
  // `details` is serialized to a JSON string by logAudit, not stored as an object.
  assert.equal(typeof data.details, "string");
  assert.equal(JSON.parse(data.details).op, "add");
  assert.equal(JSON.parse(data.details).title, "The Matrix");
});

test("a successful DELETE audits with the remove op", async () => {
  items = [{ id: "a", tmdbId: 603, mediaType: "MOVIE", title: null, reason: null, addedBy: "x", createdAt: new Date() }];
  await remove(await mintSession(), "?tmdbId=603&mediaType=MOVIE");
  await drainAfter();
  const data = (opsOf("auditLog.create")[0].args as { data: { details: string } }).data;
  assert.equal(JSON.parse(data.details).op, "remove");
});

test("a no-op DELETE writes no audit row — nothing changed", async () => {
  await remove(await mintSession(), "?tmdbId=999&mediaType=MOVIE");
  await drainAfter();
  assert.equal(opsOf("auditLog.create").length, 0);
});

test("a failing audit write does NOT turn a successful POST into a 500", async () => {
  auditFails = true;
  const res = await add(await mintSession(), { tmdbId: 603, mediaType: "MOVIE" });
  assert.equal(res.status, 201);
  assert.equal(items.length, 1, "the upsert still committed");
  await drainAfter(); // must not reject — logAudit swallows
});

test("a failing audit write does NOT turn a successful DELETE into a 500", async () => {
  // The sharp edge of guardrail 26: a 500 here has the caller retry a delete
  // whose row is already gone, so the retry 404s with no audit trail either way.
  auditFails = true;
  items = [{ id: "a", tmdbId: 603, mediaType: "MOVIE", title: null, reason: null, addedBy: "x", createdAt: new Date() }];
  const res = await remove(await mintSession(), "?tmdbId=603&mediaType=MOVIE");
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { ok: true, removed: 1 });
  assert.equal(items.length, 0, "the delete still committed");
  await drainAfter();
});

test("a rejected POST writes no audit row", async () => {
  await add(await mintSession(), { tmdbId: -1, mediaType: "MOVIE" });
  await drainAfter();
  assert.equal(opsOf("auditLog.create").length, 0);
});

test("a 403 writes no audit row", async () => {
  const token = await mintSession({ role: "USER", permissions: 0n });
  await add(token, { tmdbId: 603, mediaType: "MOVIE" });
  await drainAfter();
  assert.equal(opsOf("auditLog.create").length, 0);
});

// ── cache invalidation ───────────────────────────────────────────────────────

test("a POST makes the new entry visible to the blacklist cache immediately", async () => {
  // invalidateBlacklistCache() runs on write; without it discovery would keep
  // serving the pre-write deny list for the cache's lifetime.
  const { getBlacklistSet, blacklistKey } = await import("../src/lib/blacklist.ts");
  shadowPrismaModel(prisma, "blacklistItem", {
    findMany: async (args: { select?: unknown; take?: number }) => {
      rec("blacklistItem.findMany", args);
      return items.map((i) => ({ ...i }));
    },
    upsert: async (args: Record<string, unknown>) => {
      rec("blacklistItem.upsert", args);
      const created = { id: "bl-1", createdAt: new Date(), ...(args.create as object) } as BlItem;
      items.push(created);
      return created;
    },
    deleteMany: async () => ({ count: 0 }),
  });

  await getBlacklistSet(); // prime the cache while empty
  assert.equal((await getBlacklistSet()).size, 0);

  await add(await mintSession(), { tmdbId: 603, mediaType: "MOVIE" });
  const set = await getBlacklistSet();
  assert.ok(set.has(blacklistKey(603, "movie")), "the write must invalidate the cached deny list");
});
