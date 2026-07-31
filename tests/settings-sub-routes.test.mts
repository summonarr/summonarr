// Route-level unit tests for the six uncovered settings sub-routes:
//   POST/DELETE /api/settings/plex             rotate / clear the Plex admin token
//   GET         /api/settings/webhook-urls     the copy-button token reveal
//   GET         /api/settings/arr-options      root folders + quality profiles
//   GET         /api/settings/plex/libraries
//   GET         /api/settings/jellyfin/libraries
//   POST        /api/settings/test-ratings     provider connectivity tests
//
// tests/settings-route.test.mts covers the main PATCH surface; these are the
// sub-routes around it, and between them they read, write and reveal every
// remaining credential in the app. What matters:
//
//   1. THE PLEX TOKEN IS VALIDATED BEFORE IT IS STORED. getPlexUser runs first,
//      and a bad/expired token or an unreachable plex.tv is a clean 422 with NO
//      Setting write. Storing first would leave the instance configured with a
//      dead admin token — every library sync and membership check then fails,
//      and the admin sees a "saved" confirmation for it.
//   2. ROTATING OR CLEARING THE TOKEN MUST FLUSH PlexTokenCache. That table
//      caches per-user auth decisions made against the OLD admin token; leaving
//      it behind means a user removed from the Plex server keeps passing the
//      membership check until the cache expires.
//   3. GUARDRAIL 7a: the route stores PLAINTEXT and lets the Prisma extension
//      encrypt. A call-site encryptToken produces `enc:v1:<enc:v1:…>` rows whose
//      inner ciphertext is later handed out AS the token — the bc81802 failure
//      class. Observable here because the stub shadows the delegate, so whatever
//      the route passed is exactly what lands.
//   4. webhook-urls EXISTS SO SECRETS DON'T RIDE THE RSC PAYLOAD. It is the one
//      place these tokens legitimately cross the wire, so it must be admin-only,
//      and its legacy-fallback shape is load-bearing: radarr/sonarr fold in the
//      shared `webhookSecret` (matching how the webhook handler resolves them),
//      while the 4K keys deliberately do NOT — they are per-instance, and
//      folding the legacy secret in there would report a working 4K webhook that
//      the handler will reject.
//   5. Every upstream-facing route maps a connection failure to 502/422 and
//      never leaks the underlying error text to the client.
//
// Harness: real withAdmin-wrapped handlers, genuine signed session JWTs, a
// synthetic Next request scope, in-memory prisma stubs, scripted fetch (plex.tv,
// the arr/Jellyfin servers as RFC1918 literals so the SSRF stack short-circuits
// DNS). No DB, no network.
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { AsyncLocalStorage } from "node:async_hooks";
import dns from "node:dns/promises";

(globalThis as { AsyncLocalStorage?: unknown }).AsyncLocalStorage = AsyncLocalStorage;

process.env.TOKEN_ENCRYPTION_KEY = "ab".repeat(32);
process.env.NEXTAUTH_SECRET = "settings-sub-routes-secret-0123456789ab";
process.env.AUTH_URL = "http://localhost:3000";
process.env.TRUST_PROXY = "true";
(process.env as Record<string, string | undefined>).NODE_ENV = "test";

const fakeLookup = async () => [{ address: "93.184.216.34", family: 4 }];
(dns as { lookup: unknown }).lookup = fakeLookup;
if ((dns as { lookup: unknown }).lookup !== fakeLookup) throw new Error("could not stub dns.lookup");

const warns: string[] = [];
const errors: string[] = [];
console.warn = (...args: unknown[]) => { warns.push(args.map(String).join(" ")); };
console.error = (...args: unknown[]) => { errors.push(args.map(String).join(" ")); };

// ── scripted upstreams ───────────────────────────────────────────────────────
const fetchCalls: Array<{ url: URL; headers: Headers }> = [];
let plexUserOk = true;
let arrOk = true;
let plexSectionsOk = true;
let jellyfinFoldersOk = true;
let providerOk = true;

globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
  const url = new URL(String(input));
  fetchCalls.push({ url, headers: new Headers(init?.headers) });
  const json = (b: unknown, s = 200) => new Response(JSON.stringify(b), { status: s, headers: { "content-type": "application/json" } });

  if (url.hostname === "plex.tv") {
    return plexUserOk
      ? json({ email: "owner@example.com", username: "owner", id: 77, uuid: "u" })
      : json({ error: "PLEX SAYS NO" }, 401);
  }
  // Plex library sections. getPlexLibrarySections asks for JSON (plexFetch sets
  // Accept: application/json), so the fixture is the MediaContainer JSON shape,
  // not the XML the same endpoint serves by default.
  if (url.pathname.includes("/library/sections")) {
    return plexSectionsOk
      ? json({ MediaContainer: { Directory: [
          { key: "1", title: "Movies", type: "movie" },
          { key: "2", title: "Shows", type: "show" },
          { key: "3", title: "Music", type: "artist" },
        ] } })
      : json({ error: "PLEX SERVER DOWN" }, 500);
  }
  // Jellyfin media folders.
  if (url.pathname.includes("/Library/MediaFolders") || url.pathname.includes("/Items")) {
    return jellyfinFoldersOk
      ? json({ Items: [{ Id: "jf1", Name: "Movies", CollectionType: "movies" }] })
      : json({ error: "JELLYFIN DOWN" }, 500);
  }
  // Radarr/Sonarr options.
  if (url.pathname.includes("/api/v3/rootfolder")) {
    return arrOk ? json([{ path: "/movies" }]) : json({ error: "ARR DOWN" }, 500);
  }
  if (url.pathname.includes("/api/v3/qualityprofile")) {
    return arrOk ? json([{ id: 1, name: "HD" }]) : json({ error: "ARR DOWN" }, 500);
  }
  // Ratings providers (omdb / mdblist / trakt / ipinfo).
  return providerOk
    ? json({ Title: "The Matrix", title: "The Matrix", ip: "1.1.1.1", city: "Testville" })
    : json({ error: "PROVIDER SECRET DETAIL" }, 500);
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
const { shadowPrismaModel, shadowPrismaClientMethod } = await import("./_helpers.mts");
const { signSessionJwt } = await import("../src/lib/session-jwt.ts");
const { getSessionCookieName } = await import("../src/lib/session-cookie.ts");
const { Permission } = await import("../src/lib/permissions.ts");
const { arrSettingKey } = await import("../src/lib/arr-instances.ts");
const { isSensitiveSettingKey } = await import("../src/lib/settings-sensitive-keys.ts");

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
shadowPrismaModel(prisma, "user", {
  findUnique: async (args: { where: { id: string } }) => sessionUsers.get(args.where.id) ?? null,
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

// ── Setting store ────────────────────────────────────────────────────────────
// Shadowing the delegate bypasses the crypto extension, which is what makes the
// guardrail-7a plaintext assertion below meaningful: whatever the ROUTE hands to
// prisma is exactly what lands in this map.
const settings = new Map<string, string>();
shadowPrismaModel(prisma, "setting", {
  findUnique: async (args: { where: { key: string } }) => {
    rec("setting.findUnique", args.where.key);
    const v = settings.get(args.where.key);
    return v === undefined ? null : { key: args.where.key, value: v };
  },
  findMany: async (args: { where?: { key?: { in?: string[] } } } = {}) => {
    rec("setting.findMany", args.where?.key?.in);
    const keys = args.where?.key?.in;
    const all = [...settings.entries()].map(([key, value]) => ({ key, value }));
    return keys ? all.filter((r) => keys.includes(r.key)) : all;
  },
  upsert: async (args: { where: { key: string }; update: { value: string } }) => {
    rec("setting.upsert", { key: args.where.key, value: args.update.value });
    settings.set(args.where.key, args.update.value);
    return { key: args.where.key, value: args.update.value };
  },
  deleteMany: async (args: { where: { key: { in: string[] } } }) => {
    rec("setting.deleteMany", args.where.key.in);
    let n = 0;
    for (const k of args.where.key.in) if (settings.delete(k)) n++;
    return { count: n };
  },
  create: async (args: unknown) => { rec("setting.create", args); return {}; },
  update: async (args: unknown) => { rec("setting.update", args); return {}; },
});

let tokenCacheRows = 0;
shadowPrismaModel(prisma, "plexTokenCache", {
  deleteMany: async (args: unknown) => {
    rec("plexTokenCache.deleteMany", args);
    const n = tokenCacheRows;
    tokenCacheRows = 0;
    return { count: n };
  },
  findUnique: async () => null, findMany: async () => [], upsert: async () => ({}),
});

shadowPrismaModel(prisma, "auditLog", { create: async (args: unknown) => { rec("auditLog.create", args); return { id: "a1" }; } });
shadowPrismaClientMethod(prisma, "$transaction", async (arg: unknown) =>
  Array.isArray(arg) ? Promise.all(arg) : (arg as (tx: unknown) => Promise<unknown>)(prisma));

const settingsPlex = await import("../src/app/api/settings/plex/route.ts");
const webhookUrls = await import("../src/app/api/settings/webhook-urls/route.ts");
const arrOptions = await import("../src/app/api/settings/arr-options/route.ts");
const plexLibraries = await import("../src/app/api/settings/plex/libraries/route.ts");
const jellyfinLibraries = await import("../src/app/api/settings/jellyfin/libraries/route.ts");
const testRatings = await import("../src/app/api/settings/test-ratings/route.ts");

// ── scope ────────────────────────────────────────────────────────────────────
const afterTasks: Array<() => Promise<unknown>> = [];
function inScope<T>(fn: () => Promise<T>): Promise<T> {
  const workStore = {
    route: "/settings-sub.test", forceStatic: false, dynamicShouldError: false,
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

function mk(path: string, token: string | null, init: { method: string; body?: string; query?: string } = { method: "GET" }) {
  return new NextRequest(`http://localhost:3000${path}${init.query ?? ""}`, {
    method: init.method,
    headers: { ...(token ? { cookie: `${COOKIE}=${token}` } : {}), "content-type": "application/json" },
    ...(init.body !== undefined ? { body: init.body } : {}),
  });
}
const postPlex = (t: string | null, body: unknown, raw?: string) =>
  inScope(() => settingsPlex.POST(mk("/api/settings/plex", t, { method: "POST", body: raw ?? JSON.stringify(body) }), undefined));
const deletePlex = (t: string | null) =>
  inScope(() => settingsPlex.DELETE(mk("/api/settings/plex", t, { method: "DELETE" }), undefined));
const getWebhookUrls = (t: string | null) =>
  inScope(() => webhookUrls.GET(mk("/api/settings/webhook-urls", t), undefined));
const getArrOptions = (t: string | null, q: string) =>
  inScope(() => arrOptions.GET(mk("/api/settings/arr-options", t, { method: "GET", query: q }), undefined));
const getPlexLibs = (t: string | null) =>
  inScope(() => plexLibraries.GET(mk("/api/settings/plex/libraries", t), undefined));
const getJfLibs = (t: string | null) =>
  inScope(() => jellyfinLibraries.GET(mk("/api/settings/jellyfin/libraries", t), undefined));
const postTestRatings = (t: string | null, body: unknown, raw?: string) =>
  inScope(() => testRatings.POST(mk("/api/settings/test-ratings", t, { method: "POST", body: raw ?? JSON.stringify(body) }), undefined));

beforeEach(() => {
  ops = [];
  settings.clear();
  fetchCalls.length = 0;
  afterTasks.length = 0;
  warns.length = 0;
  errors.length = 0;
  tokenCacheRows = 5;
  plexUserOk = true;
  arrOk = true;
  plexSectionsOk = true;
  jellyfinFoldersOk = true;
  providerOk = true;
});

// ── gating ───────────────────────────────────────────────────────────────────

test("all six routes refuse an anonymous caller with 401", async () => {
  assert.equal((await postPlex(null, { authToken: "t" })).status, 401);
  assert.equal((await deletePlex(null)).status, 401);
  assert.equal((await getWebhookUrls(null)).status, 401);
  assert.equal((await getArrOptions(null, "?service=radarr")).status, 401);
  assert.equal((await getPlexLibs(null)).status, 401);
  assert.equal((await getJfLibs(null)).status, 401);
  assert.equal((await postTestRatings(null, { service: "omdb" })).status, 401);
});

test("a plain USER is 403 everywhere, and nothing is written or fetched", async () => {
  const t = await mintSession({ role: "USER", permissions: 0n });
  assert.equal((await postPlex(t, { authToken: "t" })).status, 403);
  assert.equal((await deletePlex(t)).status, 403);
  assert.equal((await getWebhookUrls(t)).status, 403);
  assert.equal((await getArrOptions(t, "?service=radarr")).status, 403);
  assert.equal((await getPlexLibs(t)).status, 403);
  assert.equal((await getJfLibs(t)).status, 403);
  assert.equal((await postTestRatings(t, { service: "omdb" })).status, 403);
  assert.equal(opsOf("setting.upsert").length, 0);
  assert.equal(opsOf("setting.deleteMany").length, 0);
  assert.deepEqual(fetchCalls, []);
});

test("an ISSUE_ADMIN cannot read the webhook secrets or rotate the Plex token", async () => {
  const t = await mintSession({ role: "ISSUE_ADMIN", permissions: Permission.MANAGE_ISSUES });
  assert.equal((await getWebhookUrls(t)).status, 403);
  assert.equal((await postPlex(t, { authToken: "t" })).status, 403);
});

// ── 1: validate the Plex token BEFORE storing it ─────────────────────────────

test("settings/plex requires an authToken", async () => {
  const t = await mintSession();
  for (const body of [{}, { authToken: "" }, { authToken: 42 }, { authToken: null }]) {
    ops = [];
    const res = await postPlex(t, body);
    assert.equal(res.status, 400, `body ${JSON.stringify(body)} should be rejected`);
    assert.equal(opsOf("setting.upsert").length, 0);
    assert.deepEqual(fetchCalls, [], "a missing token must not reach plex.tv");
  }
});

test("an INVALID Plex token is a 422 and writes NOTHING", async () => {
  // Storing first would leave the instance configured with a dead admin token —
  // every library sync and membership check then fails, behind a "saved" toast.
  plexUserOk = false;
  const t = await mintSession();
  const res = await postPlex(t, { authToken: "expired-token" });
  assert.equal(res.status, 422);
  assert.equal(opsOf("setting.upsert").length, 0, "no Setting write on a rejected token");
  assert.equal(settings.get("plexAdminToken"), undefined);
});

test("a rejected token also leaves the existing config untouched", async () => {
  plexUserOk = false;
  settings.set("plexAdminToken", "the-good-old-token");
  settings.set("plexAdminEmail", "old@example.com");
  const t = await mintSession();
  await postPlex(t, { authToken: "expired-token" });
  assert.equal(settings.get("plexAdminToken"), "the-good-old-token");
  assert.equal(settings.get("plexAdminEmail"), "old@example.com");
});

test("a rejected token does not flush the token cache", async () => {
  plexUserOk = false;
  const t = await mintSession();
  await postPlex(t, { authToken: "expired-token" });
  assert.equal(opsOf("plexTokenCache.deleteMany").length, 0, "nothing changed, so nothing to invalidate");
});

test("a 422 never leaks the upstream error body", async () => {
  plexUserOk = false;
  const t = await mintSession();
  const res = await postPlex(t, { authToken: "expired-token" });
  const text = await res.text();
  assert.ok(!text.includes("PLEX SAYS NO"), "the upstream error reached the client");
  assert.ok(errors.some((e) => e.includes("[settings/plex]")), "the failure should be logged server-side");
});

test("a VALID token is stored along with the resolved admin email", async () => {
  const t = await mintSession();
  const res = await postPlex(t, { authToken: "a-good-token" });
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { email: "owner@example.com", username: "owner" });
  assert.equal(settings.get("plexAdminToken"), "a-good-token");
  assert.equal(settings.get("plexAdminEmail"), "owner@example.com");
});

test("the admin email comes from plex.tv, never from the request body", async () => {
  const t = await mintSession();
  await postPlex(t, { authToken: "a-good-token", email: "attacker@example.com" });
  assert.equal(settings.get("plexAdminEmail"), "owner@example.com");
});

// ── 2: rotating or clearing the token flushes PlexTokenCache ─────────────────

test("rotating the token FLUSHES PlexTokenCache", async () => {
  // That table caches per-user auth decisions made against the OLD token; a user
  // removed from the Plex server would keep passing the membership check.
  const t = await mintSession();
  await postPlex(t, { authToken: "a-good-token" });
  assert.equal(opsOf("plexTokenCache.deleteMany").length, 1);
  assert.equal(tokenCacheRows, 0);
});

test("DELETE removes both keys and flushes PlexTokenCache", async () => {
  settings.set("plexAdminToken", "tok");
  settings.set("plexAdminEmail", "owner@example.com");
  const t = await mintSession();
  const res = await deletePlex(t);
  assert.equal(res.status, 200);
  assert.equal(settings.get("plexAdminToken"), undefined);
  assert.equal(settings.get("plexAdminEmail"), undefined);
  assert.equal(opsOf("plexTokenCache.deleteMany").length, 1);
});

test("DELETE removes ONLY the two Plex admin keys", async () => {
  settings.set("plexAdminToken", "tok");
  settings.set("plexAdminEmail", "owner@example.com");
  settings.set("jellyfinApiKey", "jf-key");
  settings.set("radarrApiKey", "radarr-key");
  const t = await mintSession();
  await deletePlex(t);
  assert.equal(settings.get("jellyfinApiKey"), "jf-key");
  assert.equal(settings.get("radarrApiKey"), "radarr-key");
  const keys = opsOf("setting.deleteMany")[0].args as string[];
  assert.deepEqual([...keys].sort(), ["plexAdminEmail", "plexAdminToken"]);
});

test("both verbs warn about the cache flush so an operator can correlate it", async () => {
  const t = await mintSession();
  await postPlex(t, { authToken: "a-good-token" });
  assert.ok(warns.some((w) => w.includes("PlexTokenCache")), `no rotate warn: ${warns.join(" | ")}`);
  warns.length = 0;
  await deletePlex(t);
  assert.ok(warns.some((w) => w.includes("PlexTokenCache")), `no delete warn: ${warns.join(" | ")}`);
});

test("both verbs audit the change", async () => {
  const t = await mintSession();
  await postPlex(t, { authToken: "a-good-token" });
  await drainAfter();
  let data = (opsOf("auditLog.create")[0].args as { data: { action: string; target: string; details: string } }).data;
  assert.equal(data.action, "SETTINGS_CHANGE");
  assert.equal(data.target, "settings:plex");
  assert.equal(JSON.parse(data.details).operation, "rotate");

  ops = [];
  await deletePlex(t);
  await drainAfter();
  data = (opsOf("auditLog.create")[0].args as { data: { details: string } }).data as never;
  assert.equal(JSON.parse((opsOf("auditLog.create")[0].args as { data: { details: string } }).data.details).operation, "delete");
});

test("the audit record never contains the token itself", async () => {
  const t = await mintSession();
  await postPlex(t, { authToken: "super-secret-plex-token" });
  await drainAfter();
  const dump = JSON.stringify(ops.filter((o) => o.op === "auditLog.create"));
  assert.ok(!dump.includes("super-secret-plex-token"), "the rotated token leaked into the audit trail");
});

// ── 3: guardrail 7a — plaintext to prisma ────────────────────────────────────

test("the route stores the token as PLAINTEXT — the prisma extension owns encryption", async () => {
  // A call-site encryptToken produces enc:v1:<enc:v1:…> rows whose inner
  // ciphertext is later handed out AS the Plex token (the bc81802 failure class).
  const t = await mintSession();
  await postPlex(t, { authToken: "a-good-token" });
  assert.equal(settings.get("plexAdminToken"), "a-good-token");
  for (const [, v] of settings) {
    assert.ok(!String(v).startsWith("enc:v1:"), "the route pre-encrypted a value (guardrail 7a)");
  }
});

test("plexAdminToken is a key the extension will encrypt, while plexAdminEmail is not", async () => {
  assert.ok(isSensitiveSettingKey("plexAdminToken"));
  assert.ok(!isSensitiveSettingKey("plexAdminEmail"));
});

// ── 4: webhook-urls ──────────────────────────────────────────────────────────

test("webhook-urls returns nulls when nothing is configured", async () => {
  const t = await mintSession();
  const body = await (await getWebhookUrls(t)).json();
  assert.deepEqual(body, { radarr: null, sonarr: null, radarr4k: null, sonarr4k: null });
});

test("webhook-urls returns the per-service secrets when set", async () => {
  settings.set("radarrWebhookSecret", "r-secret");
  settings.set("sonarrWebhookSecret", "s-secret");
  const t = await mintSession();
  const body = await (await getWebhookUrls(t)).json();
  assert.equal(body.radarr, "r-secret");
  assert.equal(body.sonarr, "s-secret");
});

test("radarr/sonarr fall back to the LEGACY shared secret", async () => {
  // Matches how the webhook handler resolves tokens; without the fallback the
  // settings page would show "not configured" for a working webhook.
  settings.set("webhookSecret", "legacy-shared");
  const t = await mintSession();
  const body = await (await getWebhookUrls(t)).json();
  assert.equal(body.radarr, "legacy-shared");
  assert.equal(body.sonarr, "legacy-shared");
});

test("a per-service secret WINS over the legacy shared one", async () => {
  settings.set("webhookSecret", "legacy-shared");
  settings.set("radarrWebhookSecret", "r-specific");
  const t = await mintSession();
  const body = await (await getWebhookUrls(t)).json();
  assert.equal(body.radarr, "r-specific");
  assert.equal(body.sonarr, "legacy-shared", "sonarr still falls back");
});

test("the 4K keys deliberately do NOT fall back to the legacy secret", async () => {
  // They are per-instance. Folding the legacy secret in would advertise a 4K
  // webhook URL that the handler will reject.
  settings.set("webhookSecret", "legacy-shared");
  const t = await mintSession();
  const body = await (await getWebhookUrls(t)).json();
  assert.equal(body.radarr4k, null);
  assert.equal(body.sonarr4k, null);
});

test("the 4K keys are returned when they ARE set", async () => {
  settings.set("radarr4kWebhookSecret", "r4k");
  settings.set("sonarr4kWebhookSecret", "s4k");
  const t = await mintSession();
  const body = await (await getWebhookUrls(t)).json();
  assert.equal(body.radarr4k, "r4k");
  assert.equal(body.sonarr4k, "s4k");
});

test("an empty-string secret reads as unset rather than an empty token", async () => {
  settings.set("radarrWebhookSecret", "");
  const t = await mintSession();
  assert.equal((await (await getWebhookUrls(t)).json()).radarr, null);
});

test("webhook-urls reads an explicit key allowlist and reveals nothing else", async () => {
  settings.set("plexAdminToken", "must-not-appear");
  settings.set("radarrApiKey", "must-not-appear-either");
  settings.set("radarrWebhookSecret", "r-secret");
  const t = await mintSession();
  const text = await (await getWebhookUrls(t)).text();
  assert.ok(!text.includes("must-not-appear"));
  const asked = opsOf("setting.findMany")[0].args as string[];
  assert.ok(Array.isArray(asked) && asked.length === 5, "the read must name its keys");
  for (const k of asked) assert.match(k, /WebhookSecret$|^webhookSecret$/);
});

// ── 5: arr-options ───────────────────────────────────────────────────────────

for (const service of [undefined, "plex", "RADARR", ""]) {
  test(`arr-options rejects service ${JSON.stringify(service)}`, async () => {
    const t = await mintSession();
    const q = service === undefined ? "" : `?service=${encodeURIComponent(service)}`;
    const res = await getArrOptions(t, q);
    assert.equal(res.status, 400);
    assert.deepEqual(fetchCalls, []);
  });
}

for (const bad of ["Bad Slug", "UPPER", "with/slash"]) {
  test(`arr-options rejects the invalid instance slug ${JSON.stringify(bad)}`, async () => {
    // Guardrail 32: a bad slug must not be silently routed to the default, or the
    // admin configures one instance while reading another's root folders.
    const t = await mintSession();
    const res = await getArrOptions(t, `?service=radarr&instance=${encodeURIComponent(bad)}`);
    assert.equal(res.status, 400);
    assert.deepEqual(fetchCalls, []);
  });
}

test("arr-options is 422 when the instance is not configured", async () => {
  const t = await mintSession();
  const res = await getArrOptions(t, "?service=radarr");
  assert.equal(res.status, 422);
  assert.match((await res.json()).error, /not configured/);
  assert.deepEqual(fetchCalls, []);
});

test("arr-options is 422 when only HALF the connection is configured", async () => {
  settings.set(arrSettingKey("radarr", "", "Url"), "http://10.0.0.2:7878");
  const t = await mintSession();
  assert.equal((await getArrOptions(t, "?service=radarr")).status, 422);
});

test("arr-options returns root folders and quality profiles for a configured instance", async () => {
  settings.set(arrSettingKey("radarr", "", "Url"), "http://10.0.0.2:7878");
  settings.set(arrSettingKey("radarr", "", "ApiKey"), "radarr-key");
  const t = await mintSession();
  const res = await getArrOptions(t, "?service=radarr");
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.deepEqual(body.rootFolders, [{ path: "/movies" }]);
  assert.deepEqual(body.qualityProfiles, [{ id: 1, name: "HD" }]);
});

test("arr-options reads the NAMED instance's keys, not the default's", async () => {
  settings.set(arrSettingKey("radarr", "", "Url"), "http://10.0.0.2:7878");
  settings.set(arrSettingKey("radarr", "", "ApiKey"), "default-key");
  settings.set(arrSettingKey("radarr", "anime", "Url"), "http://10.0.0.3:7878");
  settings.set(arrSettingKey("radarr", "anime", "ApiKey"), "anime-key");
  const t = await mintSession();
  await getArrOptions(t, "?service=radarr&instance=anime");
  assert.ok(fetchCalls.some((c) => c.url.hostname === "10.0.0.3"), "the named instance's URL should be used");
  assert.ok(!fetchCalls.some((c) => c.url.hostname === "10.0.0.2"));
});

test("the legacy ?variant=4k spelling still selects the 4K instance", async () => {
  settings.set(arrSettingKey("radarr", "4k", "Url"), "http://10.0.0.4:7878");
  settings.set(arrSettingKey("radarr", "4k", "ApiKey"), "4k-key");
  const t = await mintSession();
  const res = await getArrOptions(t, "?service=radarr&variant=4k");
  assert.equal(res.status, 200);
  assert.ok(fetchCalls.some((c) => c.url.hostname === "10.0.0.4"));
});

test("an explicit ?instance= wins over the legacy ?variant=", async () => {
  settings.set(arrSettingKey("radarr", "", "Url"), "http://10.0.0.2:7878");
  settings.set(arrSettingKey("radarr", "", "ApiKey"), "default-key");
  const t = await mintSession();
  const res = await getArrOptions(t, "?service=radarr&instance=&variant=4k");
  assert.equal(res.status, 200, "instance='' should select the default, not 4k");
  assert.ok(fetchCalls.some((c) => c.url.hostname === "10.0.0.2"));
});

test("arr-options maps a connection failure to 502 without leaking the upstream body", async () => {
  settings.set(arrSettingKey("radarr", "", "Url"), "http://10.0.0.2:7878");
  settings.set(arrSettingKey("radarr", "", "ApiKey"), "radarr-key");
  arrOk = false;
  const t = await mintSession();
  const res = await getArrOptions(t, "?service=radarr");
  assert.equal(res.status, 502);
  const body = await res.json();
  // Pinned as an EXACT message rather than a substring absence: the thrown
  // ArrResponseError does not necessarily quote the upstream body, so a
  // "does not contain <upstream string>" check would pass even if the route
  // started returning String(err) — which can carry the arr URL and status.
  assert.deepEqual(body, { error: "Could not connect to radarr" });
  assert.ok(errors.some((e) => e.includes("[settings/arr-options]")));
});

test("arr-options never echoes the arr API key", async () => {
  settings.set(arrSettingKey("radarr", "", "Url"), "http://10.0.0.2:7878");
  settings.set(arrSettingKey("radarr", "", "ApiKey"), "super-secret-radarr-key");
  const t = await mintSession();
  const text = await (await getArrOptions(t, "?service=radarr")).text();
  assert.ok(!text.includes("super-secret-radarr-key"));
});

// ── library pickers ──────────────────────────────────────────────────────────

test("plex/libraries is 400 when Plex is unconfigured and fetches nothing", async () => {
  const t = await mintSession();
  const res = await getPlexLibs(t);
  assert.equal(res.status, 400);
  assert.deepEqual(fetchCalls, []);
});

test("plex/libraries returns the sections for a configured server", async () => {
  settings.set("plexServerUrl", "http://10.0.0.5:32400");
  settings.set("plexAdminToken", "plex-token");
  const t = await mintSession();
  const res = await getPlexLibs(t);
  assert.equal(res.status, 200);
  const sections = await res.json();
  // Only movie/show sections are offered as library choices — a music library
  // has nothing this app can sync.
  assert.deepEqual(sections.map((x: { type: string }) => x.type), ["movie", "show"]);
});

test("plex/libraries maps an unreachable server to 502 without leaking the body", async () => {
  settings.set("plexServerUrl", "http://10.0.0.5:32400");
  settings.set("plexAdminToken", "plex-token");
  plexSectionsOk = false;
  const t = await mintSession();
  const res = await getPlexLibs(t);
  assert.equal(res.status, 502);
  assert.ok(!(await res.text()).includes("PLEX SERVER DOWN"));
  assert.ok(errors.some((e) => e.includes("[settings/plex/libraries]")));
});

test("jellyfin/libraries is 400 when Jellyfin is unconfigured and fetches nothing", async () => {
  const t = await mintSession();
  const res = await getJfLibs(t);
  assert.equal(res.status, 400);
  assert.deepEqual(fetchCalls, []);
});

test("jellyfin/libraries is 400 when only HALF the connection is configured", async () => {
  settings.set("jellyfinUrl", "http://10.0.0.6:8096");
  const t = await mintSession();
  assert.equal((await getJfLibs(t)).status, 400);
});

test("jellyfin/libraries maps an unreachable server to 502 without leaking the body", async () => {
  settings.set("jellyfinUrl", "http://10.0.0.6:8096");
  settings.set("jellyfinApiKey", "jf-key");
  jellyfinFoldersOk = false;
  const t = await mintSession();
  const res = await getJfLibs(t);
  assert.equal(res.status, 502);
  assert.ok(!(await res.text()).includes("JELLYFIN DOWN"));
  assert.ok(errors.some((e) => e.includes("[settings/jellyfin/libraries]")));
});

test("neither library picker echoes its credential", async () => {
  settings.set("plexServerUrl", "http://10.0.0.5:32400");
  settings.set("plexAdminToken", "secret-plex-token");
  settings.set("jellyfinUrl", "http://10.0.0.6:8096");
  settings.set("jellyfinApiKey", "secret-jf-key");
  const t = await mintSession();
  assert.ok(!(await (await getPlexLibs(t)).text()).includes("secret-plex-token"));
  assert.ok(!(await (await getJfLibs(t)).text()).includes("secret-jf-key"));
});

// ── test-ratings ─────────────────────────────────────────────────────────────

for (const bad of [undefined, "", "OMDB", "tmdb", 1, null]) {
  test(`test-ratings rejects service ${JSON.stringify(bad)} with 400`, async () => {
    const t = await mintSession();
    const res = await postTestRatings(t, { service: bad });
    assert.equal(res.status, 400);
    assert.match((await res.json()).error, /omdb.*mdblist.*trakt.*ipinfo/);
  });
}

for (const service of ["omdb", "mdblist", "trakt", "ipinfo"]) {
  test(`test-ratings dispatches ${service} and reports a failure as 422, not a 500`, async () => {
    providerOk = false;
    const t = await mintSession();
    const res = await postTestRatings(t, { service });
    assert.equal(res.status, 422);
    const body = await res.json();
    assert.equal(body.ok, false);
    assert.match(body.error, new RegExp(service, "i"));
  });

  test(`a failing ${service} test never leaks the provider's response body`, async () => {
    providerOk = false;
    const t = await mintSession();
    const text = await (await postTestRatings(t, { service })).text();
    assert.ok(!text.includes("PROVIDER SECRET DETAIL"), "the upstream body reached the client");
    assert.ok(errors.some((e) => e.includes("[test-ratings]")), "the failure should be logged server-side");
  });
}

test("test-ratings rejects a malformed body with 400, and an oversized one is capped", async () => {
  const t = await mintSession();
  assert.equal((await postTestRatings(t, undefined, "{nope")).status, 400);
  const huge = JSON.stringify({ service: "omdb", pad: "z".repeat(32 * 1024) });
  const res = await postTestRatings(t, undefined, huge);
  assert.ok(res.status === 400 || res.status === 413);
});

test("test-ratings writes no Settings — it is a connectivity probe, not a save", async () => {
  const t = await mintSession();
  for (const service of ["omdb", "mdblist", "trakt", "ipinfo"]) {
    await postTestRatings(t, { service });
  }
  assert.equal(opsOf("setting.upsert").length, 0);
  assert.equal(opsOf("setting.deleteMany").length, 0);
});
