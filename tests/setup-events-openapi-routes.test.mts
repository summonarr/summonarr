// Route-level unit tests for the last four uncovered routes:
//   POST        /api/setup/import        first-run restore from a backup
//   POST/DELETE /api/setup/import-chunk  its chunked sibling
//   GET         /api/events              the SSE stream
//   GET         /api/openapi             the API spec
//
// SCOPE: as with the admin backup pair, the RESTORE SUCCESS PATH stays out of the
// unit suite per the project brief — a real encrypted blob, PBKDF2 and the
// destructive TRUNCATE are live-verification territory, and tests/backup-import
// covers the decrypt/allowlist/rollback layer against real fixtures. What is
// covered here is everything before a byte is imported.
//
// The setup pair is the only UNAUTHENTICATED write surface in the app, so its
// gate is the point:
//
//   1. IT SLAMS SHUT ONCE THE INSTANCE HAS ANY USER. Either a `setup_completed_at`
//      marker OR a non-zero user count closes it with 409. Without that, anyone
//      on the network could restore an attacker-authored backup over a live
//      instance — every user, every credential, replaced.
//   2. THE GATE IS RE-CHECKED INSIDE A TRANSACTION UNDER ADVISORY LOCK 43, shared
//      with /api/auth/register, so a racing first-registration cannot slip
//      between the SELECT and the import.
//   3. IT IS CONFIGURATION-GATED AND IP RATE-LIMITED like the admin pair, and the
//      chunked variant consumes its limiter on chunk 0 only, for the same reason:
//      a per-chunk limiter would 429 an honest multi-chunk restore partway.
//
// /api/events is DB-checked-auth (guardrail 29 reasoning: it is reachable on the
// prefetch path proxy.ts skips, so a JWT-only check would honour a revoked or
// demoted session until its natural expiry) and connection-capped. /api/openapi
// is ADMIN-only and must not embed live secrets.
//
// Harness: real handlers, in-memory prisma stubs, a synthetic Next request scope
// for the routes that read cookies()/headers(). No DB, no network.
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { AsyncLocalStorage } from "node:async_hooks";

(globalThis as { AsyncLocalStorage?: unknown }).AsyncLocalStorage = AsyncLocalStorage;

process.env.TOKEN_ENCRYPTION_KEY = "ab".repeat(32);
process.env.NEXTAUTH_SECRET = "setup-events-openapi-secret-01234567";
process.env.AUTH_URL = "http://localhost:3000";
process.env.TRUST_PROXY = "true";
(process.env as Record<string, string | undefined>).NODE_ENV = "test";

globalThis.fetch = (async () => new Response("{}", { status: 503 })) as unknown as typeof fetch;

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

// ── stores ───────────────────────────────────────────────────────────────────
let userCount = 0;
const settings = new Map<string, string>();
const usersById = new Map<string, Record<string, unknown>>();
const sessionRows = new Set<string>();

shadowPrismaModel(prisma, "authSession", {
  findUnique: async (args: { where: { sessionId: string } }) =>
    sessionRows.has(args.where.sessionId) ? { id: `row-${args.where.sessionId}`, sessionId: args.where.sessionId } : null,
  update: async () => ({}),
});
shadowPrismaModel(prisma, "user", {
  findUnique: async (args: { where: { id: string } }) => usersById.get(args.where.id) ?? null,
  findMany: async () => [],
  count: async () => { rec("user.count"); return userCount; },
  update: async () => ({}),
});
shadowPrismaModel(prisma, "setting", {
  findUnique: async (args: { where: { key: string } }) => {
    rec("setting.findUnique", args.where.key);
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
shadowPrismaModel(prisma, "auditLog", { create: async (args: unknown) => { rec("auditLog.create", args); return { id: "a1" }; } });

let advisoryLocks: number[] = [];
shadowPrismaClientMethod(prisma, "$transaction", async (arg: unknown) => {
  rec("$transaction");
  if (Array.isArray(arg)) return Promise.all(arg);
  return (arg as (tx: unknown) => Promise<unknown>)(prisma);
});
shadowPrismaClientMethod(prisma, "$executeRawUnsafe", async (sql: string) => {
  rec("$executeRawUnsafe", sql);
  const m = /pg_advisory_xact_lock\((\d+)\)/.exec(String(sql));
  if (m) advisoryLocks.push(Number(m[1]));
  return 1;
});
shadowPrismaClientMethod(prisma, "$executeRaw", async () => 1);
shadowPrismaClientMethod(prisma, "$queryRaw", async () => []);
shadowPrismaClientMethod(prisma, "$queryRawUnsafe", async () => []);

const setupImport = await import("../src/app/api/setup/import/route.ts");
const setupChunk = await import("../src/app/api/setup/import-chunk/route.ts");
const events = await import("../src/app/api/events/route.ts");
const openapi = await import("../src/app/api/openapi/route.ts");

// ── scope + helpers ──────────────────────────────────────────────────────────
function inScope<T>(fn: () => Promise<T>, cookie?: string): Promise<T> {
  const workStore = {
    route: "/setup-events.test", forceStatic: false, dynamicShouldError: false,
    afterContext: { after: () => {} },
  };
  const reqHeaders = new Headers(cookie ? { cookie } : {});
  const requestStore = {
    type: "request", phase: "render",
    headers: HeadersAdapter.seal(reqHeaders),
    cookies: RequestCookiesAdapter.seal(new RequestCookies(reqHeaders)),
    usedDynamic: false,
  };
  return workAsyncStorage.run(workStore, () => workUnitAsyncStorage.run(requestStore, fn));
}

let seq = 0;
async function mintSession(opts: { permissions?: bigint; role?: string } = {}): Promise<string> {
  seq++;
  const userId = `u-${seq}`;
  const sessionId = `sess-${seq}`;
  const role = opts.role ?? "USER";
  const permissions = (opts.permissions ?? 0n).toString();
  usersById.set(userId, {
    id: userId, name: `U${seq}`, email: `u${seq}@example.com`, role,
    permissions: BigInt(permissions), mediaServer: null, sessionsRevokedAt: null,
    passwordChangedAt: null, deactivatedAt: null, notificationEmail: null,
  });
  sessionRows.add(sessionId);
  const iat = Math.floor(Date.now() / 1000);
  return signSessionJwt(
    { id: userId, role, permissions, provider: "credentials", sessionId, expiresAt: iat + 86_400 },
    { expiresInSeconds: 7_200, iat },
  );
}
const COOKIE = getSessionCookieName();

const GOOD_PASSWORD = "a-long-enough-backup-password";
const BODY = new Uint8Array([1, 2, 3, 4]);

// The setup routes rate-limit per CLIENT IP (5 per 5 minutes). Without a fresh
// IP per call the whole file shares one budget and every test after the fifth
// 429s regardless of what it is asserting — so each call gets its own unless a
// test deliberately pins one to exercise the limiter.
let ipSeq = 0;
function freshIp(): string {
  ipSeq++;
  return `198.51.100.${ipSeq % 254 + 1}`;
}

function importReq(headers: Record<string, string> = {}, body: Uint8Array | null = BODY) {
  const init: Record<string, unknown> = { method: "POST", headers };
  if (body) { init.body = body; init.duplex = "half"; }
  return new NextRequest(
    "http://localhost:3000/api/setup/import",
    init as unknown as ConstructorParameters<typeof NextRequest>[1],
  );
}
const doImport = (headers: Record<string, string> = {}, body?: Uint8Array | null) =>
  inScope(() => setupImport.POST(importReq(
    { "x-forwarded-for": freshIp(), ...headers },
    body === undefined ? BODY : body,
  )));

let uploadSeq = 0;
function chunkHeaders(over: Partial<Record<string, string>> = {}): Record<string, string> {
  uploadSeq++;
  return {
    "x-upload-id": `22222222-2222-4222-8222-${String(uploadSeq).padStart(12, "0")}`,
    "x-chunk-index": "0",
    "x-chunk-total": "4",
    "x-file-size": "4096",
    ...over,
  } as Record<string, string>;
}
function chunkReq(headers: Record<string, string>, body: Uint8Array | null = BODY) {
  const init: Record<string, unknown> = { method: "POST", headers };
  if (body) { init.body = body; init.duplex = "half"; }
  return new NextRequest(
    "http://localhost:3000/api/setup/import-chunk",
    init as unknown as ConstructorParameters<typeof NextRequest>[1],
  );
}
const doChunk = (headers: Record<string, string>, body?: Uint8Array | null) =>
  inScope(() => setupChunk.POST(chunkReq(
    { "x-forwarded-for": freshIp(), ...headers },
    body === undefined ? BODY : body,
  )));

beforeEach(() => {
  ops = [];
  advisoryLocks = [];
  userCount = 0;
  settings.clear();
  warns.length = 0;
  errors.length = 0;
  process.env.BACKUP_DB_PASSWORD = GOOD_PASSWORD;
});

// ── 1: the setup gate slams shut ─────────────────────────────────────────────

test("setup/import is 409 once ANY user exists", async () => {
  // The only unauthenticated write surface in the app. Without this, anyone on
  // the network could restore an attacker-authored backup over a live instance.
  userCount = 1;
  const res = await doImport();
  assert.equal(res.status, 409);
  assert.match((await res.json()).error, /fresh server with no users/i);
});

test("setup/import is 409 once setup_completed_at is set, even with zero users", async () => {
  settings.set("setup_completed_at", new Date().toISOString());
  const res = await doImport();
  assert.equal(res.status, 409);
});

test("EITHER condition alone closes the gate — they are an OR, not an AND", async () => {
  userCount = 1;
  settings.delete("setup_completed_at");
  assert.equal((await doImport()).status, 409, "a user alone should close it");

  userCount = 0;
  settings.set("setup_completed_at", "2026-01-01T00:00:00Z");
  assert.equal((await doImport()).status, 409, "the marker alone should close it");
});

test("a closed gate rejects BEFORE the password check and before reading the body", async () => {
  userCount = 1;
  delete process.env.BACKUP_DB_PASSWORD;
  const res = await doImport();
  assert.equal(res.status, 409, "the gate must win over the config check");
});

test("the gate is re-checked inside a TRANSACTION under advisory lock 43", async () => {
  // Shared with /api/auth/register: a racing first-registration must not slip
  // between the SELECT and the import.
  await doImport();
  assert.ok(opsOf("$transaction").length > 0, "the gate must run in a transaction");
  assert.ok(advisoryLocks.includes(43), `expected advisory lock 43, saw ${advisoryLocks.join(",")}`);
});

test("the gate reads BOTH the marker and the user count", async () => {
  await doImport();
  assert.ok(opsOf("setting.findUnique").some((o) => o.args === "setup_completed_at"));
  assert.ok(opsOf("user.count").length > 0);
});

// ── setup/import: configuration + caps ───────────────────────────────────────

test("setup/import is 503 with no BACKUP_DB_PASSWORD", async () => {
  delete process.env.BACKUP_DB_PASSWORD;
  const res = await doImport();
  assert.equal(res.status, 503);
  assert.match((await res.json()).error, /not configured/i);
});

test("setup/import is 503 with a too-short BACKUP_DB_PASSWORD", async () => {
  process.env.BACKUP_DB_PASSWORD = "short";
  assert.equal((await doImport()).status, 503);
});

test("setup/import accepts a password at exactly the 12-char floor", async () => {
  process.env.BACKUP_DB_PASSWORD = "123456789012";
  assert.notEqual((await doImport()).status, 503);
});

test("setup/import rejects an oversized declared body", async () => {
  const res = await doImport({ "content-length": String(MAX_CIPHERTEXT_BYTES + 1) });
  assert.ok(res.status === 400 || res.status === 413, `expected a cap rejection, got ${res.status}`);
});

test("setup/import rejects an empty body with 400", async () => {
  const res = await doImport({}, null);
  assert.equal(res.status, 400);
  assert.match((await res.json()).error, /empty/i);
});

test("setup/import is IP rate-limited", async () => {
  const ip = "203.0.113.200";
  for (let i = 0; i < 5; i++) {
    const r = await doImport({ "x-forwarded-for": ip });
    assert.notEqual(r.status, 429, `attempt ${i + 1} should pass the limiter`);
  }
  assert.equal((await doImport({ "x-forwarded-for": ip })).status, 429);
});

test("a throttled setup/import never reaches the gate transaction", async () => {
  const ip = "203.0.113.201";
  for (let i = 0; i < 6; i++) await doImport({ "x-forwarded-for": ip });
  ops = [];
  const res = await doImport({ "x-forwarded-for": ip });
  assert.equal(res.status, 429);
  assert.equal(opsOf("$transaction").length, 0);
});

// ── setup/import-chunk ───────────────────────────────────────────────────────

// NOTE the status divergence, pinned deliberately: the single-shot import
// answers 409 while the chunked one answers 403 for the SAME closed-gate
// condition. Both refuse, which is what matters, but a client switching between
// the two transports sees different codes — so this is documented rather than
// silently harmonised.
test("import-chunk refuses with 403 once the instance has a user", async () => {
  userCount = 1;
  const res = await doChunk(chunkHeaders());
  assert.equal(res.status, 403);
});

test("import-chunk refuses with 403 once setup_completed_at is set", async () => {
  settings.set("setup_completed_at", "2026-01-01T00:00:00Z");
  assert.equal((await doChunk(chunkHeaders())).status, 403);
});

test("the two setup transports both REFUSE a closed gate, even though the codes differ", async () => {
  userCount = 1;
  const single = await doImport();
  const chunked = await doChunk(chunkHeaders());
  assert.ok(single.status >= 400 && chunked.status >= 400, "both must refuse");
  assert.equal(single.status, 409);
  assert.equal(chunked.status, 403);
});

for (const [label, over] of [
  ["a missing upload id", { "x-upload-id": "" }],
  ["a non-numeric chunk index", { "x-chunk-index": "abc" }],
  ["a non-numeric chunk total", { "x-chunk-total": "many" }],
  ["a non-numeric file size", { "x-file-size": "big" }],
] as const) {
  test(`import-chunk rejects ${label}`, async () => {
    const res = await doChunk(chunkHeaders(over as Record<string, string>));
    assert.ok(res.status >= 400, `expected a rejection, got ${res.status}`);
  });
}

test("import-chunk rejects a file over MAX_CIPHERTEXT_BYTES", async () => {
  const res = await doChunk(chunkHeaders({ "x-file-size": String(MAX_CIPHERTEXT_BYTES + 1) }));
  assert.ok(res.status === 413 || res.status === 403, `expected a refusal, got ${res.status}`);
});

test("a NON-ZERO chunk with no active session is 409, not a silent accept", async () => {
  const res = await doChunk(chunkHeaders({ "x-chunk-index": "7" }));
  assert.equal(res.status, 409);
  assert.match((await res.json()).error, /start at chunk 0|no active upload/i);
});

test("import-chunk consumes its rate limiter on CHUNK 0 only", async () => {
  // A real backup is many chunks; a per-chunk limiter would 429 an honest
  // restore partway through and strand a half-uploaded session.
  const ip = "203.0.113.210";
  for (let i = 0; i < 12; i++) {
    const res = await doChunk(chunkHeaders({ "x-chunk-index": "3", "x-forwarded-for": ip }));
    assert.notEqual(res.status, 429, `non-zero chunk ${i + 1} must not be rate-limited`);
  }
});

test("import-chunk DELETE requires an upload id", async () => {
  const req = new NextRequest("http://localhost:3000/api/setup/import-chunk", { method: "DELETE" });
  const res = await inScope(() => setupChunk.DELETE(req));
  assert.ok(res.status >= 400);
});

test("neither setup route echoes BACKUP_DB_PASSWORD", async () => {
  userCount = 1;
  for (const res of [await doImport(), await doChunk(chunkHeaders())]) {
    assert.ok(!(await res.text()).includes(GOOD_PASSWORD));
  }
});

// ── /api/events ──────────────────────────────────────────────────────────────

test("events refuses an anonymous caller", async () => {
  const res = await inScope(() => events.GET());
  assert.equal(res.status, 401);
});

test("events refuses a garbage session cookie", async () => {
  const res = await inScope(() => events.GET(), `${COOKIE}=not-a-jwt`);
  assert.equal(res.status, 401);
});

test("events serves an SSE stream to a signed-in caller", async () => {
  const token = await mintSession();
  const res = await inScope(() => events.GET(), `${COOKIE}=${token}`);
  assert.equal(res.status, 200);
  assert.match(res.headers.get("content-type") ?? "", /text\/event-stream/);
  await res.body?.cancel();
});

test("the SSE response is marked no-cache so a proxy can't buffer it", async () => {
  const token = await mintSession();
  const res = await inScope(() => events.GET(), `${COOKIE}=${token}`);
  assert.match(res.headers.get("cache-control") ?? "", /no-cache|no-store/);
  await res.body?.cancel();
});

test("events uses a DB-CHECKED session read, not a JWT-only one", async () => {
  // Guardrail 29's reasoning: this route is reachable on the prefetch path
  // proxy.ts skips, so auth() alone would honour a revoked or role-demoted
  // session until its natural expiry. A JWT whose AuthSession row is gone must
  // be refused.
  const token = await mintSession();
  sessionRows.clear(); // the row is revoked; the JWT is still perfectly valid
  const res = await inScope(() => events.GET(), `${COOKIE}=${token}`);
  assert.equal(res.status, 401, "a revoked session must not open a stream");
});

test("events caps concurrent connections per user with 429", async () => {
  const token = await mintSession();
  const opened: Response[] = [];
  let limited: Response | null = null;
  for (let i = 0; i < 60; i++) {
    const res = await inScope(() => events.GET(), `${COOKIE}=${token}`);
    if (res.status === 429) { limited = res; break; }
    opened.push(res);
  }
  for (const r of opened) await r.body?.cancel();
  assert.ok(limited, "the connection cap should eventually refuse");
  assert.match(await limited.text(), /too many/i);
});

// ── /api/openapi ─────────────────────────────────────────────────────────────

const getSpec = (cookie?: string) =>
  inScope(() => openapi.GET(new NextRequest("http://localhost:3000/api/openapi", {
    method: "GET", headers: cookie ? { cookie } : {},
  }), undefined), cookie);

test("openapi refuses an anonymous caller", async () => {
  assert.equal((await getSpec()).status, 401);
});

test("openapi refuses a non-admin", async () => {
  const token = await mintSession();
  assert.equal((await getSpec(`${COOKIE}=${token}`)).status, 403);
});

test("an ADMIN gets the spec", async () => {
  const token = await mintSession({ role: "ADMIN", permissions: Permission.ADMIN });
  const res = await getSpec(`${COOKIE}=${token}`);
  assert.equal(res.status, 200);
  const spec = await res.json();
  assert.equal(typeof spec.openapi, "string");
  assert.ok(spec.paths && Object.keys(spec.paths).length > 0);
});

test("the spec embeds NO live secrets or configured server URLs", async () => {
  // It is a static document, but it is served from the running instance — a
  // hardcoded token or a real server address would leak deployment detail.
  settings.set("radarrApiKey", "a-real-radarr-key");
  settings.set("plexAdminToken", "a-real-plex-token");
  const token = await mintSession({ role: "ADMIN", permissions: Permission.ADMIN });
  const text = await (await getSpec(`${COOKIE}=${token}`)).text();
  for (const secret of ["a-real-radarr-key", "a-real-plex-token", process.env.NEXTAUTH_SECRET!, process.env.TOKEN_ENCRYPTION_KEY!]) {
    assert.ok(!text.includes(secret), "the spec leaked a live secret");
  }
});

test("the spec reads no Setting rows — it is static, not assembled from config", async () => {
  const token = await mintSession({ role: "ADMIN", permissions: Permission.ADMIN });
  ops = [];
  await getSpec(`${COOKIE}=${token}`);
  const settingReads = opsOf("setting.findUnique").filter((o) => typeof o.args === "string" && !String(o.args).startsWith("feature."));
  assert.deepEqual(settingReads, [], "the spec must not be built from live configuration");
});

test("the spec documents the routes this suite covers", async () => {
  // A sanity check that the document is real rather than a stub.
  const token = await mintSession({ role: "ADMIN", permissions: Permission.ADMIN });
  const spec = await (await getSpec(`${COOKIE}=${token}`)).json();
  // Path keys are RELATIVE to the declared server base, so they carry no /api
  // prefix — asserting on "/api/requests" would silently pass nothing.
  assert.deepEqual(spec.servers?.[0]?.url, "/api");
  const paths = Object.keys(spec.paths);
  for (const p of ["/requests", "/search", "/notifications"]) {
    assert.ok(paths.some((k) => k.startsWith(p)), `${p} is missing from the spec`);
  }
});
