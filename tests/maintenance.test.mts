// Unit tests for maintenance mode (src/lib/maintenance.ts): getMaintenanceStatus
// (the Setting-backed on/off + message read) and maintenanceGuard (the 503 gate
// mutating API routes call before doing work). The contracts pinned here:
//   - status parsing is STRICT: only the literal "true" enables maintenance
//     ("TRUE"/"1"/missing/anything else ⇒ off), message defaults to "";
//   - a failed Settings read FAILS CLOSED ({enabled:true}) — during a DB
//     incident writes must not slip through just because the flag is unreadable;
//   - the guard returns null (allow) when maintenance is off, and a REAL
//     NextResponse — status 503, body { error: "Service unavailable", message }
//     with the "Under maintenance" fallback for an empty/missing message — when
//     it is on. Native clients parse that exact body;
//   - the admin bypass is an authz decision keyed off the ADMIN permission bit
//     (hasPermission), not the role string, and it short-circuits BEFORE the
//     status read; a signed-in non-admin is NOT exempt;
//   - the bypass rides authActive(), so a garbage cookie, an expired JWT, and
//     an admin cookie replayed under a different User-Agent (UA-fingerprint
//     mismatch) all degrade to "anonymous" — blocked, never thrown.
//
// Harness notes — maintenanceGuard's session read is the DB-checked
// authActive(), which reaches cookies()/headers() from next/headers, and those
// THROW outside a Next request scope. The tests therefore run each guard call
// inside a minimal synthetic request scope: Next's real workAsyncStorage +
// workUnitAsyncStorage singletons (the same CJS instances next/headers.js
// reads — required via createRequire so there's no ESM-interop ambiguity) are
// entered with a type:"request"/phase:"render" store whose cookies/headers are
// built by Next's own RequestCookies/HeadersAdapter. Next's storage shim also
// needs globalThis.AsyncLocalStorage, which Next's server preamble normally
// provides — set here before the module graph loads. This exercises the REAL
// wire path (real cookie parse, real JWT verify, real fingerprint check)
// instead of stubbing authActive.
//
// No DB or network: sessions are real signSessionJwt tokens carrying a
// fresh dbCheckedAt claim, so verifyAndRefreshSession takes its documented
// fast path (recently-DB-validated ⇒ skip the DB round-trip) — the ONLY
// prisma surface left is prisma.setting.findMany, shadowed in-memory
// (tests/_helpers.mts). The admin-bypass test doubles as a fast-path pin:
// zero setting reads proves nothing else touched the stub.
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { AsyncLocalStorage } from "node:async_hooks";

// Next's async-local-storage shim captures globalThis.AsyncLocalStorage at
// module load — assign it BEFORE anything pulls in next/headers.
(globalThis as { AsyncLocalStorage?: unknown }).AsyncLocalStorage = AsyncLocalStorage;

process.env.TOKEN_ENCRYPTION_KEY = "ab".repeat(32); // prisma.ts pulls in token-crypto
process.env.NEXTAUTH_SECRET = "unit-test-session-secret-0123456789abcdef"; // session-jwt sign/verify
process.env.AUTH_URL = "http://localhost:3000"; // insecure context → unprefixed cookie name
// Keep next/headers off its dev-warnings wrappers (they expect richer store
// shapes). Cast: next/types marks NODE_ENV readonly at the type level.
(process.env as Record<string, string | undefined>).NODE_ENV = "test";

// ── console capture (rate-limit warns at import; auth paths log) ────────────
const warns: string[] = [];
const errors: string[] = [];
console.warn = (...args: unknown[]) => { warns.push(args.map(String).join(" ")); };
console.error = (...args: unknown[]) => { errors.push(args.map(String).join(" ")); };

// The storage singletons + request-store building blocks. createRequire (not
// import) guarantees we get the exact CJS module instances next/headers.js
// itself loads.
type RunStore = { run<T>(store: unknown, fn: () => T): T };
const cjsRequire = createRequire(import.meta.url);
const { workAsyncStorage } = cjsRequire("next/dist/server/app-render/work-async-storage.external.js") as { workAsyncStorage: RunStore };
const { workUnitAsyncStorage } = cjsRequire("next/dist/server/app-render/work-unit-async-storage.external.js") as { workUnitAsyncStorage: RunStore };
const { RequestCookies } = cjsRequire("next/dist/server/web/spec-extension/cookies.js") as { RequestCookies: new (h: Headers) => unknown };
const { RequestCookiesAdapter } = cjsRequire("next/dist/server/web/spec-extension/adapters/request-cookies.js") as { RequestCookiesAdapter: { seal(c: unknown): unknown } };
const { HeadersAdapter } = cjsRequire("next/dist/server/web/spec-extension/adapters/headers.js") as { HeadersAdapter: { seal(h: Headers): unknown } };

// Dynamic imports so the env/global stubs above genuinely precede the
// module-graph load (static imports would hoist above them).
const { prisma } = await import("../src/lib/prisma.ts");
const { shadowPrismaModel } = await import("./_helpers.mts");
const { getMaintenanceStatus, maintenanceGuard } = await import("../src/lib/maintenance.ts");
const { signSessionJwt } = await import("../src/lib/session-jwt.ts");
const { getSessionCookieName } = await import("../src/lib/session-cookie.ts");
const { extractUaFingerprint, serializeFingerprint } = await import("../src/lib/ua-fingerprint.ts");
const { Permission } = await import("../src/lib/permissions.ts");
const { NextResponse } = await import("next/server");

// ── prisma stub ─────────────────────────────────────────────────────────────
const settings = new Map<string, string>();
const findManyCalls: string[][] = [];
let settingsReadFails = false;
shadowPrismaModel(prisma, "setting", {
  findMany: async (args: { where: { key: { in: string[] } } }) => {
    findManyCalls.push([...args.where.key.in]);
    if (settingsReadFails) throw new Error("connection refused");
    return args.where.key.in
      .filter((k) => settings.has(k))
      .map((k) => ({ key: k, value: settings.get(k) }));
  },
});

// ── synthetic request scope ─────────────────────────────────────────────────
function withRequestContext<T>(
  opts: { cookies?: Record<string, string>; userAgent?: string },
  fn: () => Promise<T>,
): Promise<T> {
  const reqHeaders = new Headers();
  if (opts.userAgent) reqHeaders.set("user-agent", opts.userAgent);
  const cookiePairs = Object.entries(opts.cookies ?? {});
  if (cookiePairs.length > 0) {
    reqHeaders.set("cookie", cookiePairs.map(([k, v]) => `${k}=${v}`).join("; "));
  }
  const workStore = { route: "/maintenance.test", forceStatic: false, dynamicShouldError: false };
  const requestStore = {
    type: "request",
    phase: "render",
    headers: HeadersAdapter.seal(reqHeaders),
    cookies: RequestCookiesAdapter.seal(new RequestCookies(reqHeaders)),
    usedDynamic: false,
  };
  return workAsyncStorage.run(workStore, () => workUnitAsyncStorage.run(requestStore, fn));
}

// A real session JWT whose dbCheckedAt rides the fast path (≤10s for admins,
// ≤60s otherwise), so verifyAndRefreshSession never needs authSession/user rows.
async function mintSessionJwt(opts: {
  role: string;
  permissions?: string;
  uaFingerprint?: string;
  expiresInSeconds?: number;
}): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  return signSessionJwt(
    {
      id: "user-1",
      role: opts.role,
      permissions: opts.permissions ?? "0",
      provider: "credentials",
      sessionId: "11111111-1111-4111-8111-111111111111",
      expiresAt: now + 3600,
      dbCheckedAt: now,
      ...(opts.uaFingerprint ? { uaFingerprint: opts.uaFingerprint } : {}),
    },
    { expiresInSeconds: opts.expiresInSeconds ?? 3600 },
  );
}

const COOKIE = getSessionCookieName();
const UA_CHROME =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36";

beforeEach(() => {
  settings.clear();
  findManyCalls.length = 0;
  settingsReadFails = false;
  warns.length = 0;
  errors.length = 0;
});

// ── getMaintenanceStatus ────────────────────────────────────────────────────

test("status: enabled 'true' + message parse through; exactly the two keys are queried", async () => {
  settings.set("maintenanceEnabled", "true");
  settings.set("maintenanceMessage", "Upgrading the database");
  assert.deepEqual(await getMaintenanceStatus(), { enabled: true, message: "Upgrading the database" });
  assert.deepEqual(findManyCalls, [["maintenanceEnabled", "maintenanceMessage"]]);
});

test("status: only the literal 'true' enables — 'false'/'TRUE'/'1'/missing all read as off; message defaults ''", async () => {
  for (const value of ["false", "TRUE", "1", "yes", ""]) {
    settings.set("maintenanceEnabled", value);
    assert.deepEqual(await getMaintenanceStatus(), { enabled: false, message: "" }, `enabled=${JSON.stringify(value)}`);
  }
  settings.delete("maintenanceEnabled"); // no row at all
  assert.deepEqual(await getMaintenanceStatus(), { enabled: false, message: "" });
});

test("status: a failed Settings read FAILS CLOSED (enabled:true) instead of throwing", async () => {
  settingsReadFails = true;
  assert.deepEqual(await getMaintenanceStatus(), { enabled: true, message: "" });
});

// ── maintenanceGuard ────────────────────────────────────────────────────────

test("guard: maintenance off → null for an anonymous request (the everyday no-op)", async () => {
  const res = await withRequestContext({}, () => maintenanceGuard());
  assert.equal(res, null);
});

test("guard: maintenance on → a real 503 NextResponse with the exact JSON body native clients parse", async () => {
  settings.set("maintenanceEnabled", "true");
  settings.set("maintenanceMessage", "Back at 09:00 UTC");
  const res = await withRequestContext({}, () => maintenanceGuard());
  assert.ok(res instanceof NextResponse, "must be the real NextResponse the route returns as-is");
  assert.equal(res.status, 503);
  assert.deepEqual(await res.json(), { error: "Service unavailable", message: "Back at 09:00 UTC" });
});

test("guard: empty or missing message falls back to 'Under maintenance'", async () => {
  settings.set("maintenanceEnabled", "true");
  settings.set("maintenanceMessage", "");
  const res1 = await withRequestContext({}, () => maintenanceGuard());
  assert.deepEqual(await res1!.json(), { error: "Service unavailable", message: "Under maintenance" });

  settings.delete("maintenanceMessage"); // no message row at all
  const res2 = await withRequestContext({}, () => maintenanceGuard());
  assert.deepEqual(await res2!.json(), { error: "Service unavailable", message: "Under maintenance" });
});

test("guard: an ADMIN session bypasses with null and short-circuits BEFORE the status read", async () => {
  settings.set("maintenanceEnabled", "true");
  const jwt = await mintSessionJwt({ role: "ADMIN" });
  const res = await withRequestContext(
    { cookies: { [COOKIE]: jwt }, userAgent: UA_CHROME },
    () => maintenanceGuard(),
  );
  assert.equal(res, null);
  assert.equal(findManyCalls.length, 0, "the admin bypass must not read maintenance settings at all");
});

test("guard: a signed-in NON-admin is not exempt — 503 like everyone else", async () => {
  settings.set("maintenanceEnabled", "true");
  const jwt = await mintSessionJwt({ role: "USER" });
  const res = await withRequestContext(
    { cookies: { [COOKIE]: jwt }, userAgent: UA_CHROME },
    () => maintenanceGuard(),
  );
  assert.equal(res?.status, 503);
});

test("guard: the bypass keys off the ADMIN permission BIT, not the role string", async () => {
  // A non-ADMIN role explicitly granted the ADMIN superbit passes hasPermission
  // — the guard's contract is the permission model, not role === "ADMIN".
  settings.set("maintenanceEnabled", "true");
  const jwt = await mintSessionJwt({ role: "USER", permissions: Permission.ADMIN.toString() });
  const res = await withRequestContext(
    { cookies: { [COOKIE]: jwt }, userAgent: UA_CHROME },
    () => maintenanceGuard(),
  );
  assert.equal(res, null);
});

test("guard: a garbage cookie and an expired JWT both degrade to anonymous (503), never throw", async () => {
  settings.set("maintenanceEnabled", "true");

  const garbage = await withRequestContext(
    { cookies: { [COOKIE]: "not-a-jwt" } },
    () => maintenanceGuard(),
  );
  assert.equal(garbage?.status, 503);

  const expiredJwt = await mintSessionJwt({ role: "ADMIN", expiresInSeconds: -60 });
  const expired = await withRequestContext(
    { cookies: { [COOKIE]: expiredJwt }, userAgent: UA_CHROME },
    () => maintenanceGuard(),
  );
  assert.equal(expired?.status, 503, "an expired admin token must not bypass maintenance");
});

test("guard: an admin cookie replayed under a different User-Agent loses the bypass (authActive's fingerprint check)", async () => {
  settings.set("maintenanceEnabled", "true");
  const storedFp = serializeFingerprint(extractUaFingerprint(UA_CHROME));
  const jwt = await mintSessionJwt({ role: "ADMIN", uaFingerprint: storedFp });

  // Positive control: same device class → fingerprint matches → bypass holds.
  const sameUa = await withRequestContext(
    { cookies: { [COOKIE]: jwt }, userAgent: UA_CHROME },
    () => maintenanceGuard(),
  );
  assert.equal(sameUa, null);

  // Replay from a different client → authActive returns null → treated as
  // anonymous → blocked. A stolen admin cookie can't ride out maintenance.
  const replay = await withRequestContext(
    { cookies: { [COOKIE]: jwt }, userAgent: "curl/8.7.1" },
    () => maintenanceGuard(),
  );
  assert.equal(replay?.status, 503);
});

test("guard: a Settings read failure fails closed — anonymous requests get 503", async () => {
  settingsReadFails = true;
  const res = await withRequestContext({}, () => maintenanceGuard());
  assert.equal(res?.status, 503);
  assert.deepEqual(await res!.json(), { error: "Service unavailable", message: "Under maintenance" });
});
