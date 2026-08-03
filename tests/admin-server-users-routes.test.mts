// Route-level unit tests for the three uncovered admin server-user routes:
//   GET/PATCH /api/admin/server-users
//   POST      /api/admin/server-users/bulk
//   GET       /api/admin/server-users/diagnose
//
// (The per-row PATCH /api/admin/server-users/[id] is already covered by
// tests/admin-routes.test.mts; these are the list, bulk and diagnostic surfaces
// around it.)
//
// MediaServerUser is the table guardrails 28 and 34 are both about — it owns the
// binding that makes play history belong to somebody, and its rows FK PlayHistory
// with onDelete: Restrict precisely because a hard delete once cascaded away
// users' entire watch history. So the pins here are:
//
//   1. NOTHING ON THESE ROUTES DELETES A MediaServerUser. The bulk route touches
//      every non-admin Jellyfin row in one shot, which makes it the most
//      plausible place for a "clean up departed users" delete to be added later.
//      The test asserts no delete/deleteMany reaches the model at all.
//   2. THE ACTIVE/HISTORY SPLIT (guardrail 28). GET is an ACTIVE-management
//      surface, so it filters active:true and hides soft-deleted departed users;
//      the bulk push and the diagnose count do the same, because there is no
//      server-side account left to push a policy to. This is deliberately the
//      opposite of the history/stats surfaces, which stay unfiltered.
//   3. THE BULK SNAPSHOT RACE. The route reads its target ids FIRST and drives
//      the updateMany off those exact ids. Re-running the `where` for the push
//      list would pick up rows the concurrent Jellyfin sync inserted after the
//      update — those users get the policy pushed to Jellyfin while their
//      Summonarr row keeps the old value, and nothing reconciles it (policy is
//      only pushed on an explicit admin action). The test drives exactly that
//      interleaving: a new row appears between the two reads.
//   4. RUNTIME TYPE CHECKS. A JSON body's declared type is a compile-time claim;
//      a non-boolean downloadsEnabled would otherwise reach Prisma's Boolean?
//      column and the Jellyfin push as a 500.
//   5. PLEX IS REFUSED on the bulk route — its sharing API has no working remote
//      toggle, so accepting source:"plex" would silently do nothing while
//      reporting success.
//   6. PARTIAL-FAILURE ISOLATION. One failed Jellyfin push must not abort the
//      rest or fail the request; the counts report what happened.
//   7. manualUserLink and serverInstance are PROJECTED by the list — the admin UI
//      needs to see which bindings are pinned and which server a row belongs to,
//      and both are guardrail-34/35 concepts.
//
// Harness: the tests/votes-route.test.mts idiom — real withAdmin-wrapped handlers,
// genuine signed session JWTs, a synthetic workAsyncStorage + workUnitAsyncStorage
// scope, in-memory prisma stubs, scripted fetch for the Jellyfin admin API
// (RFC1918 literal so safeFetchAdminConfigured's SSRF stack short-circuits DNS).
// No DB, no network.
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { AsyncLocalStorage } from "node:async_hooks";

(globalThis as { AsyncLocalStorage?: unknown }).AsyncLocalStorage = AsyncLocalStorage;

process.env.TOKEN_ENCRYPTION_KEY = "ab".repeat(32);
process.env.NEXTAUTH_SECRET = "admin-server-users-secret-0123456789abc";
process.env.AUTH_URL = "http://localhost:3000";
process.env.TRUST_PROXY = "true";
(process.env as Record<string, string | undefined>).NODE_ENV = "test";

const warns: string[] = [];
const errors: string[] = [];
console.warn = (...args: unknown[]) => { warns.push(args.map(String).join(" ")); };
console.error = (...args: unknown[]) => { errors.push(args.map(String).join(" ")); };

// ── scripted Jellyfin admin API ──────────────────────────────────────────────
// RFC1918 literal ⇒ safeFetchAdminConfigured's isIP short-circuit, no DNS.
const JF_URL = "http://10.10.0.5:8096";
type FetchCall = { url: URL; method: string };
const fetchCalls: FetchCall[] = [];
let failPolicyFor = new Set<string>();
let usersFetchMode: "array" | "queryresult" | "500" | "throw" | "garbage" = "array";
let jellyfinUsersPayload: unknown[] = [];

globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
  const url = new URL(String(input));
  const method = init?.method ?? "GET";
  fetchCalls.push({ url, method });
  const ok = (b: unknown, s = 200) => new Response(JSON.stringify(b), { status: s, headers: { "content-type": "application/json" } });

  // /Users/<id>/Policy — the write half of setJellyfinDownloadPolicy
  if (/\/Users\/[^/]+\/Policy$/.test(url.pathname)) {
    const id = decodeURIComponent(url.pathname.split("/")[2]);
    return failPolicyFor.has(id) ? ok({ error: "nope" }, 500) : ok({});
  }
  // /Users/<id> — the read half
  if (/\/Users\/[^/]+$/.test(url.pathname)) {
    const id = decodeURIComponent(url.pathname.split("/")[2]);
    return failPolicyFor.has(id) ? ok({ error: "nope" }, 500) : ok({ Policy: { EnableContentDownloading: false } });
  }
  // /Users — the diagnose fetch
  if (url.pathname.endsWith("/Users")) {
    if (usersFetchMode === "throw") throw new TypeError("connect ECONNREFUSED");
    if (usersFetchMode === "500") return ok({ error: "boom" }, 500);
    if (usersFetchMode === "garbage") return ok("not-an-object");
    if (usersFetchMode === "queryresult") return ok({ Items: jellyfinUsersPayload });
    return ok(jellyfinUsersPayload);
  }
  throw new Error(`unexpected fetch ${url}`);
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
shadowPrismaModel(prisma, "user", {
  findUnique: async (args: { where: { id: string } }) => usersById.get(args.where.id) ?? null,
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
    id: userId, name: `Admin ${seq}`, role, permissions: BigInt(permissions),
    mediaServer: null, sessionsRevokedAt: null, passwordChangedAt: null, deactivatedAt: null,
    email: `admin-${seq}@example.com`, notificationEmail: null,
  });
  sessionRows.add(sessionId);
  const iat = Math.floor(Date.now() / 1000);
  return signSessionJwt(
    { id: userId, role, permissions, provider: "credentials", sessionId, expiresAt: iat + 86_400 },
    { expiresInSeconds: 7_200, iat },
  );
}
const COOKIE = getSessionCookieName();

// ── MediaServerUser store ────────────────────────────────────────────────────
type Msu = {
  id: string; source: string; serverInstance: string; sourceUserId: string;
  username: string; email: string | null; thumbUrl: string | null;
  downloadsEnabled: boolean | null; isServerAdmin: boolean; active: boolean;
  userId: string | null; manualUserLink: boolean;
};
let msuRows: Msu[] = [];
// Fires once, between the bulk route's findMany and its updateMany, to model the
// concurrent Jellyfin sync inserting a row mid-flight.
let onAfterFindMany: (() => void) | null = null;

function msuMatch(r: Msu, where: Record<string, unknown> | undefined): boolean {
  if (!where) return true;
  for (const [k, v] of Object.entries(where)) {
    if (k === "id") {
      const ids = (v as { in?: string[] }).in;
      if (Array.isArray(ids)) { if (!ids.includes(r.id)) return false; continue; }
      if (r.id !== v) return false;
      continue;
    }
    if ((r as unknown as Record<string, unknown>)[k] !== v) return false;
  }
  return true;
}

shadowPrismaModel(prisma, "mediaServerUser", {
  findMany: async (args: { where?: Record<string, unknown>; select?: Record<string, unknown>; take?: number; orderBy?: unknown }) => {
    rec("mediaServerUser.findMany", { where: args.where, take: args.take, select: args.select });
    const rows = msuRows.filter((r) => msuMatch(r, args.where)).map((r) => ({ ...r, user: null }));
    const out = args.take != null ? rows.slice(0, args.take) : rows;
    if (onAfterFindMany) { const f = onAfterFindMany; onAfterFindMany = null; f(); }
    return out;
  },
  updateMany: async (args: { where: Record<string, unknown>; data: Record<string, unknown> }) => {
    rec("mediaServerUser.updateMany", args);
    let n = 0;
    for (const r of msuRows) {
      if (!msuMatch(r, args.where)) continue;
      Object.assign(r, args.data);
      n++;
    }
    return { count: n };
  },
  count: async (args: { where?: Record<string, unknown> } = {}) => {
    rec("mediaServerUser.count", args.where);
    return msuRows.filter((r) => msuMatch(r, args.where)).length;
  },
  // Present ONLY so a delete attempt is observable — guardrail 28 says these
  // routes must never reach them.
  delete: async (args: unknown) => { rec("mediaServerUser.delete", args); return {}; },
  deleteMany: async (args: unknown) => { rec("mediaServerUser.deleteMany", args); return { count: 0 }; },
});

const settings = new Map<string, string>();
shadowPrismaModel(prisma, "setting", {
  findUnique: async (args: { where: { key: string } }) => {
    rec("setting.findUnique", args.where.key);
    const v = settings.get(args.where.key);
    return v === undefined ? null : { key: args.where.key, value: v };
  },
  findMany: async () => [],
  upsert: async (args: { where: { key: string }; create: { value: string }; update: { value: string } }) => {
    rec("setting.upsert", args);
    settings.set(args.where.key, args.update.value);
    return { key: args.where.key, value: args.update.value };
  },
});

let auditFails = false;
shadowPrismaModel(prisma, "auditLog", {
  create: async (args: unknown) => {
    rec("auditLog.create", args);
    if (auditFails) throw new Error("simulated audit failure");
    return { id: "a1" };
  },
});

const list = await import("../src/app/api/admin/server-users/route.ts");
const bulk = await import("../src/app/api/admin/server-users/bulk/route.ts");
const diagnose = await import("../src/app/api/admin/server-users/diagnose/route.ts");

// ── scope ────────────────────────────────────────────────────────────────────
const afterTasks: Array<() => Promise<unknown>> = [];
function inScope<T>(fn: () => Promise<T>): Promise<T> {
  const workStore = {
    route: "/admin-server-users.test", forceStatic: false, dynamicShouldError: false,
    afterContext: {
      after: (task: unknown) => {
        afterTasks.push(typeof task === "function" ? (task as () => Promise<unknown>) : async () => task);
      },
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
async function drainAfter(): Promise<void> {
  const tasks = [...afterTasks];
  afterTasks.length = 0;
  for (const t of tasks) await t();
}

function mk(path: string, token: string | null, init: { method: string; body?: string }) {
  return new NextRequest(`http://localhost:3000${path}`, {
    method: init.method,
    headers: { ...(token ? { cookie: `${COOKIE}=${token}` } : {}), "content-type": "application/json" },
    ...(init.body !== undefined ? { body: init.body } : {}),
  });
}
const getList = (t: string | null) => inScope(() => list.GET(mk("/api/admin/server-users", t, { method: "GET" }), undefined));
const patchList = (t: string | null, body: unknown, raw?: string) =>
  inScope(() => list.PATCH(mk("/api/admin/server-users", t, { method: "PATCH", body: raw ?? JSON.stringify(body) }), undefined));
const postBulk = (t: string | null, body: unknown, raw?: string) =>
  inScope(() => bulk.POST(mk("/api/admin/server-users/bulk", t, { method: "POST", body: raw ?? JSON.stringify(body) }), undefined));
const getDiagnose = (t: string | null) => inScope(() => diagnose.GET(mk("/api/admin/server-users/diagnose", t, { method: "GET" }), undefined));

function msu(over: Partial<Msu> & { id: string }): Msu {
  return {
    source: "jellyfin", serverInstance: "", sourceUserId: `jf-${over.id}`,
    username: `user-${over.id}`, email: null, thumbUrl: null,
    downloadsEnabled: true, isServerAdmin: false, active: true,
    userId: null, manualUserLink: false, ...over,
  };
}

beforeEach(() => {
  ops = [];
  msuRows = [];
  fetchCalls.length = 0;
  afterTasks.length = 0;
  warns.length = 0;
  errors.length = 0;
  settings.clear();
  settings.set("jellyfinUrl", JF_URL);
  settings.set("jellyfinApiKey", "jf-admin-key");
  failPolicyFor = new Set();
  usersFetchMode = "array";
  jellyfinUsersPayload = [];
  auditFails = false;
  onAfterFindMany = null;
});

// ── role gating ──────────────────────────────────────────────────────────────

test("all three routes refuse an anonymous caller with 401", async () => {
  assert.equal((await getList(null)).status, 401);
  assert.equal((await patchList(null, { autoDisableNew: true })).status, 401);
  assert.equal((await postBulk(null, { source: "jellyfin", downloadsEnabled: false })).status, 401);
  assert.equal((await getDiagnose(null)).status, 401);
});

test("a plain USER is refused 403 and reaches no query", async () => {
  const t = await mintSession({ role: "USER", permissions: 0n });
  assert.equal((await getList(t)).status, 403);
  assert.equal((await patchList(t, { autoDisableNew: true })).status, 403);
  assert.equal((await postBulk(t, { source: "jellyfin", downloadsEnabled: false })).status, 403);
  assert.equal((await getDiagnose(t)).status, 403);
  assert.equal(opsOf("mediaServerUser.findMany").length, 0);
  assert.equal(opsOf("mediaServerUser.updateMany").length, 0);
});

test("an ISSUE_ADMIN is refused — these are withAdmin, not withIssueAdmin", async () => {
  const t = await mintSession({ role: "ISSUE_ADMIN", permissions: Permission.MANAGE_ISSUES });
  assert.equal((await getList(t)).status, 403);
  assert.equal((await postBulk(t, { source: "jellyfin", downloadsEnabled: false })).status, 403);
});

// ── 1 + 2: guardrail 28 — never delete, and the active/history split ─────────

test("NOTHING on these routes deletes a MediaServerUser row", async () => {
  // The FK is onDelete: Restrict precisely because a hard delete once cascaded
  // away users' entire watch history, which the live poller cannot rebuild.
  const t = await mintSession();
  msuRows = [msu({ id: "a" }), msu({ id: "b", active: false })];
  await getList(t);
  await patchList(t, { autoDisableNew: true });
  await postBulk(t, { source: "jellyfin", downloadsEnabled: false });
  await getDiagnose(t);
  assert.equal(opsOf("mediaServerUser.delete").length, 0);
  assert.equal(opsOf("mediaServerUser.deleteMany").length, 0);
});

test("GET hides soft-deleted (departed) server users from active management", async () => {
  const t = await mintSession();
  msuRows = [msu({ id: "here" }), msu({ id: "gone", active: false })];
  const body = await (await getList(t)).json();
  assert.deepEqual(body.users.map((u: Msu) => u.id), ["here"]);
  const where = (opsOf("mediaServerUser.findMany")[0].args as { where: { active: boolean } }).where;
  assert.equal(where.active, true);
});

test("the bulk push targets only ACTIVE rows — a departed user has no account to push to", async () => {
  const t = await mintSession();
  msuRows = [msu({ id: "here" }), msu({ id: "gone", active: false })];
  await postBulk(t, { source: "jellyfin", downloadsEnabled: false });
  const where = (opsOf("mediaServerUser.findMany")[0].args as { where: Record<string, unknown> }).where;
  assert.equal(where.active, true);
  assert.equal(msuRows.find((r) => r.id === "gone")!.downloadsEnabled, true, "the departed row must be untouched");
});

test("the diagnose DB count is scoped to active Jellyfin rows", async () => {
  const t = await mintSession();
  msuRows = [msu({ id: "a" }), msu({ id: "b", active: false }), msu({ id: "c", source: "plex" })];
  await getDiagnose(t);
  const where = opsOf("mediaServerUser.count")[0].args as { source: string; serverInstance: string; active: boolean };
  // serverInstance too: the /Users fetch is per-instance, so the count it is
  // compared against must be scoped to the same server or `gap` is meaningless.
  assert.deepEqual(where, { source: "jellyfin", serverInstance: "", active: true });
});

// ── 3: the bulk snapshot race ────────────────────────────────────────────────

test("bulk drives the update off the SNAPSHOT ids, not a re-run of the where", async () => {
  // The failure this guards: the concurrent Jellyfin sync inserts a row between
  // the read and the update. Re-running the `where` for the push list would push
  // the policy to that new user on Jellyfin while their Summonarr row keeps the
  // old value — and nothing reconciles it, because policy is only pushed on an
  // explicit admin action.
  const t = await mintSession();
  msuRows = [msu({ id: "known", sourceUserId: "jf-known" })];
  onAfterFindMany = () => { msuRows.push(msu({ id: "raced-in", sourceUserId: "jf-raced-in" })); };

  const res = await postBulk(t, { source: "jellyfin", downloadsEnabled: false });
  assert.equal(res.status, 200);

  const updateWhere = (opsOf("mediaServerUser.updateMany")[0].args as { where: { id: { in: string[] } } }).where;
  assert.deepEqual(updateWhere.id.in, ["known"], "the update must be keyed on the snapshot ids");

  // The raced-in row is neither updated in the DB nor pushed to Jellyfin — the
  // two stay consistent, which is the whole point.
  assert.equal(msuRows.find((r) => r.id === "raced-in")!.downloadsEnabled, true);
  const pushed = fetchCalls.filter((c) => c.method === "POST").map((c) => c.url.pathname);
  assert.ok(!pushed.some((p) => p.includes("jf-raced-in")), "the raced-in user must not receive a push");
});

test("bulk pushes to exactly the users it updated", async () => {
  const t = await mintSession();
  msuRows = [msu({ id: "a", sourceUserId: "jf-a" }), msu({ id: "b", sourceUserId: "jf-b" })];
  await postBulk(t, { source: "jellyfin", downloadsEnabled: false });
  const policyPosts = fetchCalls.filter((c) => c.method === "POST" && c.url.pathname.endsWith("/Policy"));
  assert.deepEqual(policyPosts.map((c) => c.url.pathname.split("/")[2]).sort(), ["jf-a", "jf-b"]);
});

test("bulk excludes server admins from the policy sweep", async () => {
  const t = await mintSession();
  msuRows = [msu({ id: "normal" }), msu({ id: "boss", isServerAdmin: true })];
  await postBulk(t, { source: "jellyfin", downloadsEnabled: false });
  const where = (opsOf("mediaServerUser.findMany")[0].args as { where: Record<string, unknown> }).where;
  assert.equal(where.isServerAdmin, false);
  assert.equal(msuRows.find((r) => r.id === "boss")!.downloadsEnabled, true);
});

test("bulk only ever touches Jellyfin rows, never Plex ones", async () => {
  const t = await mintSession();
  msuRows = [msu({ id: "jf" }), msu({ id: "px", source: "plex" })];
  await postBulk(t, { source: "jellyfin", downloadsEnabled: false });
  assert.equal(msuRows.find((r) => r.id === "px")!.downloadsEnabled, true);
});

// ── 4 + 5: validation ────────────────────────────────────────────────────────

for (const [label, body] of [
  ["a missing source", { downloadsEnabled: true }],
  ["source plex", { source: "plex", downloadsEnabled: true }],
  ["an unknown source", { source: "emby", downloadsEnabled: true }],
  ["an uppercase source", { source: "JELLYFIN", downloadsEnabled: true }],
] as const) {
  test(`bulk with ${label} is 400 and writes nothing`, async () => {
    // Plex is refused deliberately: its sharing API has no working remote
    // toggle, so accepting it would report success having done nothing.
    const t = await mintSession();
    const res = await postBulk(t, body);
    assert.equal(res.status, 400);
    assert.equal((await res.json()).error, "source must be 'jellyfin'");
    assert.equal(opsOf("mediaServerUser.updateMany").length, 0);
  });
}

for (const [label, v] of [
  ["a missing downloadsEnabled", undefined],
  ["a string 'true'", "true"],
  ["a number 1", 1],
  ["null", null],
] as const) {
  test(`bulk with ${label} is 400 and writes nothing`, async () => {
    const t = await mintSession();
    const res = await postBulk(t, { source: "jellyfin", downloadsEnabled: v });
    assert.equal(res.status, 400);
    assert.equal((await res.json()).error, "downloadsEnabled must be a boolean");
    assert.equal(opsOf("mediaServerUser.updateMany").length, 0);
    assert.deepEqual(fetchCalls, []);
  });
}

test("bulk accepts downloadsEnabled:false and actually writes it", async () => {
  const t = await mintSession();
  msuRows = [msu({ id: "a", downloadsEnabled: true })];
  const res = await postBulk(t, { source: "jellyfin", downloadsEnabled: false });
  assert.equal(res.status, 200);
  assert.equal(msuRows[0].downloadsEnabled, false);
});

test("bulk rejects a malformed body with 400, not a 500", async () => {
  const t = await mintSession();
  assert.equal((await postBulk(t, undefined, "{nope")).status, 400);
});

test("bulk rejects an oversized body (guardrail 30)", async () => {
  const t = await mintSession();
  const huge = JSON.stringify({ source: "jellyfin", downloadsEnabled: true, pad: "z".repeat(30_000) });
  const res = await postBulk(t, undefined, huge);
  assert.ok(res.status === 400 || res.status === 413);
  assert.equal(opsOf("mediaServerUser.updateMany").length, 0);
});

// ── 6: partial-failure isolation + rate limit ────────────────────────────────

test("one failed Jellyfin push does not abort the rest, and the request still succeeds", async () => {
  const t = await mintSession();
  msuRows = [msu({ id: "a", sourceUserId: "jf-a" }), msu({ id: "b", sourceUserId: "jf-b" }), msu({ id: "c", sourceUserId: "jf-c" })];
  failPolicyFor = new Set(["jf-b"]);
  const res = await postBulk(t, { source: "jellyfin", downloadsEnabled: false });
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.pushed, 2);
  assert.equal(body.errors, 1);
  // …and the DB write for every target still stands.
  assert.deepEqual(msuRows.map((r) => r.downloadsEnabled), [false, false, false]);
});

test("a failed push is warned with a scoped prefix (guardrail 7)", async () => {
  const t = await mintSession();
  msuRows = [msu({ id: "a", sourceUserId: "jf-a" })];
  failPolicyFor = new Set(["jf-a"]);
  await postBulk(t, { source: "jellyfin", downloadsEnabled: false });
  assert.ok(warns.some((w) => w.includes("[server-users/bulk]")), `no scoped warn: ${warns.join(" | ")}`);
});

test("bulk still updates the DB when Jellyfin is unconfigured — it just pushes nothing", async () => {
  const t = await mintSession();
  settings.delete("jellyfinUrl");
  msuRows = [msu({ id: "a" })];
  const res = await postBulk(t, { source: "jellyfin", downloadsEnabled: false });
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { ok: true, pushed: 0, errors: 0 });
  assert.equal(msuRows[0].downloadsEnabled, false);
  assert.deepEqual(fetchCalls, []);
});

test("bulk is rate-limited to 5 per minute per admin", async () => {
  const t = await mintSession();
  for (let i = 0; i < 5; i++) {
    assert.equal((await postBulk(t, { source: "jellyfin", downloadsEnabled: false })).status, 200, `call ${i + 1}`);
  }
  const limited = await postBulk(t, { source: "jellyfin", downloadsEnabled: false });
  assert.equal(limited.status, 429);
});

test("the bulk rate limit is per admin — a second admin has their own budget", async () => {
  const a = await mintSession();
  for (let i = 0; i < 6; i++) await postBulk(a, { source: "jellyfin", downloadsEnabled: false });
  assert.equal((await postBulk(a, { source: "jellyfin", downloadsEnabled: false })).status, 429);
  const b = await mintSession();
  assert.equal((await postBulk(b, { source: "jellyfin", downloadsEnabled: false })).status, 200);
});

test("bulk audits the sweep with its counts", async () => {
  const t = await mintSession();
  msuRows = [msu({ id: "a", sourceUserId: "jf-a" }), msu({ id: "b", sourceUserId: "jf-b" })];
  failPolicyFor = new Set(["jf-b"]);
  await postBulk(t, { source: "jellyfin", downloadsEnabled: false });
  await drainAfter();
  const data = (opsOf("auditLog.create")[0].args as { data: { action: string; details: string } }).data;
  assert.equal(data.action, "SERVER_USERS_BULK");
  const details = JSON.parse(data.details);
  assert.equal(details.targetCount, 2);
  assert.equal(details.pushed, 1);
  assert.equal(details.errors, 1);
});

test("a failing audit write does not turn a successful bulk sweep into a 500 (guardrail 26)", async () => {
  auditFails = true;
  const t = await mintSession();
  msuRows = [msu({ id: "a" })];
  const res = await postBulk(t, { source: "jellyfin", downloadsEnabled: false });
  assert.equal(res.status, 200);
  assert.equal(msuRows[0].downloadsEnabled, false);
  await drainAfter();
});

// ── 7: the list projection ───────────────────────────────────────────────────

test("the list projects manualUserLink and serverInstance", async () => {
  // manualUserLink is guardrail 34's pin (automatic resolution skips the row);
  // serverInstance is guardrail 35's identity. The admin UI needs both.
  const t = await mintSession();
  msuRows = [msu({ id: "a", manualUserLink: true, serverInstance: "remote" })];
  const body = await (await getList(t)).json();
  assert.equal(body.users[0].manualUserLink, true);
  assert.equal(body.users[0].serverInstance, "remote");
});

test("the list is bounded so a pathological server can't return an unbounded row set", async () => {
  const t = await mintSession();
  await getList(t);
  assert.equal((opsOf("mediaServerUser.findMany")[0].args as { take: number }).take, 10_000);
});

test("the list carries the auto-disable flag alongside the users", async () => {
  const t = await mintSession();
  settings.set("downloadAutoDisableNew", "true");
  const body = await (await getList(t)).json();
  assert.equal(body.autoDisableNew, true);
  assert.ok(Array.isArray(body.users));
});

test("autoDisableNew is a strict 'true' comparison, not truthiness", async () => {
  const t = await mintSession();
  for (const v of ["1", "yes", "TRUE", "on", ""]) {
    settings.set("downloadAutoDisableNew", v);
    const body = await (await getList(t)).json();
    assert.equal(body.autoDisableNew, false, `"${v}" must not read as enabled`);
  }
});

// ── PATCH (the auto-disable toggle) ──────────────────────────────────────────

test("PATCH persists autoDisableNew and audits the before/after", async () => {
  const t = await mintSession();
  settings.set("downloadAutoDisableNew", "false");
  const res = await patchList(t, { autoDisableNew: true });
  assert.equal(res.status, 200);
  assert.equal(settings.get("downloadAutoDisableNew"), "true");
  await drainAfter();
  const data = (opsOf("auditLog.create")[0].args as { data: { action: string; target: string; details: string } }).data;
  assert.equal(data.action, "SETTINGS_CHANGE");
  assert.equal(data.target, "settings:downloadAutoDisableNew");
  const details = JSON.parse(data.details);
  assert.equal(details.before.value, "false");
  assert.equal(details.after.value, "true");
});

test("PATCH rejects a non-boolean autoDisableNew and writes nothing", async () => {
  const t = await mintSession();
  for (const v of ["true", 1, null, {}]) {
    ops = [];
    const res = await patchList(t, { autoDisableNew: v });
    assert.equal(res.status, 400, `value ${JSON.stringify(v)} should be rejected`);
    assert.equal(opsOf("setting.upsert").length, 0);
  }
});

test("PATCH with no autoDisableNew key is an accepted no-op", async () => {
  const t = await mintSession();
  const res = await patchList(t, {});
  assert.equal(res.status, 200);
  assert.equal(opsOf("setting.upsert").length, 0);
  await drainAfter();
  assert.equal(opsOf("auditLog.create").length, 0);
});

test("PATCH rejects a malformed body with 400", async () => {
  const t = await mintSession();
  assert.equal((await patchList(t, undefined, "{bad")).status, 400);
});

// ── diagnose ─────────────────────────────────────────────────────────────────

test("diagnose returns 400 when Jellyfin is unconfigured, without fetching", async () => {
  const t = await mintSession();
  settings.delete("jellyfinApiKey");
  const res = await getDiagnose(t);
  assert.equal(res.status, 400);
  assert.deepEqual(fetchCalls, []);
});

test("diagnose reports a plain array response and categorises every user", async () => {
  const t = await mintSession();
  jellyfinUsersPayload = [
    { Id: "1", Name: "alice", Email: "alice@example.com", Policy: { IsAdministrator: false, EnableContentDownloading: true } },
    { Id: "2", Name: "bob", Policy: { IsAdministrator: true } },
  ];
  const body = await (await getDiagnose(t)).json();
  assert.equal(body.responseShape, "array");
  assert.equal(body.rawCount, 2);
  assert.equal(body.processedCount, 2);
  assert.equal(body.skippedCount, 0);
});

test("diagnose recognises the QueryResult{Items} response shape", async () => {
  const t = await mintSession();
  usersFetchMode = "queryresult";
  jellyfinUsersPayload = [{ Id: "1", Name: "alice", Policy: {} }];
  const body = await (await getDiagnose(t)).json();
  assert.equal(body.responseShape, "QueryResult{Items}");
  assert.equal(body.rawCount, 1);
});

test("diagnose explains WHY a user would be skipped rather than silently dropping them", async () => {
  const t = await mintSession();
  jellyfinUsersPayload = [
    { Id: null, Name: "no-id", Policy: {} },
    { Id: "2", Name: "", Policy: {} },
    { Id: "3", Name: "no-policy" },
  ];
  const body = await (await getDiagnose(t)).json();
  assert.equal(body.skippedCount, 3);
  const reasons = body.skipped.flatMap((s: { skipReasons: string[] }) => s.skipReasons);
  assert.ok(reasons.some((r: string) => r.includes("missing Id")));
  assert.ok(reasons.some((r: string) => r.includes("empty Name")));
  assert.ok(reasons.some((r: string) => r.includes("no Policy object")));
});

test("diagnose reports the gap between what Jellyfin returns and what the DB holds", async () => {
  const t = await mintSession();
  jellyfinUsersPayload = [
    { Id: "1", Name: "a", Policy: {} },
    { Id: "2", Name: "b", Policy: {} },
    { Id: "3", Name: "c", Policy: {} },
  ];
  msuRows = [msu({ id: "x" })];
  const body = await (await getDiagnose(t)).json();
  assert.equal(body.dbCount, 1);
  assert.equal(body.gap, 2);
});

test("diagnose truncates emails in the processed list rather than dumping them", async () => {
  const t = await mintSession();
  jellyfinUsersPayload = [{ Id: "1", Name: "alice", Email: "alice@example.com", Policy: {} }];
  const body = await (await getDiagnose(t)).json();
  const email = body.processed[0].email;
  assert.ok(!email.includes("@example.com"), `full address leaked: ${email}`);
  assert.ok(email.startsWith("ali"));
});

test("diagnose surfaces a transport failure instead of throwing", async () => {
  const t = await mintSession();
  usersFetchMode = "throw";
  const res = await getDiagnose(t);
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.ok(body.fetchError, "the transport error must be reported in the body");
  assert.equal(body.rawCount, 0);
});

test("diagnose reports a non-2xx upstream status", async () => {
  const t = await mintSession();
  usersFetchMode = "500";
  const body = await (await getDiagnose(t)).json();
  assert.equal(body.httpStatus, 500);
});

test("diagnose labels an unexpected body shape rather than crashing", async () => {
  const t = await mintSession();
  usersFetchMode = "garbage";
  const body = await (await getDiagnose(t)).json();
  assert.match(body.responseShape, /^unexpected:/);
  assert.equal(body.rawCount, 0);
});

test("diagnose never echoes the Jellyfin API key", async () => {
  const t = await mintSession();
  jellyfinUsersPayload = [{ Id: "1", Name: "a", Policy: {} }];
  const text = await (await getDiagnose(t)).text();
  assert.ok(!text.includes("jf-admin-key"));
});
