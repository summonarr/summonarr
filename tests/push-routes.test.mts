// Route-level unit tests for the push-notification API surface:
//   POST /api/push/subscribe       — register a Web Push (VAPID) subscription
//   POST /api/push/apns            — register an iOS APNs device token
//   GET  /api/push/vapid-key       — hand the browser the VAPID public key
//   POST /api/push/test            — fire a diagnostic push to the caller's devices
//   POST /api/push/announce-update — admin broadcast "update the app" to all iOS
//
// THE anchor assertion is guardrail 7a. /api/push/subscribe and /api/push/apns
// are TWO of the only THREE legitimate call-site `encryptToken` uses in the tree
// (PushSubscription is NOT covered by the prisma crypto extension — see
// tests/token-crypto.test.mts + CLAUDE.md guardrail 7a), so the row-at-rest
// shape is the route's own responsibility and exactly the surface that regressed
// as double-encryption (`enc:v1:<enc:v1:…>`) or plaintext elsewhere. These tests
// register real subscriptions and prove the stored p256dh/auth (web) and
// deviceToken (iOS) are encrypted EXACTLY ONCE — they carry the `enc:v1:` marker
// AND decrypt in a single pass back to the original plaintext (a value that
// decrypts to a nested `enc:v1:…` would be the double-encryption bug). The E2E
// `publicKey` is pinned as the deliberate exception: stored in plaintext.
//
// Division of labour: tests/push.test.mts OWNS the push.ts orchestration
// internals (sendApnsTestToUser per-device results, sendAppUpdateNoticeToAllIos
// {sent,failed}, getOrCreateVapidPublicKey advisory-lock lifecycle, the APNs
// relay wire + E2E blob layout, recipient bitmask selection). This file only
// pins how the ROUTES wire into them: the auth wrapper (guardrail 6a — 401 before
// any body runs, ADMIN-gating on the broadcast), the body caps (guardrail 30),
// validation/SSRF/upsert semantics, feature-flag gating, and the response shapes
// native + web clients decode.
//
// No DB, network, or DNS: prisma.{setting,pushSubscription,authSession,user} and
// $transaction are shadowed in-memory (tests/_helpers.mts); dns/promises.lookup
// is stubbed to a public IP so the subscribe SSRF resolve + the APNs relay
// safe-fetch never leave the process; globalThis.fetch answers only the relay
// host. Sessions are REAL signed jose JWTs over the in-memory authSession/user
// stubs (tests/api-auth.test.mts idiom). maintenanceGuard()'s authActive()
// reaches cookies()/headers() from next/headers, which THROW outside a Next
// request scope, so every route call runs inside a minimal synthetic
// work/request async-storage scope (tests/maintenance.test.mts idiom).
// TOKEN_ENCRYPTION_KEY is set FIRST and identically so the route's encryptToken
// and this file's decryptToken share a key and genuinely round-trip.
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { AsyncLocalStorage } from "node:async_hooks";
import { createECDH } from "node:crypto";
import dns from "node:dns/promises";

// Next's async-local-storage shim captures globalThis.AsyncLocalStorage at
// module load — assign it BEFORE anything pulls in next/headers.
(globalThis as { AsyncLocalStorage?: unknown }).AsyncLocalStorage = AsyncLocalStorage;

process.env.TOKEN_ENCRYPTION_KEY = "ab".repeat(32); // 64 hex — SAME key encrypt+decrypt round-trip
process.env.NEXTAUTH_SECRET = "push-routes-test-secret-0123456789abcdef"; // session JWT sign/verify
process.env.AUTH_URL = "http://localhost:3000"; // insecure context → unprefixed cookie name
process.env.TRUST_PROXY = "true"; // silence rate-limit's module-load warning
process.env.DATABASE_URL ??= "postgresql://unit:unit@127.0.0.1:9/never_connects";
// Keep next/headers off its dev-warning wrappers (they expect richer store shapes).
(process.env as Record<string, string | undefined>).NODE_ENV = "test";

// ── DNS stub (tests/push.test.mts rationale) — the subscribe SSRF resolve and
// the APNs relay safe-fetch both resolve a hostname; no real lookup may escape.
const fakeLookup = async () => [{ address: "93.184.216.34", family: 4 }];
(dns as { lookup: unknown }).lookup = fakeLookup;
if ((dns as { lookup: unknown }).lookup !== fakeLookup) {
  throw new Error("could not stub dns.lookup — aborting before a real DNS query can leave the process");
}

// ── console capture ─────────────────────────────────────────────────────────
const warns: string[] = [];
const errors: string[] = [];
console.warn = (...args: unknown[]) => { warns.push(args.map(String).join(" ")); };
console.error = (...args: unknown[]) => { errors.push(args.map(String).join(" ")); };

// ── scripted fetch: only the APNs relay host answers; anything else throws ────
type RelayBody = { deviceToken: string; payload: { aps?: unknown; url?: string; e2e?: string }; collapseId?: string };
type RelayCall = { url: string; auth: string | null; body: RelayBody };
const relayCalls: RelayCall[] = [];
function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}
let relayRespond: (call: RelayCall) => Response = () => jsonResponse({ ok: true });
globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
  const url = input instanceof Request ? input.url : String(input);
  const { hostname } = new URL(url);
  if (hostname === "summonapns.gadgetusaf.com") {
    const call: RelayCall = {
      url,
      auth: new Headers(init?.headers).get("authorization"),
      body: JSON.parse(String(init?.body)) as RelayBody,
    };
    relayCalls.push(call);
    return relayRespond(call);
  }
  throw new Error(`unexpected fetch: ${url} — no push route should reach this host`);
}) as typeof fetch;

// ── Next request-scope building blocks (tests/maintenance.test.mts idiom).
// createRequire pins the exact CJS singletons next/headers.js itself reads.
type RunStore = { run<T>(store: unknown, fn: () => T): T };
const cjsRequire = createRequire(import.meta.url);
const { workAsyncStorage } = cjsRequire("next/dist/server/app-render/work-async-storage.external.js") as { workAsyncStorage: RunStore };
const { workUnitAsyncStorage } = cjsRequire("next/dist/server/app-render/work-unit-async-storage.external.js") as { workUnitAsyncStorage: RunStore };
const { RequestCookies } = cjsRequire("next/dist/server/web/spec-extension/cookies.js") as { RequestCookies: new (h: Headers) => unknown };
const { RequestCookiesAdapter } = cjsRequire("next/dist/server/web/spec-extension/adapters/request-cookies.js") as { RequestCookiesAdapter: { seal(c: unknown): unknown } };
const { HeadersAdapter } = cjsRequire("next/dist/server/web/spec-extension/adapters/headers.js") as { HeadersAdapter: { seal(h: Headers): unknown } };

// Dynamic imports so the env/global stubs above genuinely precede the module graph.
const { NextRequest } = await import("next/server");
const { prisma } = await import("../src/lib/prisma.ts");
const { shadowPrismaModel, shadowPrismaClientMethod } = await import("./_helpers.mts");
const { signSessionJwt } = await import("../src/lib/session-jwt.ts");
const { getSessionCookieName } = await import("../src/lib/session-cookie.ts");
const { encryptToken, decryptToken } = await import("../src/lib/token-crypto.ts");
const { invalidateFeatureFlagCache } = await import("../src/lib/features.ts");

// ── Setting stub (feature flags, VAPID keys, relay config, maintenance, cap) ──
const settings = new Map<string, string>();
const settingModel = {
  findUnique: async (args: { where: { key: string } }) =>
    settings.has(args.where.key) ? { key: args.where.key, value: settings.get(args.where.key)! } : null,
  findMany: async (args: { where?: { key?: { in?: string[] } } }) => {
    const keys = args?.where?.key?.in ?? [...settings.keys()];
    return keys.filter((k) => settings.has(k)).map((k) => ({ key: k, value: settings.get(k)! }));
  },
  upsert: async (args: { where: { key: string }; create: { key: string; value: string } }) => {
    settings.set(args.where.key, args.create.value);
    return { key: args.where.key, value: args.create.value };
  },
};
shadowPrismaModel(prisma, "setting", settingModel);

// ── PushSubscription stub — the in-memory row store the routes write through.
// The SAME object backs both the top-level delegate and the tx-scoped delegate,
// so a tx upsert is visible to a post-call inspection.
type SubRow = {
  id: string;
  createdAt: Date;
  endpoint: string;
  platform: string;
  p256dh: string | null;
  auth: string | null;
  deviceToken: string | null;
  publicKey: string | null;
  label: string | null;
  userId: string | null;
};
let subRows: SubRow[] = [];
let subSeq = 0;

type SubWhere = { userId?: string | { in?: string[] }; platform?: string; endpoint?: string; id?: string };
function subMatches(row: SubRow, where: SubWhere | undefined): boolean {
  if (!where) return true;
  if (typeof where.userId === "string" && row.userId !== where.userId) return false;
  if (where.userId && typeof where.userId === "object" && where.userId.in && !where.userId.in.includes(row.userId ?? "")) return false;
  if (where.platform !== undefined && row.platform !== where.platform) return false;
  if (where.endpoint !== undefined && row.endpoint !== where.endpoint) return false;
  if (where.id !== undefined && row.id !== where.id) return false;
  return true;
}

const pushModel = {
  findUnique: async (args: { where: { endpoint: string } }) =>
    subRows.find((r) => r.endpoint === args.where.endpoint) ?? null,
  findMany: async (args: { where?: SubWhere }) =>
    subRows.filter((r) => subMatches(r, args?.where)).map((r) => ({ ...r })),
  count: async (args: { where?: SubWhere }) => subRows.filter((r) => subMatches(r, args?.where)).length,
  findFirst: async (args: { where?: SubWhere }) => {
    const matched = subRows.filter((r) => subMatches(r, args?.where));
    matched.sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime());
    return matched[0] ?? null;
  },
  deleteMany: async (args: { where: SubWhere }) => {
    const before = subRows.length;
    subRows = subRows.filter((r) => !subMatches(r, args.where));
    return { count: before - subRows.length };
  },
  upsert: async (args: {
    where: { endpoint: string };
    create: Partial<SubRow> & { endpoint: string };
    update: Partial<SubRow>;
  }) => {
    const existing = subRows.find((r) => r.endpoint === args.where.endpoint);
    if (existing) {
      Object.assign(existing, args.update);
      return { ...existing };
    }
    const row: SubRow = {
      id: `stored-${++subSeq}`,
      createdAt: new Date(),
      platform: "web", // schema default; apns create overrides to "ios"
      p256dh: null,
      auth: null,
      deviceToken: null,
      publicKey: null,
      label: null,
      userId: null,
      ...args.create,
      endpoint: args.where.endpoint, // upsert key: where.endpoint === create.endpoint
    };
    subRows.push(row);
    return { ...row };
  },
};
shadowPrismaModel(prisma, "pushSubscription", pushModel);

// ── auth fixture (tests/api-auth.test.mts idiom): real signed JWT over an
// in-memory authSession + user row so the withAuth slow path is DB-checked.
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

// $transaction: interactive form only. The tx object exposes every delegate a
// push-route (or a would-be session rotation) callback might touch, all sharing
// the in-memory stores above so committed writes are observable afterwards.
const txObj = {
  $executeRaw: async () => 0, // pg_advisory_xact_lock no-op (getOrCreateVapidPublicKey)
  pushSubscription: pushModel,
  setting: settingModel,
  authSession: {
    findUnique: async (args: { where: { sessionId: string } }) =>
      sessionRows.has(args.where.sessionId) ? { id: `row-${args.where.sessionId}` } : null,
    update: async () => ({}),
  },
  user: {
    findUnique: async (args: { where: { id: string } }) => {
      const u = usersById.get(args.where.id);
      return u ? { sessionsRevokedAt: u.sessionsRevokedAt } : null;
    },
    update: async () => ({}),
  },
};
shadowPrismaClientMethod(prisma, "$transaction", async (arg: unknown) => {
  if (Array.isArray(arg)) return Promise.all(arg);
  return (arg as (tx: typeof txObj) => Promise<unknown>)(txObj);
});

// Route handlers (imported AFTER every stub is in place).
const { POST: subscribePost } = await import("../src/app/api/push/subscribe/route.ts");
const { POST: apnsPost } = await import("../src/app/api/push/apns/route.ts");
const { POST: testPost } = await import("../src/app/api/push/test/route.ts");
const { GET: vapidGet } = await import("../src/app/api/push/vapid-key/route.ts");
const { POST: announcePost } = await import("../src/app/api/push/announce-update/route.ts");

// ── fixtures ──────────────────────────────────────────────────────────────
const COOKIE = getSessionCookieName();
let seq = 0;
async function mintSession(opts: { role?: string; permissions?: string } = {}): Promise<{ userId: string; token: string }> {
  seq++;
  const userId = `user-${seq}`;
  const sessionId = `sess-${seq}`;
  const permissions = opts.permissions ?? "0";
  usersById.set(userId, {
    role: opts.role ?? "USER",
    permissions: BigInt(permissions),
    mediaServer: null,
    sessionsRevokedAt: null,
    passwordChangedAt: null,
    deactivatedAt: null,
    email: "u@example.com",
    notificationEmail: null,
  });
  sessionRows.add(sessionId);
  const iat = Math.floor(Date.now() / 1000);
  const token = await signSessionJwt(
    { id: userId, role: opts.role ?? "USER", permissions, provider: "credentials", sessionId, expiresAt: iat + 86_400 },
    { expiresInSeconds: 7_200, iat },
  );
  return { userId, token };
}

// A real, valid X9.63 uncompressed P-256 point (65 bytes, 0x04-prefixed) as
// base64 — what the iOS app registers as its E2E public key.
function validDevicePublicKeyB64(): string {
  const ecdh = createECDH("prime256v1");
  return Buffer.from(ecdh.generateKeys()).toString("base64");
}

// Insert a stored iOS subscription directly (bypassing the route) so the
// test/announce fan-out helpers have devices to send to. deviceToken is stored
// ENCRYPTED, matching what /api/push/apns persists.
function seedIosSub(userId: string, token: string, opts: { label?: string | null; endpoint?: string } = {}): SubRow {
  const row: SubRow = {
    id: `stored-${++subSeq}`,
    createdAt: new Date(),
    endpoint: opts.endpoint ?? `apns:${token}`,
    platform: "ios",
    p256dh: null,
    auth: null,
    deviceToken: encryptToken(token),
    publicKey: null,
    label: opts.label ?? null,
    userId,
  };
  subRows.push(row);
  return row;
}
function seedWebSub(userId: string, slug: string): SubRow {
  const row: SubRow = {
    id: `stored-${++subSeq}`,
    createdAt: new Date(),
    endpoint: `https://fcm.googleapis.com/fcm/send/${slug}`,
    platform: "web",
    p256dh: encryptToken("stored-p256"),
    auth: encryptToken("stored-auth"),
    deviceToken: null,
    publicKey: null,
    label: null,
    userId,
  };
  subRows.push(row);
  return row;
}

type Handler = (req: InstanceType<typeof NextRequest>, ctx: unknown) => Promise<Response>;
function pushReq(
  path: string,
  opts: { method?: string; token?: string; body?: unknown; rawBody?: string } = {},
): InstanceType<typeof NextRequest> {
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (opts.token) headers.cookie = `${COOKIE}=${opts.token}`;
  const init: { method: string; headers: Record<string, string>; body?: string } = {
    method: opts.method ?? "POST",
    headers,
  };
  if (opts.rawBody !== undefined) init.body = opts.rawBody;
  else if (opts.body !== undefined) init.body = JSON.stringify(opts.body);
  return new NextRequest(`http://localhost:3000/api/push/${path}`, init);
}

// Run a route inside a minimal synthetic request scope with EMPTY ambient
// cookies — so maintenanceGuard()'s authActive() reads no session (→ anonymous,
// maintenance off → proceed), while the withAuth wrapper reads the real session
// from the NextRequest's own cookie header.
function callRoute(handler: Handler, req: InstanceType<typeof NextRequest>): Promise<Response> {
  const reqHeaders = new Headers();
  const workStore = { route: "/push-routes.test", forceStatic: false, dynamicShouldError: false };
  const requestStore = {
    type: "request",
    phase: "render",
    headers: HeadersAdapter.seal(reqHeaders),
    cookies: RequestCookiesAdapter.seal(new RequestCookies(reqHeaders)),
    usedDynamic: false,
  };
  return workAsyncStorage.run(workStore, () =>
    workUnitAsyncStorage.run(requestStore, () => handler(req, undefined)),
  );
}

const FCM = "https://fcm.googleapis.com/fcm/send"; // a recognized Web Push service host

beforeEach(() => {
  subRows = [];
  settings.clear();
  usersById.clear();
  sessionRows.clear();
  relayCalls.length = 0;
  relayRespond = () => jsonResponse({ ok: true });
  warns.length = 0;
  errors.length = 0;
  invalidateFeatureFlagCache(); // the 10s flag cache must not leak across tests
});

// ── guardrail 6a: the auth wrapper gates every route ────────────────────────

test("every push route rejects a request with no session (401) and mutates no state (guardrail 6a)", async () => {
  const cases: Array<[string, Handler, InstanceType<typeof NextRequest>]> = [
    ["subscribe", subscribePost, pushReq("subscribe", { token: undefined, body: { endpoint: `${FCM}/x`, keys: { p256dh: "p", auth: "a" } } })],
    ["apns", apnsPost, pushReq("apns", { token: undefined, body: { deviceToken: "ab".repeat(32) } })],
    ["test", testPost, pushReq("test", { token: undefined })],
    ["vapid-key", vapidGet, pushReq("vapid-key", { method: "GET", token: undefined })],
    ["announce-update", announcePost, pushReq("announce-update", { token: undefined })],
  ];
  for (const [name, handler, req] of cases) {
    const res = await callRoute(handler, req);
    assert.equal(res.status, 401, `${name} must 401 without a session`);
    assert.deepEqual(await res.json(), { error: "Unauthorized" }, `${name} body`);
  }
  assert.equal(subRows.length, 0, "no handler body ran → no subscription written");
  assert.equal(relayCalls.length, 0, "no handler body ran → no relay call");
});

// ── guardrail 7a: /api/push/subscribe — the web-push encryption pin ──────────

test("POST /api/push/subscribe stores p256dh+auth encrypted EXACTLY ONCE (guardrail 7a round-trip) and keeps the sanitized label", async () => {
  const { userId, token } = await mintSession();
  const P256DH = "BEl62iUYgUivxIkv69yViEuiBIa-Ib9-SkFptL2WLDN"; // representative UA public key
  const AUTH = "k9Xzm6H1c3RhbXBsZQ";

  const res = await callRoute(
    subscribePost,
    pushReq("subscribe", { token, body: { endpoint: `${FCM}/device-abc`, keys: { p256dh: P256DH, auth: AUTH }, label: "My Phone" } }),
  );
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { ok: true });

  assert.equal(subRows.length, 1, "exactly one subscription row was persisted");
  const stored = subRows[0];
  assert.equal(stored.userId, userId);
  assert.equal(stored.platform, "web");
  assert.equal(stored.label, "My Phone");
  assert.equal(stored.endpoint, `${FCM}/device-abc`, "the SSRF-resolved canonical endpoint is the stored key");

  // At rest the crypto material is ENCRYPTED — never the plaintext.
  assert.ok(stored.p256dh, "p256dh must be persisted");
  assert.ok(stored.auth, "auth must be persisted");
  assert.notEqual(stored.p256dh, P256DH, "p256dh must not be stored in plaintext");
  assert.ok(stored.p256dh!.startsWith("enc:v1:"), "p256dh must carry the token-crypto envelope marker");
  assert.ok(stored.auth!.startsWith("enc:v1:"), "auth must carry the token-crypto envelope marker");

  // ...and it is encrypted EXACTLY ONCE: a single decrypt pass returns the
  // original plaintext, not a nested envelope. A value that decrypted to another
  // `enc:v1:…` would be the double-encryption bug (enc:v1:<enc:v1:…>) — the
  // prisma extension would then under-decrypt it and ship a corrupt key upstream.
  assert.equal(
    decryptToken(stored.p256dh!, "PushSubscription.p256dh"),
    P256DH,
    "guardrail 7a: stored p256dh must decrypt to the ORIGINAL plaintext in ONE pass — a nested enc:v1:… means double-encryption",
  );
  assert.equal(
    decryptToken(stored.auth!, "PushSubscription.auth"),
    AUTH,
    "guardrail 7a: stored auth must decrypt to the ORIGINAL plaintext in ONE pass — a nested enc:v1:… means double-encryption",
  );
  assert.ok(
    !decryptToken(stored.p256dh!, "x").startsWith("enc:v1:"),
    "guardrail 7a: one decrypt pass must yield plaintext, not another enc:v1: marker (double-encryption)",
  );
  assert.deepEqual(errors, []);
});

test("POST /api/push/subscribe re-subscribing the same endpoint upserts in place (no duplicate) and re-encrypts the rotated keys", async () => {
  const { token } = await mintSession();
  const endpoint = `${FCM}/rotating-device`;

  await callRoute(subscribePost, pushReq("subscribe", { token, body: { endpoint, keys: { p256dh: "first-p256", auth: "first-auth" } } }));
  assert.equal(subRows.length, 1);

  // Same endpoint, rotated keys → the row is UPDATED, not duplicated.
  const res = await callRoute(subscribePost, pushReq("subscribe", { token, body: { endpoint, keys: { p256dh: "second-p256", auth: "second-auth" } } }));
  assert.equal(res.status, 200);
  assert.equal(subRows.length, 1, "re-subscribing the same endpoint must not create a second row");
  const stored = subRows[0];
  assert.ok(stored.p256dh!.startsWith("enc:v1:"));
  assert.equal(decryptToken(stored.p256dh!, "p"), "second-p256", "the rotated key must be re-encrypted, single-pass");
  assert.equal(decryptToken(stored.auth!, "a"), "second-auth");
});

test("POST /api/push/subscribe rejects malformed and unsafe subscriptions with 400, writing nothing", async () => {
  const { token } = await mintSession();
  const cases: Array<[string, unknown]> = [
    ["missing keys", { endpoint: `${FCM}/x` }],
    ["missing auth half", { endpoint: `${FCM}/x`, keys: { p256dh: "p" } }],
    ["non-HTTPS endpoint", { endpoint: "http://fcm.googleapis.com/x", keys: { p256dh: "p", auth: "a" } }],
    ["unrecognized service host", { endpoint: "https://evil.example.com/x", keys: { p256dh: "p", auth: "a" } }],
    ["over-long p256dh field", { endpoint: `${FCM}/x`, keys: { p256dh: "p".repeat(300), auth: "a" } }],
  ];
  for (const [label, body] of cases) {
    const res = await callRoute(subscribePost, pushReq("subscribe", { token, body }));
    assert.equal(res.status, 400, `${label} must be a 400`);
    const parsed = (await res.json()) as { error: string };
    assert.ok(typeof parsed.error === "string" && parsed.error.length > 0, `${label} error message`);
  }
  assert.equal(subRows.length, 0, "no invalid subscription may be persisted");
});

test("POST /api/push/subscribe returns 403 when feature.integration.push is disabled", async () => {
  settings.set("feature.integration.push", "false");
  const { token } = await mintSession();
  const res = await callRoute(subscribePost, pushReq("subscribe", { token, body: { endpoint: `${FCM}/x`, keys: { p256dh: "p", auth: "a" } } }));
  assert.equal(res.status, 403);
  assert.deepEqual(await res.json(), { error: "Push notifications are disabled" });
  assert.equal(subRows.length, 0);
});

test("POST /api/push/subscribe caps the JSON body at 32 KB → 413 (guardrail 30), before parsing subscription fields", async () => {
  const { token } = await mintSession();
  // ~35 KB body (no Content-Length on a string body → the post-read chunked cap fires).
  const oversized = JSON.stringify({ endpoint: `${FCM}/x`, keys: { p256dh: "A".repeat(35_000), auth: "B" } });
  const res = await callRoute(subscribePost, pushReq("subscribe", { token, rawBody: oversized }));
  assert.equal(res.status, 413);
  const parsed = (await res.json()) as { error: string };
  assert.ok(parsed.error.includes("too large"), parsed.error);
  assert.equal(subRows.length, 0);
});

test("POST /api/push/subscribe returns 409 when the endpoint is already registered to another user", async () => {
  seedWebSub("someone-else", "shared-endpoint");
  const { token } = await mintSession();
  const res = await callRoute(
    subscribePost,
    pushReq("subscribe", { token, body: { endpoint: `${FCM}/shared-endpoint`, keys: { p256dh: "p", auth: "a" } } }),
  );
  assert.equal(res.status, 409);
  assert.deepEqual(await res.json(), { error: "Endpoint already registered to another user" });
  assert.equal(subRows.length, 1, "the other user's row is untouched; no second row created");
});

// ── guardrail 7a: /api/push/apns — the iOS device-token encryption pin ───────

test("POST /api/push/apns stores the APNs deviceToken encrypted (guardrail 7a) with the E2E publicKey in PLAINTEXT and platform ios", async () => {
  const { userId, token } = await mintSession();
  const DEVICE_TOKEN = "a1b2c3d4".repeat(8); // 64 hex = 32 bytes, matches DEVICE_TOKEN_RE
  const PUBLIC_KEY = validDevicePublicKeyB64();

  const res = await callRoute(apnsPost, pushReq("apns", { token, body: { deviceToken: DEVICE_TOKEN, publicKey: PUBLIC_KEY, label: "iPhone 15" } }));
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { ok: true });

  assert.equal(subRows.length, 1);
  const stored = subRows[0];
  assert.equal(stored.userId, userId);
  assert.equal(stored.platform, "ios");
  assert.equal(stored.endpoint, `apns:${DEVICE_TOKEN}`, "the synthetic apns: handle keys the row");
  assert.equal(stored.label, "iPhone 15");

  // deviceToken: encrypted at rest, single-pass round-trip (guardrail 7a).
  assert.ok(stored.deviceToken, "deviceToken must be persisted");
  assert.notEqual(stored.deviceToken, DEVICE_TOKEN, "deviceToken must not be stored in plaintext");
  assert.ok(stored.deviceToken!.startsWith("enc:v1:"), "deviceToken must carry the token-crypto envelope marker");
  assert.equal(
    decryptToken(stored.deviceToken!, "PushSubscription.deviceToken"),
    DEVICE_TOKEN,
    "guardrail 7a: stored deviceToken must decrypt to the ORIGINAL token in ONE pass — a nested enc:v1:… means double-encryption",
  );
  assert.ok(
    !decryptToken(stored.deviceToken!, "x").startsWith("enc:v1:"),
    "guardrail 7a: one decrypt pass must yield the plaintext token, not another enc:v1: marker",
  );

  // E2E publicKey is the deliberate exception: stored in the clear (the relay/NSE
  // needs it to verify the ECIES envelope; it is not a secret).
  assert.equal(stored.publicKey, PUBLIC_KEY, "the E2E publicKey is stored verbatim, in plaintext by design");
  assert.ok(!stored.publicKey!.startsWith("enc:v1:"), "the E2E publicKey must NOT be encrypted");
  const pubBytes = Buffer.from(stored.publicKey!, "base64");
  assert.equal(pubBytes.length, 65);
  assert.equal(pubBytes[0], 0x04, "an uncompressed P-256 point");
  assert.deepEqual(errors, []);
});

test("POST /api/push/apns rejects a non-hex device token (400) and a token owned by another account (409)", async () => {
  const a = await mintSession();
  const bad = await callRoute(apnsPost, pushReq("apns", { token: a.token, body: { deviceToken: "not-a-hex-token" } }));
  assert.equal(bad.status, 400);
  assert.deepEqual(await bad.json(), { error: "deviceToken must be a hex APNs token" });
  assert.equal(subRows.length, 0);

  // An odd-length hex string is also rejected (the relay would never deliver it).
  const odd = await callRoute(apnsPost, pushReq("apns", { token: a.token, body: { deviceToken: "abc" } }));
  assert.equal(odd.status, 400);

  const DEVICE_TOKEN = "f0e1d2c3".repeat(8);
  seedIosSub("someone-else", DEVICE_TOKEN);
  const b = await mintSession();
  const conflict = await callRoute(apnsPost, pushReq("apns", { token: b.token, body: { deviceToken: DEVICE_TOKEN } }));
  assert.equal(conflict.status, 409);
  assert.deepEqual(await conflict.json(), { error: "Device already registered to another account" });
  assert.equal(subRows.length, 1, "the other account's device row is untouched");
});

// ── /api/push/vapid-key ──────────────────────────────────────────────────────

test("GET /api/push/vapid-key returns the stored public key, and cold-starts a persistent keypair when none exists", async () => {
  // Warm path: a stored keypair is handed back verbatim, no generation.
  settings.set("vapidPublicKey", "stored-public-key");
  settings.set("vapidPrivateKey", "stored-private-key");
  const warm = await mintSession();
  const warmRes = await callRoute(vapidGet, pushReq("vapid-key", { method: "GET", token: warm.token }));
  assert.equal(warmRes.status, 200);
  assert.deepEqual(await warmRes.json(), { publicKey: "stored-public-key" });

  // Cold path: no keys → the route generates + persists one and returns it; a
  // second call returns the SAME key (proves the route wrote it through).
  settings.clear();
  const cold = await mintSession();
  const coldRes = await callRoute(vapidGet, pushReq("vapid-key", { method: "GET", token: cold.token }));
  assert.equal(coldRes.status, 200);
  const first = ((await coldRes.json()) as { publicKey: string }).publicKey;
  assert.ok(typeof first === "string" && first.length > 0, "cold start yields a usable public key");
  assert.ok(settings.get("vapidPublicKey"), "the generated public key was persisted");
  assert.ok(settings.get("vapidPrivateKey"), "the generated private key was persisted");

  const again = await callRoute(vapidGet, pushReq("vapid-key", { method: "GET", token: cold.token }));
  assert.equal(((await again.json()) as { publicKey: string }).publicKey, first, "the persisted key is stable across calls");
});

// ── /api/push/test ────────────────────────────────────────────────────────────

test("POST /api/push/test returns 404 when the caller has no registered subscriptions", async () => {
  const { token } = await mintSession();
  const res = await callRoute(testPost, pushReq("test", { token }));
  assert.equal(res.status, 404);
  const body = (await res.json()) as { error: string };
  assert.ok(body.error.includes("No push subscription"), body.error);
  assert.equal(relayCalls.length, 0);
});

test("POST /api/push/test fans a diagnostic push to the caller's OWN iOS devices and returns per-device results (200 when all deliver)", async () => {
  const { userId, token } = await mintSession();
  seedIosSub(userId, "test-device-1", { label: "iPhone" });
  seedIosSub("another-user", "not-mine"); // must NOT be selected

  const res = await callRoute(testPost, pushReq("test", { token }));
  assert.equal(res.status, 200);
  const body = (await res.json()) as { results: Array<{ platform: string; endpoint: string; ok: boolean }> };
  assert.equal(body.results.length, 1, "only the caller's own device is tested");
  assert.equal(body.results[0].platform, "ios");
  assert.equal(body.results[0].ok, true);
  assert.ok(body.results[0].endpoint.startsWith("apns:") && body.results[0].endpoint.endsWith("…"), "the endpoint is display-truncated");

  // The relay saw exactly one send, carrying the DECRYPTED device token.
  assert.equal(relayCalls.length, 1);
  assert.equal(relayCalls[0].body.deviceToken, "test-device-1", "the relay receives the decrypted token, never the ciphertext");
  assert.equal(relayCalls[0].body.collapseId, "test");
});

test("POST /api/push/test reports failures: a relay error → ok:false + 502; a web row with no VAPID keys → 'VAPID keys not configured' with zero wire calls", async () => {
  // iOS device whose relay send fails.
  const ios = await mintSession();
  seedIosSub(ios.userId, "flaky-device");
  relayRespond = () => jsonResponse({ error: "boom" }, 500);
  const iosRes = await callRoute(testPost, pushReq("test", { token: ios.token }));
  assert.equal(iosRes.status, 502, "any device failing flips the overall status to 502");
  const iosBody = (await iosRes.json()) as { results: Array<{ platform: string; ok: boolean }> };
  assert.equal(iosBody.results[0].ok, false);
  assert.equal(relayCalls.length, 1);

  // Web row present but no VAPID keys configured → a "not configured" result and
  // NO network call for the web branch.
  relayCalls.length = 0;
  const web = await mintSession();
  seedWebSub(web.userId, "web-only");
  const webRes = await callRoute(testPost, pushReq("test", { token: web.token }));
  assert.equal(webRes.status, 502);
  const webBody = (await webRes.json()) as { results: Array<{ platform: string; ok: boolean; message?: string }> };
  assert.equal(webBody.results.length, 1);
  assert.equal(webBody.results[0].platform, "web");
  assert.equal(webBody.results[0].ok, false);
  assert.equal(webBody.results[0].message, "VAPID keys not configured");
  assert.equal(relayCalls.length, 0, "the web branch reached no relay (iOS-only host) and no VAPID send");
});

// ── /api/push/announce-update ────────────────────────────────────────────────

test("POST /api/push/announce-update is ADMIN-gated: a plain USER gets 403 and triggers no broadcast (guardrail 6a, withAdmin)", async () => {
  const user = await mintSession({ role: "USER" });
  seedIosSub("anyone", "would-be-target");
  const res = await callRoute(announcePost, pushReq("announce-update", { token: user.token }));
  assert.equal(res.status, 403);
  assert.deepEqual(await res.json(), { error: "Forbidden" });
  assert.equal(relayCalls.length, 0, "a forbidden caller never reaches the broadcast");
});

test("POST /api/push/announce-update (admin) broadcasts to EVERY iOS device across users and returns {sent, failed}, excluding web rows", async () => {
  const admin = await mintSession({ role: "ADMIN" });
  seedIosSub("user-a", "ios-a");
  seedIosSub("user-b", "ios-b");
  seedWebSub("user-a", "web-excluded"); // platform filter must drop this
  relayRespond = (call) => (call.body.deviceToken === "ios-b" ? jsonResponse({ error: "later" }, 500) : jsonResponse({ ok: true }));

  const res = await callRoute(announcePost, pushReq("announce-update", { token: admin.token }));
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { ok: true, sent: 1, failed: 1 });
  assert.equal(relayCalls.length, 2, "both iOS devices were hit; the web row was excluded");
  assert.deepEqual(
    relayCalls.map((c) => c.body.deviceToken).sort(),
    ["ios-a", "ios-b"],
  );
  for (const c of relayCalls) assert.equal(c.body.collapseId, "app_update");
});
