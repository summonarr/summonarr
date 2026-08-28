// Route-level unit tests for four more uncovered admin routes:
//   GET/POST /api/admin/arr-instances            the Radarr/Sonarr instance manager
//   GET      /api/admin/ip-lookup
//   GET      /api/admin/library/bad-matches
//   GET      /api/admin/play-history/heatmap-cell
//
// arr-instances is the interesting one and carries most of this file. It is the
// guardrail-32 registry surface, and it writes the connection Settings that hold
// each instance's API key and webhook secret — values that are encrypted at rest
// and UNRECOVERABLE if destroyed. Three guards there are load-bearing, each with
// its rationale spelled out in the route:
//
//   1. `instances` MUST BE AN ARRAY, explicitly. Coercing a missing or malformed
//      value to [] reads downstream as "the admin removed every named instance"
//      and deleteMany's their Setting rows. A body that doesn't say is not a body
//      that means delete everything.
//   2. THE BUILT-INS ARE NEVER CLEANUP CANDIDATES. The default ("") and legacy 4K
//      ("4k") instances are synthesized into getArrInstances, not registry-backed,
//      and the manager UI deliberately omits them from its POST — so treating
//      their absence as "removed" would wipe the radarr4k*/sonarr4k* connection
//      Settings, including the unrecoverable encrypted API key, on every save.
//   3. SECRETS ARE NEVER RETURNED. The view sends hasApiKey/hasWebhookSecret
//      booleans, and the UI echoes a mask sentinel back for a field it didn't
//      edit — which must SKIP the write, or the sentinel itself becomes the
//      stored API key.
//
// Plus guardrail 7a: the route must hand PLAINTEXT to prisma and let the client
// extension encrypt, never encryptToken at the call site (that produces
// enc:v1:<enc:v1:…> double-wrapped rows whose inner ciphertext then goes out as
// an API key and fails auth).
//
// The three smaller routes each have one real edge: ip-lookup makes a BILLED
// upstream call so it is rate-limited per admin; bad-matches maps a failure to a
// 500 rather than leaking the error; and heatmap-cell rejects absent/empty
// numeric params BEFORE coercion, because Number(null) and Number("") are both 0
// and would silently resolve to the Sunday-00:00 cell instead of a 400.
//
// Harness: real withAdmin-wrapped handlers, genuine signed session JWTs, a
// synthetic Next request scope, in-memory prisma stubs, scripted fetch (arr
// connection tests + ipinfo, RFC1918/literal hosts so the SSRF stack short-
// circuits DNS). No DB, no network.
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { AsyncLocalStorage } from "node:async_hooks";
import dns from "node:dns/promises";

(globalThis as { AsyncLocalStorage?: unknown }).AsyncLocalStorage = AsyncLocalStorage;

process.env.TOKEN_ENCRYPTION_KEY = "ab".repeat(32);
process.env.NEXTAUTH_SECRET = "admin-arr-instances-secret-0123456789ab";
process.env.AUTH_URL = "http://localhost:3000";
process.env.TRUST_PROXY = "true";
(process.env as Record<string, string | undefined>).NODE_ENV = "test";

const fakeLookup = async () => [{ address: "93.184.216.34", family: 4 }];
(dns as { lookup: unknown }).lookup = fakeLookup;
if ((dns as { lookup: unknown }).lookup !== fakeLookup) {
  throw new Error("could not stub dns.lookup");
}

const warns: string[] = [];
const errors: string[] = [];
console.warn = (...args: unknown[]) => { warns.push(args.map(String).join(" ")); };
console.error = (...args: unknown[]) => { errors.push(args.map(String).join(" ")); };

// ── scripted fetch ───────────────────────────────────────────────────────────
const fetchCalls: URL[] = [];
let arrTestOk = true;
let ipinfoOk = true;
globalThis.fetch = (async (input: RequestInfo | URL) => {
  const url = new URL(String(input));
  fetchCalls.push(url);
  const json = (b: unknown, s = 200) => new Response(JSON.stringify(b), { status: s, headers: { "content-type": "application/json" } });
  if (url.hostname === "ipinfo.io") {
    return ipinfoOk ? json({ ip: url.pathname.slice(1).replace("/json", ""), city: "Testville", country: "US", org: "AS1 Test" }) : json({}, 500);
  }
  if (url.pathname.includes("/api/v3/system/status")) {
    return arrTestOk ? json({ version: "5.1.0" }) : json({ error: "bad key" }, 401);
  }
  return json({});
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
// NOTE: this shadows the model delegate, so the crypto extension does NOT run.
// That is what makes guardrail 7a observable here: whatever the ROUTE hands to
// prisma is exactly what lands in this map, so a call-site encryptToken would
// show up as `enc:v1:…` and a correct route shows plaintext.
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
  upsert: async (args: { where: { key: string }; create: { key: string; value: string }; update: { value: string } }) => {
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

shadowPrismaModel(prisma, "auditLog", { create: async (args: unknown) => { rec("auditLog.create", args); return { id: "a1" }; } });
shadowPrismaModel(prisma, "ipLookupCache", {
  findUnique: async () => null, findFirst: async () => null, findMany: async () => [],
  upsert: async (args: unknown) => { rec("ipLookupCache.upsert", args); return {}; },
  create: async () => ({}), deleteMany: async () => ({ count: 0 }),
});
for (const m of ["plexLibraryItem", "jellyfinLibraryItem", "tmdbCache", "tmdbMediaCore", "playHistory", "mediaServerUser", "activeSession"]) {
  shadowPrismaModel(prisma, m, {
    findMany: async () => { rec(`${m}.findMany`); return []; },
    findFirst: async () => null, findUnique: async () => null, count: async () => 0,
    aggregate: async () => ({ _count: { _all: 0 }, _sum: {}, _min: {}, _max: {} }),
    groupBy: async () => [],
  });
}
// The removal cleanup deletes the de-registered slug's wanted/available cache
// rows — record the scoped where so the pin below can assert it.
// trashApplication joins them: it is per-instance CACHE (recordApply upserts it
// on every apply), and a stale row resurrects on a REUSED slug as a wrong
// remoteId that both misreports "applied" and gets pushed into a live profile.
for (const m of ["radarrWantedItem", "radarrAvailableItem", "sonarrWantedItem", "sonarrAvailableItem", "trashApplication"]) {
  shadowPrismaModel(prisma, m, {
    deleteMany: async (args: { where?: unknown }) => { rec(`${m}.deleteMany`, args?.where); return { count: 0 }; },
  });
}
// The POST handler commits the registry write, the per-instance connection rows
// and the removal cleanup in ONE transaction, so a mid-sequence failure cannot
// leave an instance de-registered while its rows survive (the cleanup is
// diff-driven and never gets a second chance). Every model the callback touches
// is already shadowed on `prisma` above, so handing the callback `prisma` itself
// as `tx` records the ops through the same recorders.
const txOptions: ({ timeout?: number } | undefined)[] = [];
// Set by a test that wants to observe state at the moment the callback returns.
let txObserver: (() => void) | null = null;
shadowPrismaClientMethod(prisma, "$transaction", async (arg: unknown, opts?: { timeout?: number }) => {
  if (typeof arg === "function") {
    txOptions.push(opts);
    rec("$transaction");
    const out = await (arg as (tx: typeof prisma) => Promise<unknown>)(prisma);
    txObserver?.();
    return out;
  }
  return Promise.all(arg as Promise<unknown>[]);
});
shadowPrismaClientMethod(prisma, "$queryRawUnsafe", async () => { rec("$queryRawUnsafe"); return []; });
shadowPrismaClientMethod(prisma, "$queryRaw", async () => { rec("$queryRaw"); return []; });

const arrInstances = await import("../src/app/api/admin/arr-instances/route.ts");
const ipLookup = await import("../src/app/api/admin/ip-lookup/route.ts");
const badMatches = await import("../src/app/api/admin/library/bad-matches/route.ts");
const heatmapCell = await import("../src/app/api/admin/play-history/heatmap-cell/route.ts");

// ── scope ────────────────────────────────────────────────────────────────────
const afterTasks: Array<() => Promise<unknown>> = [];
function inScope<T>(fn: () => Promise<T>): Promise<T> {
  const workStore = {
    route: "/admin-arr-instances.test", forceStatic: false, dynamicShouldError: false,
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

function mk(path: string, token: string | null, init: { method: string; body?: string; query?: string }) {
  return new NextRequest(`http://localhost:3000${path}${init.query ?? ""}`, {
    method: init.method,
    headers: { ...(token ? { cookie: `${COOKIE}=${token}` } : {}), "content-type": "application/json" },
    ...(init.body !== undefined ? { body: init.body } : {}),
  });
}
const getInstances = (t: string | null) => inScope(() => arrInstances.GET(mk("/api/admin/arr-instances", t, { method: "GET" }), undefined));
const saveInstances = (t: string | null, body: unknown, raw?: string) =>
  inScope(() => arrInstances.POST(mk("/api/admin/arr-instances", t, { method: "POST", body: raw ?? JSON.stringify(body) }), undefined));
const doIpLookup = (t: string | null, q: string) => inScope(() => ipLookup.GET(mk("/api/admin/ip-lookup", t, { method: "GET", query: q }), undefined));
const doBadMatches = (t: string | null, q = "") => inScope(() => badMatches.GET(mk("/api/admin/library/bad-matches", t, { method: "GET", query: q }), undefined));
const doHeatmap = (t: string | null, q: string) => inScope(() => heatmapCell.GET(mk("/api/admin/play-history/heatmap-cell", t, { method: "GET", query: q }), undefined));

// Seed the legacy 4K instance's connection Settings, which are the ones a
// mishandled cleanup would destroy.
function seed4k(service: "radarr" | "sonarr"): void {
  settings.set(arrSettingKey(service, "4k", "Url"), "http://10.0.0.9:7878");
  settings.set(arrSettingKey(service, "4k", "ApiKey"), "the-4k-api-key");
  settings.set(arrSettingKey(service, "4k", "WebhookSecret"), "the-4k-webhook-secret");
}
function registry(service: "radarr" | "sonarr", entries: unknown[]): void {
  settings.set(service === "radarr" ? "arrRadarrInstances" : "arrSonarrInstances", JSON.stringify(entries));
}

beforeEach(() => {
  ops = [];
  settings.clear();
  fetchCalls.length = 0;
  afterTasks.length = 0;
  warns.length = 0;
  errors.length = 0;
  arrTestOk = true;
  ipinfoOk = true;
});

// ── gating ───────────────────────────────────────────────────────────────────

test("all four routes refuse anonymous with 401", async () => {
  assert.equal((await getInstances(null)).status, 401);
  assert.equal((await saveInstances(null, { service: "radarr", instances: [] })).status, 401);
  assert.equal((await doIpLookup(null, "?ip=1.1.1.1")).status, 401);
  assert.equal((await doBadMatches(null)).status, 401);
  assert.equal((await doHeatmap(null, "?mode=day&day=2026-01-01")).status, 401);
});

test("a plain USER is 403 on all four and writes nothing", async () => {
  const t = await mintSession({ role: "USER", permissions: 0n });
  assert.equal((await getInstances(t)).status, 403);
  assert.equal((await saveInstances(t, { service: "radarr", instances: [] })).status, 403);
  assert.equal((await doIpLookup(t, "?ip=1.1.1.1")).status, 403);
  assert.equal((await doBadMatches(t)).status, 403);
  assert.equal((await doHeatmap(t, "?mode=day&day=2026-01-01")).status, 403);
  assert.equal(opsOf("setting.upsert").length, 0);
  assert.deepEqual(fetchCalls, []);
});

// ── 1: the array guard ───────────────────────────────────────────────────────

for (const [label, body] of [
  ["a missing instances key", { service: "radarr" }],
  ["instances: null", { service: "radarr", instances: null }],
  ["instances as an object", { service: "radarr", instances: {} }],
  ["instances as a string", { service: "radarr", instances: "" }],
  ["instances as a number", { service: "radarr", instances: 0 }],
] as const) {
  test(`save with ${label} is 400 and DESTROYS NOTHING`, async () => {
    // Coercing to [] reads downstream as "remove every named instance" and
    // deleteMany's their Setting rows, including unrecoverable encrypted secrets.
    const t = await mintSession();
    seed4k("radarr");
    registry("radarr", [{ slug: "anime", name: "Anime" }]);
    settings.set(arrSettingKey("radarr", "anime", "ApiKey"), "anime-key");

    const res = await saveInstances(t, body);
    assert.equal(res.status, 400);
    assert.equal((await res.json()).error, "instances must be an array");
    assert.equal(opsOf("setting.deleteMany").length, 0, "a malformed body must delete nothing");
    assert.equal(settings.get(arrSettingKey("radarr", "anime", "ApiKey")), "anime-key");
    assert.equal(settings.get(arrSettingKey("radarr", "4k", "ApiKey")), "the-4k-api-key");
  });
}

test("save with a bad service is 400 before touching anything", async () => {
  const t = await mintSession();
  for (const service of [undefined, "plex", "RADARR", ""]) {
    ops = [];
    const res = await saveInstances(t, { service, instances: [] });
    assert.equal(res.status, 400);
    assert.equal(opsOf("setting.upsert").length, 0);
    assert.equal(opsOf("setting.deleteMany").length, 0);
  }
});

test("an invalid slug is rejected and nothing is written", async () => {
  const t = await mintSession();
  for (const slug of ["Has Space", "UPPER", "with/slash", "a".repeat(64), 42, null]) {
    ops = [];
    const res = await saveInstances(t, { service: "radarr", instances: [{ slug }] });
    assert.equal(res.status, 400, `slug ${JSON.stringify(slug)} should be rejected`);
    assert.equal(opsOf("setting.upsert").length, 0);
  }
});

// ── 2: built-ins are never cleanup candidates ────────────────────────────────

test("saving a list that omits the built-ins does NOT wipe the 4K connection settings", async () => {
  // The manager UI deliberately omits "" and "4k" from its POST; treating their
  // absence as "removed" would destroy the unrecoverable encrypted 4K API key on
  // every single save.
  const t = await mintSession();
  seed4k("radarr");
  const res = await saveInstances(t, { service: "radarr", instances: [] });
  assert.equal(res.status, 200);
  assert.equal(settings.get(arrSettingKey("radarr", "4k", "ApiKey")), "the-4k-api-key");
  assert.equal(settings.get(arrSettingKey("radarr", "4k", "WebhookSecret")), "the-4k-webhook-secret");
  assert.equal(settings.get(arrSettingKey("radarr", "4k", "Url")), "http://10.0.0.9:7878");
});

test("the default instance's settings likewise survive a save that omits it", async () => {
  const t = await mintSession();
  settings.set(arrSettingKey("radarr", "", "ApiKey"), "the-default-key");
  await saveInstances(t, { service: "radarr", instances: [] });
  assert.equal(settings.get(arrSettingKey("radarr", "", "ApiKey")), "the-default-key");
});

test("a 4k entry in the POST is excluded from the registry so it can't shadow the built-in", async () => {
  const t = await mintSession();
  await saveInstances(t, { service: "radarr", instances: [{ slug: "4k", name: "Hijack" }] });
  const stored = JSON.parse(settings.get("arrRadarrInstances") ?? "[]");
  assert.ok(!stored.some((e: { slug: string }) => e.slug === "4k"), "4k must never be registry-backed");
});

test("removing a NAMED instance DOES clean up its setting rows AND its slug-scoped wanted/available cache rows", async () => {
  const t = await mintSession();
  registry("radarr", [{ slug: "anime", name: "Anime" }]);
  settings.set(arrSettingKey("radarr", "anime", "Url"), "http://10.0.0.8:7878");
  settings.set(arrSettingKey("radarr", "anime", "ApiKey"), "anime-key");

  await saveInstances(t, { service: "radarr", instances: [] });
  assert.equal(settings.get(arrSettingKey("radarr", "anime", "ApiKey")), undefined);
  assert.equal(settings.get(arrSettingKey("radarr", "anime", "Url")), undefined);

  // The de-registered slug's cache rows are unreachable by every writer after
  // removal (no sync path targets a removed slug) while the availability
  // attach reads them unscoped — the cleanup must delete them, slug-scoped,
  // for THIS service only.
  const wantedDeletes = ops.filter((c) => c.op === "radarrWantedItem.deleteMany").map((c) => c.args);
  const availDeletes = ops.filter((c) => c.op === "radarrAvailableItem.deleteMany").map((c) => c.args);
  assert.deepEqual(wantedDeletes, [{ arrInstance: "anime" }]);
  assert.deepEqual(availDeletes, [{ arrInstance: "anime" }]);
  assert.equal(ops.filter((c) => c.op === "sonarrWantedItem.deleteMany").length, 0, "a radarr save must not touch sonarr caches");

  // TRaSH applications are per-instance cache too: recordApply upserts them on
  // every apply, and a stale row resurrects on a REUSED slug — listSpecs would
  // report its remoteId as applied to a different server, and buildProfileBody
  // would skip re-creating the custom format and push a remoteId that does not
  // exist there into a live quality profile.
  assert.deepEqual(
    ops.filter((c) => c.op === "trashApplication.deleteMany").map((c) => c.args),
    [{ arrInstance: "anime" }],
  );
});

test("PIN: the registry write, connection rows and removal cleanup share ONE transaction", async () => {
  // Without this the statements auto-committed individually, so a failure after
  // the registry commit left the slug de-registered while its Setting and cache
  // rows survived — permanently, because the cleanup is diff-driven: only the
  // request that watches the registry stop listing a slug treats it as removed,
  // and that request had already committed. A retry reads a `before` without it.
  const t = await mintSession();
  txOptions.length = 0;
  registry("radarr", [{ slug: "anime", name: "Anime" }]);
  settings.set(arrSettingKey("radarr", "anime", "ApiKey"), "anime-key");

  await saveInstances(t, { service: "radarr", instances: [] });

  assert.equal(txOptions.length, 1, "exactly one transaction for the whole write sequence");
  assert.equal(txOptions[0]?.timeout, 30_000, "opened with BATCH_TX_TIMEOUT");

  // Every write op must fall inside that transaction — i.e. after it opened.
  const txIdx = ops.findIndex((c) => c.op === "$transaction");
  assert.ok(txIdx >= 0, "the transaction was opened");
  for (const writeOp of ["setting.deleteMany", "radarrWantedItem.deleteMany", "trashApplication.deleteMany"]) {
    const idx = ops.findIndex((c) => c.op === writeOp);
    assert.ok(idx > txIdx, `${writeOp} must run inside the transaction, not before it`);
  }
});

test("PIN: no connection test fires while the transaction is open", async () => {
  // Network I/O must never hold a DB transaction open (it starves the pool for
  // as long as an unreachable *arr instance takes to time out — 30s each). The
  // stub runs the callback inline, so recording the fetch count at the moment
  // the callback returns proves nothing was fetched inside it.
  const t = await mintSession();
  txOptions.length = 0;
  fetchCalls.length = 0;
  registry("radarr", []);
  let fetchesWhenTxClosed = -1;
  txObserver = () => { fetchesWhenTxClosed = fetchCalls.length; };

  await saveInstances(t, {
    service: "radarr",
    instances: [{ slug: "anime", name: "Anime", url: "http://10.0.0.8:7878", apiKey: "k" }],
  });

  txObserver = null;
  assert.equal(txOptions.length, 1, "the write sequence ran in a transaction");
  assert.equal(fetchesWhenTxClosed, 0, "zero fetches had been issued when the transaction closed");
  assert.ok(fetchCalls.length > 0, "…and the connection test did run, afterwards");
});

test("a kept named instance is not cleaned up", async () => {
  const t = await mintSession();
  registry("radarr", [{ slug: "anime", name: "Anime" }, { slug: "docs", name: "Docs" }]);
  settings.set(arrSettingKey("radarr", "anime", "ApiKey"), "anime-key");
  settings.set(arrSettingKey("radarr", "docs", "ApiKey"), "docs-key");

  await saveInstances(t, { service: "radarr", instances: [{ slug: "anime", name: "Anime" }] });
  assert.equal(settings.get(arrSettingKey("radarr", "anime", "ApiKey")), "anime-key");
  assert.equal(settings.get(arrSettingKey("radarr", "docs", "ApiKey")), undefined, "the removed one is cleaned up");
});

test("a save on one service never touches the other service's rows", async () => {
  const t = await mintSession();
  registry("sonarr", [{ slug: "anime", name: "Anime" }]);
  settings.set(arrSettingKey("sonarr", "anime", "ApiKey"), "sonarr-anime-key");
  await saveInstances(t, { service: "radarr", instances: [] });
  assert.equal(settings.get(arrSettingKey("sonarr", "anime", "ApiKey")), "sonarr-anime-key");
});

// ── 3: secrets never leave, and the mask sentinel is honoured ────────────────

test("GET never returns an API key or webhook secret — only presence flags", async () => {
  const t = await mintSession();
  seed4k("radarr");
  const res = await getInstances(t);
  const text = await res.text();
  assert.ok(!text.includes("the-4k-api-key"), "the API key leaked");
  assert.ok(!text.includes("the-4k-webhook-secret"), "the webhook secret leaked");
  const body = JSON.parse(text);
  const fourk = body.radarr.find((i: { slug: string }) => i.slug === "4k");
  assert.equal(fourk.hasApiKey, true);
  assert.equal(fourk.hasWebhookSecret, true);
  assert.ok(!("apiKey" in fourk));
  assert.ok(!("webhookSecret" in fourk));
});

test("GET reports hasApiKey false when the key is absent or empty", async () => {
  // Uses a registry-backed named instance: those are always listed, whereas the
  // legacy 4K one is synthesized only when actually configured (see below).
  const t = await mintSession();
  registry("radarr", [{ slug: "anime", name: "Anime" }]);
  settings.set(arrSettingKey("radarr", "anime", "ApiKey"), "");
  const body = await (await getInstances(t)).json();
  const anime = body.radarr.find((i: { slug: string }) => i.slug === "anime");
  assert.equal(anime.hasApiKey, false);
  assert.equal(anime.hasWebhookSecret, false);
});

test("the legacy 4K instance is synthesized ONLY when its connection is configured", async () => {
  // It is not registry-backed, so its presence in the list is derived purely
  // from having both a url and an api key. A half-configured 4K row must not
  // appear as a usable instance.
  const t = await mintSession();

  const absent = await (await getInstances(t)).json();
  assert.ok(!absent.radarr.some((i: { slug: string }) => i.slug === "4k"), "unconfigured 4K must not be listed");

  settings.set(arrSettingKey("radarr", "4k", "Url"), "http://10.0.0.9:7878");
  const halfway = await (await getInstances(t)).json();
  assert.ok(!halfway.radarr.some((i: { slug: string }) => i.slug === "4k"), "url without a key is not configured");

  settings.set(arrSettingKey("radarr", "4k", "ApiKey"), "the-4k-api-key");
  const configured = await (await getInstances(t)).json();
  assert.ok(configured.radarr.some((i: { slug: string }) => i.slug === "4k"), "a fully configured 4K should be listed");
});

test("the default instance is always listed, configured or not", async () => {
  const t = await mintSession();
  const body = await (await getInstances(t)).json();
  assert.ok(body.radarr.some((i: { slug: string }) => i.slug === ""));
  assert.ok(body.sonarr.some((i: { slug: string }) => i.slug === ""));
});

test("the MASK SENTINEL is skipped, never stored as the API key", async () => {
  // The UI echoes it back for a field the admin didn't edit; writing it would
  // replace the real key with bullet characters.
  const t = await mintSession();
  settings.set(arrSettingKey("radarr", "anime", "ApiKey"), "real-key");
  registry("radarr", [{ slug: "anime", name: "Anime" }]);
  await saveInstances(t, {
    service: "radarr",
    instances: [{ slug: "anime", name: "Anime", apiKey: "••••••••", webhookSecret: "••••••••" }],
  });
  assert.equal(settings.get(arrSettingKey("radarr", "anime", "ApiKey")), "real-key");
});

test("an explicit empty string CLEARS a secret", async () => {
  const t = await mintSession();
  settings.set(arrSettingKey("radarr", "anime", "ApiKey"), "real-key");
  registry("radarr", [{ slug: "anime", name: "Anime" }]);
  await saveInstances(t, { service: "radarr", instances: [{ slug: "anime", name: "Anime", apiKey: "" }] });
  assert.equal(settings.get(arrSettingKey("radarr", "anime", "ApiKey")), "");
});

test("an undefined field leaves the stored value untouched", async () => {
  const t = await mintSession();
  settings.set(arrSettingKey("radarr", "anime", "RootFolder"), "/movies");
  registry("radarr", [{ slug: "anime", name: "Anime" }]);
  await saveInstances(t, { service: "radarr", instances: [{ slug: "anime", name: "Anime" }] });
  assert.equal(settings.get(arrSettingKey("radarr", "anime", "RootFolder")), "/movies");
});

// ── guardrail 7a: plaintext to prisma, never a call-site encrypt ─────────────

test("the route stores PLAINTEXT secrets — the prisma extension owns encryption", async () => {
  // A call-site encryptToken produces enc:v1:<enc:v1:…> double-wrapped rows; on
  // read the extension unwraps once and hands out the inner ciphertext, which
  // then goes to Radarr as the API key and fails auth. This stub bypasses the
  // extension, so whatever the route passed is exactly what lands here.
  const t = await mintSession();
  registry("radarr", [{ slug: "anime", name: "Anime" }]);
  await saveInstances(t, {
    service: "radarr",
    instances: [{ slug: "anime", name: "Anime", apiKey: "plain-api-key", webhookSecret: "plain-hook" }],
  });
  assert.equal(settings.get(arrSettingKey("radarr", "anime", "ApiKey")), "plain-api-key");
  assert.equal(settings.get(arrSettingKey("radarr", "anime", "WebhookSecret")), "plain-hook");
  for (const [, v] of settings) {
    assert.ok(!String(v).startsWith("enc:v1:"), "the route pre-encrypted a value (guardrail 7a)");
  }
});

test("the per-instance secret keys are ones isSensitiveSettingKey will encrypt", async () => {
  // The regex in settings-sensitive-keys.ts is what makes the extension cover
  // admin-defined slugs; if the key naming drifts, the secret silently goes to
  // disk in plaintext.
  for (const service of ["radarr", "sonarr"] as const) {
    for (const slug of ["", "4k", "anime"]) {
      assert.ok(isSensitiveSettingKey(arrSettingKey(service, slug, "ApiKey")), `${service}/${slug} ApiKey not sensitive`);
      assert.ok(isSensitiveSettingKey(arrSettingKey(service, slug, "WebhookSecret")), `${service}/${slug} WebhookSecret not sensitive`);
    }
  }
});

test("the non-secret keys are deliberately NOT marked sensitive", async () => {
  for (const field of ["Url", "RootFolder", "QualityProfileId"] as const) {
    assert.ok(!isSensitiveSettingKey(arrSettingKey("radarr", "anime", field)), `${field} should stay plaintext`);
  }
});

// ── registry normalization + write shape ─────────────────────────────────────

test("registry flags are strict === true, not truthy", async () => {
  const t = await mintSession();
  await saveInstances(t, {
    service: "radarr",
    instances: [{ slug: "anime", name: "Anime", restricted: "true", serverAll: 1, skipLibraryCheck: "yes" }],
  });
  const stored = JSON.parse(settings.get("arrRadarrInstances") ?? "[]");
  const anime = stored.find((e: { slug: string }) => e.slug === "anime");
  assert.equal(anime.restricted, false);
  assert.equal(anime.serverAll, false);
  assert.equal(anime.skipLibraryCheck, false);
});

test("a blank name falls back to the slug", async () => {
  const t = await mintSession();
  await saveInstances(t, { service: "radarr", instances: [{ slug: "anime", name: "   " }] });
  const stored = JSON.parse(settings.get("arrRadarrInstances") ?? "[]");
  assert.equal(stored.find((e: { slug: string }) => e.slug === "anime").name, "anime");
});

test("a url is trimmed before storage", async () => {
  const t = await mintSession();
  await saveInstances(t, { service: "radarr", instances: [{ slug: "anime", url: "  http://10.0.0.8:7878  " }] });
  assert.equal(settings.get(arrSettingKey("radarr", "anime", "Url")), "http://10.0.0.8:7878");
});

test("qualityProfileId null clears while undefined leaves it alone", async () => {
  const t = await mintSession();
  settings.set(arrSettingKey("radarr", "anime", "QualityProfileId"), "7");
  await saveInstances(t, { service: "radarr", instances: [{ slug: "anime", qualityProfileId: null }] });
  assert.equal(settings.get(arrSettingKey("radarr", "anime", "QualityProfileId")), "");

  settings.set(arrSettingKey("radarr", "anime", "QualityProfileId"), "7");
  await saveInstances(t, { service: "radarr", instances: [{ slug: "anime" }] });
  assert.equal(settings.get(arrSettingKey("radarr", "anime", "QualityProfileId")), "7");
});

test("a numeric qualityProfileId is stringified", async () => {
  const t = await mintSession();
  await saveInstances(t, { service: "radarr", instances: [{ slug: "anime", qualityProfileId: 9 }] });
  assert.equal(settings.get(arrSettingKey("radarr", "anime", "QualityProfileId")), "9");
});

test("a save is audited with the slug list", async () => {
  const t = await mintSession();
  await saveInstances(t, { service: "radarr", instances: [{ slug: "anime" }] });
  await (async () => { for (const task of afterTasks.splice(0)) await task(); })();
  const created = opsOf("auditLog.create");
  assert.equal(created.length, 1);
  const data = (created[0].args as { data: { action: string; target: string; details: string } }).data;
  assert.equal(data.action, "SETTINGS_CHANGE");
  assert.equal(data.target, "arr-instances:radarr");
  assert.deepEqual(JSON.parse(data.details).instances, ["anime"]);
});

test("connection tests run only for instances that have BOTH url and apiKey", async () => {
  const t = await mintSession();
  registry("radarr", [{ slug: "anime", name: "Anime" }, { slug: "half", name: "Half" }]);
  settings.set(arrSettingKey("radarr", "anime", "Url"), "http://10.0.0.8:7878");
  settings.set(arrSettingKey("radarr", "anime", "ApiKey"), "k");
  settings.set(arrSettingKey("radarr", "half", "Url"), "http://10.0.0.7:7878"); // no key
  const body = await (await saveInstances(t, {
    service: "radarr",
    instances: [{ slug: "anime", name: "Anime" }, { slug: "half", name: "Half" }],
  })).json();
  assert.ok(body.testResults.anime);
  assert.ok(!body.testResults.half, "an instance with no api key should not be probed");
});

test("a failed connection test is reported without leaking the upstream body", async () => {
  const t = await mintSession();
  arrTestOk = false;
  registry("radarr", [{ slug: "anime", name: "Anime" }]);
  settings.set(arrSettingKey("radarr", "anime", "Url"), "http://10.0.0.8:7878");
  settings.set(arrSettingKey("radarr", "anime", "ApiKey"), "bad");
  const body = await (await saveInstances(t, { service: "radarr", instances: [{ slug: "anime", name: "Anime" }] })).json();
  assert.equal(body.testResults.anime.error, "radarr connection failed");
  assert.ok(!JSON.stringify(body).includes("bad key"));
});

test("an oversized save body is capped (guardrail 30)", async () => {
  const t = await mintSession();
  const huge = JSON.stringify({ service: "radarr", instances: [{ slug: "anime", name: "n".repeat(80_000) }] });
  const res = await saveInstances(t, undefined, huge);
  assert.ok(res.status === 400 || res.status === 413);
  assert.equal(opsOf("setting.upsert").length, 0);
});

// ── /api/admin/ip-lookup ─────────────────────────────────────────────────────

test("ip-lookup requires an ip param", async () => {
  const t = await mintSession();
  const res = await doIpLookup(t, "");
  assert.equal(res.status, 400);
  assert.deepEqual(fetchCalls, []);
});

test("ip-lookup treats a whitespace-only ip as missing", async () => {
  const t = await mintSession();
  assert.equal((await doIpLookup(t, "?ip=%20%20")).status, 400);
});

test("ip-lookup is rate-limited per admin — every lookup is a billed upstream call", async () => {
  const t = await mintSession();
  for (let i = 0; i < 60; i++) {
    const r = await doIpLookup(t, `?ip=8.8.8.${i % 256}`);
    assert.notEqual(r.status, 429, `lookup ${i + 1} should pass`);
  }
  assert.equal((await doIpLookup(t, "?ip=8.8.4.4")).status, 429);
});

test("the ip-lookup budget is per admin", async () => {
  const a = await mintSession();
  for (let i = 0; i < 61; i++) await doIpLookup(a, `?ip=9.9.9.${i % 256}`);
  assert.equal((await doIpLookup(a, "?ip=9.9.9.9")).status, 429);
  const b = await mintSession();
  assert.notEqual((await doIpLookup(b, "?ip=9.9.9.9")).status, 429);
});

test("a failed or unconfigured lookup is 404, not a 500", async () => {
  const t = await mintSession();
  ipinfoOk = false;
  const res = await doIpLookup(t, "?ip=203.0.113.5");
  assert.equal(res.status, 404);
});

// ── /api/admin/library/bad-matches ───────────────────────────────────────────

test("bad-matches whitelists the mediaType filter", async () => {
  const t = await mintSession();
  for (const q of ["", "?mediaType=movie", "?mediaType=tv", "?mediaType=ANIME", "?mediaType=MOVIE"]) {
    const res = await doBadMatches(t, q);
    assert.equal(res.status, 200, `query ${q} should serve`);
  }
});

test("bad-matches maps an internal failure to a 500 without leaking the error", async () => {
  const t = await mintSession();
  shadowPrismaModel(prisma, "plexLibraryItem", {
    findMany: async () => { throw new Error("SECRET INTERNAL DETAIL"); },
    findFirst: async () => null, findUnique: async () => null, count: async () => 0,
  });
  const res = await doBadMatches(t);
  try {
    assert.equal(res.status, 500, "an internal failure must map to a 500");
    const text = await res.text();
    assert.ok(!text.includes("SECRET INTERNAL DETAIL"), "the internal error leaked to the client");
    assert.ok(errors.some((e) => e.includes("[library/bad-matches]")), "no scoped error log");
  } finally {
    shadowPrismaModel(prisma, "plexLibraryItem", {
      findMany: async () => { rec("plexLibraryItem.findMany"); return []; },
      findFirst: async () => null, findUnique: async () => null, count: async () => 0,
      aggregate: async () => ({ _count: { _all: 0 }, _sum: {}, _min: {}, _max: {} }), groupBy: async () => [],
    });
  }
});

// ── /api/admin/play-history/heatmap-cell ─────────────────────────────────────

for (const [label, q] of [
  ["a missing mode", ""],
  ["an unknown mode", "?mode=week"],
  ["mode=day with no day", "?mode=day"],
  ["mode=day with a bad date", "?mode=day&day=2026-1-1"],
  ["mode=day with a non-date", "?mode=day&day=yesterday"],
] as const) {
  test(`heatmap-cell rejects ${label} with 400`, async () => {
    const t = await mintSession();
    assert.equal((await doHeatmap(t, q)).status, 400);
  });
}

for (const [label, q] of [
  ["an ABSENT dow", "?mode=hour&hour=5"],
  ["an EMPTY dow", "?mode=hour&dow=&hour=5"],
  ["an ABSENT hour", "?mode=hour&dow=3"],
  ["an EMPTY hour", "?mode=hour&dow=3&hour="],
] as const) {
  test(`heatmap-cell rejects ${label} instead of coercing it to the Sunday-00:00 cell`, async () => {
    // Number(null) and Number("") are both 0, so an unguarded coercion silently
    // answers for a completely different cell rather than 400ing.
    const t = await mintSession();
    const res = await doHeatmap(t, q);
    assert.equal(res.status, 400, `${label} must not coerce to 0`);
  });
}

for (const [label, q] of [
  ["dow 7", "?mode=hour&dow=7&hour=0"],
  ["dow -1", "?mode=hour&dow=-1&hour=0"],
  ["a float dow", "?mode=hour&dow=1.5&hour=0"],
  ["hour 24", "?mode=hour&dow=0&hour=24"],
  ["hour -1", "?mode=hour&dow=0&hour=-1"],
] as const) {
  test(`heatmap-cell rejects out-of-range ${label}`, async () => {
    const t = await mintSession();
    assert.equal((await doHeatmap(t, q)).status, 400);
  });
}

test("heatmap-cell accepts the boundary values", async () => {
  const t = await mintSession();
  for (const q of ["?mode=hour&dow=0&hour=0", "?mode=hour&dow=6&hour=23", "?mode=day&day=2026-02-29"]) {
    assert.equal((await doHeatmap(t, q)).status, 200, `${q} should be accepted`);
  }
});

test("heatmap-cell ignores an out-of-range days window rather than erroring", async () => {
  const t = await mintSession();
  for (const q of ["?mode=hour&dow=0&hour=0&days=0", "?mode=hour&dow=0&hour=0&days=99999", "?mode=hour&dow=0&hour=0&days=abc"]) {
    assert.equal((await doHeatmap(t, q)).status, 200);
  }
});

test("heatmap-cell whitelists source and mediaType", async () => {
  const t = await mintSession();
  for (const q of [
    "?mode=day&day=2026-01-01&source=plex",
    "?mode=day&day=2026-01-01&source=emby",
    "?mode=day&day=2026-01-01&mediaType=MOVIE",
    "?mode=day&day=2026-01-01&mediaType=ANIME",
  ]) {
    assert.equal((await doHeatmap(t, q)).status, 200, `${q} should serve`);
  }
});
