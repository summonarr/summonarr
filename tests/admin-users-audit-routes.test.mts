// Route-level unit tests for three uncovered admin routes:
//   GET/POST   /api/admin/users            list + create a local-credentials user
//   GET/DELETE /api/admin/audit-log        the trail, and the manual PII scrub
//   GET        /api/admin/audit-log/export CSV/JSON export of the whole trail
//
// These are the highest-privilege surfaces left uncovered, and each has a
// distinct sharp edge:
//
//   1. SELF-ESCALATION (users POST). Both verbs are gated on MANAGE_USERS rather
//      than withAdmin — deliberately, so the bit that gates the [id] PATCH/DELETE
//      also gates listing and creating, since a holder who could edit and delete
//      users it couldn't list would be incoherent. But MANAGE_USERS delegates
//      creation of NON-admin users only: without the extra check, a MANAGE_USERS
//      holder could mint a fresh ADMIN with a password they control and promote
//      themselves. That check is tested from both sides.
//   2. THE EXPORT IS ITSELF AN EXFIL VECTOR. It streams up to 100k rows of PII,
//      so the audit row is written BEFORE the stream opens and finalized in a
//      `finally`. Two failure modes are pinned: an invalid date must be rejected
//      UP FRONT (inside the stream's start() it would throw after headers were
//      sent, producing a half-written export AND skipping the audit row — an
//      exfil-evasion vector the in-code comment names), and an aborted stream
//      must still leave a row recording what happened.
//   3. CSV INJECTION. Exported cells beginning =, +, -, @, tab or CR are formula
//      triggers in Excel/Sheets; they must be prefixed. This is the one place
//      audit content authored by an attacker (a crafted username) reaches a
//      spreadsheet an operator opens.
//   4. THE SCRUB IS A REDACTION, NOT A DELETION. DELETE /audit-log updates rows
//      past a 90-day cutoff; it must never delete them, must stay cutoff-bounded,
//      and must clear `details` only on the auth events (a USER_DELETE record's
//      details are the deletion evidence and are deliberately preserved).
//   5. ILIKE wildcard stripping on both search boxes (Prisma `contains` emits an
//      ILIKE with no ESCAPE clause), and the action-beats-group filter precedence
//      shared by the list and the export.
//   6. The user list must not serialize passwordHash, which it selects only to
//      derive the local-vs-OAuth `source` label.
//
// Harness: the tests/votes-route.test.mts idiom — real wrapped handlers, genuine
// signed session JWTs, a synthetic workAsyncStorage + workUnitAsyncStorage scope,
// in-memory prisma stubs. No DB, no network.
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { AsyncLocalStorage } from "node:async_hooks";

(globalThis as { AsyncLocalStorage?: unknown }).AsyncLocalStorage = AsyncLocalStorage;

process.env.TOKEN_ENCRYPTION_KEY = "ab".repeat(32);
process.env.NEXTAUTH_SECRET = "admin-users-audit-secret-0123456789abcd";
process.env.AUTH_URL = "http://localhost:3000";
process.env.TRUST_PROXY = "true";
(process.env as Record<string, string | undefined>).NODE_ENV = "test";

globalThis.fetch = (() => { throw new Error("unexpected network call"); }) as unknown as typeof fetch;

const warns: string[] = [];
const errors: string[] = [];
console.warn = (...args: unknown[]) => { warns.push(args.map(String).join(" ")); };
console.error = (...args: unknown[]) => { errors.push(args.map(String).join(" ")); };

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
const { Prisma } = await import("@/generated/prisma");
const { signSessionJwt } = await import("../src/lib/session-jwt.ts");
const { getSessionCookieName } = await import("../src/lib/session-cookie.ts");
const { Permission, defaultPermissionsForRole } = await import("../src/lib/permissions.ts");
const { verifyPassword } = await import("../src/lib/password-hash.ts");

// ── op log ───────────────────────────────────────────────────────────────────
type Op = { op: string; args?: unknown };
let ops: Op[] = [];
const rec = (op: string, args?: unknown) => { ops.push({ op, args }); };
const opsOf = (name: string) => ops.filter((o) => o.op === name);

// ── auth fixture ─────────────────────────────────────────────────────────────
const sessionUsers = new Map<string, Record<string, unknown>>();
const sessionRows = new Set<string>();
shadowPrismaModel(prisma, "authSession", {
  findUnique: async (args: { where: { sessionId: string } }) =>
    sessionRows.has(args.where.sessionId) ? { id: `row-${args.where.sessionId}`, sessionId: args.where.sessionId } : null,
  update: async () => ({}),
});

let seq = 0;
async function mintSession(opts: { role?: string; permissions?: bigint } = {}): Promise<string> {
  seq++;
  const userId = `caller-${seq}`;
  const sessionId = `sess-${seq}`;
  const role = opts.role ?? "ADMIN";
  const permissions = (opts.permissions ?? Permission.ADMIN).toString();
  sessionUsers.set(userId, {
    id: userId, name: `Caller ${seq}`, role, permissions: BigInt(permissions),
    mediaServer: null, sessionsRevokedAt: null, passwordChangedAt: null, deactivatedAt: null,
    email: `caller-${seq}@example.com`, notificationEmail: null,
  });
  sessionRows.add(sessionId);
  const iat = Math.floor(Date.now() / 1000);
  return signSessionJwt(
    { id: userId, role, permissions, provider: "credentials", sessionId, expiresAt: iat + 86_400 },
    { expiresInSeconds: 7_200, iat },
  );
}
const COOKIE = getSessionCookieName();

// ── User store ───────────────────────────────────────────────────────────────
type AppUser = Record<string, unknown> & { id: string; email: string | null };
let appUsers: AppUser[] = [];
let nextUserCreateThrows: "P2002" | null = null;

shadowPrismaModel(prisma, "user", {
  // Session resolution AND the admin list both land here.
  findUnique: async (args: { where: { id: string } }) => sessionUsers.get(args.where.id) ?? null,
  update: async () => ({}),
  findMany: async (args: { select?: unknown; take?: number; orderBy?: unknown }) => {
    rec("user.findMany", { take: args.take, select: args.select });
    return appUsers.map((u) => ({ ...u }));
  },
  create: async (args: { data: Record<string, unknown>; select?: unknown }) => {
    rec("user.create", args.data);
    if (nextUserCreateThrows === "P2002") {
      nextUserCreateThrows = null;
      throw new Prisma.PrismaClientKnownRequestError("unique violation", { code: "P2002", clientVersion: "0.0.0-test" });
    }
    // `email` arrives from args.data (spread last), which the compiler can't see
    // through — hence the two-step cast rather than a direct one.
    const row = {
      id: `new-${appUsers.length + 1}`,
      createdAt: new Date(), deactivatedAt: null, purgedAt: null, mediaServer: null,
      maxContentRating: null, movieQuotaLimit: null, movieQuotaDays: null,
      tvQuotaLimit: null, tvQuotaDays: null,
      notifyOnApproved: true, notifyOnAvailable: true, notifyOnDeclined: true,
      emailOnApproved: false, emailOnAvailable: false, emailOnDeclined: false,
      pushOnApproved: false, pushOnAvailable: false, pushOnDeclined: false,
      notifyOnIssue: false, _count: { requests: 0 },
      ...args.data,
    } as unknown as AppUser;
    appUsers.push(row);
    return row;
  },
});

// ── AuditLog store ───────────────────────────────────────────────────────────
type AuditRow = {
  id: string; createdAt: Date; userId: string; userName: string; action: string;
  target: string; details: string | null; ipAddress: string | null;
  userAgent: string | null; provider: string | null;
};
let auditRows: AuditRow[] = [];
let auditSeq = 0;
let findManyThrowsAfter: number | null = null;
let findManyCalls = 0;

function auditMatch(r: AuditRow, where: Record<string, unknown> | undefined): boolean {
  if (!where) return true;
  for (const [k, v] of Object.entries(where)) {
    if (k === "OR") { if (!(v as Record<string, unknown>[]).some((w) => auditMatch(r, w))) return false; continue; }
    if (k === "createdAt") {
      const c = v as { gte?: Date; lt?: Date };
      if (c.gte && r.createdAt < c.gte) return false;
      if (c.lt && r.createdAt >= c.lt) return false;
      continue;
    }
    if (k === "action") {
      const a = v as string | { in?: string[] };
      if (typeof a === "string") { if (r.action !== a) return false; continue; }
      if (a.in && !a.in.includes(r.action)) return false;
      continue;
    }
    if (k === "userId") {
      const u = v as string | { not?: string };
      if (typeof u === "string") { if (r.userId !== u) return false; continue; }
      if (u.not !== undefined && r.userId === u.not) return false;
      continue;
    }
    if (k === "userName" || k === "target") {
      const f = v as { contains?: string } | string;
      const val = (r as unknown as Record<string, string>)[k] ?? "";
      if (typeof f === "string") { if (val !== f) return false; continue; }
      if (f.contains && !val.toLowerCase().includes(f.contains.toLowerCase())) return false;
      continue;
    }
    if (k === "ipAddress" || k === "userAgent" || k === "details") {
      const f = v as { not?: unknown };
      const val = (r as unknown as Record<string, unknown>)[k];
      if ("not" in f) { if (val === f.not) return false; continue; }
      if (val !== v) return false;
      continue;
    }
    throw new Error(`unhandled AuditLog where key: ${k}`);
  }
  return true;
}

shadowPrismaModel(prisma, "auditLog", {
  findMany: async (args: { where?: Record<string, unknown>; take?: number; cursor?: { id: string }; skip?: number }) => {
    findManyCalls++;
    rec("auditLog.findMany", { where: args.where, take: args.take, cursor: args.cursor });
    if (findManyThrowsAfter !== null && findManyCalls > findManyThrowsAfter) {
      throw new Error("simulated export read failure");
    }
    let rows = auditRows
      .filter((r) => auditMatch(r, args.where))
      .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime() || (a.id < b.id ? 1 : -1));
    if (args.cursor) {
      const i = rows.findIndex((r) => r.id === args.cursor!.id);
      rows = i === -1 ? [] : rows.slice(i + (args.skip ?? 0));
    }
    return args.take != null ? rows.slice(0, args.take) : rows;
  },
  updateMany: async (args: { where: Record<string, unknown>; data: Record<string, unknown> }) => {
    rec("auditLog.updateMany", args.where);
    let n = 0;
    for (const r of auditRows) {
      if (!auditMatch(r, args.where)) continue;
      Object.assign(r, args.data);
      n++;
    }
    return { count: n };
  },
  create: async (args: { data: Record<string, unknown> }) => {
    rec("auditLog.create", args);
    const row = { id: `audit-${++auditSeq}`, createdAt: new Date(), ...args.data } as AuditRow;
    auditRows.push(row);
    return row;
  },
  update: async (args: { where: { id: string }; data: Record<string, unknown> }) => {
    rec("auditLog.update", args);
    const row = auditRows.find((r) => r.id === args.where.id);
    if (row) Object.assign(row, args.data);
    return row ?? {};
  },
  delete: async (args: unknown) => { rec("auditLog.delete", args); return {}; },
  deleteMany: async (args: unknown) => { rec("auditLog.deleteMany", args); return { count: 0 }; },
});

shadowPrismaModel(prisma, "setting", { findUnique: async () => null, findMany: async () => [] });

const users = await import("../src/app/api/admin/users/route.ts");
const auditLog = await import("../src/app/api/admin/audit-log/route.ts");
const auditExport = await import("../src/app/api/admin/audit-log/export/route.ts");

// ── scope ────────────────────────────────────────────────────────────────────
const afterTasks: Array<() => Promise<unknown>> = [];
function inScope<T>(fn: () => Promise<T>): Promise<T> {
  const workStore = {
    route: "/admin-users-audit.test", forceStatic: false, dynamicShouldError: false,
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

function mk(path: string, token: string | null, init: { method: string; body?: string; query?: string }) {
  return new NextRequest(`http://localhost:3000${path}${init.query ?? ""}`, {
    method: init.method,
    headers: { ...(token ? { cookie: `${COOKIE}=${token}` } : {}), "content-type": "application/json" },
    ...(init.body !== undefined ? { body: init.body } : {}),
  });
}
const listUsers = (t: string | null) => inScope(() => users.GET(mk("/api/admin/users", t, { method: "GET" }), undefined));
const createUser = (t: string | null, body: unknown, raw?: string) =>
  inScope(() => users.POST(mk("/api/admin/users", t, { method: "POST", body: raw ?? JSON.stringify(body) }), undefined));
const listAudit = (t: string | null, q = "") => inScope(() => auditLog.GET(mk("/api/admin/audit-log", t, { method: "GET", query: q }), undefined));
const scrubAudit = (t: string | null) => inScope(() => auditLog.DELETE(mk("/api/admin/audit-log", t, { method: "DELETE" }), undefined));
const exportAudit = (t: string | null, q = "") => inScope(() => auditExport.GET(mk("/api/admin/audit-log/export", t, { method: "GET", query: q }), undefined));

function audit(over: Partial<AuditRow> & { id: string }): AuditRow {
  return {
    createdAt: new Date("2026-07-01T00:00:00Z"), userId: "u1", userName: "alice",
    action: "AUTH_LOGIN", target: "user:u1", details: null,
    ipAddress: "10.0.0.1", userAgent: "curl", provider: "credentials", ...over,
  };
}

async function readAll(res: Response): Promise<string> {
  return res.text();
}

beforeEach(() => {
  ops = [];
  appUsers = [];
  auditRows = [];
  auditSeq = 0;
  afterTasks.length = 0;
  warns.length = 0;
  errors.length = 0;
  nextUserCreateThrows = null;
  findManyThrowsAfter = null;
  findManyCalls = 0;
});

// ── /api/admin/users — gating ────────────────────────────────────────────────

test("users: anonymous is 401 on both verbs", async () => {
  assert.equal((await listUsers(null)).status, 401);
  assert.equal((await createUser(null, { email: "a@b.com", password: "password123" })).status, 401);
});

test("users: a plain USER is 403 and reaches no query", async () => {
  const t = await mintSession({ role: "USER", permissions: 0n });
  assert.equal((await listUsers(t)).status, 403);
  assert.equal((await createUser(t, { email: "a@b.com", password: "password123" })).status, 403);
  assert.equal(opsOf("user.findMany").length, 0);
  assert.equal(opsOf("user.create").length, 0);
});

test("users: a MANAGE_USERS holder who is NOT an admin can list and create", async () => {
  // The bit is deliberately MANAGE_USERS, not withAdmin, so the same capability
  // that gates the [id] PATCH/DELETE also gates listing and creating.
  const t = await mintSession({ role: "USER", permissions: Permission.MANAGE_USERS });
  assert.equal((await listUsers(t)).status, 200);
  assert.equal((await createUser(t, { email: "new@example.com", password: "password123" })).status, 201);
});

// ── the self-escalation guard ────────────────────────────────────────────────

test("users: a MANAGE_USERS holder CANNOT create an ADMIN account", async () => {
  // Without this check the holder could mint a fresh ADMIN with a password they
  // control and self-escalate.
  const t = await mintSession({ role: "USER", permissions: Permission.MANAGE_USERS });
  const res = await createUser(t, { email: "boss@example.com", password: "password123", role: "ADMIN" });
  assert.equal(res.status, 403);
  assert.equal((await res.json()).error, "Only an admin can create an admin account");
  assert.equal(opsOf("user.create").length, 0);
});

test("users: a full ADMIN CAN create an ADMIN account", async () => {
  const t = await mintSession();
  const res = await createUser(t, { email: "boss@example.com", password: "password123", role: "ADMIN" });
  assert.equal(res.status, 201);
});

test("users: a MANAGE_USERS holder can still create USER and ISSUE_ADMIN accounts", async () => {
  const t = await mintSession({ role: "USER", permissions: Permission.MANAGE_USERS });
  assert.equal((await createUser(t, { email: "u1@example.com", password: "password123", role: "USER" })).status, 201);
  assert.equal((await createUser(t, { email: "u2@example.com", password: "password123", role: "ISSUE_ADMIN" })).status, 201);
});

test("users: an unknown role is rejected before any privilege check", async () => {
  const t = await mintSession();
  for (const role of ["SUPERADMIN", "admin", "OWNER", ""]) {
    ops = [];
    const res = await createUser(t, { email: "x@example.com", password: "password123", role });
    assert.equal(res.status, 400, `role ${role} should be rejected`);
    assert.equal(opsOf("user.create").length, 0);
  }
});

test("users: the created row seeds its permission bitmask from the role", async () => {
  const t = await mintSession();
  await createUser(t, { email: "ia@example.com", password: "password123", role: "ISSUE_ADMIN" });
  const data = opsOf("user.create")[0].args as { permissions: bigint; role: string };
  assert.equal(data.role, "ISSUE_ADMIN");
  assert.equal(data.permissions, defaultPermissionsForRole("ISSUE_ADMIN"));
});

// ── users: validation ────────────────────────────────────────────────────────

for (const [label, email] of [
  ["a missing email", undefined],
  ["an empty email", ""],
  ["no @", "nobody"],
  ["two @", "a@b@c.com"],
  ["no domain dot", "a@localhost"],
  ["a trailing dot domain", "a@b."],
  ["embedded whitespace", "a b@c.com"],
  ["a 255-char address", `${"a".repeat(250)}@b.com`],
  ["a non-string", 42],
] as const) {
  test(`users: ${label} is 400 and creates nothing`, async () => {
    const t = await mintSession();
    const res = await createUser(t, { email, password: "password123" });
    assert.equal(res.status, 400);
    assert.equal((await res.json()).error, "Invalid email address");
    assert.equal(opsOf("user.create").length, 0);
  });
}

for (const [label, password, wantErr] of [
  ["a missing password", undefined, "Password is required"],
  ["an empty password", "", "Password is required"],
  ["a 7-char password", "1234567", "Password must be at least 8 characters"],
] as const) {
  test(`users: ${label} is 400 and creates nothing`, async () => {
    const t = await mintSession();
    const res = await createUser(t, { email: "a@b.com", password });
    assert.equal(res.status, 400);
    assert.equal((await res.json()).error, wantErr);
    assert.equal(opsOf("user.create").length, 0);
  });
}

test("users: an over-long password is rejected rather than hashed", async () => {
  // Bounding this matters: the hash cost scales with input length.
  const { MAX_PASSWORD_LENGTH } = await import("../src/lib/password-hash.ts");
  const t = await mintSession();
  const res = await createUser(t, { email: "a@b.com", password: "x".repeat(MAX_PASSWORD_LENGTH + 1) });
  assert.equal(res.status, 400);
  assert.equal(opsOf("user.create").length, 0);
});

test("users: an over-long name is rejected", async () => {
  const t = await mintSession();
  const res = await createUser(t, { email: "a@b.com", password: "password123", name: "n".repeat(101) });
  assert.equal(res.status, 400);
  assert.equal(opsOf("user.create").length, 0);
});

test("users: the email is normalized (lower-cased) before storage", async () => {
  const t = await mintSession();
  await createUser(t, { email: "Mixed.Case@Example.COM", password: "password123" });
  const data = opsOf("user.create")[0].args as { email: string };
  assert.equal(data.email, data.email.toLowerCase());
  assert.equal(data.email, data.email.trim());
});

test("users: a surrounding-whitespace email is REJECTED, not silently trimmed", async () => {
  // The validator refuses any whitespace in the address rather than trimming it,
  // so two addresses differing only by padding can never both be accepted.
  const t = await mintSession();
  const res = await createUser(t, { email: "  spaced@example.com  ", password: "password123" });
  assert.equal(res.status, 400);
  assert.equal(opsOf("user.create").length, 0);
});

test("users: the password is HASHED, never stored in the clear", async () => {
  const t = await mintSession();
  await createUser(t, { email: "a@b.com", password: "correct horse battery" });
  const data = opsOf("user.create")[0].args as { passwordHash: string };
  assert.notEqual(data.passwordHash, "correct horse battery");
  assert.ok(data.passwordHash.length > 20);
  assert.equal(await verifyPassword("correct horse battery", data.passwordHash), true);
  assert.equal(await verifyPassword("wrong", data.passwordHash), false);
});

test("users: a duplicate email maps to 409, not a 500", async () => {
  const t = await mintSession();
  nextUserCreateThrows = "P2002";
  const res = await createUser(t, { email: "dupe@example.com", password: "password123" });
  assert.equal(res.status, 409);
});

test("users: a malformed body is 400 and an oversized one is capped (guardrail 30)", async () => {
  const t = await mintSession();
  assert.equal((await createUser(t, undefined, "{bad")).status, 400);
  const huge = JSON.stringify({ email: "a@b.com", password: "password123", name: "n".repeat(30_000) });
  const res = await createUser(t, undefined, huge);
  assert.ok(res.status === 400 || res.status === 413);
});

test("users: creation is rate-limited per caller", async () => {
  const t = await mintSession();
  for (let i = 0; i < 10; i++) {
    assert.equal((await createUser(t, { email: `u${i}@example.com`, password: "password123" })).status, 201, `create ${i}`);
  }
  assert.equal((await createUser(t, { email: "over@example.com", password: "password123" })).status, 429);
});

// ── users: the list projection ───────────────────────────────────────────────

test("users: passwordHash is NEVER serialized, on either verb", async () => {
  // It is selected only to derive the local-vs-OAuth `source` label.
  const t = await mintSession();
  appUsers = [{
    id: "u1", name: "Alice", email: "a@b.com", role: "USER", createdAt: new Date(),
    deactivatedAt: null, purgedAt: null, mediaServer: null, maxContentRating: null,
    passwordHash: "$argon2id$SUPERSECRETHASH", movieQuotaLimit: null, movieQuotaDays: null,
    tvQuotaLimit: null, tvQuotaDays: null, permissions: 0n,
    notifyOnApproved: true, notifyOnAvailable: true, notifyOnDeclined: true,
    emailOnApproved: false, emailOnAvailable: false, emailOnDeclined: false,
    pushOnApproved: false, pushOnAvailable: false, pushOnDeclined: false,
    notifyOnIssue: false, _count: { requests: 3 },
  }];
  const listText = await (await listUsers(t)).text();
  assert.ok(!listText.includes("SUPERSECRETHASH"));
  assert.ok(!listText.includes("passwordHash"));

  const created = await (await createUser(t, { email: "n@example.com", password: "password123" })).text();
  assert.ok(!created.includes("passwordHash"));
});

test("users: the source label is derived from the hash and the synthetic Jellyfin domain", async () => {
  const t = await mintSession();
  const base = {
    role: "USER", createdAt: new Date(), deactivatedAt: null, purgedAt: null, mediaServer: null,
    maxContentRating: null, movieQuotaLimit: null, movieQuotaDays: null, tvQuotaLimit: null,
    tvQuotaDays: null, permissions: 0n, notifyOnApproved: true, notifyOnAvailable: true,
    notifyOnDeclined: true, emailOnApproved: false, emailOnAvailable: false, emailOnDeclined: false,
    pushOnApproved: false, pushOnAvailable: false, pushOnDeclined: false, notifyOnIssue: false,
    _count: { requests: 0 },
  };
  appUsers = [
    { id: "l", name: "Local", email: "l@b.com", passwordHash: "h", ...base },
    { id: "j", name: "Jelly", email: "jellyfin-9@jellyfin.local", passwordHash: null, ...base },
    { id: "p", name: "Plexy", email: "p@b.com", passwordHash: null, ...base },
  ];
  const body = await (await listUsers(t)).json();
  assert.deepEqual(body.map((u: { source: string }) => u.source), ["local", "jellyfin", "plex"]);
});

test("users: permissions serialize as a decimal string the PATCH can round-trip", async () => {
  const t = await mintSession();
  appUsers = [{
    id: "u1", name: "A", email: "a@b.com", role: "ADMIN", createdAt: new Date(),
    deactivatedAt: null, purgedAt: null, mediaServer: null, maxContentRating: null,
    passwordHash: null, movieQuotaLimit: null, movieQuotaDays: null, tvQuotaLimit: null,
    tvQuotaDays: null, permissions: Permission.ADMIN,
    notifyOnApproved: true, notifyOnAvailable: true, notifyOnDeclined: true,
    emailOnApproved: false, emailOnAvailable: false, emailOnDeclined: false,
    pushOnApproved: false, pushOnAvailable: false, pushOnDeclined: false,
    notifyOnIssue: false, _count: { requests: 0 },
  }];
  const body = await (await listUsers(t)).json();
  assert.equal(typeof body[0].permissions, "string");
  assert.equal(BigInt(body[0].permissions), Permission.ADMIN);
});

test("users: the list is bounded", async () => {
  const t = await mintSession();
  await listUsers(t);
  assert.equal((opsOf("user.findMany")[0].args as { take: number }).take, 1000);
});

test("users: a successful create is audited", async () => {
  const t = await mintSession();
  await createUser(t, { email: "audited@example.com", password: "password123" });
  await drainAfter();
  const created = opsOf("auditLog.create").find((o) => (o.args as { data: { action: string } }).data.action === "USER_CREATE");
  assert.ok(created, "USER_CREATE audit row missing");
});

test("users: a create audit never records the password", async () => {
  const t = await mintSession();
  await createUser(t, { email: "audited@example.com", password: "hunter2-secret" });
  await drainAfter();
  // BigInt permissions live in the op log, so stringify needs a replacer.
  const dump = JSON.stringify(ops, (_k, v) => (typeof v === "bigint" ? v.toString() : v));
  assert.ok(!dump.includes("hunter2-secret"), "the plaintext password reached the audit payload");
});

// ── /api/admin/audit-log — list ──────────────────────────────────────────────

test("audit-log: anonymous is 401 and a plain USER is 403", async () => {
  assert.equal((await listAudit(null)).status, 401);
  const t = await mintSession({ role: "USER", permissions: 0n });
  assert.equal((await listAudit(t)).status, 403);
  assert.equal((await scrubAudit(t)).status, 403);
});

test("audit-log: a MANAGE_USERS holder without ADMIN is refused — this is withAdmin", async () => {
  const t = await mintSession({ role: "USER", permissions: Permission.MANAGE_USERS });
  assert.equal((await listAudit(t)).status, 403);
});

test("audit-log: pageSize is clamped to 50 and at least 1", async () => {
  const t = await mintSession();
  // NOTE the asymmetry, pinned deliberately: 0 and a non-numeric string fall
  // through `|| 50` to the DEFAULT page size, whereas a NEGATIVE parses truthy
  // and is clamped by Math.max(1, …) to 1. Both are safe (no negative take), but
  // they are not the same answer.
  for (const [q, want] of [["?pageSize=500", 51], ["?pageSize=0", 51], ["?pageSize=-3", 2], ["?pageSize=abc", 51], ["?pageSize=10", 11]] as const) {
    ops = [];
    await listAudit(t, q);
    assert.equal((opsOf("auditLog.findMany")[0].args as { take: number }).take, want, `for ${q}`);
  }
});

test("audit-log: an unknown action filter is ignored rather than returning nothing", async () => {
  const t = await mintSession();
  auditRows = [audit({ id: "a1" })];
  await listAudit(t, "?action=NOT_A_REAL_ACTION");
  const where = (opsOf("auditLog.findMany")[0].args as { where: Record<string, unknown> }).where;
  assert.ok(!("action" in where), "an invalid action must not reach the query");
});

test("audit-log: a valid action filter is applied", async () => {
  const t = await mintSession();
  await listAudit(t, "?action=AUTH_LOGIN");
  const where = (opsOf("auditLog.findMany")[0].args as { where: { action: string } }).where;
  assert.equal(where.action, "AUTH_LOGIN");
});

test("audit-log: action beats group when both are supplied", async () => {
  const t = await mintSession();
  await listAudit(t, "?action=AUTH_LOGIN&group=admin");
  const where = (opsOf("auditLog.findMany")[0].args as { where: { action: unknown } }).where;
  assert.equal(where.action, "AUTH_LOGIN");
});

test("audit-log: a group filter expands to that group's action list", async () => {
  const t = await mintSession();
  await listAudit(t, "?group=auth");
  const where = (opsOf("auditLog.findMany")[0].args as { where: { action: { in: string[] } } }).where;
  assert.ok(Array.isArray(where.action.in));
  assert.ok(where.action.in.includes("AUTH_LOGIN"));
});

test("audit-log: the user and target search terms are wildcard-stripped", async () => {
  const t = await mintSession();
  await listAudit(t, "?user=%25%5F%5C&target=%25%5F%5C");
  const where = (opsOf("auditLog.findMany")[0].args as { where: { userName: { contains: string }; target: { contains: string } } }).where;
  for (const ch of ["%", "_", "\\"]) {
    assert.ok(!where.userName.contains.includes(ch), `wildcard ${ch} reached userName`);
    assert.ok(!where.target.contains.includes(ch), `wildcard ${ch} reached target`);
  }
});

test("audit-log: an invalid date is ignored rather than producing an Invalid Date bind", async () => {
  const t = await mintSession();
  await listAudit(t, "?dateFrom=not-a-date");
  const where = (opsOf("auditLog.findMany")[0].args as { where: { createdAt?: { gte?: Date } } }).where;
  assert.ok(!where.createdAt?.gte, "an unparseable date must not reach the query");
});

test("audit-log: dateTo is inclusive of the requested day", async () => {
  const t = await mintSession();
  await listAudit(t, "?dateTo=2026-07-01");
  const where = (opsOf("auditLog.findMany")[0].args as { where: { createdAt: { lt: Date } } }).where;
  assert.equal(where.createdAt.lt.toISOString().slice(0, 10), "2026-07-02");
});

test("audit-log: hideCron excludes the system actor", async () => {
  const t = await mintSession();
  await listAudit(t, "?hideCron=1");
  const where = (opsOf("auditLog.findMany")[0].args as { where: { userId: { not: string } } }).where;
  assert.deepEqual(where.userId, { not: "system" });
});

test("audit-log: hasMore/nextCursor page correctly", async () => {
  const t = await mintSession();
  auditRows = Array.from({ length: 12 }, (_, i) =>
    audit({ id: `a${String(i).padStart(2, "0")}`, createdAt: new Date(Date.UTC(2026, 0, 1, 0, i)) }));
  const body = await (await listAudit(t, "?pageSize=10")).json();
  assert.equal(body.logs.length, 10);
  assert.equal(body.hasMore, true);
  assert.equal(body.nextCursor, body.logs[9].id);
});

test("audit-log: the final page reports hasMore false", async () => {
  const t = await mintSession();
  auditRows = [audit({ id: "a1" })];
  const body = await (await listAudit(t, "?pageSize=10")).json();
  assert.equal(body.hasMore, false);
});

// ── /api/admin/audit-log — the PII scrub ─────────────────────────────────────

test("scrub: redacts rather than deletes, and is cutoff-bounded", async () => {
  const t = await mintSession();
  const old = new Date(Date.now() - 200 * 86_400_000);
  auditRows = [audit({ id: "old", createdAt: old }), audit({ id: "new", createdAt: new Date() })];
  const res = await scrubAudit(t);
  assert.equal(res.status, 200);
  assert.equal(opsOf("auditLog.delete").length, 0);
  assert.equal(opsOf("auditLog.deleteMany").length, 0);
  for (const op of opsOf("auditLog.updateMany")) {
    const where = op.args as { createdAt?: { lt?: Date } };
    assert.ok(where.createdAt?.lt instanceof Date, "the scrub must stay cutoff-bounded");
  }
});

test("scrub: clears ipAddress, userAgent and userName on aged rows only", async () => {
  const t = await mintSession();
  const old = new Date(Date.now() - 200 * 86_400_000);
  auditRows = [audit({ id: "old", createdAt: old }), audit({ id: "recent", createdAt: new Date() })];
  await scrubAudit(t);
  const oldRow = auditRows.find((r) => r.id === "old")!;
  const newRow = auditRows.find((r) => r.id === "recent")!;
  assert.equal(oldRow.ipAddress, null);
  assert.equal(oldRow.userAgent, null);
  assert.equal(oldRow.userName, "[redacted]");
  assert.equal(newRow.ipAddress, "10.0.0.1", "a recent row must be untouched");
});

test("scrub: clears details on auth events but PRESERVES a USER_DELETE record", async () => {
  // A deletion record's details ARE the audit evidence; clearing them would
  // destroy the very thing the trail exists to keep.
  const t = await mintSession();
  const old = new Date(Date.now() - 200 * 86_400_000);
  auditRows = [
    audit({ id: "login", createdAt: old, action: "AUTH_LOGIN", details: '{"ip":"1.2.3.4"}' }),
    audit({ id: "del", createdAt: old, action: "USER_DELETE", details: '{"target":"bob"}' }),
  ];
  await scrubAudit(t);
  assert.equal(auditRows.find((r) => r.id === "login")!.details, null);
  assert.equal(auditRows.find((r) => r.id === "del")!.details, '{"target":"bob"}');
});

test("scrub: reports the counts and the cutoff it used", async () => {
  const t = await mintSession();
  auditRows = [audit({ id: "old", createdAt: new Date(Date.now() - 200 * 86_400_000) })];
  const body = await (await scrubAudit(t)).json();
  assert.equal(body.scrubbed, 1);
  assert.equal(typeof body.cutoff, "string");
  const ageDays = (Date.now() - new Date(body.cutoff).getTime()) / 86_400_000;
  assert.ok(ageDays > 80 && ageDays < 100, `cutoff is ${ageDays.toFixed(0)}d, expected ~90d`);
});

// ── /api/admin/audit-log/export ──────────────────────────────────────────────

test("export: anonymous is 401 and a plain USER is 403", async () => {
  assert.equal((await exportAudit(null)).status, 401);
  const t = await mintSession({ role: "USER", permissions: 0n });
  assert.equal((await exportAudit(t)).status, 403);
});

test("export: writes its audit row BEFORE the stream opens", async () => {
  // Without a paper trail a malicious admin could exfiltrate the whole trail
  // with no record; writing it pre-stream means a client abort can't skip it.
  const t = await mintSession();
  auditRows = [audit({ id: "a1" })];
  const res = await exportAudit(t);
  const created = opsOf("auditLog.create");
  assert.equal(created.length, 1);
  assert.equal((created[0].args as { data: { action: string } }).data.action, "AUDIT_LOG_EXPORT");
  const started = JSON.parse((created[0].args as { data: { details: string } }).data.details);
  assert.equal(started.status, "started");
  await readAll(res);
});

test("export: finalizes the audit row with the row count and completed status", async () => {
  const t = await mintSession();
  auditRows = [audit({ id: "a1" }), audit({ id: "a2" })];
  const res = await exportAudit(t);
  await readAll(res);
  const upd = opsOf("auditLog.update");
  assert.ok(upd.length >= 1, "the audit row was never finalized");
  const details = JSON.parse((upd[upd.length - 1].args as { data: { details: string } }).data.details);
  assert.equal(details.status, "completed");
  assert.equal(details.rowCount, 3); // the two fixtures + the export's own row
  assert.equal(details.truncated, false);
});

test("export: an INVALID DATE is rejected up front — never mid-stream", async () => {
  // Inside the stream's start() an Invalid Date throws after headers are sent,
  // producing a half-written export AND skipping the audit row — exfil evasion.
  const t = await mintSession();
  for (const q of ["?dateFrom=nonsense", "?dateTo=nonsense", "?dateFrom=2026-13-45"]) {
    ops = [];
    const res = await exportAudit(t, q);
    assert.equal(res.status, 400, `query ${q} should be rejected up front`);
    assert.equal(opsOf("auditLog.create").length, 0, "no audit row for a rejected export");
    assert.equal(opsOf("auditLog.findMany").length, 0, "no rows read for a rejected export");
  }
});

test("export: a mid-stream read failure still finalizes the audit row as aborted", async () => {
  const t = await mintSession();
  auditRows = [audit({ id: "a1" })];
  findManyThrowsAfter = 0; // the first page read inside the stream throws
  const res = await exportAudit(t);
  try { await readAll(res); } catch { /* the stream errors by design */ }
  const upd = opsOf("auditLog.update");
  assert.ok(upd.length >= 1, "an aborted export must still leave a record");
  const details = JSON.parse((upd[upd.length - 1].args as { data: { details: string } }).data.details);
  assert.equal(details.status, "aborted");
  assert.ok(details.error, "the failure reason should be recorded");
});

test("export: CSV formula-injection characters are neutralized", async () => {
  // A crafted username is the one place attacker-authored audit content reaches
  // a spreadsheet an operator opens.
  const t = await mintSession();
  auditRows = [
    audit({ id: "a1", userName: "=cmd|'/c calc'!A1" }),
    audit({ id: "a2", userName: "+SUM(1)" }),
    audit({ id: "a3", userName: "-2+3" }),
    audit({ id: "a4", userName: "@import" }),
  ];
  const text = await readAll(await exportAudit(t, "?format=csv"));
  for (const bad of ["=cmd", "+SUM", "-2+3", "@import"]) {
    assert.ok(!text.includes(`,${bad}`), `unescaped formula reached the CSV: ${bad}`);
  }
  assert.ok(text.includes("'=cmd") || text.includes(`"'=cmd`), "the = cell should be quote-prefixed");
});

test("export: CSV quotes cells containing commas, quotes and newlines", async () => {
  const t = await mintSession();
  auditRows = [audit({ id: "a1", userName: 'we, "the" people', target: "line1\nline2" })];
  const text = await readAll(await exportAudit(t, "?format=csv"));
  assert.ok(text.includes('"we, ""the"" people"'), `quoting failed: ${text.slice(0, 300)}`);
});

test("export: CSV carries the documented header row", async () => {
  const t = await mintSession();
  const text = await readAll(await exportAudit(t, "?format=csv"));
  assert.ok(text.startsWith("id,createdAt,userId,userName,action,target,details,ipAddress,userAgent,provider\n"));
});

test("export: JSON format emits a parseable array", async () => {
  const t = await mintSession();
  auditRows = [audit({ id: "a1" }), audit({ id: "a2" })];
  const text = await readAll(await exportAudit(t, "?format=json"));
  const parsed = JSON.parse(text);
  assert.ok(Array.isArray(parsed));
  assert.ok(parsed.length >= 2);
});

test("export: an unknown format falls back to CSV rather than erroring", async () => {
  const t = await mintSession();
  const res = await exportAudit(t, "?format=xml");
  assert.match(res.headers.get("content-type") ?? "", /text\/csv/);
  await readAll(res);
});

test("export: sets attachment disposition and nosniff", async () => {
  const t = await mintSession();
  const res = await exportAudit(t, "?format=csv");
  assert.match(res.headers.get("content-disposition") ?? "", /^attachment; filename="audit-log-\d{4}-\d{2}-\d{2}\.csv"$/);
  assert.equal(res.headers.get("x-content-type-options"), "nosniff");
  await readAll(res);
});

test("export: is rate-limited to 3 per hour per admin", async () => {
  const t = await mintSession();
  for (let i = 0; i < 3; i++) {
    const r = await exportAudit(t);
    assert.notEqual(r.status, 429, `export ${i + 1} should pass`);
    await readAll(r);
  }
  const limited = await exportAudit(t);
  assert.equal(limited.status, 429);
  assert.equal(opsOf("auditLog.create").length, 3, "a throttled export must not write a paper-trail row");
});

test("export: the filters actually applied are recorded on the audit row", async () => {
  const t = await mintSession();
  const res = await exportAudit(t, "?format=json&action=AUTH_LOGIN&hideCron=1&user=alice");
  await readAll(res);
  const started = JSON.parse((opsOf("auditLog.create")[0].args as { data: { details: string } }).data.details);
  assert.equal(started.filters.format, "json");
  assert.equal(started.filters.action, "AUTH_LOGIN");
  assert.equal(started.filters.hideCron, true);
  assert.equal(started.filters.user, "alice");
});

test("export: applies the same wildcard stripping as the list", async () => {
  const t = await mintSession();
  const res = await exportAudit(t, "?user=%25%5F%5C");
  await readAll(res);
  const read = opsOf("auditLog.findMany")[0];
  const where = (read.args as { where: { userName?: { contains: string } } }).where;
  if (where.userName) {
    for (const ch of ["%", "_", "\\"]) {
      assert.ok(!where.userName.contains.includes(ch), `wildcard ${ch} reached the export query`);
    }
  }
});
