// Route-level unit tests for the admin settings API (src/app/api/settings/route.ts):
// GET (masked read) and PATCH (validated write). This file invokes the exported
// route handlers directly with constructed NextRequests + a REAL signed admin
// session, and pins the exact security contracts the route owns.
//
// ── THE HEADLINE: GUARDRAIL 7a (the bc81802 double-encryption bug) ────────────
// This route is EXACTLY where the `bc81802` regression shipped: a route-level
// pre-encryption of `Setting.value` before the write. The Prisma extension in
// src/lib/prisma.ts is the SOLE encryptor — it encrypts sensitive keys on write
// and decrypts on read, so callers always work in plaintext. A route that
// pre-encrypts produces double-wrapped `enc:v1:<enc:v1:…>` rows: on read the
// extension decrypts once and hands the inner ciphertext to upstream services as
// the API key, which then fails auth. So the load-bearing pin here is: the value
// handed to `tx.setting.upsert` is the RAW PLAINTEXT the admin submitted, NOT an
// `enc:v1:…` string — for a sensitive key (radarrApiKey / jellyfinApiKey / a
// webhook secret) AND a non-sensitive key (both pass through untouched).
//
// With prisma STUBBED (below), the real extension is bypassed entirely, so the
// value reaching the upsert stub IS what the route produced. If the route ever
// pre-encrypts, that value starts with `enc:v1:` and these assertions fail —
// that is the whole point of asserting on the raw upsert arg.
//
// ── Division of labour (owned elsewhere; NOT re-pinned here) ──────────────────
//   - tests/settings-sensitive-keys.test.mts OWNS isSensitiveSettingKey and the
//     SETTINGS_SENSITIVE_KEYS list (which keys are classified sensitive). Here we
//     pin only the ROUTE's *use* of that classification: sensitive values are
//     masked on GET and pass through as raw plaintext on PATCH.
//   - tests/token-crypto.test.mts OWNS encryptToken/decryptToken (incl. the
//     idempotency guard). We never call them — we assert the route does NOT.
//   - tests/api-auth.test.mts OWNS the withAuth/withAdmin wrapper matrix. Here we
//     spot-check that withAdmin fronts both handlers (401 anon, 403 non-admin).
//   - tests/body-size.test.mts OWNS the readJsonCapped cap logic; we pin only
//     that PATCH routes its body through it (413 over-cap, 400 malformed).
//
// No DB, no network, no DNS: globalThis.prisma is a recording fake seeded BEFORE
// the module graph loads (the admin-routes.test.mts idiom), fetch is scripted per
// test, and the connection-test Radarr/Sonarr URLs are RFC1918 IP literals so
// safeFetchAdminConfigured's SSRF stack short-circuits on isIP with no lookup.
// Admin sessions are REAL jose JWTs over in-memory AuthSession/User rows; claims
// mirror the rows so the privilege-rotation path never fires. Bearer transport
// skips the UA-fingerprint check and the sliding Set-Cookie, keeping responses clean.
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";

process.env.TOKEN_ENCRYPTION_KEY = "ab".repeat(32); // prisma.ts pulls in token-crypto at load
process.env.NEXTAUTH_SECRET = "settings-route-test-secret-0123456789abcdef";
process.env.AUTH_URL = "http://localhost:3000"; // unprefixed cookie name + trusted origin
process.env.TRUST_PROXY = "true"; // silence rate-limit's module-load warning

// ── console capture (guardrail 7: warn/error only; no console.log in tests) ───
const warns: string[] = [];
const errors: string[] = [];
console.warn = (...args: unknown[]) => { warns.push(args.map(String).join(" ")); };
console.error = (...args: unknown[]) => { errors.push(args.map(String).join(" ")); };

// ── scripted fetch (connection-test paths only) ──────────────────────────────
type FetchCall = { url: URL; method: string };
const fetchCalls: FetchCall[] = [];
let respond: (url: URL) => Response | Promise<Response> = (url) => {
  throw new Error(`unexpected fetch ${url} — script a responder for this test`);
};
globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
  const url = new URL(String(input));
  fetchCalls.push({ url, method: init?.method ?? "GET" });
  return respond(url);
}) as typeof fetch;

const okJson = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

// ── recording fake prisma (seeded on globalThis before the module graph) ─────
// One shared in-memory Setting store: top-level reads (findMany/findUnique) and
// in-tx writes (upsert/deleteMany) all go through it, so a connection-test read
// AFTER the write observes the freshly-written value — exactly like the real DB.
const settings = new Map<string, string>();

// Every tx.setting.upsert arg, in order — THE guardrail-7a surface. `create.value`
// / `update.value` here are whatever the route produced; the assertions demand
// they equal the submitted plaintext (never `enc:v1:…`).
type UpsertArgs = { where: { key: string }; update: { value: string }; create: { key: string; value: string } };
const upsertCalls: UpsertArgs[] = [];
const deleteManyCalls: Array<{ where: { key: string } }> = [];
const auditAttempts: Array<Record<string, unknown>> = [];
const auditRows: Array<Record<string, unknown>> = [];
let auditThrows = false;

type DbUser = {
  id: string; role: string; permissions: bigint; name: string | null; email: string | null;
  mediaServer: string | null; notificationEmail: string | null;
  sessionsRevokedAt: Date | null; passwordChangedAt: Date | null; deactivatedAt: Date | null;
};
const usersById = new Map<string, DbUser>();
const authSessionsById = new Map<string, { userId: string }>();

function makeTx() {
  return {
    setting: {
      upsert: async (args: UpsertArgs) => {
        upsertCalls.push(args);
        // create.value === update.value in this route; store either so a later
        // connection-test findMany sees the written value.
        settings.set(args.where.key, args.create.value);
        return { key: args.where.key, value: args.create.value };
      },
      deleteMany: async (args: { where: { key: string } }) => {
        deleteManyCalls.push(args);
        settings.delete(args.where.key);
        return { count: 1 };
      },
    },
    auditLog: {
      create: async (args: { data: Record<string, unknown> }) => {
        auditAttempts.push(args.data);
        if (auditThrows) throw new Error("audit insert exploded (unit test)");
        auditRows.push(args.data);
        return args.data;
      },
    },
  };
}

const fakePrisma = {
  user: {
    findUnique: async (args: { where: { id: string } }) => {
      const u = usersById.get(args.where.id);
      return u ? { ...u } : null;
    },
    update: async () => ({}),
  },
  authSession: {
    findUnique: async (args: { where: { sessionId: string } }) =>
      authSessionsById.has(args.where.sessionId)
        ? { id: `row-${args.where.sessionId}`, sessionId: args.where.sessionId }
        : null,
    update: async () => ({}), // lastSeenAt fire-and-forget touch
  },
  setting: {
    findMany: async (args?: { where?: { key?: { in?: string[] } } }) => {
      const only = args?.where?.key?.in;
      const rows = [...settings.entries()].map(([key, value]) => ({ key, value }));
      return only ? rows.filter((r) => only.includes(r.key)) : rows;
    },
    findUnique: async (args: { where: { key: string } }) => {
      const value = settings.get(args.where.key);
      return value === undefined ? null : { key: args.where.key, value };
    },
  },
  $transaction: async (arg: unknown, _opts?: { timeout?: number }) => {
    if (typeof arg === "function") return (arg as (t: ReturnType<typeof makeTx>) => Promise<unknown>)(makeTx());
    return Promise.all(arg as Promise<unknown>[]);
  },
};
(globalThis as unknown as { prisma: unknown }).prisma = fakePrisma;

// ── dynamic imports (env + globalThis stubs must precede the module graph) ───
const { NextRequest } = await import("next/server");
const { signSessionJwt } = await import("../src/lib/session-jwt.ts");
const { GET, PATCH } = await import("../src/app/api/settings/route.ts");

type Req = InstanceType<typeof NextRequest>;
const MASK = "••••••••";

// ── fixtures ────────────────────────────────────────────────────────────────
let seq = 0;

// Mint a real signed session JWT backed by an in-memory User + AuthSession row.
// Bearer transport (returned header): skips UA-fingerprint + sliding Set-Cookie,
// while the DB-checked auth still runs in full. Claims mirror the row (role +
// perms "0"), so verifyAndRefreshSession never rotates.
async function mintSession(role: string): Promise<{ userId: string; header: Record<string, string> }> {
  seq++;
  const userId = `actor-${seq}`;
  const sessionId = `actor-sess-${seq}`;
  usersById.set(userId, {
    id: userId, role, permissions: 0n, name: `Actor ${seq}`, email: "admin@example.com",
    mediaServer: null, notificationEmail: null,
    sessionsRevokedAt: null, passwordChangedAt: null, deactivatedAt: null,
  });
  authSessionsById.set(sessionId, { userId });
  const token = await signSessionJwt(
    { id: userId, role, permissions: "0", provider: "credentials", sessionId, expiresAt: Math.floor(Date.now() / 1000) + 86_400 },
    { expiresInSeconds: 7_200 },
  );
  return { userId, header: { authorization: `Bearer ${token}` } };
}

const ENDPOINT = "http://localhost:3000/api/settings";

function getReq(headers: Record<string, string> = {}): Req {
  return new NextRequest(ENDPOINT, { method: "GET", headers });
}
function patchReq(body: string, headers: Record<string, string> = {}): Req {
  return new NextRequest(ENDPOINT, { method: "PATCH", headers: { "content-type": "application/json", ...headers }, body });
}
const upsertFor = (key: string) => upsertCalls.filter((c) => c.where.key === key);

beforeEach(() => {
  auditThrows = false;
  upsertCalls.length = 0;
  deleteManyCalls.length = 0;
  auditAttempts.length = 0;
  auditRows.length = 0;
  fetchCalls.length = 0;
  warns.length = 0;
  errors.length = 0;
  respond = (url) => { throw new Error(`unexpected fetch ${url}`); };
  settings.clear(); // reset DB state; the route's per-key write cooldown is module-private (see notes on key reuse)
});

// ════════════════════════════════════════════════════════════════════════════
// GET — authorization + the masked/redacted read (no cleartext secret ever ships)
// ════════════════════════════════════════════════════════════════════════════

test("GET: no session → 401 (withAdmin fronts the read)", async () => {
  const res = await GET(getReq(), undefined);
  assert.equal(res.status, 401);
  assert.deepEqual(await res.json(), { error: "Unauthorized" });
});

test("GET: a plain USER → 403 Forbidden", async () => {
  const user = await mintSession("USER");
  const res = await GET(getReq(user.header), undefined);
  assert.equal(res.status, 403);
  assert.deepEqual(await res.json(), { error: "Forbidden" });
});

test("GET: every sensitive value is masked, URL userinfo is stripped, non-sensitive passes through — NO cleartext secret ships", async () => {
  const admin = await mintSession("ADMIN");
  // Seed real-looking secrets across several sensitive keys, one non-sensitive
  // key, and a URL key carrying embedded credentials.
  const secrets: Record<string, string> = {
    radarrApiKey: "RADARR-SECRET-aaaa",
    sonarrApiKey: "SONARR-SECRET-bbbb",
    jellyfinApiKey: "JELLYFIN-SECRET-cccc",
    plexAdminToken: "PLEX-SECRET-dddd",
    webhookSecret: "WEBHOOK-SECRET-eeee",
    smtpPassword: "SMTP-SECRET-ffff",
  };
  for (const [k, v] of Object.entries(secrets)) settings.set(k, v);
  settings.set("radarrUrl", "http://admin:hunter2@10.10.0.5:7878");
  settings.set("siteTitle", "My Media Server");

  const res = await GET(getReq(admin.header), undefined);
  assert.equal(res.status, 200);
  const body = (await res.json()) as Record<string, string>;

  // Every sensitive key is returned as the mask (non-empty ⇒ "••••••••"), never cleartext.
  for (const key of Object.keys(secrets)) {
    assert.equal(body[key], MASK, `${key} must be masked, not returned in cleartext`);
  }
  // The URL key ships with embedded credentials stripped.
  assert.ok(!body.radarrUrl.includes("hunter2"), "URL userinfo password must be stripped on read");
  assert.ok(!body.radarrUrl.includes("admin@"), "URL userinfo username must be stripped on read");
  assert.ok(body.radarrUrl.includes("10.10.0.5"), "the host itself must survive userinfo stripping");
  // Non-sensitive values pass through verbatim.
  assert.equal(body.siteTitle, "My Media Server");

  // Belt-and-suspenders: not one raw secret appears anywhere in the serialized response.
  const wire = JSON.stringify(body);
  for (const v of Object.values(secrets)) {
    assert.ok(!wire.includes(v), `raw secret ${v} leaked into the GET response body`);
  }
});

test("GET: a sensitive key stored empty is returned as an empty string, not the mask", async () => {
  const admin = await mintSession("ADMIN");
  settings.set("radarrApiKey", ""); // cleared credential
  const res = await GET(getReq(admin.header), undefined);
  assert.equal(res.status, 200);
  assert.equal((await res.json() as Record<string, string>).radarrApiKey, "");
});

// ════════════════════════════════════════════════════════════════════════════
// PATCH — authorization fronting
// ════════════════════════════════════════════════════════════════════════════

test("PATCH: no session → 401, no upsert, no audit", async () => {
  const res = await PATCH(patchReq(JSON.stringify({ siteTitle: "x" })), undefined);
  assert.equal(res.status, 401);
  assert.equal(upsertCalls.length, 0, "the handler body must not run for an unauthenticated caller");
  assert.equal(auditAttempts.length, 0);
});

test("PATCH: a plain USER → 403, no upsert", async () => {
  const user = await mintSession("USER");
  const res = await PATCH(patchReq(JSON.stringify({ siteTitle: "x" }), user.header), undefined);
  assert.equal(res.status, 403);
  assert.deepEqual(await res.json(), { error: "Forbidden" });
  assert.equal(upsertCalls.length, 0);
});

// ════════════════════════════════════════════════════════════════════════════
// GUARDRAIL 7a — the route stores RAW PLAINTEXT; it must NEVER pre-encrypt.
// (Each write test below uses a DISTINCT Setting key: the route enforces a 10s
// per-key write cooldown via a module-private Map that outlives beforeEach, so
// reusing a key across tests within one fast run would 429.)
// ════════════════════════════════════════════════════════════════════════════

test("GUARDRAIL 7a (headline): a sensitive key reaches setting.upsert as PLAINTEXT, never enc:v1:… (the bc81802 double-encryption bug)", async () => {
  const admin = await mintSession("ADMIN");
  const PLAINTEXT = "radarr-api-key-PLAINTEXT-123";
  const res = await PATCH(patchReq(JSON.stringify({ radarrApiKey: PLAINTEXT }), admin.header), undefined);
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { ok: true });

  const calls = upsertFor("radarrApiKey");
  assert.equal(calls.length, 1, "the sensitive key must be written exactly once");
  const { create, update } = calls[0];
  // THE pin: the value the route handed the DB layer is the admin's plaintext.
  // The Prisma extension (bypassed here) is the sole encryptor; a route that
  // pre-encrypts would produce enc:v1:<enc:v1:…> — the bc81802 regression.
  assert.equal(create.value, PLAINTEXT, "create.value must be the raw submitted plaintext");
  assert.equal(update.value, PLAINTEXT, "update.value must be the raw submitted plaintext");
  assert.ok(
    !create.value.startsWith("enc:v1:"),
    "bc81802 double-encryption regression: the route pre-encrypted a Setting.value at the call site — the Prisma extension MUST be the sole encryptor",
  );

  // Gated side effect: with radarrApiKey written but radarrUrl absent, the Radarr
  // connection test must NOT fire (guard requires both URL and key).
  assert.equal(fetchCalls.length, 0, "no connection test may fire when only the API key (no URL) is present");
});

test("GUARDRAIL 7a: two more sensitive keys AND a non-sensitive key all pass through setting.upsert verbatim", async () => {
  const admin = await mintSession("ADMIN");
  const body = {
    jellyfinApiKey: "jellyfin-key-PLAINTEXT-xyz", // sensitive (…ApiKey)
    sonarrWebhookSecret: "sonarr-webhook-PLAINTEXT-77", // sensitive (…Secret) — a webhook secret
    radarrRootFolder: "/data/media/movies", // non-sensitive
  };
  const res = await PATCH(patchReq(JSON.stringify(body), admin.header), undefined);
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { ok: true });

  for (const [key, expected] of Object.entries(body)) {
    const calls = upsertFor(key);
    assert.equal(calls.length, 1, `${key} must be written once`);
    assert.equal(calls[0].create.value, expected, `${key}: create.value must be the raw plaintext`);
    assert.equal(calls[0].update.value, expected, `${key}: update.value must be the raw plaintext`);
    assert.ok(
      !calls[0].create.value.startsWith("enc:v1:"),
      `${key}: the route must not pre-encrypt (bc81802) — sensitive AND non-sensitive keys both store plaintext`,
    );
  }
  assert.equal(fetchCalls.length, 0, "none of these keys trigger a connection test");
});

// ════════════════════════════════════════════════════════════════════════════
// PATCH — body caps (guardrail 30) + malformed-body handling
// ════════════════════════════════════════════════════════════════════════════

test("GUARDRAIL 30: an over-cap Content-Length → 413 before any write (readJsonCapped, not a bare req.json())", async () => {
  const admin = await mintSession("ADMIN");
  const res = await PATCH(
    patchReq(JSON.stringify({ siteTitle: "x" }), { ...admin.header, "content-length": String(65536 + 1) }),
    undefined,
  );
  assert.equal(res.status, 413, "the 64 KB PATCH cap must reject an over-cap body up front");
  assert.equal(upsertCalls.length, 0, "no Setting write may happen once the body is rejected");
});

test("PATCH: malformed JSON → 400 Invalid request body, no write", async () => {
  const admin = await mintSession("ADMIN");
  const res = await PATCH(patchReq("{not valid json", admin.header), undefined);
  assert.equal(res.status, 400);
  assert.deepEqual(await res.json(), { error: "Invalid request body" });
  assert.equal(upsertCalls.length, 0);
});

// ════════════════════════════════════════════════════════════════════════════
// PATCH — key allowlisting + per-key validation
// ════════════════════════════════════════════════════════════════════════════

test("PATCH: an unknown key is silently ignored; only the allowlisted key is written", async () => {
  const admin = await mintSession("ADMIN");
  const res = await PATCH(
    patchReq(JSON.stringify({ notARealSetting: "attacker-controlled", siteTitle: "Renamed Server" }), admin.header),
    undefined,
  );
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { ok: true });
  assert.equal(upsertFor("siteTitle").length, 1, "the allowlisted key is written");
  assert.equal(upsertFor("siteTitle")[0].create.value, "Renamed Server");
  assert.equal(upsertFor("notARealSetting").length, 0, "an unknown key must never reach the DB");
  assert.equal(settings.has("notARealSetting"), false);
});

test("PATCH: a URL key with embedded credentials → 400, no write", async () => {
  const admin = await mintSession("ADMIN");
  const res = await PATCH(
    patchReq(JSON.stringify({ radarrUrl: "http://user:pass@10.0.0.9:7878" }), admin.header),
    undefined,
  );
  assert.equal(res.status, 400);
  assert.deepEqual(await res.json(), { error: 'Setting "radarrUrl" must not contain embedded credentials' });
  assert.equal(upsertCalls.length, 0, "a rejected value must not be persisted");
});

test("PATCH: a malformed validated value (discordClientId not a snowflake) → 400, no write", async () => {
  const admin = await mintSession("ADMIN");
  const res = await PATCH(
    patchReq(JSON.stringify({ discordClientId: "not-a-snowflake" }), admin.header),
    undefined,
  );
  assert.equal(res.status, 400);
  assert.deepEqual(await res.json(), { error: 'Setting "discordClientId" must be a numeric Discord snowflake' });
  assert.equal(upsertCalls.length, 0);
});

// ════════════════════════════════════════════════════════════════════════════
// PATCH — rate limit + per-key write cooldown
// ════════════════════════════════════════════════════════════════════════════

test("PATCH: the admin-settings rate limit (10/min per admin) returns 429 on the 11th request", async () => {
  const admin = await mintSession("ADMIN"); // one admin ⇒ one rate-limit bucket
  for (let i = 0; i < 10; i++) {
    const res = await PATCH(patchReq("{}", admin.header), undefined); // empty body writes nothing (no cooldown consumed)
    assert.equal(res.status, 200, `request ${i + 1} must be under the limit`);
  }
  const limited = await PATCH(patchReq("{}", admin.header), undefined);
  assert.equal(limited.status, 429);
  assert.deepEqual(await limited.json(), { error: "Too many requests — try again later" });
});

test("PATCH: writing the same key twice in quick succession → 429 per-key write cooldown with retryAfterMs", async () => {
  const admin = await mintSession("ADMIN");
  const first = await PATCH(patchReq(JSON.stringify({ donationPatreon: "https://patreon.com/alice" }), admin.header), undefined);
  assert.equal(first.status, 200, "the first write of the key succeeds");
  assert.equal(upsertFor("donationPatreon").length, 1);

  const second = await PATCH(patchReq(JSON.stringify({ donationPatreon: "https://patreon.com/bob" }), admin.header), undefined);
  assert.equal(second.status, 429, "a second write within the 10s cooldown is throttled");
  const body = (await second.json()) as { error: string; retryAfterMs: number };
  assert.match(body.error, /modified too recently/);
  assert.equal(typeof body.retryAfterMs, "number");
  assert.equal(upsertFor("donationPatreon").length, 1, "the throttled second write never reached the DB");
});

// ════════════════════════════════════════════════════════════════════════════
// PATCH — connection-test side effect (reached when URL+key present; gated otherwise)
// RFC1918 IP literals ⇒ admin SSRF mode, isIP short-circuit, no DNS.
// ════════════════════════════════════════════════════════════════════════════

test("PATCH: writing a Radarr URL + key REACHES the connection test; a failure rolls the write back with 422", async () => {
  const admin = await mintSession("ADMIN");
  // Default respond() throws ⇒ the Radarr status fetch fails ⇒ testRadarrConnection
  // throws ⇒ the route records the error, rolls back, and returns 422.
  const res = await PATCH(
    patchReq(JSON.stringify({ radarr4kUrl: "http://10.0.0.1:7878", radarr4kApiKey: "k4-plaintext" }), admin.header),
    undefined,
  );
  assert.equal(res.status, 422, "a failed connectivity test must surface as 422");
  const body = (await res.json()) as { ok: boolean; radarr4kError?: string };
  assert.equal(body.ok, false);
  assert.equal(body.radarr4kError, "Radarr 4K connection failed", "the connection test was reached and reported failure");

  // Proof it was reached: a fetch to the Radarr status endpoint was attempted.
  assert.ok(
    fetchCalls.some((c) => c.url.hostname === "10.0.0.1" && c.url.pathname === "/api/v3/system/status"),
    "the Radarr status probe must have been issued",
  );
  // Proof of rollback: both freshly-created keys were deleted; nothing durably persisted.
  const rolledBack = deleteManyCalls.map((c) => c.where.key).sort();
  assert.deepEqual(rolledBack, ["radarr4kApiKey", "radarr4kUrl"], "a failed test rolls back the keys it just wrote");
  assert.equal(settings.has("radarr4kApiKey"), false);
  assert.equal(settings.has("radarr4kUrl"), false);
});

test("PATCH: writing a Sonarr URL + key with a healthy server → 200 with the reported version, values persist", async () => {
  const admin = await mintSession("ADMIN");
  respond = (url) => {
    if (url.hostname === "10.0.0.2" && url.pathname === "/api/v3/system/status") return okJson({ version: "4.0.0.999" });
    throw new Error(`unexpected fetch ${url}`);
  };
  const res = await PATCH(
    patchReq(JSON.stringify({ sonarrUrl: "http://10.0.0.2:8989", sonarrApiKey: "sonarr-plaintext" }), admin.header),
    undefined,
  );
  assert.equal(res.status, 200);
  const body = (await res.json()) as { ok: boolean; sonarrVersion?: string };
  assert.equal(body.ok, true);
  assert.equal(body.sonarrVersion, "4.0.0.999", "a passing test surfaces the upstream version");
  assert.equal(deleteManyCalls.length, 0, "a passing test never rolls back");
  assert.equal(settings.get("sonarrUrl"), "http://10.0.0.2:8989", "the value persists after a passing test");
  // And the sensitive key still stored plaintext (guardrail 7a holds on the success path too).
  assert.equal(upsertFor("sonarrApiKey")[0].create.value, "sonarr-plaintext");
});
