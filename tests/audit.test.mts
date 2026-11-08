// Unit tests for the audit writers (src/lib/audit.ts) — logAudit, logAuditOrFail,
// and auditContext. The load-bearing contract here is guardrail 26's two-variant
// split, pinned HARD:
//
//   - logAudit SWALLOWS a failed write (resolves, logs with the [audit] scope):
//     it is the only variant safe AFTER a mutation has committed, where a
//     transient audit failure must never turn a successful destructive op into
//     a 500 (the retry then 404s with no trail, or double-applies);
//   - logAuditOrFail PROPAGATES the same failure — it exists for use INSIDE a
//     $transaction as the last op, so a failed audit rolls the mutation back.
//     It must NOT log the error itself (the throw is the signal; the enclosing
//     tx owns the outcome);
//   - both variants write the IDENTICAL row for identical params — one field
//     mapping, two error policies. The mapping: userName/target sanitized
//     (sanitizeText — HTML angle brackets, bidi overrides, trim; full matrix
//     owned by tests/sanitize.test.mts), nullish userName → "unknown" (empty
//     string is NOT nullish and stays empty), details JSON-stringified or null,
//     every optional context field ?? null, and a null userId (machine actor)
//     passes through — the column is nullable by design;
//   - auditContext shapes the request context: user-agent capped at 512 chars
//     (VarChar guard) or null, provider read defensively off the session, and
//     ipAddress delegated to getClientIp — untrusted deployments get the
//     spoof-proof "unknown:<ua-hash>" bucket (a forged X-Forwarded-For must NOT
//     land in audit rows), trusted ones the rightmost forwarded hop. The full
//     XFF matrix is owned by tests/rate-limit.test.mts; what's pinned here is
//     the delegation and the spoof-resistance property audit rows inherit.
//
// No DB: the auditLog delegate is shadowed in-memory (tests/_helpers.mts).
// console.warn/error are captured BEFORE the module graph loads — rate-limit.ts
// (imported for getClientIp) warns at module load when TRUST_PROXY is unset.
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";

process.env.TOKEN_ENCRYPTION_KEY = "ab".repeat(32); // prisma.ts pulls in token-crypto

// ── console capture (before imports — rate-limit warns at module load) ──────
const warns: string[] = [];
const errors: string[] = [];
console.warn = (...args: unknown[]) => { warns.push(args.map(String).join(" ")); };
console.error = (...args: unknown[]) => { errors.push(args.map(String).join(" ")); };

// Dynamic imports so the env/console stubs above genuinely precede the
// module-graph load (static imports would hoist above them).
const { prisma } = await import("../src/lib/prisma.ts");
const { shadowPrismaModel } = await import("./_helpers.mts");

type CreateArgs = { data: Record<string, unknown> };
const creates: CreateArgs[] = [];
let createError: Error | null = null;

shadowPrismaModel(prisma, "auditLog", {
  create: async (args: CreateArgs) => {
    creates.push(args);
    if (createError) throw createError;
    return { id: `row-${creates.length}`, ...args.data };
  },
});

const { logAudit, logAuditOrFail, logAuditOrFailReturningId, logAuditTx, auditContext } = await import("../src/lib/audit.ts");

beforeEach(() => {
  creates.length = 0;
  warns.length = 0;
  errors.length = 0;
  createError = null;
});

// ── field mapping ───────────────────────────────────────────────────────────

test("logAudit writes the exact row: passthrough ids, null-normalized optionals", async () => {
  await logAudit({
    userId: "u1",
    userName: "Chris",
    action: "USER_DELETE",
    target: "user:victim-id",
  });
  assert.equal(creates.length, 1);
  assert.deepEqual(creates[0].data, {
    userId: "u1",
    userName: "Chris",
    action: "USER_DELETE",
    target: "user:victim-id",
    details: null,
    ipAddress: null,
    userAgent: null,
    provider: null,
    sessionId: null,
  });
  assert.deepEqual(errors, []); // silent success (guardrail 7)
});

test("nullish userName → 'unknown'; empty string stays empty; null userId (machine actor) passes through", async () => {
  await logAudit({ userId: null, userName: null, action: "LIBRARY_SYNC", target: "sync" });
  await logAudit({ userId: null, userName: undefined, action: "LIBRARY_SYNC", target: "sync" });
  await logAudit({ userId: "u2", userName: "", action: "LIBRARY_SYNC", target: "sync" });
  assert.equal(creates[0].data.userName, "unknown");
  assert.equal(creates[0].data.userId, null); // nullable column, not "" or "unknown"
  assert.equal(creates[1].data.userName, "unknown");
  assert.equal(creates[2].data.userName, ""); // ?? is nullish-only — "" is a real (empty) name
});

test("userName and target are sanitized before storage (angle brackets, bidi overrides, trim)", async () => {
  await logAudit({
    userId: "u1",
    userName: "  <b>Eve‮</b> ",
    action: "AUTH_LOGIN_FAILED",
    target: "login:<script>alert(1)</script>",
  });
  // sanitizeText strips <>, bidi controls, and trims — full matrix in
  // tests/sanitize.test.mts; pinned here: it IS applied to both fields.
  assert.equal(creates[0].data.userName, "bEve/b");
  assert.equal(creates[0].data.target, "login:scriptalert(1)/script");
});

test("details serialize to a JSON string; absent → null; an empty object is '{}', not null", async () => {
  await logAudit({
    userId: "u1",
    userName: "n",
    action: "USER_ROLE_CHANGE",
    target: "user:x",
    details: { role: "ADMIN", prev: "USER" },
  });
  await logAudit({ userId: "u1", userName: "n", action: "USER_ROLE_CHANGE", target: "user:x" });
  await logAudit({
    userId: "u1",
    userName: "n",
    action: "USER_ROLE_CHANGE",
    target: "user:x",
    details: {},
  });
  assert.equal(creates[0].data.details, '{"role":"ADMIN","prev":"USER"}');
  assert.equal(creates[1].data.details, null);
  assert.equal(creates[2].data.details, "{}"); // truthiness gate: {} is truthy
});

test("provided context fields pass through verbatim", async () => {
  await logAudit({
    userId: "u1",
    userName: "n",
    action: "SESSION_REVOKE",
    target: "session:s1",
    ipAddress: "203.0.113.7",
    userAgent: "Summonarr-iOS/12 iPhone",
    provider: "plex",
    sessionId: "sess-1",
  });
  const row = creates[0].data;
  assert.equal(row.ipAddress, "203.0.113.7");
  assert.equal(row.userAgent, "Summonarr-iOS/12 iPhone");
  assert.equal(row.provider, "plex");
  assert.equal(row.sessionId, "sess-1");
});

// ── the two-variant error contract (guardrail 26) ───────────────────────────

test("GUARDRAIL 26: logAudit swallows a failed write — resolves and logs with the [audit] scope", async () => {
  createError = new Error("insert exploded");
  // Must NOT reject: a failed audit write never breaks the triggering request.
  await logAudit({ userId: "u1", userName: "n", action: "USER_DELETE", target: "user:x" });
  assert.equal(creates.length, 1); // the write was attempted
  assert.equal(errors.length, 1);
  assert.ok(
    errors[0].includes("[audit] Failed to write audit log:"),
    `scoped swallow log, got: ${errors[0]}`,
  );
});

test("GUARDRAIL 26: logAuditOrFail PROPAGATES the same failure (in-tx rollback) and does not log it", async () => {
  const boom = new Error("insert exploded");
  createError = boom;
  await assert.rejects(
    () => logAuditOrFail({ userId: "u1", userName: "n", action: "USER_DELETE", target: "user:x" }),
    (err: unknown) => err === boom, // the ORIGINAL error, so P2002 mapping etc. still works upstream
  );
  assert.deepEqual(errors, []); // the throw is the signal — no double logging
});

test("logAudit and logAuditOrFail write byte-identical rows for identical params", async () => {
  const params = {
    userId: "u9",
    userName: " <Admin> ",
    action: "BACKUP_EXPORT",
    target: "backup:<file>",
    details: { bytes: 42 },
    ipAddress: "198.51.100.2",
    userAgent: "curl/8",
    provider: "credentials",
    sessionId: "sess-9",
  } as const;
  await logAudit(params);
  await logAuditOrFail(params);
  assert.equal(creates.length, 2);
  assert.deepEqual(creates[1].data, creates[0].data); // one mapping, two error policies
});

test("logAuditTx writes, on the transaction client it is given, the row logAuditOrFail writes — the user agent's controls and bidi overrides stripped", async () => {
  const params = {
    userId: "u9",
    userName: "Admin",
    action: "ISSUE_DELETE",
    target: "issue:abc",
    details: { action: "delete" },
    ipAddress: "198.51.100.2",
    userAgent: "curl/8\x1b[2J\u202Eevil",
    provider: "credentials",
  } as const;
  await logAuditOrFail(params);
  const txCreates: CreateArgs[] = [];
  const tx = { auditLog: { create: async (args: CreateArgs) => { txCreates.push(args); return args.data; } } };
  await logAuditTx(tx as unknown as Parameters<typeof logAuditTx>[0], params);
  assert.equal(creates.length, 1, "the transaction client is written, never the global one");
  assert.equal(txCreates.length, 1);
  assert.deepEqual(txCreates[0].data, creates[0].data);
  assert.equal(txCreates[0].data.userAgent, "curl/8[2Jevil");
});

test("logAuditOrFailReturningId writes the logAuditOrFail row, answers its id, and propagates a failed write", async () => {
  const params = { userId: "u9", userName: "Admin", action: "AUDIT_LOG_EXPORT", target: "audit-log:export", userAgent: "curl/8\x1b[2J\u202Eevil" } as const;
  await logAuditOrFail(params);
  const id = await logAuditOrFailReturningId(params);
  assert.equal(creates.length, 2);
  assert.deepEqual(creates[1].data, creates[0].data);
  assert.equal(creates[1].data.userAgent, "curl/8[2Jevil");
  assert.deepEqual((creates[1] as { select?: unknown }).select, { id: true });
  assert.equal(id, "row-2");
  const boom = new Error("insert exploded");
  createError = boom;
  await assert.rejects(() => logAuditOrFailReturningId(params), (err: unknown) => err === boom);
  assert.deepEqual(errors, []);
});

test("GUARDRAIL 23/26: logAuditTx PROPAGATES a failed write, so the transaction it sits in rolls back", async () => {
  const boom = new Error("insert exploded");
  const tx = { auditLog: { create: async () => { throw boom; } } };
  await assert.rejects(
    () => logAuditTx(tx as unknown as Parameters<typeof logAuditTx>[0], { userId: "u1", userName: "n", action: "ISSUE_DELETE", target: "issue:x" }),
    (err: unknown) => err === boom,
  );
  assert.deepEqual(errors, []);
});

// ── auditContext ────────────────────────────────────────────────────────────

test("auditContext caps the user-agent at 512 chars and nulls it when absent", () => {
  const long = "M".repeat(600);
  // Accepts a real Request…
  const withUa = auditContext(new Request("http://localhost/api/x", { headers: { "user-agent": long } }));
  assert.equal((withUa.userAgent as string).length, 512);
  assert.equal(withUa.userAgent, long.slice(0, 512));
  // …and the bare { headers } shape, with no UA → null (not "").
  const withoutUa = auditContext({ headers: new Headers() });
  assert.equal(withoutUa.userAgent, null);
});

test("auditContext reads the provider defensively off the session — null for anonymous/absent shapes", () => {
  const headers = new Headers();
  assert.equal(auditContext({ headers }, { user: { provider: "jellyfin" } }).provider, "jellyfin");
  assert.equal(auditContext({ headers }).provider, null);
  assert.equal(auditContext({ headers }, null).provider, null);
  assert.equal(auditContext({ headers }, {}).provider, null);
  assert.equal(auditContext({ headers }, { user: {} }).provider, null);
});

test("without TRUST_PROXY, a forged X-Forwarded-For never lands in the audit row — UA-hash bucket instead", () => {
  const saved = process.env.TRUST_PROXY;
  try {
    delete process.env.TRUST_PROXY;
    const ctx = auditContext({
      headers: new Headers({ "x-forwarded-for": "6.6.6.6", "user-agent": "Mozilla/5.0" }),
    });
    // The spoofable header is ignored; the bucket is a UA fingerprint.
    assert.match(String(ctx.ipAddress), /^unknown:[0-9a-f]{12}$/);
    const other = auditContext({
      headers: new Headers({ "x-forwarded-for": "6.6.6.6", "user-agent": "curl/8" }),
    });
    assert.notEqual(other.ipAddress, ctx.ipAddress); // distinct clients, distinct buckets
  } finally {
    if (saved === undefined) delete process.env.TRUST_PROXY;
    else process.env.TRUST_PROXY = saved;
  }
});

test("behind a trusted proxy, audit rows record the RIGHTMOST forwarded hop (spoof-resistant), via getClientIp", () => {
  const savedTrust = process.env.TRUST_PROXY;
  const savedHops = process.env.TRUSTED_PROXY_HOPS;
  try {
    process.env.TRUST_PROXY = "true";
    delete process.env.TRUSTED_PROXY_HOPS; // default: 1 trusted hop
    const ctx = auditContext({
      headers: new Headers({ "x-forwarded-for": "6.6.6.6, 203.0.113.7" }),
    });
    // The leftmost entry is client-forgeable; only the entry the trusted proxy
    // appended is credible. Full matrix in tests/rate-limit.test.mts.
    assert.equal(ctx.ipAddress, "203.0.113.7");
  } finally {
    if (savedTrust === undefined) delete process.env.TRUST_PROXY;
    else process.env.TRUST_PROXY = savedTrust;
    if (savedHops === undefined) delete process.env.TRUSTED_PROXY_HOPS;
    else process.env.TRUSTED_PROXY_HOPS = savedHops;
  }
});

// ── auditActor / finalizeAuditRow ───────────────────────────────────────────

test("auditActor names the signed-in actor (name, else email) beside the request context", async () => {
  const { auditActor } = await import("../src/lib/audit.ts");
  const req = new Request("http://localhost/api/x", { headers: { "user-agent": "ua/1" } });
  const named = auditActor(req, { user: { id: "u1", name: "Ann", email: "ann@example.com", provider: "credentials" } });
  assert.equal(named.userId, "u1");
  assert.equal(named.userName, "Ann");
  assert.equal(named.userAgent, "ua/1");
  assert.equal(named.provider, "credentials");
  assert.equal(auditActor(req, { user: { id: "u2", name: null, email: "bob@example.com" } }).userName, "bob@example.com");
  assert.equal(auditActor(req, { user: { id: "u3" } }).userName, null);
});

test("finalizeAuditRow rewrites the row's details and swallows a failed write with the caller's scope", async () => {
  const { finalizeAuditRow } = await import("../src/lib/audit.ts");
  const updates: Array<{ where: { id: string }; data: { details: string } }> = [];
  let fail = false;
  shadowPrismaModel(prisma, "auditLog", {
    create: async (args: CreateArgs) => ({ id: "x", ...args.data }),
    update: async (args: { where: { id: string }; data: { details: string } }) => {
      if (fail) throw new Error("db down");
      updates.push(args);
      return {};
    },
  });
  await finalizeAuditRow("row-1", { status: "completed", rows: 3 }, "[test-export]");
  assert.deepEqual(updates, [{ where: { id: "row-1" }, data: { details: JSON.stringify({ status: "completed", rows: 3 }) } }]);
  fail = true;
  errors.length = 0;
  await finalizeAuditRow("row-1", { status: "aborted" }, "[test-export]");
  assert.ok(errors.some((e) => e.startsWith("[test-export] failed to finalize audit row:")), errors.join("\n"));
});

test("an oversized details is replaced by a marker that is still JSON, and a long target is cut", async () => {
  const rows: CreateArgs[] = [];
  shadowPrismaModel(prisma, "auditLog", { create: async (args: CreateArgs) => { rows.push(args); return { id: "r" }; } });
  const creates = rows;
  const { MAX_AUDIT_DETAILS_LENGTH, MAX_AUDIT_TARGET_LENGTH } = await import("../src/lib/audit.ts");
  await logAudit({ userId: "u", userName: "n", action: "SETTINGS_CHANGE", target: "t".repeat(2_000), details: { keys: "k".repeat(MAX_AUDIT_DETAILS_LENGTH), other: 1 } });
  const row = creates[0].data as { target: string; details: string };
  assert.equal(row.target.length, MAX_AUDIT_TARGET_LENGTH);
  const details = JSON.parse(row.details) as Record<string, unknown>;
  assert.equal(details.truncated, true);
  assert.deepEqual(details.keys, ["keys", "other"]);
  assert.ok(row.details.length < 1_000);
  creates.length = 0;
  await logAudit({ userId: "u", userName: "n", action: "SETTINGS_CHANGE", target: "t", details: { a: 1 } });
  assert.equal((creates[0].data as { details: string }).details, JSON.stringify({ a: 1 }), "a normal row is unchanged");
});

test("a failed retention read scrubs with the LONGEST window, never the shorter default", async () => {
  const { getAuditPiiRetentionDays, AUDIT_PII_RETENTION_MAX_DAYS } = await import("../src/lib/audit.ts");
  shadowPrismaModel(prisma, "setting", { findUnique: async () => { throw new Error("pool timeout"); } });
  assert.equal(await getAuditPiiRetentionDays(), AUDIT_PII_RETENTION_MAX_DAYS);
  assert.ok(warns.some((w) => w.includes("[audit] couldn't read the PII retention setting")));
  shadowPrismaModel(prisma, "setting", { findUnique: async () => null });
  assert.equal(await getAuditPiiRetentionDays(), 90, "no row is the documented default");
});
