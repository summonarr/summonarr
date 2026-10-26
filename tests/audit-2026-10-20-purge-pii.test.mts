// An account purge must leave no audit row that still names the person
// (findings F001/F006/F014 of the 2026-10-20 audit, plus the paging bug F015,
// pinned in tests/audit-scrub.test.mts; and the review's R10–R12).
//
// The purge scrubs `targetUser`/`targetEmail` from rows ABOUT the account, found
// by their `user:<id>` target. Two writers named a user under another target:
// an admin's single-session revoke — `session:<sid>`, with the display name (or
// the email) and the email in its details — and request moderation (approve,
// decline, delete) — `request:<rid>`, with `requestedBy`, the requester's name
// or email. Those rows kept the purged person's name and email past the purge,
// and `requestedBy` past every retention run too. Pinned here:
//
//   1. DELETE /api/admin/users/[id]/sessions writes both of its SESSION_REVOKE
//      rows under `user:<id>`, naming the account by `targetUserId` (+ the
//      display name only when it has one), the session in details, and never
//      the email. The row it writes is reached by the purge's scrub. (The
//      request routes' new shape is pinned in
//      tests/audit-2026-10-20-request-requester.test.mts.)
//   2. purgeUserDataInTx also scrubs the legacy `session:` rows naming this
//      account's email (read before the purge rewrites it) or its id, and the
//      `request:` moderation rows naming it by `requesterId` or, on older rows,
//      by its email — never by a display name. The audit fake applies
//      `contains`/`startsWith` as Postgres would — a LIKE with no ESCAPE, so `_`
//      and `%` are wildcards and a backslash escapes the next character — so an
//      email whose JSON form carries a backslash (a `"` or `\` in it) must
//      still be found, and another account's rows are left alone. It also
//      scrubs the moderation rows of every request the account still OWNS,
//      matched by request id alone (the review's R2: older display-name rows,
//      and rows naming a Discord placeholder merged into the account).
//   3. The audit-log table's SESSION_REVOKE and request summaries name the
//      account for both shapes. The suite renders no React, so the table's
//      formatSummary is type-stripped out of the .tsx source and run.
//
// No DB, no network: the route runs on the real prisma client with its
// delegates shadowed and a genuinely signed session JWT (the
// tests/admin-users-audit-routes.test.mts harness); the purge gets a fake tx.
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { createRequire, stripTypeScriptTypes } from "node:module";
import { AsyncLocalStorage } from "node:async_hooks";
import { readFileSync } from "node:fs";

(globalThis as { AsyncLocalStorage?: unknown }).AsyncLocalStorage = AsyncLocalStorage;

process.env.TOKEN_ENCRYPTION_KEY = "ab".repeat(32);
process.env.NEXTAUTH_SECRET = "purge-pii-2026-10-20-secret-0123456789ab";
process.env.AUTH_URL = "http://localhost:3000";
process.env.TRUST_PROXY = "true";
(process.env as Record<string, string | undefined>).NODE_ENV = "test";

globalThis.fetch = (() => { throw new Error("unexpected network call"); }) as unknown as typeof fetch;

const errors: string[] = [];
console.warn = () => {};
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
const { shadowPrismaModel, shadowPrismaClientMethod } = await import("./_helpers.mts");
const { signSessionJwt } = await import("../src/lib/session-jwt.ts");
const { getSessionCookieName } = await import("../src/lib/session-cookie.ts");
const { Permission } = await import("../src/lib/permissions.ts");
const { purgeUserDataInTx } = await import("../src/lib/account-lifecycle.ts");
const { requesterAuditDetails } = await import("../src/lib/audit-scrub.ts");

// ── route harness ────────────────────────────────────────────────────────────
type DbUser = Record<string, unknown> & { id: string; role: string; name: string | null; email: string };
const users = new Map<string, DbUser>();
const authSessions = new Map<string, { userId: string; deviceLabel: string | null }>();
type Written = { action: string; target: string; details: string | null };
let written: Written[] = [];

shadowPrismaModel(prisma, "user", {
  findUnique: async (args: { where: { id: string } }) => users.get(args.where.id) ?? null,
  update: async () => ({}),
});
shadowPrismaModel(prisma, "authSession", {
  findUnique: async (args: { where: { sessionId: string } }) => {
    const row = authSessions.get(args.where.sessionId);
    return row ? { id: `row-${args.where.sessionId}`, sessionId: args.where.sessionId, ...row } : null;
  },
  findMany: async (args: { where: { userId: string } }) =>
    [...authSessions].filter(([, r]) => r.userId === args.where.userId).map(([sessionId]) => ({ sessionId })),
  delete: async (args: { where: { sessionId: string } }) => { authSessions.delete(args.where.sessionId); return {}; },
  deleteMany: async (args: { where: { userId: string } }) => {
    let count = 0;
    for (const [sid, r] of authSessions) if (r.userId === args.where.userId) { authSessions.delete(sid); count++; }
    return { count };
  },
  update: async () => ({}),
});
shadowPrismaModel(prisma, "auditLog", {
  create: async (args: { data: Written }) => { written.push(args.data); return args.data; },
});
shadowPrismaModel(prisma, "setting", { findUnique: async () => null, findMany: async () => [] });
// Guardrail 6g: admin revoke-all clears session footholds in the same tx.
const noopDeleteMany = async () => ({ count: 0 });
shadowPrismaModel(prisma, "pushSubscription", { deleteMany: noopDeleteMany });
shadowPrismaModel(prisma, "discordLinkToken", { deleteMany: noopDeleteMany });
shadowPrismaModel(prisma, "discordMergeCode", { deleteMany: noopDeleteMany });
shadowPrismaModel(prisma, "verificationToken", { deleteMany: noopDeleteMany });
// The revoke helpers run their reads and deletes in a $transaction, behind the
// lock-42 role re-read: the tx is the shadowed client itself.
shadowPrismaClientMethod(prisma, "$executeRawUnsafe", async () => 0);
shadowPrismaClientMethod(prisma, "$transaction", async (fn: (tx: unknown) => Promise<unknown>) => fn(prisma));

const sessionsRoute = await import("../src/app/api/admin/users/[id]/sessions/route.ts");

let seq = 0;
async function mintAdmin(): Promise<string> {
  seq++;
  const id = `admin-${seq}`;
  const sessionId = `admin-sess-${seq}`;
  users.set(id, {
    id, name: `Admin ${seq}`, email: `admin-${seq}@example.com`, role: "ADMIN", permissions: Permission.ADMIN,
    mediaServer: null, sessionsRevokedAt: null, passwordChangedAt: null, deactivatedAt: null,
    notificationEmail: null, plexUserId: null,
  });
  authSessions.set(sessionId, { userId: id, deviceLabel: "admin laptop" });
  const iat = Math.floor(Date.now() / 1000);
  return signSessionJwt(
    { id, role: "ADMIN", permissions: Permission.ADMIN.toString(), provider: "credentials", sessionId, expiresAt: iat + 86_400 },
    { expiresInSeconds: 7_200, iat },
  );
}

function seedTarget(id: string, name: string | null, email: string): void {
  users.set(id, {
    id, name, email, role: "USER", permissions: 0n, mediaServer: null,
    sessionsRevokedAt: null, passwordChangedAt: null, deactivatedAt: null, notificationEmail: null, plexUserId: null,
  });
}

function inScope<T>(fn: () => Promise<T>): Promise<T> {
  const workStore = {
    route: "/audit-2026-10-20-purge-pii.test", forceStatic: false, dynamicShouldError: false,
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

async function revoke(token: string, targetId: string, body: unknown): Promise<Response> {
  const req = new NextRequest(`http://localhost:3000/api/admin/users/${targetId}/sessions`, {
    method: "DELETE",
    headers: { cookie: `${getSessionCookieName()}=${token}`, "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  const res = await inScope(() => sessionsRoute.DELETE(req, { params: Promise.resolve({ id: targetId }) }));
  // logAudit is fire-and-forget (guardrail 26).
  for (let i = 0; i < 5; i++) await new Promise((r) => setImmediate(r));
  return res;
}

function onlyRevokeRow(): Written & { parsed: Record<string, unknown> } {
  const rows = written.filter((w) => w.action === "SESSION_REVOKE");
  assert.equal(rows.length, 1, "one SESSION_REVOKE row");
  return { ...rows[0], parsed: JSON.parse(rows[0].details!) };
}

beforeEach(() => {
  written = [];
  errors.length = 0;
});

// ── 1. the route's rows ──────────────────────────────────────────────────────

test("single-session revoke: logged under user:<id> with the session in details, the name, and never the email", async () => {
  const token = await mintAdmin();
  seedTarget("u-named", "Alice Example", "alice@example.com");
  authSessions.set("sess-alice-phone", { userId: "u-named", deviceLabel: "iPhone" });

  const res = await revoke(token, "u-named", { sessionId: "sess-alice-phone" });
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { ok: true, revoked: "sess-alice-phone" }, "wire contract unchanged");

  const row = onlyRevokeRow();
  assert.equal(row.target, "user:u-named", "the purge's user:<id> scrub must be able to reach it");
  assert.deepEqual(row.parsed, {
    targetUserId: "u-named",
    targetUser: "Alice Example",
    sessionId: "sess-alice-phone",
    deviceLabel: "iPhone",
    adminAction: true,
  });
  assert.ok(!row.details!.includes("alice@example.com"), "the email is never written");
});

test("single-session revoke of an account with no display name: no targetUser, and no email in its place", async () => {
  const token = await mintAdmin();
  seedTarget("u-anon", null, "anon@example.com");
  authSessions.set("sess-anon-tv", { userId: "u-anon", deviceLabel: "Apple TV" });

  assert.equal((await revoke(token, "u-anon", { sessionId: "sess-anon-tv" })).status, 200);
  const row = onlyRevokeRow();
  assert.equal(row.target, "user:u-anon");
  assert.deepEqual(row.parsed, { targetUserId: "u-anon", sessionId: "sess-anon-tv", deviceLabel: "Apple TV", adminAction: true });
  assert.ok(!row.details!.includes("anon@example.com"));
});

test("revoke-all: targetUserId (+ the name when set), never targetEmail or an email fallback", async () => {
  const token = await mintAdmin();
  seedTarget("u-anon2", null, "anon2@example.com");
  authSessions.set("sess-anon2-a", { userId: "u-anon2", deviceLabel: "a" });
  const res = await revoke(token, "u-anon2", { all: true });
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { ok: true, revoked: "all" });
  let row = onlyRevokeRow();
  assert.equal(row.target, "user:u-anon2");
  assert.deepEqual(row.parsed, { targetUserId: "u-anon2", revokedAll: true, adminAction: true });
  assert.ok(!row.details!.includes("anon2@example.com"));

  written = [];
  seedTarget("u-named2", "Bea", "bea@example.com");
  assert.equal((await revoke(token, "u-named2", { all: true })).status, 200);
  row = onlyRevokeRow();
  assert.deepEqual(row.parsed, { targetUserId: "u-named2", targetUser: "Bea", revokedAll: true, adminAction: true });
  assert.ok(!row.details!.includes("bea@example.com"));
});

// ── 2. the purge ─────────────────────────────────────────────────────────────

type AuditRow = { id: string; action: string; target: string; userId: string | null; userName: string; details: string | null };
type Where = Record<string, unknown>;

// `contains` / `startsWith` as Postgres runs Prisma's: a case-sensitive LIKE on
// `%term%` / `term%`, the term bound unescaped with no ESCAPE clause
// (sanitize.ts) — so `_` and `%` are wildcards and a backslash is Postgres's
// default LIKE escape, which eats the one JSON writes before a `"` or `\`.
function like(value: string, pattern: string): boolean {
  const lit = (ch: string) => ch.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  let re = "";
  for (let i = 0; i < pattern.length; i++) {
    const ch = pattern[i];
    if (ch === "\\") re += lit(pattern[++i] ?? "");
    else if (ch === "%") re += "[\\s\\S]*";
    else if (ch === "_") re += "[\\s\\S]";
    else re += lit(ch);
  }
  return new RegExp(`^${re}$`).test(value);
}

function matches(r: AuditRow, w: Where): boolean {
  for (const [k, v] of Object.entries(w)) {
    if (k === "AND") {
      if (!(Array.isArray(v) ? v : [v]).every((c) => matches(r, c as Where))) return false;
    } else if (k === "OR") {
      if (!(v as Where[]).some((c) => matches(r, c))) return false;
    } else if (k === "id") {
      if (typeof v === "string" ? r.id !== v : !(r.id > (v as { gt: string }).gt)) return false;
    } else if (k === "NOT") {
      // SQL: NOT over a NULL comparison is NULL, so the row is not selected.
      if ((Array.isArray(v) ? v : [v]).some((c) => r.details == null || matches(r, c as Where))) return false;
    } else if (k === "action" || k === "userId") {
      if (typeof v === "object" && v !== null) {
        if (!(v as { in: string[] }).in.includes(String(r[k]))) return false;
      } else if (r[k] !== v) return false;
    } else if (k === "target" || k === "details") {
      const val = r[k];
      if (typeof v === "string") { if (val !== v) return false; continue; }
      const f = v as { contains?: string; startsWith?: string; in?: string[] };
      if (val == null) return false;
      if (f.in !== undefined && !f.in.includes(val)) return false;
      if (f.contains !== undefined && !like(val, `%${f.contains}%`)) return false;
      if (f.startsWith !== undefined && !like(val, `${f.startsWith}%`)) return false;
    } else {
      throw new Error(`fake auditLog: unhandled where key ${k}`);
    }
  }
  return true;
}

let store: AuditRow[] = [];
// MediaRequest ownership as the purge reads it (requestedBy). The purge keeps
// every request; only their ids are read.
let requests: Array<{ id: string; requestedBy: string }> = [];
let purgeOps: string[] = [];
let auditReads: Where[] = [];
let purgeUser: { deactivatedAt: Date | null; purgedAt: Date | null; email: string } | null = null;
let findUniqueSelect: unknown = null;

const record = (op: string) => async () => { purgeOps.push(op); return { count: 0 }; };
const purgeTx = {
  account: { deleteMany: record("account.deleteMany") },
  authSession: { deleteMany: record("authSession.deleteMany") },
  userTotp: { deleteMany: record("userTotp.deleteMany") },
  webAuthnCredential: { deleteMany: record("webAuthnCredential.deleteMany") },
  mfaRecoveryCode: { deleteMany: record("mfaRecoveryCode.deleteMany") },
  pushSubscription: { deleteMany: record("pushSubscription.deleteMany") },
  discordLinkToken: { deleteMany: record("discordLinkToken.deleteMany") },
  discordMergeCode: { deleteMany: record("discordMergeCode.deleteMany") },
  mediaServerUser: { updateMany: record("mediaServerUser.updateMany") },
  watchlistItem: { deleteMany: record("watchlistItem.deleteMany") },
  hiddenItem: { deleteMany: record("hiddenItem.deleteMany") },
  notification: { deleteMany: record("notification.deleteMany") },
  userRecommendation: { deleteMany: record("userRecommendation.deleteMany") },
  traktWatchedItem: { deleteMany: record("traktWatchedItem.deleteMany") },
  traktConnection: { deleteMany: record("traktConnection.deleteMany") },
  verificationToken: { deleteMany: record("verificationToken.deleteMany") },
  mediaRequest: {
    findMany: async (args: { where: { requestedBy: string }; select: unknown }) => {
      purgeOps.push("mediaRequest.findMany");
      assert.deepEqual(args.select, { id: true });
      return requests.filter((r) => r.requestedBy === args.where.requestedBy).map((r) => ({ id: r.id }));
    },
  },
  auditLog: {
    findMany: async (args: { where: Where; orderBy: unknown; take: number; cursor?: unknown }) => {
      purgeOps.push("auditLog.findMany");
      auditReads.push(args.where);
      assert.deepEqual(args.orderBy, { id: "asc" });
      assert.equal(args.cursor, undefined, "paged by a strict id bound, not a cursor");
      return store
        .filter((r) => matches(r, args.where))
        .sort((a, b) => (a.id < b.id ? -1 : 1))
        .slice(0, args.take)
        .map((r) => ({ id: r.id, details: r.details }));
    },
    updateMany: async (args: { where: Where; data: Partial<AuditRow> }) => {
      purgeOps.push("auditLog.updateMany");
      let count = 0;
      const byId = typeof args.where.id === "string" ? store.filter((r) => r.id === args.where.id) : store;
      for (const r of byId) if (matches(r, args.where)) { Object.assign(r, args.data); count++; }
      return { count };
    },
  },
  user: {
    findUnique: async (args: { select: unknown }) => {
      purgeOps.push("user.findUnique");
      findUniqueSelect = args.select;
      return purgeUser;
    },
    updateMany: async () => { purgeOps.push("user.updateMany"); return { count: 1 }; },
  },
} as unknown as Parameters<typeof purgeUserDataInTx>[0];

const PURGED = "u-purged";
const PURGED_EMAIL = "a_b@example.com"; // `_` is a LIKE wildcard
const NOW = new Date("2026-10-20T12:00:00.000Z");

const detailsOf = (id: string) => JSON.parse(store.find((r) => r.id === id)!.details!) as Record<string, unknown>;

beforeEach(() => {
  store = [];
  requests = [];
  purgeOps = [];
  auditReads = [];
  purgeUser = { deactivatedAt: new Date("2026-10-19T00:00:00.000Z"), purgedAt: null, email: PURGED_EMAIL };
  findUniqueSelect = null;
});

test("purge scrubs the row the single-session revoke route now writes (user:<id> target)", async () => {
  const token = await mintAdmin();
  seedTarget(PURGED, "Alice Example", PURGED_EMAIL);
  authSessions.set("sess-purged-ipad", { userId: PURGED, deviceLabel: "iPad" });
  assert.equal((await revoke(token, PURGED, { sessionId: "sess-purged-ipad" })).status, 200);
  const logged = onlyRevokeRow();
  store = [{ id: "r1", action: logged.action, target: logged.target, userId: "admin-x", userName: "Admin", details: logged.details }];

  await purgeUserDataInTx(purgeTx, PURGED, NOW);
  assert.deepEqual(detailsOf("r1"), { targetUserId: PURGED, sessionId: "sess-purged-ipad", deviceLabel: "iPad", adminAction: true },
    "who it was goes; which account id and which session stay");
});

test("purge scrubs LEGACY session:<sid> revoke rows naming this account's email or id — and leaves every other account's alone", async () => {
  const legacy = (id: string, details: Record<string, unknown>, extra: Partial<AuditRow> = {}): AuditRow => ({
    id, action: "SESSION_REVOKE", target: `session:${id}`, userId: "admin-1", userName: "Admin", details: JSON.stringify(details), ...extra,
  });
  store = [
    // Named account: targetUser was the display name.
    legacy("s1", { targetUser: "Alice Example", targetEmail: PURGED_EMAIL, deviceLabel: "iPhone", adminAction: true }),
    // No display name: targetUser fell back to the email.
    legacy("s2", { targetUser: PURGED_EMAIL, targetEmail: PURGED_EMAIL, deviceLabel: "TV", adminAction: true }),
    // Named by id.
    legacy("s3", { targetUserId: PURGED, targetUser: "Alice Example", deviceLabel: "Mac", adminAction: true }),
    // Another account whose email differs only where the purged one has a `_`
    // (a LIKE wildcard, had the email been a where term).
    legacy("s4", { targetUser: "Axel", targetEmail: "axb@example.com", deviceLabel: "phone", adminAction: true }),
    // Another account outright.
    legacy("s5", { targetUser: "Bob", targetEmail: "bob@example.com", deviceLabel: "phone", adminAction: true }),
    // The purged person's own revoke: nothing to strip (its actor name goes by userId).
    legacy("s6", { deviceLabel: "old phone", revokedByOwner: true }, { userId: PURGED, userName: PURGED_EMAIL }),
  ];

  await purgeUserDataInTx(purgeTx, PURGED, NOW);

  assert.ok(String(JSON.stringify(findUniqueSelect)).includes('"email":true'), "the email is read before the purge rewrites it");
  assert.deepEqual(detailsOf("s1"), { deviceLabel: "iPhone", adminAction: true });
  assert.deepEqual(detailsOf("s2"), { deviceLabel: "TV", adminAction: true });
  assert.deepEqual(detailsOf("s3"), { targetUserId: PURGED, deviceLabel: "Mac", adminAction: true });
  assert.deepEqual(detailsOf("s4"), { targetUser: "Axel", targetEmail: "axb@example.com", deviceLabel: "phone", adminAction: true },
    "a wildcard match on another account's email is not this account");
  assert.deepEqual(detailsOf("s5"), { targetUser: "Bob", targetEmail: "bob@example.com", deviceLabel: "phone", adminAction: true });
  assert.deepEqual(detailsOf("s6"), { deviceLabel: "old phone", revokedByOwner: true });
  assert.equal(store.find((r) => r.id === "s6")!.userName, "[redacted]");
  // Inside the purge, before the row's own scrub — and nothing is swallowed.
  assert.ok(purgeOps.lastIndexOf("auditLog.findMany") < purgeOps.indexOf("user.updateMany"));
  assert.deepEqual(errors, []);
});

test("purge's legacy scrub reaches every one of 1,001 legacy rows (past two full batches)", async () => {
  for (let i = 0; i < 1001; i++) {
    store.push({
      id: `s${String(i).padStart(5, "0")}`, action: "SESSION_REVOKE", target: `session:x${i}`, userId: "admin-1", userName: "Admin",
      details: JSON.stringify({ targetUser: "Alice Example", targetEmail: PURGED_EMAIL, deviceLabel: `d${i}`, adminAction: true }),
    });
  }
  await purgeUserDataInTx(purgeTx, PURGED, NOW);
  assert.deepEqual(store.filter((r) => r.details!.includes("target")).map((r) => r.id), []);
});

// The R11/R12 class: JSON writes `\"` for a quote and `\\` for a backslash in
// the address, and a LIKE with no ESCAPE reads that backslash as an escape — a
// `where` term built from the email never matched the stored text.
const AWKWARD_EMAILS = ['o"brien@example.com', "a\\b@example.com"];

test("purge scrubs legacy session revoke rows for an email with a quote or a backslash — and not a look-alike account's", async () => {
  for (const email of [...AWKWARD_EMAILS, "a@b.com"]) {
    store = [
      { id: "s1", action: "SESSION_REVOKE", target: "session:p1", userId: "admin-1", userName: "Admin",
        details: JSON.stringify({ targetUser: email, targetEmail: email, deviceLabel: "iPhone", adminAction: true }) },
      { id: "s2", action: "SESSION_REVOKE", target: "session:p2", userId: "admin-1", userName: "Admin",
        details: JSON.stringify({ targetUser: "Xa", targetEmail: `x${email}`, deviceLabel: "phone", adminAction: true }) },
    ];
    purgeUser = { deactivatedAt: new Date("2026-10-19T00:00:00.000Z"), purgedAt: null, email };
    await purgeUserDataInTx(purgeTx, PURGED, NOW);
    assert.deepEqual(detailsOf("s1"), { deviceLabel: "iPhone", adminAction: true }, `${email}: found and scrubbed`);
    assert.deepEqual(detailsOf("s2"), { targetUser: "Xa", targetEmail: `x${email}`, deviceLabel: "phone", adminAction: true },
      `x${email} is another account`);
  }
});

test("purge scrubs the requester from its requests' moderation rows — by requesterId, or on older rows by the email — and nothing else", async () => {
  const OTHER = "u-other";
  const mod = (id: string, action: string, details: Record<string, unknown>, target = `request:${id}`): AuditRow => ({
    id, action, target, userId: "admin-1", userName: "Admin", details: JSON.stringify(details),
  });
  const base = { title: "The Matrix", mediaType: "MOVIE", year: "1999" };
  store = [
    // New rows, as the request routes write them (requesterAuditDetails).
    mod("q1", "REQUEST_APPROVE", { ...base, ...requesterAuditDetails(PURGED, "Alice Example"), before: { status: "PENDING" } }),
    mod("q2", "REQUEST_DELETE", { ...base, ...requesterAuditDetails(PURGED, null) }),
    mod("q3", "REQUEST_DECLINE", { ...base, ...requesterAuditDetails(OTHER, "Alice Example"), adminNote: null }),
    // Older rows: `requestedBy` alone — the email when the account had no name.
    mod("q4", "REQUEST_DECLINE", { ...base, requestedBy: PURGED_EMAIL }),
    mod("q5", "REQUEST_DELETE", { ...base, requestedBy: "axb@example.com" }), // `_` wildcard look-alike
    // A display name is never a match: another account may share it. (No
    // request here is the account's; the owned-request pass is pinned below.)
    mod("q6", "REQUEST_APPROVE", { ...base, requestedBy: "Alice Example" }),
    // Not a single-request moderation row.
    mod("q7", "SETTINGS_CHANGE", { requestedBy: PURGED_EMAIL }, "request:q7:adminNote"),
    mod("q8", "REQUEST_APPROVE", { batch: true, count: 2, ids: ["a", "b"], requestedBy: PURGED_EMAIL }, "batch:2"),
  ];

  await purgeUserDataInTx(purgeTx, PURGED, NOW);

  assert.deepEqual(detailsOf("q1"), { ...base, requesterId: PURGED, before: { status: "PENDING" } }, "who it was goes, which account id stays");
  assert.deepEqual(detailsOf("q2"), { ...base, requesterId: PURGED }, "nothing to strip on an unnamed account's row");
  assert.deepEqual(detailsOf("q3"), { ...base, requesterId: OTHER, requestedBy: "Alice Example", adminNote: null }, "another account's row, same name");
  assert.deepEqual(detailsOf("q4"), { ...base });
  assert.deepEqual(detailsOf("q5"), { ...base, requestedBy: "axb@example.com" });
  assert.deepEqual(detailsOf("q6"), { ...base, requestedBy: "Alice Example" }, "left for the retention scrub");
  assert.deepEqual(detailsOf("q7"), { requestedBy: PURGED_EMAIL });
  assert.deepEqual(detailsOf("q8"), { batch: true, count: 2, ids: ["a", "b"], requestedBy: PURGED_EMAIL });
  assert.ok(purgeOps.lastIndexOf("auditLog.findMany") < purgeOps.indexOf("user.updateMany"), "inside the purge, before the row's own scrub");
  assert.deepEqual(errors, []);
});

test("purge scrubs older request moderation rows for an email with a quote or a backslash — and not a look-alike account's", async () => {
  for (const email of [...AWKWARD_EMAILS, "a@b.com"]) {
    store = [
      { id: "q1", action: "REQUEST_APPROVE", target: "request:q1", userId: "admin-1", userName: "Admin",
        details: JSON.stringify({ title: "T", requestedBy: email }) },
      { id: "q2", action: "REQUEST_DECLINE", target: "request:q2", userId: "admin-1", userName: "Admin",
        details: JSON.stringify({ title: "T", requestedBy: `x${email}` }) },
    ];
    purgeUser = { deactivatedAt: new Date("2026-10-19T00:00:00.000Z"), purgedAt: null, email };
    await purgeUserDataInTx(purgeTx, PURGED, NOW);
    assert.deepEqual(detailsOf("q1"), { title: "T" }, `${email}: found and scrubbed`);
    assert.deepEqual(detailsOf("q2"), { title: "T", requestedBy: `x${email}` }, `x${email} is another account`);
  }
});

test("purge's requester scrub reaches every one of 1,001 rows (past two full batches)", async () => {
  for (let i = 0; i < 1001; i++) {
    store.push({
      id: `q${String(i).padStart(5, "0")}`, action: "REQUEST_APPROVE", target: `request:r${i}`, userId: "admin-1", userName: "Admin",
      details: JSON.stringify(i % 2 === 0 ? { n: i, ...requesterAuditDetails(PURGED, "Alice Example") } : { n: i, requestedBy: PURGED_EMAIL }),
    });
  }
  await purgeUserDataInTx(purgeTx, PURGED, NOW);
  assert.deepEqual(store.filter((r) => r.details!.includes("requestedBy")).map((r) => r.id), []);
});

// The review's R2 gap: the requester pass above can't reach a row that names the
// requester by display name only (every row from before 2026-10-20), nor a new
// row whose requesterId is a Discord placeholder that discord-merge.ts folded
// into this account (it moves the requests, then deletes the placeholder). The
// purge also scrubs the moderation rows of every request the account still
// OWNS, matched by the request id alone — exact, so no name has to match.
test("purge scrubs the moderation rows of requests the account still owns — by request id, whatever name or placeholder id they carry", async () => {
  const OTHER = "u-other";
  requests = [
    { id: "r-own-old", requestedBy: PURGED },
    { id: "r-own-merged", requestedBy: PURGED },
    { id: "r-own-new", requestedBy: PURGED },
    { id: "r-other", requestedBy: OTHER },
  ];
  const mod = (id: string, action: string, target: string, details: Record<string, unknown>): AuditRow => ({
    id, action, target, userId: "admin-1", userName: "Admin", details: JSON.stringify(details),
  });
  const base = { title: "The Matrix", mediaType: "MOVIE", year: "1999" };
  store = [
    // (a) declined before 2026-10-20: the display name alone.
    mod("m1", "REQUEST_DECLINE", "request:r-own-old", { ...base, requestedBy: "Alice Smith", adminNote: null }),
    // (b) a Discord placeholder's request, approved on the web, then merged in.
    mod("m2", "REQUEST_APPROVE", "request:r-own-merged", { ...base, ...requesterAuditDetails("dplaceholder", "alice#1234") }),
    mod("m3", "REQUEST_DELETE", "request:r-own-new", { ...base, requestedBy: "Alice Smith" }),
    // Another account's request, same display name: not this person's row.
    mod("m4", "REQUEST_APPROVE", "request:r-other", { ...base, requestedBy: "Alice Smith" }),
    // Not a single-request moderation row on that request (its own target).
    mod("m5", "SETTINGS_CHANGE", "request:r-own-old:adminNote", { requestedBy: "Alice Smith" }),
  ];

  await purgeUserDataInTx(purgeTx, PURGED, NOW);

  assert.deepEqual(detailsOf("m1"), { ...base, adminNote: null }, "an older display-name row on a request it owns");
  assert.deepEqual(detailsOf("m2"), { ...base, requesterId: "dplaceholder" }, "a merged placeholder's row: the name goes, the id stays");
  assert.deepEqual(detailsOf("m3"), { ...base });
  assert.deepEqual(detailsOf("m4"), { ...base, requestedBy: "Alice Smith" }, "another account's request is untouched");
  assert.deepEqual(detailsOf("m5"), { requestedBy: "Alice Smith" });
  // The ids are read inside the purge, before the row's own scrub; nothing is swallowed.
  assert.ok(purgeOps.indexOf("mediaRequest.findMany") < purgeOps.indexOf("user.updateMany"));
  assert.ok(purgeOps.lastIndexOf("auditLog.findMany") < purgeOps.indexOf("user.updateMany"));
  assert.deepEqual(errors, []);
});

test("purge's owned-request scrub reaches every one of 1,201 requests, at most 500 ids per read", async () => {
  for (let i = 0; i < 1201; i++) {
    const rid = `r${String(i).padStart(5, "0")}`;
    requests.push({ id: rid, requestedBy: PURGED });
    store.push({
      id: `m${String(i).padStart(5, "0")}`, action: i % 3 === 0 ? "REQUEST_DELETE" : "REQUEST_APPROVE", target: `request:${rid}`,
      userId: "admin-1", userName: "Admin", details: JSON.stringify({ n: i, requestedBy: "Alice Smith" }),
    });
  }
  await purgeUserDataInTx(purgeTx, PURGED, NOW);
  assert.deepEqual(store.filter((r) => r.details!.includes("requestedBy")).map((r) => r.id), []);
  const lists = auditReads
    .map((w) => (w.target as { in?: string[] } | undefined)?.in)
    .filter((l): l is string[] => Array.isArray(l));
  assert.ok(lists.length >= 3, "1,201 ids take three chunks");
  assert.ok(lists.every((l) => l.length <= 500), "each IN list stays within one chunk");
});

// ── 3. the audit-log table ───────────────────────────────────────────────────

const tableSrc = readFileSync(new URL("../src/components/admin/audit-log-table.tsx", import.meta.url), "utf8");
const fnStart = tableSrc.indexOf("function formatSummary(");
assert.ok(fnStart >= 0, "formatSummary is in the table source");
const fnSrc = stripTypeScriptTypes(tableSrc.slice(fnStart, tableSrc.indexOf("\n}\n", fnStart) + 2));
type Summary = (action: string, d: Record<string, unknown>, t: (key: string, vars?: Record<string, unknown>) => string) => string | null;
// The table's own source, type-stripped (the suite renders no .tsx).
const formatSummary = new Function(`${fnSrc}\nreturn formatSummary;`)() as Summary;
const en = JSON.parse(readFileSync(new URL("../src/lib/i18n/messages/en/adminManage.json", import.meta.url), "utf8")) as Record<string, string>;
const t = (key: string, vars: Record<string, unknown> = {}) => en[key].replace(/\{(\w+)\}/g, (_, n: string) => String(vars[n]));

test("audit table: a SESSION_REVOKE row names the account AND the device, in the new shape and the legacy one", () => {
  assert.equal(
    formatSummary("SESSION_REVOKE", { targetUserId: "u1", targetUser: "Alice", sessionId: "s1", deviceLabel: "iPhone", adminAction: true }, t),
    "User: Alice · Device: iPhone · by admin",
  );
  assert.equal(
    formatSummary("SESSION_REVOKE", { targetUserId: "u1", sessionId: "s1", deviceLabel: "iPhone", adminAction: true }, t),
    "User: u1 · Device: iPhone · by admin",
    "no display name: the account id, never a blank",
  );
  assert.equal(
    formatSummary("SESSION_REVOKE", { targetUser: "Alice", targetEmail: "a@example.com", deviceLabel: "iPhone", adminAction: true }, t),
    "User: Alice · Device: iPhone · by admin",
    "a legacy session:<sid> row still reads the same",
  );
  assert.equal(formatSummary("SESSION_REVOKE", { targetUserId: "u1", revokedAll: true, adminAction: true }, t), "User: u1 · All sessions · by admin");
  assert.equal(formatSummary("SESSION_REVOKE", { deviceLabel: "old phone", revokedByOwner: true }, t), "Device: old phone · by owner");
});

test("audit table: a request moderation row names the requester in the new shape, the legacy one, and after a scrub", () => {
  const base = { title: "The Matrix", mediaType: "MOVIE", year: "1999" };
  assert.equal(
    formatSummary("REQUEST_APPROVE", { ...base, requesterId: "u1", requestedBy: "Alice" }, t),
    '"The Matrix" (movie) [1999] requested by Alice',
  );
  assert.equal(
    formatSummary("REQUEST_DECLINE", { ...base, requesterId: "u1" }, t),
    '"The Matrix" (movie) [1999] requested by u1',
    "no display name (or scrubbed): the account id, never a blank",
  );
  assert.equal(
    formatSummary("REQUEST_DELETE", { ...base, requestedBy: "alice@example.com" }, t),
    '"The Matrix" (movie) [1999] requested by alice@example.com',
    "a legacy row still reads the same",
  );
  assert.equal(formatSummary("REQUEST_DELETE", { ...base }, t), '"The Matrix" (movie) [1999]', "a legacy row after the scrub");
  // The on-behalf row is ABOUT the account (`user:<id>`): targetUserId + the name.
  const tp = (key: string, vars: Record<string, unknown> = {}) => t(key in en ? key : `${key}_other`, vars);
  assert.equal(formatSummary("REQUEST_ON_BEHALF", { targetUserId: "u1", created: 2 }, tp), "2 requests created for u1");
  assert.equal(formatSummary("REQUEST_ON_BEHALF", { targetUserId: "u1", targetUser: "Alice", created: 2 }, tp), "2 requests created for Alice");
  assert.equal(formatSummary("REQUEST_ON_BEHALF", { targetUser: "alice@example.com", created: 2 }, tp), "2 requests created for alice@example.com", "legacy");
});

test("audit table: the user-admin rows name the account by display name, else by targetUserId — and legacy rows read as before", () => {
  const cases: Array<[string, Record<string, unknown>, string]> = [
    ["USER_PERMISSIONS_CHANGE", { targetUserId: "u1", targetUser: "Alice", before: "0", after: "16" }, "User: Alice"],
    ["USER_PERMISSIONS_CHANGE", { field: "instanceGrants", targetUserId: "u1", after: {} }, "User: u1"],
    ["USER_PERMISSIONS_CHANGE", { targetUser: "alice@example.com", before: "0", after: "16" }, "User: alice@example.com"],
    ["MFA_RESET", { targetUserId: "u1", targetUser: "Alice", role: "USER" }, "User: Alice"],
    ["MFA_RESET", { targetUserId: "u1", role: "USER" }, "User: u1"],
    ["MFA_RESET", { targetUser: "alice@example.com", role: "USER" }, "User: alice@example.com"],
    ["USER_REACTIVATE", { targetUserId: "u1", targetUser: "Alice", role: "USER" }, "Re-enabled Alice"],
    ["USER_REACTIVATE", { targetUserId: "u1", role: "USER" }, "Re-enabled u1"],
    ["USER_REACTIVATE", { targetUser: "Alice", targetEmail: "a@example.com", role: "USER" }, "Re-enabled Alice (a@example.com)"],
  ];
  for (const [action, d, want] of cases) assert.equal(formatSummary(action, d, t), want, `${action} ${JSON.stringify(d)}`);
});
