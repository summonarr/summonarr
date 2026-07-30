// Route-level unit tests for the last three uncovered admin routes:
//   GET         /api/admin/stats
//   GET         /api/admin/backup/db-export
//   POST/DELETE /api/admin/backup/db-import-chunk
//
// SCOPE NOTE: per the project brief, the DB-restore SUCCESS path (a real
// encrypted blob + PBKDF2 + the destructive TRUNCATE/INSERT) stays out of the
// unit suite — that is live-verification territory, and tests/backup-import.mts
// already covers the decrypt/allowlist/rollback layer against real fixtures.
// What is covered here is everything BEFORE a byte is ever imported: the
// configuration gate, the rate limit, the header contract, the size caps and the
// upload-session state machine. Every test below stops short of a completed
// upload, so no test in this file can execute an import.
//
// The two backup routes are the highest-value targets in the app — one export
// pull hands an attacker every user, session, encrypted secret and play-history
// record, and one import overwrites the whole database — so:
//
//   1. BOTH ARE CONFIGURATION-GATED. No BACKUP_DB_PASSWORD, or one under 12
//      characters, is a 503 BEFORE any work: no stream is built, no upload slot
//      is claimed. A weak-password export is worse than no export.
//   2. BOTH ARE RATE-LIMITED to 5/hour per admin, and the import's limiter is
//      consumed ON CHUNK 0 ONLY. That asymmetry is load-bearing: a real backup is
//      split into many 16 MiB chunks, so a per-chunk limiter would burn the
//      bucket and 429 an honest restore partway through — leaving a
//      half-uploaded session and an operator with no way to finish.
//   3. THE SIZE CHECK RUNS BEFORE THE SLOT IS CLAIMED. startSession occupies the
//      one global upload slot; an oversized chunk 0 that bailed after claiming it
//      would strand that slot (409 for everyone) until the 30-minute TTL.
//   4. THE EXPORT IS A DOWNLOAD, NOT A PAGE: attachment disposition, nosniff, and
//      no-store, so a browser can't be talked into rendering or caching a full
//      database dump.
//   5. Guardrail 26 on both: the audit write is post-commit/post-stream and must
//      never turn a successful export into a 500.
//
// stats is a read-only aggregate; its pins are the admin gate, force-dynamic (a
// cached dashboard would show stale counts), and BigInt-safe serialization —
// raw COUNT(*)::bigint values reach JSON.stringify and throw unless converted.
//
// Harness: real withAdmin-wrapped handlers, genuine signed session JWTs, a
// synthetic Next request scope, in-memory prisma stubs. No DB, no network.
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { AsyncLocalStorage } from "node:async_hooks";

(globalThis as { AsyncLocalStorage?: unknown }).AsyncLocalStorage = AsyncLocalStorage;

process.env.TOKEN_ENCRYPTION_KEY = "ab".repeat(32);
process.env.NEXTAUTH_SECRET = "admin-backup-stats-secret-0123456789ab";
process.env.AUTH_URL = "http://localhost:3000";
process.env.TRUST_PROXY = "true";
(process.env as Record<string, string | undefined>).NODE_ENV = "test";

globalThis.fetch = (async () =>
  new Response("{}", { status: 503, headers: { "content-type": "application/json" } })) as unknown as typeof fetch;

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
const { shadowPrismaModel, shadowPrismaClientMethod } = await import("./_helpers.mts");
const { signSessionJwt } = await import("../src/lib/session-jwt.ts");
const { getSessionCookieName } = await import("../src/lib/session-cookie.ts");
const { Permission } = await import("../src/lib/permissions.ts");
const { MAX_CIPHERTEXT_BYTES } = await import("../src/lib/backup-import.ts");

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
  const userId = `admin-${seq}`;
  const sessionId = `sess-${seq}`;
  const role = opts.role ?? "ADMIN";
  const permissions = (opts.permissions ?? Permission.ADMIN).toString();
  sessionUsers.set(userId, {
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

// ── stats stubs ──────────────────────────────────────────────────────────────
shadowPrismaModel(prisma, "user", {
  findUnique: async (args: { where: { id: string } }) => sessionUsers.get(args.where.id) ?? null,
  update: async () => ({}),
  count: async () => { rec("user.count"); return 7; },
  findMany: async () => { rec("user.findMany"); return []; },
  groupBy: async () => [],
});
for (const m of ["mediaRequest", "plexLibraryItem", "jellyfinLibraryItem", "issue", "tVEpisodeCache"]) {
  shadowPrismaModel(prisma, m, {
    count: async (args: unknown) => { rec(`${m}.count`, args); return 3; },
    findMany: async () => { rec(`${m}.findMany`); return []; },
    groupBy: async () => { rec(`${m}.groupBy`); return []; },
    aggregate: async () => ({ _count: { _all: 0 }, _sum: {} }),
  });
}
const settings = new Map<string, string>();
shadowPrismaModel(prisma, "setting", {
  findUnique: async (args: { where: { key: string } }) => {
    const v = settings.get(args.where.key);
    return v === undefined ? null : { key: args.where.key, value: v };
  },
  findMany: async () => [],
});
shadowPrismaModel(prisma, "auditLog", { create: async (args: unknown) => { rec("auditLog.create", args); return { id: "a1" }; } });

// $queryRaw feeds the stats aggregates; BigInt on purpose, so the route's own
// serialization is what has to cope.
shadowPrismaClientMethod(prisma, "$queryRaw", async (strings: TemplateStringsArray) => {
  const sql = Array.isArray(strings) ? strings.join(" ") : String(strings);
  rec("$queryRaw");
  if (sql.includes("avg_hours")) return [{ avg_hours: 12.5 }];
  if (sql.includes("month")) return [{ month: "2026-01", count: 5n }];
  return [];
});
shadowPrismaClientMethod(prisma, "$queryRawUnsafe", async () => { rec("$queryRawUnsafe"); return []; });

const stats = await import("../src/app/api/admin/stats/route.ts");
const dbExport = await import("../src/app/api/admin/backup/db-export/route.ts");
const dbImport = await import("../src/app/api/admin/backup/db-import-chunk/route.ts");

// ── scope ────────────────────────────────────────────────────────────────────
function inScope<T>(fn: () => Promise<T>): Promise<T> {
  const workStore = {
    route: "/admin-backup-stats.test", forceStatic: false, dynamicShouldError: false,
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

function getReq(path: string, token: string | null) {
  return new NextRequest(`http://localhost:3000${path}`, {
    method: "GET",
    headers: token ? { cookie: `${COOKIE}=${token}` } : {},
  });
}
const getStats = (t: string | null) => inScope(() => stats.GET(getReq("/api/admin/stats", t), undefined));
const getExport = (t: string | null) => inScope(() => dbExport.GET(getReq("/api/admin/backup/db-export", t), undefined));

// A chunk POST. `body` defaults to a tiny payload; pass null for "no body".
function chunkReq(
  token: string | null,
  headers: Record<string, string>,
  body: Uint8Array | null = new Uint8Array([1, 2, 3]),
) {
  const h: Record<string, string> = { ...headers };
  if (token) h.cookie = `${COOKIE}=${token}`;
  // `duplex` is required by undici for a streamed body but isn't in the DOM
  // RequestInit lib types, so the init object is assembled untyped and cast once.
  const init: Record<string, unknown> = { method: "POST", headers: h };
  if (body) {
    init.body = body;
    init.duplex = "half";
  }
  return new NextRequest(
    "http://localhost:3000/api/admin/backup/db-import-chunk",
    init as unknown as ConstructorParameters<typeof NextRequest>[1],
  );
}
const postChunk = (token: string | null, headers: Record<string, string>, body?: Uint8Array | null) =>
  inScope(() => dbImport.POST(chunkReq(token, headers, body === undefined ? new Uint8Array([1, 2, 3]) : body), undefined));

const cancelUpload = (token: string | null, uploadId?: string) =>
  inScope(() =>
    dbImport.DELETE(
      new NextRequest("http://localhost:3000/api/admin/backup/db-import-chunk", {
        method: "DELETE",
        headers: {
          ...(token ? { cookie: `${COOKIE}=${token}` } : {}),
          ...(uploadId ? { "x-upload-id": uploadId } : {}),
        },
      }),
      undefined,
    ),
  );

// Headers for a well-formed chunk. Deliberately NEVER a single-chunk upload —
// chunkTotal is always > 1 so no test in this file can complete an import.
let uploadSeq = 0;
function chunkHeaders(over: Partial<Record<string, string>> = {}): Record<string, string> {
  uploadSeq++;
  return {
    "x-upload-id": `11111111-1111-4111-8111-${String(uploadSeq).padStart(12, "0")}`,
    "x-chunk-index": "0",
    "x-chunk-total": "4",
    "x-file-size": "4096",
    ...over,
  } as Record<string, string>;
}

const GOOD_PASSWORD = "a-long-enough-backup-password";

// A chunk-0 attempt that consumes limiter budget without claiming an upload
// slot. The declared x-file-size is legal (so it passes the pre-limiter 413) but
// the Content-Length exceeds the 32 MiB per-chunk cap, which is checked AFTER
// the limiter and BEFORE startSession. That ordering is what lets these tests
// drain the bucket without ever touching the filesystem.
async function drainingChunkZero(token: string): Promise<Response> {
  const req = chunkReq(token, chunkHeaders({ "x-chunk-index": "0" }));
  req.headers.set("content-length", String(64 * 1024 * 1024));
  return inScope(() => dbImport.POST(req, undefined));
}

beforeEach(() => {
  ops = [];
  warns.length = 0;
  errors.length = 0;
  settings.clear();
  process.env.BACKUP_DB_PASSWORD = GOOD_PASSWORD;
});

// ── gating ───────────────────────────────────────────────────────────────────

test("all three routes refuse an anonymous caller with 401", async () => {
  assert.equal((await getStats(null)).status, 401);
  assert.equal((await getExport(null)).status, 401);
  assert.equal((await postChunk(null, chunkHeaders())).status, 401);
  assert.equal((await cancelUpload(null, "abc")).status, 401);
});

test("a plain USER is 403 on all three and does no work", async () => {
  const t = await mintSession({ role: "USER", permissions: 0n });
  assert.equal((await getStats(t)).status, 403);
  assert.equal((await getExport(t)).status, 403);
  assert.equal((await postChunk(t, chunkHeaders())).status, 403);
  assert.equal((await cancelUpload(t, "abc")).status, 403);
  assert.equal(opsOf("auditLog.create").length, 0);
});

test("an ISSUE_ADMIN cannot export or restore the database", async () => {
  // A delegated issue moderator must never reach the highest-value data path.
  const t = await mintSession({ role: "ISSUE_ADMIN", permissions: Permission.MANAGE_ISSUES });
  assert.equal((await getExport(t)).status, 403);
  assert.equal((await postChunk(t, chunkHeaders())).status, 403);
});

test("a MANAGE_USERS holder without ADMIN cannot export the database", async () => {
  const t = await mintSession({ role: "USER", permissions: Permission.MANAGE_USERS });
  assert.equal((await getExport(t)).status, 403);
});

// ── 1: the configuration gate ────────────────────────────────────────────────

test("export is 503 when BACKUP_DB_PASSWORD is unset, and builds no stream", async () => {
  delete process.env.BACKUP_DB_PASSWORD;
  const t = await mintSession();
  const res = await getExport(t);
  assert.equal(res.status, 503);
  assert.match((await res.json()).error, /not configured/i);
  assert.equal(opsOf("auditLog.create").length, 0, "an unconfigured export must not audit");
});

test("export is 503 when BACKUP_DB_PASSWORD is too short", async () => {
  // A weak-password export is worse than no export — the blob is exfiltrable.
  process.env.BACKUP_DB_PASSWORD = "short";
  const t = await mintSession();
  const res = await getExport(t);
  assert.equal(res.status, 503);
  assert.match((await res.json()).error, /at least|minimum/i);
});

test("export accepts a password at exactly the 12-character floor", async () => {
  process.env.BACKUP_DB_PASSWORD = "123456789012";
  const t = await mintSession();
  const res = await getExport(t);
  assert.notEqual(res.status, 503);
});

test("export rejects an 11-character password", async () => {
  process.env.BACKUP_DB_PASSWORD = "12345678901";
  const t = await mintSession();
  assert.equal((await getExport(t)).status, 503);
});

test("import is 503 when BACKUP_DB_PASSWORD is unset, BEFORE any header parsing", async () => {
  delete process.env.BACKUP_DB_PASSWORD;
  const t = await mintSession();
  // Deliberately malformed headers too: the config gate must win, proving it
  // runs first and no upload slot can be claimed on an unconfigured server.
  const res = await postChunk(t, { "x-chunk-index": "not-a-number" });
  assert.equal(res.status, 503);
});

test("import is 503 when BACKUP_DB_PASSWORD is too short", async () => {
  process.env.BACKUP_DB_PASSWORD = "tooshort";
  const t = await mintSession();
  assert.equal((await postChunk(t, chunkHeaders())).status, 503);
});

// ── 2: rate limits, and the chunk-0-only asymmetry ───────────────────────────

test("export is rate-limited to 5 per hour per admin", async () => {
  const t = await mintSession();
  for (let i = 0; i < 5; i++) {
    const r = await getExport(t);
    assert.notEqual(r.status, 429, `export ${i + 1} should pass`);
    await r.body?.cancel();
  }
  assert.equal((await getExport(t)).status, 429);
});

test("the export budget is per admin", async () => {
  const a = await mintSession();
  for (let i = 0; i < 6; i++) (await getExport(a)).body?.cancel();
  assert.equal((await getExport(a)).status, 429);
  const b = await mintSession();
  const r = await getExport(b);
  assert.notEqual(r.status, 429);
  await r.body?.cancel();
});

test("a throttled export writes no audit row and streams nothing", async () => {
  const t = await mintSession();
  for (let i = 0; i < 6; i++) (await getExport(t)).body?.cancel();
  ops = [];
  const res = await getExport(t);
  assert.equal(res.status, 429);
  assert.equal(opsOf("auditLog.create").length, 0);
});

test("the import limiter is consumed on CHUNK 0 only", async () => {
  // A real backup is many 16 MiB chunks. A per-chunk limiter would burn the
  // 5/hour bucket and 429 an honest restore partway through, stranding a
  // half-uploaded session with no way to finish.
  const t = await mintSession();
  // Ten NON-ZERO chunks: each fails the session check (no session started), but
  // none of them may consume limiter budget.
  for (let i = 0; i < 10; i++) {
    const res = await postChunk(t, chunkHeaders({ "x-chunk-index": "3" }));
    assert.notEqual(res.status, 429, `non-zero chunk ${i + 1} must not be rate-limited`);
  }
  // The budget is therefore still intact: five chunk-0 attempts still fit.
  for (let i = 0; i < 5; i++) {
    const res = await drainingChunkZero(t);
    assert.notEqual(res.status, 429, `chunk 0 attempt ${i + 1} should still have budget`);
  }
});

test("chunk 0 attempts ARE rate-limited to 5 per hour", async () => {
  const t = await mintSession();
  for (let i = 0; i < 5; i++) {
    const res = await drainingChunkZero(t);
    assert.notEqual(res.status, 429, `restore attempt ${i + 1} should pass the limiter`);
  }
  assert.equal((await drainingChunkZero(t)).status, 429);
});

test("a declared size over the ciphertext cap is rejected BEFORE the limiter, so it costs no budget", async () => {
  // Ordering pin: an obviously-too-large declaration is cheap to reject, and
  // spending limiter budget on it would let a bad client lock an operator out
  // of their own restore.
  const t = await mintSession();
  for (let i = 0; i < 8; i++) {
    const res = await postChunk(t, chunkHeaders({ "x-chunk-index": "0", "x-file-size": String(MAX_CIPHERTEXT_BYTES + 1) }));
    assert.equal(res.status, 413, `attempt ${i + 1} should be a size rejection, not a throttle`);
  }
  // Budget untouched: a real attempt still gets through the limiter.
  assert.notEqual((await drainingChunkZero(t)).status, 429);
});

test("the import budget is per admin", async () => {
  const a = await mintSession();
  for (let i = 0; i < 6; i++) await drainingChunkZero(a);
  assert.equal((await drainingChunkZero(a)).status, 429);
  const b = await mintSession();
  assert.notEqual((await drainingChunkZero(b)).status, 429);
});

// ── 3: header contract + size caps, all before the slot is claimed ───────────

for (const [label, over] of [
  ["a missing upload id", { "x-upload-id": "" }],
  ["a non-numeric chunk index", { "x-chunk-index": "abc" }],
  ["a non-numeric chunk total", { "x-chunk-total": "many" }],
  ["a non-numeric file size", { "x-file-size": "big" }],
] as const) {
  test(`import rejects ${label} with 400`, async () => {
    const t = await mintSession();
    const res = await postChunk(t, chunkHeaders(over as Record<string, string>));
    assert.equal(res.status, 400);
    assert.match((await res.json()).error, /upload headers/i);
  });
}

test("import rejects a file larger than MAX_CIPHERTEXT_BYTES with 413", async () => {
  const t = await mintSession();
  const res = await postChunk(t, chunkHeaders({ "x-file-size": String(MAX_CIPHERTEXT_BYTES + 1) }));
  assert.equal(res.status, 413);
  assert.match((await res.json()).error, /limit/i);
});

test("the declared-size check runs BEFORE the upload slot is claimed", async () => {
  // startSession occupies the ONE global slot; an oversized chunk 0 that bailed
  // after claiming it would strand that slot (409 for everyone) until the TTL.
  // Proof: after an oversized chunk 0, a normal chunk 0 is not told "another
  // upload is in progress".
  const t = await mintSession();
  const rejected = await postChunk(t, chunkHeaders({ "x-file-size": String(MAX_CIPHERTEXT_BYTES + 1) }));
  assert.equal(rejected.status, 413);

  const next = await postChunk(t, chunkHeaders({ "x-chunk-index": "2" }));
  const body = await next.json();
  assert.ok(
    !/already in progress/i.test(String(body.error ?? "")),
    `the rejected upload stranded the global slot: ${JSON.stringify(body)}`,
  );
});

test("import rejects an empty body with 400", async () => {
  const t = await mintSession();
  const res = await postChunk(t, chunkHeaders(), null);
  assert.equal(res.status, 400);
  assert.match((await res.json()).error, /empty/i);
});

test("a non-zero chunk with no active session is 409, not a silent accept", async () => {
  const t = await mintSession();
  const res = await postChunk(t, chunkHeaders({ "x-chunk-index": "5" }));
  assert.equal(res.status, 409);
  assert.match((await res.json()).error, /start at chunk 0|no active upload/i);
});

test("no rejected chunk ever writes an audit row — nothing was imported", async () => {
  const t = await mintSession();
  await postChunk(t, chunkHeaders({ "x-upload-id": "" }));
  await postChunk(t, chunkHeaders({ "x-file-size": String(MAX_CIPHERTEXT_BYTES + 1) }));
  await postChunk(t, chunkHeaders({ "x-chunk-index": "9" }));
  assert.equal(opsOf("auditLog.create").length, 0);
});

// ── DELETE (cancel) ──────────────────────────────────────────────────────────

test("cancel requires an upload id", async () => {
  const t = await mintSession();
  const res = await cancelUpload(t);
  assert.equal(res.status, 400);
  assert.match((await res.json()).error, /X-Upload-Id/i);
});

test("cancelling an unknown upload is an idempotent 200", async () => {
  const t = await mintSession();
  const res = await cancelUpload(t, "11111111-1111-4111-8111-999999999999");
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { ok: true });
});

// ── 4: the export is a download, not a page ──────────────────────────────────

test("export sets attachment disposition, nosniff and no-store", async () => {
  // A full database dump must not be renderable or cacheable by a browser.
  const t = await mintSession();
  const res = await getExport(t);
  assert.equal(res.status, 200);
  assert.match(res.headers.get("content-disposition") ?? "", /^attachment; filename="summonarr-full-backup-\d{4}-\d{2}-\d{2}\.sql\.enc"$/);
  assert.equal(res.headers.get("x-content-type-options"), "nosniff");
  assert.equal(res.headers.get("cache-control"), "no-store");
  assert.equal(res.headers.get("content-type"), "application/octet-stream");
  await res.body?.cancel();
});

test("the export filename carries the .enc suffix — the payload is encrypted", async () => {
  const t = await mintSession();
  const res = await getExport(t);
  assert.match(res.headers.get("content-disposition") ?? "", /\.sql\.enc"$/);
  await res.body?.cancel();
});

test("export returns a stream body rather than buffering the database", async () => {
  const t = await mintSession();
  const res = await getExport(t);
  assert.ok(res.body, "the export must stream");
  await res.body?.cancel();
});

// ── 5: guardrail 26 on the export audit ──────────────────────────────────────

test("export audits the pull — an untracked database export would be invisible", async () => {
  const t = await mintSession();
  const res = await getExport(t);
  await res.body?.cancel();
  const created = opsOf("auditLog.create");
  assert.equal(created.length, 1);
  const data = (created[0].args as { data: { action: string; target: string } }).data;
  assert.equal(data.action, "BACKUP_EXPORT");
  assert.equal(data.target, "backup:full-db");
});

test("a failing audit write does not turn a successful export into a 500", async () => {
  shadowPrismaModel(prisma, "auditLog", {
    create: async () => { rec("auditLog.create"); throw new Error("audit down"); },
  });
  const t = await mintSession();
  const res = await getExport(t);
  assert.equal(res.status, 200, "the stream was already built; a failed audit must not 500 it");
  await res.body?.cancel();
  shadowPrismaModel(prisma, "auditLog", { create: async (args: unknown) => { rec("auditLog.create", args); return { id: "a1" }; } });
});

test("the export never echoes BACKUP_DB_PASSWORD in its headers", async () => {
  const t = await mintSession();
  const res = await getExport(t);
  const all = [...res.headers.entries()].map(([k, v]) => `${k}:${v}`).join("|");
  assert.ok(!all.includes(GOOD_PASSWORD));
  await res.body?.cancel();
});

// ── /api/admin/stats ─────────────────────────────────────────────────────────

test("stats serves an admin and reports the aggregate counts", async () => {
  const t = await mintSession();
  const res = await getStats(t);
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(typeof body, "object");
  assert.ok(body !== null);
});

test("stats survives BigInt aggregates — raw COUNT(*)::bigint must not break serialization", async () => {
  // The month series comes back as BigInt from the pg driver; an unconverted
  // value throws "Do not know how to serialize a BigInt" at JSON.stringify time
  // and 500s the whole dashboard.
  const t = await mintSession();
  const res = await getStats(t);
  assert.equal(res.status, 200);
  const text = await res.text();
  assert.doesNotThrow(() => JSON.parse(text));
  assert.ok(!text.includes("BigInt"));
});

test("stats is force-dynamic so the dashboard can't serve stale counts", () => {
  assert.equal(stats.dynamic, "force-dynamic");
});

test("stats is read-only", async () => {
  const t = await mintSession();
  await getStats(t);
  const writes = ops.filter((o) => /(create|update|upsert|delete)/i.test(o.op));
  assert.deepEqual(writes, []);
});

test("stats reads the counts it claims to report", async () => {
  const t = await mintSession();
  await getStats(t);
  assert.ok(opsOf("mediaRequest.count").length >= 5, "request status breakdown");
  assert.equal(opsOf("user.count").length, 1);
  assert.ok(opsOf("issue.count").length >= 2, "total + open issues");
  assert.ok(opsOf("$queryRaw").length >= 2, "fulfillment average + monthly series");
});
