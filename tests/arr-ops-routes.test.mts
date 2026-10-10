// Route-level tests for the Radarr/Sonarr operations surfaces:
//   /api/admin/queue, /api/admin/queue/remove           (Admin → Download Queue)
//   /api/admin/arr-health, /api/admin/arr-health/webhook (health + one-click webhook)
//   /api/admin/arr/open                                 ("Open in Radarr/Sonarr")
//   /api/admin/missing?mode=cutoff + search mode=cutoff  (Missing → Cutoff unmet)
//   /api/requests/[id]/releases                         (request "Pick release")
//
// What is pinned:
//   1. ADMIN ONLY for the admin routes and MANAGE_REQUESTS for the request
//      releases (guardrail 6a) — refused callers never reach Radarr/Sonarr.
//   2. EVERY configured instance is read, each on its own URL (guardrail 32);
//      a failed one is named, never read as "empty"; a slug that names no
//      configured instance is refused BEFORE any upstream call.
//   3. Removal is ONE bulk DELETE on the row's own instance carrying every id
//      and every flag explicitly; it is audited only after the arr accepted it.
//   4. Webhook setup: the token rides in ?token= (guardrail 2) and never leaves
//      the server — not in the health report, not in the audit row, not in an
//      error the arr echoes back; an existing hook is repaired in place.
//   5. The cutoff search re-judges live and queues exactly the below-cutoff
//      episodes; a title that meets cutoff now is 409 and queues nothing.
//   6. A TV request's release search is always per SEASON — never the
//      series-only query Sonarr answers with its RSS feed — and the grab audit
//      never records the guid (some indexers put the apikey in it).
//
// Harness: tests/arr-missing-routes.test.mts — real wrapped handlers with a
// signed session JWT in a synthetic request scope, in-memory prisma stubs,
// Radarr/Sonarr scripted on RFC1918 literals.
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import dns from "node:dns/promises";
import { createRequire } from "node:module";
import { AsyncLocalStorage } from "node:async_hooks";

(globalThis as { AsyncLocalStorage?: unknown }).AsyncLocalStorage = AsyncLocalStorage;

process.env.TOKEN_ENCRYPTION_KEY = "ab".repeat(32);
process.env.NEXTAUTH_SECRET = "arr-ops-route-test-secret-0123456789abcdef";
process.env.AUTH_URL = "http://localhost:3000";
process.env.TRUST_PROXY = "true";
(process.env as Record<string, string | undefined>).NODE_ENV = "test";

const fakeLookup = async () => [{ address: "10.0.0.250", family: 4 }];
(dns as { lookup: unknown }).lookup = fakeLookup;
if ((dns as { lookup: unknown }).lookup !== fakeLookup) throw new Error("could not stub dns.lookup");

let errorLines: string[] = [];
let warnLines: string[] = [];
console.warn = (...a: unknown[]) => { warnLines.push(a.map(String).join(" ")); };
console.error = (...a: unknown[]) => { errorLines.push(a.map(String).join(" ")); };

// ── scripted Radarr/Sonarr ───────────────────────────────────────────────────
const RADARR = "http://10.0.0.5:7878";
const RADARR_4K = "http://10.0.0.6:7878";
const SONARR = "http://10.0.0.7:8989";
type Call = { origin: string; method: string; path: string; query: URLSearchParams; body: unknown };
let calls: Call[] = [];
type Responder = (c: Call) => Response | undefined;
let responder: Responder = () => undefined;
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
  const url = new URL(String(input));
  const method = init?.method ?? "GET";
  const body = typeof init?.body === "string" ? JSON.parse(init.body) : undefined;
  const call = { origin: url.origin, method, path: url.pathname, query: url.searchParams, body };
  calls.push(call);
  const res = responder(call);
  if (res) return res;
  throw new Error(`unexpected ${method} ${url}`);
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
const { shadowPrismaModel } = await import("./_helpers.mts");
const { signSessionJwt } = await import("../src/lib/session-jwt.ts");
const { getSessionCookieName } = await import("../src/lib/session-cookie.ts");
const { Permission } = await import("../src/lib/permissions.ts");
const { invalidateFeatureFlagCache } = await import("../src/lib/features.ts");
const { _resetReleaseHandlesForTests } = await import("../src/lib/release-handles.ts");
const { forgetWarnOnChange } = await import("../src/lib/log-dedup.ts");

// ── auth fixture ─────────────────────────────────────────────────────────────
const usersById = new Map<string, Record<string, unknown>>();
const sessionRows = new Set<string>();
shadowPrismaModel(prisma, "authSession", {
  findUnique: async (args: { where: { sessionId: string } }) =>
    sessionRows.has(args.where.sessionId) ? { id: `row-${args.where.sessionId}`, sessionId: args.where.sessionId } : null,
  update: async () => ({}),
});
shadowPrismaModel(prisma, "user", {
  findUnique: async (args: { where: { id: string } }) => {
    const u = usersById.get(args.where.id);
    return u ? { ...u } : null;
  },
  update: async () => ({}),
});
let sessionSeq = 0;
async function mintSession(opts: { role?: string; permissions?: bigint } = {}): Promise<string> {
  sessionSeq++;
  const userId = `user-${sessionSeq}`;
  const sessionId = `sess-${sessionSeq}`;
  const role = opts.role ?? "ADMIN";
  const permissions = (opts.permissions ?? Permission.ADMIN).toString();
  usersById.set(userId, {
    role, permissions: BigInt(permissions), mediaServer: null, sessionsRevokedAt: null,
    passwordChangedAt: null, deactivatedAt: null, email: `u${sessionSeq}@example.com`, notificationEmail: null,
  });
  sessionRows.add(sessionId);
  const iat = Math.floor(Date.now() / 1000);
  return signSessionJwt(
    { id: userId, role, permissions, provider: "credentials", sessionId, expiresAt: iat + 86_400 },
    { expiresInSeconds: 7_200, iat },
  );
}
const COOKIE = getSessionCookieName();

// ── data stubs ───────────────────────────────────────────────────────────────
const settings = new Map<string, string>();
const settingUpserts: Array<{ key: string; value: string }> = [];
// A hook to simulate a concurrent setup landing its secret first.
let beforeCreateMany: (() => void) | null = null;
shadowPrismaModel(prisma, "setting", {
  findMany: async (args?: { where?: { key?: { in?: string[] } } }) => {
    const keys = args?.where?.key?.in;
    return [...settings.entries()].filter(([k]) => !keys || keys.includes(k)).map(([key, value]) => ({ key, value }));
  },
  findUnique: async (args: { where: { key: string } }) => {
    const v = settings.get(args.where.key);
    return v === undefined ? null : { key: args.where.key, value: v };
  },
  createMany: async (args: { data: Array<{ key: string; value: string }>; skipDuplicates?: boolean }) => {
    beforeCreateMany?.();
    let count = 0;
    for (const row of args.data) {
      if (settings.has(row.key)) continue;
      settings.set(row.key, row.value);
      settingUpserts.push(row);
      count++;
    }
    return { count };
  },
  upsert: async (args: { where: { key: string }; create: { value: string }; update: { value: string } }) => {
    settings.set(args.where.key, args.update.value);
    settingUpserts.push({ key: args.where.key, value: args.update.value });
    return { key: args.where.key, value: args.update.value };
  },
});
shadowPrismaModel(prisma, "tmdbMediaCore", { findMany: async () => [] });
type ReqRow = { id: string; mediaType: "MOVIE" | "TV"; tmdbId: number; tvdbId: number | null; status: string; arrInstance: string; user: { name: string | null; email: string } };
let requests: ReqRow[] = [];
shadowPrismaModel(prisma, "mediaRequest", {
  findMany: async (args: { where: { mediaType?: string; tmdbId?: { in: number[] }; tvdbId?: { in: number[] }; status?: { not: string } } }) =>
    requests.filter((r) =>
      (!args.where.mediaType || r.mediaType === args.where.mediaType) &&
      (!args.where.tmdbId || args.where.tmdbId.in.includes(r.tmdbId)) &&
      (!args.where.tvdbId || (r.tvdbId !== null && args.where.tvdbId.in.includes(r.tvdbId))) &&
      (!args.where.status || r.status !== args.where.status.not)),
  findUnique: async (args: { where: { id: string } }) => requests.find((r) => r.id === args.where.id) ?? null,
});
let audits: Array<{ action: string; target: string | null; details: unknown }> = [];
shadowPrismaModel(prisma, "auditLog", {
  create: async (args: { data: { action: string; target?: string | null; details?: unknown } }) => {
    audits.push({ action: args.data.action, target: args.data.target ?? null, details: args.data.details });
    return {};
  },
});

const queueRoute = await import("../src/app/api/admin/queue/route.ts");
const removeRoute = await import("../src/app/api/admin/queue/remove/route.ts");
const importRoute = await import("../src/app/api/admin/queue/import/route.ts");
const healthRoute = await import("../src/app/api/admin/arr-health/route.ts");
const webhookRoute = await import("../src/app/api/admin/arr-health/webhook/route.ts");
const openRoute = await import("../src/app/api/admin/arr/open/route.ts");
const missingRoute = await import("../src/app/api/admin/missing/route.ts");
const missingSearchRoute = await import("../src/app/api/admin/missing/search/route.ts");
const releasesRoute = await import("../src/app/api/requests/[id]/releases/route.ts");

// ── request scope ────────────────────────────────────────────────────────────
function inScope<T>(fn: () => Promise<T>): Promise<T> {
  const workStore = { route: "/arr-ops.test", forceStatic: false, dynamicShouldError: false, afterContext: { after: () => {} } };
  const h = new Headers();
  const requestStore = {
    type: "request", phase: "render",
    headers: HeadersAdapter.seal(h),
    cookies: RequestCookiesAdapter.seal(new RequestCookies(h)),
    usedDynamic: false,
  };
  return workAsyncStorage.run(workStore, () => workUnitAsyncStorage.run(requestStore, fn));
}
type Handler = (r: unknown, c: unknown) => Promise<Response>;
const call = (handler: unknown, token: string | null, path: string, init: { method?: string; body?: unknown; ctx?: unknown } = {}) =>
  inScope(() => (handler as Handler)(
    new NextRequest(`http://localhost:3000/api${path}`, {
      method: init.method ?? "GET",
      headers: {
        ...(token ? { cookie: `${COOKIE}=${token}` } : {}),
        ...(init.body !== undefined ? { "content-type": "application/json" } : {}),
      },
      ...(init.body !== undefined ? { body: typeof init.body === "string" ? init.body : JSON.stringify(init.body) } : {}),
    }),
    init.ctx,
  ));
const idCtx = (id: string) => ({ params: Promise.resolve({ id }) });
const drain = async () => { for (let i = 0; i < 20; i++) await new Promise((r) => setImmediate(r)); };
const arrCalls = () => calls.filter((c) => c.origin !== "http://localhost:3000");

// ── fixture ──────────────────────────────────────────────────────────────────
const RADARR_SECRET = "radarr-hook-secret";
beforeEach(() => {
  calls = [];
  audits = [];
  errorLines = [];
  warnLines = [];
  beforeCreateMany = null;
  _resetReleaseHandlesForTests();
  settingUpserts.length = 0;
  requests = [];
  responder = () => undefined;
  settings.clear();
  for (const [k, v] of Object.entries({
    radarrUrl: RADARR, radarrApiKey: "radarr-key", radarrWebhookSecret: RADARR_SECRET, radarrExternalUrl: "https://radarr.example.com/",
    radarr4kUrl: RADARR_4K, radarr4kApiKey: "radarr4k-key",
    sonarrUrl: SONARR, sonarrApiKey: "sonarr-key",
  })) settings.set(k, v);
  invalidateFeatureFlagCache();
});

// ── 1: auth ──────────────────────────────────────────────────────────────────

test("anonymous is 401 and a delegated manager 403 on every admin route — nothing reaches Radarr/Sonarr", async () => {
  const manager = await mintSession({ role: "USER", permissions: Permission.MANAGE_REQUESTS });
  for (const token of [null, manager]) {
    const expected = token === null ? 401 : 403;
    assert.equal((await call(queueRoute.GET, token, "/admin/queue")).status, expected);
    assert.equal((await call(removeRoute.POST, token, "/admin/queue/remove", { method: "POST", body: { service: "radarr", ids: [1], action: "remove" } })).status, expected);
    assert.equal((await call(healthRoute.GET, token, "/admin/arr-health")).status, expected);
    assert.equal((await call(webhookRoute.POST, token, "/admin/arr-health/webhook", { method: "POST", body: { service: "radarr" } })).status, expected);
    assert.equal((await call(openRoute.GET, token, "/admin/arr/open?service=radarr&instance=&tmdbId=1")).status, expected);
    assert.equal((await call(importRoute.GET, token, "/admin/queue/import?service=radarr&instance=&downloadId=x")).status, expected);
    assert.equal((await call(importRoute.POST, token, "/admin/queue/import", { method: "POST", body: { service: "radarr", downloadId: "x", paths: ["/a"] } })).status, expected);
  }
  assert.deepEqual(arrCalls(), []);
});

test("request releases: a plain USER is 403, and a MANAGE_REQUESTS delegate is let through", async () => {
  requests = [{ id: "r1", mediaType: "MOVIE", tmdbId: 603, tvdbId: null, status: "APPROVED", arrInstance: "", user: { name: "A", email: "a@x" } }];
  responder = (c) => (c.path === "/api/v3/movie" ? json([{ id: 1, tmdbId: 603 }]) : c.path === "/api/v3/release" ? json([]) : undefined);
  const user = await mintSession({ role: "USER", permissions: 0n });
  assert.equal((await call(releasesRoute.GET, user, "/requests/r1/releases", { ctx: idCtx("r1") })).status, 403);
  assert.deepEqual(arrCalls(), []);
  const manager = await mintSession({ role: "USER", permissions: Permission.MANAGE_REQUESTS });
  assert.equal((await call(releasesRoute.GET, manager, "/requests/r1/releases", { ctx: idCtx("r1") })).status, 200);
});

// ── 2: queue ─────────────────────────────────────────────────────────────────

const sonarrPackRecord = (id: number, ep: number) => ({
  id, downloadId: "pack-1", title: "Show.S02.1080p", seriesId: 3,
  series: { title: "Show", tmdbId: 300, tvdbId: 3000 }, episode: { seasonNumber: 2, episodeNumber: ep },
  size: 6e9, sizeleft: 3e9, status: "downloading", trackedDownloadStatus: "ok", trackedDownloadState: "downloading",
});

test("the queue reads EVERY configured instance on its own URL, folds a Sonarr pack, names a failed instance, and attaches requesters per instance", async () => {
  requests = [
    { id: "a", mediaType: "MOVIE", tmdbId: 101, tvdbId: null, status: "APPROVED", arrInstance: "", user: { name: "Ana", email: "ana@x" } },
    { id: "b", mediaType: "MOVIE", tmdbId: 101, tvdbId: null, status: "APPROVED", arrInstance: "4k", user: { name: "Bo", email: "bo@x" } },
    { id: "c", mediaType: "TV", tmdbId: 999, tvdbId: 3000, status: "APPROVED", arrInstance: "", user: { name: null, email: "cy@x" } },
    { id: "d", mediaType: "MOVIE", tmdbId: 101, tvdbId: null, status: "DECLINED", arrInstance: "", user: { name: "Dee", email: "d@x" } },
  ];
  responder = (c) => {
    if (c.path !== "/api/v3/queue") return undefined;
    if (c.origin === RADARR) return json({ totalRecords: 1, records: [{ id: 1, movieId: 10, movie: { title: "Movie", tmdbId: 101 }, size: 2e9, sizeleft: 1e9, status: "downloading" }] });
    if (c.origin === RADARR_4K) return new Response("down", { status: 503 });
    if (c.origin === SONARR) return json({ totalRecords: 2, records: [sonarrPackRecord(21, 1), sonarrPackRecord(22, 2)] });
    return undefined;
  };
  const token = await mintSession();
  const res = await call(queueRoute.GET, token, "/admin/queue");
  assert.equal(res.status, 200);
  const body = await res.json() as { instances: Array<{ service: string; slug: string }>; errors: Array<{ service: string; instance: string }>; items: Array<{ service: string; instance: string; ids: number[]; requesters: string[] }> };
  assert.deepEqual(body.instances.map((i) => `${i.service}:${i.slug}`), ["radarr:", "radarr:4k", "sonarr:"]);
  assert.deepEqual(body.errors.map((e) => `${e.service}:${e.instance}`), ["radarr:4k"]);
  assert.deepEqual(body.items.map((i) => [i.service, i.instance, i.ids, i.requesters]), [
    ["radarr", "", [1], ["Ana"]],
    ["sonarr", "", [21, 22], ["cy@x"]],
  ]);
  for (const c of arrCalls()) {
    assert.equal(c.query.get("pageSize"), "250");
    assert.equal(c.query.get(c.origin === SONARR ? "includeSeries" : "includeMovie"), "true");
    // Downloads the arr can't match to a title are the ones that need an admin.
    assert.equal(c.query.get(c.origin === SONARR ? "includeUnknownSeriesItems" : "includeUnknownMovieItems"), "true");
  }
});

test("a down instance polled every 20s is logged ONCE — no per-poll [arr] error line underneath (guardrail 7b)", async () => {
  settings.set("feature.integration.sonarr", "false");
  invalidateFeatureFlagCache();
  responder = (c) => (c.path !== "/api/v3/queue" ? undefined : c.origin === RADARR_4K ? new Response("down", { status: 503 }) : json({ totalRecords: 0, records: [] }));
  forgetWarnOnChange("queue:radarr:4k"); // an earlier test logged the same outage
  const token = await mintSession();
  for (let i = 0; i < 3; i++) assert.equal((await call(queueRoute.GET, token, "/admin/queue")).status, 200);
  assert.deepEqual(errorLines.filter((l) => l.includes("/api/v3/queue")), [], "arrRequest's per-response line is suppressed for the polled read");
  assert.equal(warnLines.filter((l) => l.includes('[queue] radarr instance "4k"')).length, 1);
});

test("an integration switched off reads none of its instances", async () => {
  settings.set("feature.integration.radarr", "false");
  invalidateFeatureFlagCache();
  responder = (c) => (c.path === "/api/v3/queue" ? json({ totalRecords: 0, records: [] }) : undefined);
  const res = await call(queueRoute.GET, await mintSession(), "/admin/queue");
  const body = await res.json() as { instances: Array<{ service: string }> };
  assert.deepEqual(body.instances.map((i) => i.service), ["sonarr"]);
  assert.deepEqual([...new Set(arrCalls().map((c) => c.origin))], [SONARR]);
});

test("remove: ONE bulk DELETE on the row's own instance with every id and every flag explicit, audited after", async () => {
  responder = (c) => (c.method === "DELETE" && c.path === "/api/v3/queue/bulk" ? json({}) : undefined);
  const token = await mintSession();
  const res = await call(removeRoute.POST, token, "/admin/queue/remove", {
    method: "POST",
    body: { service: "radarr", instance: "4k", ids: [7, 8, 7], action: "blocklistSearch", removeFromClient: false },
  });
  assert.equal(res.status, 200);
  const sent = arrCalls();
  assert.equal(sent.length, 1);
  assert.equal(sent[0].origin, RADARR_4K);
  assert.deepEqual(sent[0].body, { ids: [7, 8] });
  assert.deepEqual(Object.fromEntries(sent[0].query), { removeFromClient: "false", blocklist: "true", skipRedownload: "false", changeCategory: "false" });
  await drain();
  assert.deepEqual(audits.map((a) => ({ ...a, details: typeof a.details === "string" ? JSON.parse(a.details) : a.details })), [{
    action: "ARR_QUEUE_REMOVE",
    target: "radarr:4k",
    details: { service: "radarr", instance: "4k", ids: [7, 8], action: "blocklistSearch", removeFromClient: false },
  }]);
});

test("a complete-series pack (thousands of per-episode records) is removed in ONE call", async () => {
  responder = (c) => (c.method === "DELETE" && c.path === "/api/v3/queue/bulk" ? json({}) : undefined);
  const ids = Array.from({ length: 1_200 }, (_, i) => i + 1);
  const res = await call(removeRoute.POST, await mintSession(), "/admin/queue/remove", { method: "POST", body: { service: "sonarr", ids, action: "blocklist" } });
  assert.equal(res.status, 200);
  assert.equal(arrCalls().length, 1);
  assert.equal((arrCalls()[0].body as { ids: number[] }).ids.length, 1_200);
});

test("remove refuses a bad body or an unconfigured slug before any upstream call; a vanished download is 409 and not audited", async () => {
  const token = await mintSession();
  for (const body of [
    { service: "radarr", ids: [], action: "remove" },
    { service: "radarr", ids: [0], action: "remove" },
    { service: "radarr", ids: [1], action: "nuke" },
    { service: "lidarr", ids: [1], action: "remove" },
    { service: "radarr", ids: [1], action: "remove", removeFromClient: "yes" },
  ]) {
    assert.equal((await call(removeRoute.POST, token, "/admin/queue/remove", { method: "POST", body })).status, 400, JSON.stringify(body));
  }
  assert.equal((await call(removeRoute.POST, token, "/admin/queue/remove", { method: "POST", body: { service: "radarr", instance: "anime", ids: [1], action: "remove" } })).status, 404);
  assert.deepEqual(arrCalls(), []);
  responder = (c) => (c.path === "/api/v3/queue/bulk" ? new Response("gone", { status: 404 }) : undefined);
  assert.equal((await call(removeRoute.POST, token, "/admin/queue/remove", { method: "POST", body: { service: "radarr", ids: [1], action: "remove" } })).status, 409);
  await drain();
  assert.deepEqual(audits, []);
});

// ── 2b: import a blocked download ────────────────────────────────────────────

const q = { quality: { id: 7, name: "Bluray-1080p" }, revision: { version: 1 } };
const manualRows = [
  { path: "/downloads/Movie/Movie.mkv", relativePath: "Movie.mkv", folderName: "Movie", size: 8e9, quality: q, languages: [{ id: 1, name: "English" }],
    movie: { id: 12, title: "Movie", year: 2024 }, rejections: [{ reason: "Not an upgrade for existing movie file" }] },
  { path: "/downloads/Movie/sample.mkv", relativePath: "sample.mkv", size: 5e7, quality: q, movie: null, rejections: [{ reason: "Sample" }] },
];

test("import listing: the instance's own manualimport for that download id, shaped for the dialog", async () => {
  responder = (c) => (c.path === "/api/v3/manualimport" ? json(manualRows) : undefined);
  const res = await call(importRoute.GET, await mintSession(), "/admin/queue/import?service=radarr&instance=4k&downloadId=SABnzbd_nzo_1%2B2");
  assert.equal(res.status, 200);
  const body = await res.json() as { files: Array<{ name: string; importable: boolean; rejections: string[] }> };
  assert.deepEqual(body.files.map((f) => [f.name, f.importable, f.rejections]), [
    ["Movie.mkv", true, ["Not an upgrade for existing movie file"]],
    ["sample.mkv", false, ["Sample"]],
  ]);
  assert.equal(arrCalls()[0].origin, RADARR_4K);
  assert.equal(arrCalls()[0].query.get("downloadId"), "SABnzbd_nzo_1+2");
});

test("import: the command carries ONLY the arr's own matched rows — an injected path never reaches it (guardrail 5d) — and is audited without paths", async () => {
  responder = (c) => {
    if (c.path === "/api/v3/manualimport") return json(manualRows);
    if (c.method === "POST" && c.path === "/api/v3/command") return json({ id: 1, name: "ManualImport" }, 201);
    return undefined;
  };
  const res = await call(importRoute.POST, await mintSession(), "/admin/queue/import", {
    method: "POST",
    body: { service: "radarr", instance: "", downloadId: "SAB_1", paths: ["/downloads/Movie/Movie.mkv", "/downloads/Movie/sample.mkv", "/etc/shadow"], importMode: "copy" },
  });
  assert.equal(res.status, 202);
  assert.deepEqual(await res.json(), { files: 1 });
  const command = arrCalls().find((c) => c.method === "POST")!;
  assert.equal(command.origin, RADARR);
  assert.deepEqual(command.body, {
    name: "ManualImport",
    importMode: "copy",
    files: [{ path: "/downloads/Movie/Movie.mkv", folderName: "Movie", quality: q, languages: [{ id: 1, name: "English" }], indexerFlags: 0, downloadId: "SAB_1", movieId: 12 }],
  });
  assert.ok(!JSON.stringify(command.body).includes("/etc/shadow"));
  await drain();
  assert.equal(audits.length, 1);
  assert.equal(audits[0].action, "ARR_QUEUE_IMPORT");
  assert.deepEqual(JSON.parse(String(audits[0].details)), { service: "radarr", instance: "", downloadId: "SAB_1", files: 1, importMode: "copy" });
});

test("import: nothing importable among the chosen paths is 409 and sends no command; bad input is 400 before any upstream call", async () => {
  responder = (c) => (c.path === "/api/v3/manualimport" ? json(manualRows) : undefined);
  const token = await mintSession();
  const res = await call(importRoute.POST, token, "/admin/queue/import", {
    method: "POST",
    body: { service: "radarr", downloadId: "SAB_1", paths: ["/downloads/Movie/sample.mkv", "/etc/shadow"] },
  });
  assert.equal(res.status, 409);
  assert.equal(arrCalls().filter((c) => c.method === "POST").length, 0);
  calls = [];
  for (const body of [
    { service: "radarr", downloadId: "has space", paths: ["/a"] },
    { service: "radarr", downloadId: "SAB_1", paths: [] },
    { service: "radarr", downloadId: "SAB_1", paths: ["/a"], importMode: "hardlink" },
    { service: "radarr", downloadId: "SAB_1", paths: [5] },
  ]) {
    assert.equal((await call(importRoute.POST, token, "/admin/queue/import", { method: "POST", body })).status, 400, JSON.stringify(body));
  }
  assert.equal((await call(importRoute.GET, token, "/admin/queue/import?service=radarr&instance=anime&downloadId=x")).status, 404);
  assert.deepEqual(arrCalls(), []);
  await drain();
  assert.deepEqual(audits, []);
});

// ── 3: health + webhook ──────────────────────────────────────────────────────

const radarrHook = (token: string, over: Record<string, unknown> = {}) => ({
  id: 12, name: "My Summonarr", implementation: "Webhook", tags: [4],
  fields: [{ name: "url", value: `http://summonarr:3000/api/webhooks/radarr?token=${token}` }, { name: "method", value: 1 }],
  onDownload: true, onUpgrade: true, onMovieDelete: true, onMovieFileDelete: true, onHealthIssue: true, onHealthRestored: true, onManualInteractionRequired: true,
  onGrab: true,
  ...over,
});

test("health: version, Radarr/Sonarr's own checks and the webhook verdict per instance — and never the token", async () => {
  responder = (c) => {
    if (c.path === "/api/v3/system/status") return c.origin === RADARR_4K ? new Response("x", { status: 500 }) : json({ version: c.origin === RADARR ? "5.20.1" : "4.0.15" });
    if (c.path === "/api/v3/health") return json(c.origin === SONARR ? [{ source: "IndexerStatusCheck", type: "warning", message: "Indexers unavailable", wikiUrl: "https://wiki.servarr.com/x" }] : []);
    if (c.path === "/api/v3/notification") return json(c.origin === RADARR ? [radarrHook(RADARR_SECRET)] : []);
    return undefined;
  };
  const res = await call(healthRoute.GET, await mintSession(), "/admin/arr-health");
  const text = await res.text();
  assert.equal(res.status, 200);
  assert.ok(!text.includes(RADARR_SECRET), "the webhook token must never reach the browser");
  const body = JSON.parse(text) as { webhookBase: string; instances: Array<{ service: string; slug: string; reachable: boolean; version: string | null; checks: Array<{ level: string }>; webhook: { state: string } }> };
  assert.equal(body.webhookBase, "http://localhost:3000");
  assert.deepEqual(body.instances.map((i) => [`${i.service}:${i.slug}`, i.reachable, i.version, i.checks.map((c) => c.level), i.webhook.state]), [
    ["radarr:", true, "5.20.1", [], "ok"],
    ["radarr:4k", false, null, [], "unknown"],
    ["sonarr:", true, "4.0.15", ["warning"], "missing"],
  ]);
});

test("webhook setup with no hook yet: built from the instance's schema, token in ?token=, Summonarr's events on — audited without the token", async () => {
  responder = (c) => {
    if (c.method === "GET" && c.path === "/api/v3/notification") return json([]);
    if (c.path === "/api/v3/notification/schema") {
      return json([
        { implementation: "Discord", fields: [] },
        { implementation: "Webhook", configContract: "WebhookSettings", fields: [{ name: "url", value: "" }, { name: "method", value: 1 }], onGrab: false, onDownload: false, onUpgrade: false, onMovieDelete: false, onMovieFileDelete: false, onHealthIssue: false, onHealthRestored: false, onManualInteractionRequired: false, tags: [] },
      ]);
    }
    if (c.method === "POST" && c.path === "/api/v3/notification") return json({ id: 1 }, 201);
    return undefined;
  };
  const res = await call(webhookRoute.POST, await mintSession(), "/admin/arr-health/webhook", {
    method: "POST",
    body: { service: "radarr", instance: "", baseUrl: "http://summonarr:3000/" },
  });
  assert.deepEqual(await res.json(), { outcome: "created", secretGenerated: false });
  const created = arrCalls().find((c) => c.method === "POST")!;
  assert.equal(created.origin, RADARR);
  const b = created.body as Record<string, unknown> & { fields: Array<{ name: string; value: unknown }> };
  assert.equal(b.fields.find((f) => f.name === "url")!.value, `http://summonarr:3000/api/webhooks/radarr?token=${RADARR_SECRET}`);
  assert.equal(b.name, "Summonarr");
  assert.equal(b.onDownload, true);
  assert.equal(b.onManualInteractionRequired, true);
  assert.equal(b.onGrab, false);
  await drain();
  assert.equal(audits.length, 1);
  assert.equal(audits[0].action, "SETTINGS_CHANGE");
  assert.ok(!JSON.stringify(audits[0]).includes(RADARR_SECRET), "the audit row records the base, never the token");
  assert.match(JSON.stringify(audits[0].details), /http:\/\/summonarr:3000/);
});

test("webhook setup repairs an existing hook IN PLACE (PUT), keeping the admin's name, tags and extra events", async () => {
  responder = (c) => {
    if (c.method === "GET" && c.path === "/api/v3/notification") return json([radarrHook("rotated-away")]);
    if (c.method === "PUT" && c.path === "/api/v3/notification/12") return json({ id: 12 });
    return undefined;
  };
  const res = await call(webhookRoute.POST, await mintSession(), "/admin/arr-health/webhook", {
    method: "POST",
    body: { service: "radarr", instance: "", baseUrl: "http://summonarr:3000" },
  });
  assert.deepEqual(await res.json(), { outcome: "updated", secretGenerated: false });
  const put = arrCalls().find((c) => c.method === "PUT")!;
  const b = put.body as Record<string, unknown> & { fields: Array<{ name: string; value: unknown }> };
  assert.equal(b.name, "My Summonarr");
  assert.deepEqual(b.tags, [4]);
  assert.equal(b.onGrab, true);
  assert.equal(b.fields.find((f) => f.name === "url")!.value, `http://summonarr:3000/api/webhooks/radarr?token=${RADARR_SECRET}`);
  assert.equal(arrCalls().filter((c) => c.method === "POST").length, 0, "never a second hook");
});

test("webhook setup on an instance with no secret generates one, stores it, and sends it", async () => {
  responder = (c) => {
    if (c.method === "GET" && c.path === "/api/v3/notification") return json([]);
    if (c.path === "/api/v3/notification/schema") return json([{ implementation: "Webhook", fields: [{ name: "url", value: "" }] }]);
    if (c.method === "POST" && c.path === "/api/v3/notification") return json({ id: 2 }, 201);
    return undefined;
  };
  const res = await call(webhookRoute.POST, await mintSession(), "/admin/arr-health/webhook", {
    method: "POST",
    body: { service: "radarr", instance: "4k", baseUrl: "http://summonarr:3000" },
  });
  assert.deepEqual(await res.json(), { outcome: "created", secretGenerated: true });
  assert.equal(settingUpserts.length, 1);
  assert.equal(settingUpserts[0].key, "radarr4kWebhookSecret");
  assert.match(settingUpserts[0].value, /^[0-9a-f]{48}$/);
  const created = arrCalls().find((c) => c.method === "POST")!;
  assert.equal(created.origin, RADARR_4K);
  const url = (created.body as { fields: Array<{ name: string; value: string }> }).fields[0].value;
  assert.equal(new URL(url).searchParams.get("token"), settingUpserts[0].value);
  await drain();
  assert.deepEqual(audits.map((a) => JSON.parse(String(a.details))), [
    { service: "radarr", instance: "4k", secretGenerated: true },
    { service: "radarr", instance: "4k", outcome: "created", baseUrl: "http://summonarr:3000" },
  ]);
});

test("a generated secret is audited even when Radarr then REFUSES the webhook", async () => {
  responder = (c) => {
    if (c.method === "GET" && c.path === "/api/v3/notification") return json([]);
    if (c.path === "/api/v3/notification/schema") return json([{ implementation: "Webhook", fields: [{ name: "url", value: "" }] }]);
    if (c.method === "POST") return json([{ errorMessage: "Unable to send test message" }], 400);
    return undefined;
  };
  const res = await call(webhookRoute.POST, await mintSession(), "/admin/arr-health/webhook", { method: "POST", body: { service: "radarr", instance: "4k", baseUrl: "http://x" } });
  assert.equal(res.status, 422);
  await drain();
  assert.deepEqual(audits.map((a) => JSON.parse(String(a.details))), [{ service: "radarr", instance: "4k", secretGenerated: true }]);
});

test("two setups racing on a secret-less instance end on ONE secret — the loser uses the winner's, never overwrites it", async () => {
  responder = (c) => {
    if (c.method === "GET" && c.path === "/api/v3/notification") return json([]);
    if (c.path === "/api/v3/notification/schema") return json([{ implementation: "Webhook", fields: [{ name: "url", value: "" }] }]);
    if (c.method === "POST" && c.path === "/api/v3/notification") return json({ id: 2 }, 201);
    return undefined;
  };
  // The other setup's create lands between this one's read and its create.
  beforeCreateMany = () => { settings.set("radarr4kWebhookSecret", "winner-secret"); beforeCreateMany = null; };
  const res = await call(webhookRoute.POST, await mintSession(), "/admin/arr-health/webhook", { method: "POST", body: { service: "radarr", instance: "4k", baseUrl: "http://x" } });
  assert.deepEqual(await res.json(), { outcome: "created", secretGenerated: false });
  assert.equal(settings.get("radarr4kWebhookSecret"), "winner-secret");
  const created = arrCalls().find((c) => c.method === "POST")!;
  assert.equal(new URL((created.body as { fields: Array<{ value: string }> }).fields[0].value).searchParams.get("token"), "winner-secret");
});

test("webhook setup: the arr's refusal comes back as 422 with its reason, the token masked", async () => {
  responder = (c) => {
    if (c.method === "GET" && c.path === "/api/v3/notification") return json([]);
    if (c.path === "/api/v3/notification/schema") return json([{ implementation: "Webhook", fields: [{ name: "url", value: "" }] }]);
    if (c.method === "POST") {
      return json([{ propertyName: "Url", errorMessage: `Unable to send test message: [POST] at [http://x/api/webhooks/radarr?token=${RADARR_SECRET}]` }], 400);
    }
    return undefined;
  };
  const res = await call(webhookRoute.POST, await mintSession(), "/admin/arr-health/webhook", { method: "POST", body: { service: "radarr", baseUrl: "http://x" } });
  assert.equal(res.status, 422);
  const text = await res.text();
  assert.ok(!text.includes(RADARR_SECRET), text);
  assert.match(JSON.parse(text).detail, /Unable to send test message/);
  await drain();
  assert.deepEqual(audits, [], "nothing was changed upstream");
});

test("webhook setup refuses a bad base address or an unconfigured slug before any upstream call", async () => {
  const token = await mintSession();
  for (const baseUrl of ["ftp://x", "http://u:p@x", "http://x/?a=1"]) {
    assert.equal((await call(webhookRoute.POST, token, "/admin/arr-health/webhook", { method: "POST", body: { service: "radarr", baseUrl } })).status, 400, baseUrl);
  }
  assert.equal((await call(webhookRoute.POST, token, "/admin/arr-health/webhook", { method: "POST", body: { service: "sonarr", instance: "anime", baseUrl: "http://x" } })).status, 404);
  assert.deepEqual(arrCalls(), []);
});

// ── 4: open in ───────────────────────────────────────────────────────────────

test("open: a Radarr library title redirects to the External URL's movie page; one not there opens Add New", async () => {
  let movies: unknown[] = [{ tmdbId: 603, titleSlug: "603" }];
  responder = (c) => (c.path === "/api/v3/movie" ? json(movies) : undefined);
  const token = await mintSession();
  let res = await call(openRoute.GET, token, "/admin/arr/open?service=radarr&instance=&tmdbId=603");
  assert.equal(res.status, 302);
  assert.equal(res.headers.get("location"), "https://radarr.example.com/movie/603");
  assert.equal(arrCalls()[0].origin, RADARR, "resolved against the instance's own API");
  movies = [];
  res = await call(openRoute.GET, token, "/admin/arr/open?service=radarr&instance=&tmdbId=603");
  assert.equal(res.headers.get("location"), "https://radarr.example.com/add/new?term=tmdb%3A603");
});

test("open: Sonarr uses its lookup (positive id = in library), arrId reads the series; no External URL falls back to the connection URL; a down arr still lands on its home", async () => {
  responder = (c) => {
    if (c.path === "/api/v3/series/lookup") return json([{ tmdbId: 1399, id: 0, titleSlug: "game-of-thrones" }]);
    if (c.path === "/api/v3/series/5") return json({ id: 5, titleSlug: "the-office-us" });
    return undefined;
  };
  const token = await mintSession();
  let res = await call(openRoute.GET, token, "/admin/arr/open?service=sonarr&instance=&tmdbId=1399");
  assert.equal(res.headers.get("location"), `${SONARR}/add/new?term=tmdb%3A1399`, "id 0 = not in the library");
  res = await call(openRoute.GET, token, "/admin/arr/open?service=sonarr&instance=&arrId=5");
  assert.equal(res.headers.get("location"), `${SONARR}/series/the-office-us`);
  responder = () => new Response("down", { status: 503 });
  res = await call(openRoute.GET, token, "/admin/arr/open?service=sonarr&instance=&arrId=5");
  assert.equal(res.headers.get("location"), `${SONARR}/`);
});

test("open: bad params are 400 and an unconfigured slug is 404 — neither reaches an arr", async () => {
  const token = await mintSession();
  for (const q of ["service=radarr&instance=&tmdbId=abc", "service=radarr&instance=&tmdbId=1&arrId=2", "service=lidarr&instance=&tmdbId=1", "service=radarr&instance="]) {
    assert.equal((await call(openRoute.GET, token, `/admin/arr/open?${q}`)).status, 400, q);
  }
  assert.equal((await call(openRoute.GET, token, "/admin/arr/open?service=radarr&instance=anime&tmdbId=1")).status, 404);
  assert.deepEqual(arrCalls(), []);
});

// ── 5: cutoff unmet ──────────────────────────────────────────────────────────

const profiles = [{ id: 1, name: "HD-1080p", cutoff: 7, items: [{ quality: { id: 7, name: "Bluray-1080p" } }] }];

test("cutoff listing: Radarr's /wanted/cutoff on every instance, monitored only, with the profile's cutoff named", async () => {
  responder = (c) => {
    if (c.path === "/api/v3/qualityprofile") return json(profiles);
    if (c.path === "/api/v3/wanted/cutoff" && c.origin === RADARR) {
      return json({ totalRecords: 2, records: [
        { id: 1, tmdbId: 11, title: "B", hasFile: true, qualityProfileId: 1, movieFile: { qualityCutoffNotMet: true, quality: { quality: { name: "WEBDL-1080p" } } } },
        { id: 2, tmdbId: 12, title: "A", hasFile: true, qualityProfileId: 1, movieFile: { qualityCutoffNotMet: false } },
      ] });
    }
    if (c.path === "/api/v3/wanted/cutoff" && c.origin === RADARR_4K) return json({ totalRecords: 0, records: [] });
    return undefined;
  };
  const res = await call(missingRoute.GET, await mintSession(), "/admin/missing?service=radarr&mode=cutoff");
  assert.equal(res.status, 200);
  const body = await res.json() as { items: Array<{ instance: string; arrId: number; quality: string; cutoff: string }> };
  assert.deepEqual(body.items.map((i) => [i.instance, i.arrId, i.quality, i.cutoff]), [["", 1, "WEBDL-1080p", "Bluray-1080p"]]);
  const cutoffCalls = arrCalls().filter((c) => c.path === "/api/v3/wanted/cutoff");
  assert.deepEqual(cutoffCalls.map((c) => c.origin).sort(), [RADARR, RADARR_4K].sort());
  assert.ok(cutoffCalls.every((c) => c.query.get("monitored") === "true"));
  assert.equal((await call(missingRoute.GET, await mintSession(), "/admin/missing?service=radarr&mode=upgrades")).status, 400);
});

test("cutoff listing for Sonarr groups the episode records per series", async () => {
  responder = (c) => {
    if (c.path === "/api/v3/qualityprofile") return json(profiles);
    if (c.path === "/api/v3/wanted/cutoff") {
      assert.equal(c.query.get("includeSeries"), "true");
      assert.equal(c.query.get("includeEpisodeFile"), "true");
      const ep = (id: number, e: number) => ({ id, seriesId: 4, seasonNumber: 1, episodeNumber: e, hasFile: true, episodeFile: { qualityCutoffNotMet: true }, series: { id: 4, title: "S", tmdbId: 40, qualityProfileId: 1 } });
      return json({ totalRecords: 2, records: [ep(2, 2), ep(1, 1)] });
    }
    return undefined;
  };
  const body = await (await call(missingRoute.GET, await mintSession(), "/admin/missing?service=sonarr&mode=cutoff")).json() as { items: Array<{ arrId: number; episodes: Array<{ episodeNumber: number }> }> };
  assert.deepEqual(body.items.map((i) => [i.arrId, i.episodes.map((e) => e.episodeNumber)]), [[4, [1, 2]]]);
});

test("cutoff Search re-judges LIVE: Radarr MoviesSearch only while its file is below cutoff, else 409 with nothing queued", async () => {
  let movie: Record<string, unknown> = { id: 1, hasFile: true, monitored: true, movieFile: { qualityCutoffNotMet: true } };
  responder = (c) => {
    if (c.path === "/api/v3/movie/1") return json(movie);
    if (c.method === "POST" && c.path === "/api/v3/command") return json({ id: 1 }, 201);
    return undefined;
  };
  const token = await mintSession();
  let res = await call(missingSearchRoute.POST, token, "/admin/missing/search", { method: "POST", body: { service: "radarr", instance: "", arrId: 1, mode: "cutoff" } });
  assert.equal(res.status, 202);
  assert.deepEqual(arrCalls().filter((c) => c.method === "POST").map((c) => c.body), [{ name: "MoviesSearch", movieIds: [1] }]);
  calls = [];
  movie = { ...movie, movieFile: { qualityCutoffNotMet: false } };
  res = await call(missingSearchRoute.POST, token, "/admin/missing/search", { method: "POST", body: { service: "radarr", instance: "", arrId: 1, mode: "cutoff" } });
  assert.equal(res.status, 409);
  assert.equal(arrCalls().filter((c) => c.method === "POST").length, 0);
});

test("cutoff Search for a series: ONE EpisodeSearch for the monitored episodes whose file is below cutoff — never SeasonSearch/SeriesSearch", async () => {
  responder = (c) => {
    if (c.path === "/api/v3/episode") {
      return json([
        { id: 1, episodeFileId: 11, hasFile: true, monitored: true },
        { id: 2, episodeFileId: 12, hasFile: true, monitored: true },
        { id: 3, episodeFileId: 13, hasFile: true, monitored: false },
      ]);
    }
    if (c.path === "/api/v3/episodefile") return json([{ id: 11, qualityCutoffNotMet: true }, { id: 12, qualityCutoffNotMet: false }, { id: 13, qualityCutoffNotMet: true }]);
    if (c.method === "POST" && c.path === "/api/v3/command") return json({ id: 1 }, 201);
    return undefined;
  };
  const res = await call(missingSearchRoute.POST, await mintSession(), "/admin/missing/search", { method: "POST", body: { service: "sonarr", instance: "", arrId: 9, mode: "cutoff" } });
  assert.equal(res.status, 202);
  assert.deepEqual(await res.json(), { commands: 1, seasons: [], episodes: 1 });
  assert.deepEqual(arrCalls().filter((c) => c.method === "POST").map((c) => c.body), [{ name: "EpisodeSearch", episodeIds: [1] }]);
  assert.ok(arrCalls().every((c) => c.query.get("seriesId") === null || c.query.get("seriesId") === "9"));
});

// ── 6: request releases ──────────────────────────────────────────────────────

let releaseSeq = 0;
const release = (guid: string, extra: Record<string, unknown> = {}) => ({
  guid, title: `Some.Release.${++releaseSeq}.1080p`, size: 1e9, indexerId: 3, indexer: "NZBgeek", qualityWeight: 10, protocol: "usenet",
  quality: { quality: { id: 7, name: "Bluray-1080p" }, revision: { version: 1 } }, age: 2, rejected: false, rejections: [], downloadAllowed: true,
  downloadUrl: "https://indexer.example/get?apikey=SECRET-KEY", infoUrl: "https://indexer.example/i", ...extra,
});

test("movie releases: the request's own instance, projected — no download URL, and the guid (which can carry the apikey) replaced by an opaque handle", async () => {
  requests = [{ id: "r1", mediaType: "MOVIE", tmdbId: 603, tvdbId: null, status: "APPROVED", arrInstance: "4k", user: { name: "A", email: "a@x" } }];
  responder = (c) => {
    if (c.path === "/api/v3/movie") return json([{ id: 44, tmdbId: 603 }]);
    if (c.path === "/api/v3/release") return json([release("https://prowlarr.local/1/download?apikey=SECRET-KEY&file=x")]);
    return undefined;
  };
  const res = await call(releasesRoute.GET, await mintSession(), "/requests/r1/releases", { ctx: idCtx("r1") });
  const text = await res.text();
  assert.equal(res.status, 200);
  assert.ok(!text.includes("SECRET-KEY") && !text.includes("downloadUrl") && !text.includes("prowlarr.local"), text);
  assert.match((JSON.parse(text) as { releases: Array<{ guid: string }> }).releases[0].guid, /^[0-9a-f]{32}$/);
  assert.ok(arrCalls().every((c) => c.origin === RADARR_4K));
  assert.equal(arrCalls().find((c) => c.path === "/api/v3/release")!.query.get("movieId"), "44");
});

test("TV releases: no season ⇒ the season list only (no indexer hit); a season ⇒ a SEASON search, never the series-only RSS query", async () => {
  requests = [{ id: "r2", mediaType: "TV", tmdbId: 1399, tvdbId: 121361, status: "APPROVED", arrInstance: "", user: { name: "A", email: "a@x" } }];
  responder = (c) => {
    if (c.path === "/api/v3/series") {
      return json([{ id: 8, tvdbId: 121361, seasons: [
        { seasonNumber: 0, statistics: { episodeCount: 3, episodeFileCount: 0 } },
        { seasonNumber: 1, monitored: true, statistics: { episodeCount: 10, episodeFileCount: 10 } },
        { seasonNumber: 2, monitored: true, statistics: { episodeCount: 10, episodeFileCount: 4 } },
      ] }]);
    }
    if (c.path === "/api/v3/release") return json([release("g2")]);
    return undefined;
  };
  const token = await mintSession();
  const seasons = await (await call(releasesRoute.GET, token, "/requests/r2/releases", { ctx: idCtx("r2") })).json();
  assert.deepEqual(seasons, { seasons: [
    { seasonNumber: 1, aired: 10, missing: 0, monitored: true },
    { seasonNumber: 2, aired: 10, missing: 6, monitored: true },
  ] });
  assert.equal(arrCalls().filter((c) => c.path === "/api/v3/release").length, 0);
  const res = await call(releasesRoute.GET, token, "/requests/r2/releases?season=2", { ctx: idCtx("r2") });
  assert.equal(res.status, 200);
  const search = arrCalls().filter((c) => c.path === "/api/v3/release");
  assert.equal(search.length, 1);
  assert.deepEqual([search[0].query.get("seriesId"), search[0].query.get("seasonNumber")], ["8", "2"]);
  assert.equal((await call(releasesRoute.GET, token, "/requests/r2/releases?season=x", { ctx: idCtx("r2") })).status, 400);
});

test("grab: redeems the handle into the real guid on the request's instance and audits it WITHOUT the guid; a pending request or one not in Radarr is 409", async () => {
  requests = [
    { id: "r1", mediaType: "MOVIE", tmdbId: 603, tvdbId: null, status: "APPROVED", arrInstance: "", user: { name: "A", email: "a@x" } },
    { id: "r3", mediaType: "MOVIE", tmdbId: 604, tvdbId: null, status: "PENDING", arrInstance: "", user: { name: "A", email: "a@x" } },
    { id: "r4", mediaType: "MOVIE", tmdbId: 605, tvdbId: null, status: "APPROVED", arrInstance: "", user: { name: "A", email: "a@x" } },
  ];
  const guid = "https://indexer.example/get?apikey=SECRET-KEY&id=1";
  responder = (c) => {
    if (c.method === "GET" && c.path === "/api/v3/movie") return json(c.query.get("tmdbId") === "603" ? [{ id: 44, tmdbId: 603 }] : []);
    if (c.method === "GET" && c.path === "/api/v3/release") return json([release(guid)]);
    if (c.method === "POST" && c.path === "/api/v3/release") return json({});
    return undefined;
  };
  const token = await mintSession();
  const listed = await (await call(releasesRoute.GET, token, "/requests/r1/releases", { ctx: idCtx("r1") })).json() as { releases: Array<{ guid: string }> };
  const handle = listed.releases[0].guid;
  calls = [];
  const res = await call(releasesRoute.POST, token, "/requests/r1/releases", { method: "POST", body: { release: handle }, ctx: idCtx("r1") });
  assert.equal(res.status, 200);
  assert.deepEqual(arrCalls().find((c) => c.method === "POST")!.body, { guid, indexerId: 3, movieId: 44 });
  await drain();
  assert.equal(audits.length, 1);
  assert.equal(audits[0].action, "ARR_RELEASE_GRAB");
  assert.equal(audits[0].target, "request:r1");
  assert.ok(!JSON.stringify(audits[0]).includes("SECRET-KEY"), "the guid can carry an indexer apikey");

  calls = [];
  assert.equal((await call(releasesRoute.POST, token, "/requests/r3/releases", { method: "POST", body: { release: handle }, ctx: idCtx("r3") })).status, 409);
  assert.deepEqual(arrCalls(), [], "a pending request never reaches Radarr");
  // A handle is bound to the search it came from: r1's handle is no good for r4.
  assert.equal((await call(releasesRoute.POST, token, "/requests/r4/releases", { method: "POST", body: { release: handle }, ctx: idCtx("r4") })).status, 410);
  assert.equal((await call(releasesRoute.POST, token, "/requests/r1/releases", { method: "POST", body: { release: "f".repeat(32) }, ctx: idCtx("r1") })).status, 410);
  assert.equal((await call(releasesRoute.POST, token, "/requests/r1/releases", { method: "POST", body: { guid, indexerId: 3 }, ctx: idCtx("r1") })).status, 400, "a raw guid is not accepted");
  assert.equal(arrCalls().filter((c) => c.method === "POST").length, 0);
});

test("a TV handle is good only for the season it was searched for", async () => {
  requests = [{ id: "r2", mediaType: "TV", tmdbId: 1399, tvdbId: 121361, status: "APPROVED", arrInstance: "", user: { name: "A", email: "a@x" } }];
  responder = (c) => {
    if (c.path === "/api/v3/series") return json([{ id: 8, tvdbId: 121361, seasons: [] }]);
    if (c.method === "GET" && c.path === "/api/v3/release") return json([release("g-s2")]);
    if (c.method === "POST" && c.path === "/api/v3/release") return json({});
    return undefined;
  };
  const token = await mintSession();
  const listed = await (await call(releasesRoute.GET, token, "/requests/r2/releases?season=2", { ctx: idCtx("r2") })).json() as { releases: Array<{ guid: string }> };
  const handle = listed.releases[0].guid;
  assert.equal((await call(releasesRoute.POST, token, "/requests/r2/releases", { method: "POST", body: { release: handle, season: 3 }, ctx: idCtx("r2") })).status, 410);
  const ok = await call(releasesRoute.POST, token, "/requests/r2/releases", { method: "POST", body: { release: handle, season: 2 }, ctx: idCtx("r2") });
  assert.equal(ok.status, 200);
  assert.deepEqual(arrCalls().find((c) => c.method === "POST")!.body, { guid: "g-s2", indexerId: 3, seriesId: 8 });
});
