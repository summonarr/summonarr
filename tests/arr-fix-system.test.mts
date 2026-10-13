// Admin → Arr System (and the polling it shares with the Download Queue):
// the fixes from the arr-system review, pinned.
//   /api/admin/arr/{tasks,providers,providers/test,storage} + src/lib/arr-system.ts
//
// What is pinned:
//   1. A poll tick never supersedes a load in flight; a manual load does
//      (createLoadGate). Without it a dark instance — slower than the poll —
//      left the report empty and the spinner on forever.
//   2. Queued and running commands are never cut off the list; only finished
//      ones are capped (a long library search must keep its Run button off).
//   3. Radarr's library-wide searches carry no `monitored` field (Radarr has
//      none); Sonarr's carry `monitored: true`.
//   4. A cancel that loses the race with the command starting (the arr's 409,
//      or 400) is "no longer queued", not the arr's raw refusal.
//   5. No /api/v3/indexerstatus call (neither arr has one); tags are named
//      from one /api/v3/tag read, and that read failing fails nothing; an
//      indexer Prowlarr manages is flagged from its name alone.
//   6. forceSave only on a change that turns things OFF — a mixed ON+OFF
//      change and every ON are tested by the arr; download clients alike.
//   7. A switch-ON refused for WARNINGS alone is 409 { warningsOnly }, masked,
//      not audited; `acceptWarnings` re-runs the arr's own test server-side and
//      saves with forceSave only when nothing but warnings remain.
//   8. Testing and testing saves wait 120 s; the Tasks tab's polled reads 10 s.
//      A testing save that times out is read back: saved → 200 audited, not
//      saved → 504 with the provider, not audited.
//   9. Warnings-only test results read as "working, with warnings"; Test All
//      and single tests are rate-limited separately. A System.Text.Json arr's
//      Test All flags no failure either way (C089 — the source facts are in
//      tests/audit-fix4-test-all.test.mts): those rows reach the page as
//      `uncertain`, never failed.
//  10. A "********" secret the arr sent is sent back to it unchanged in both
//      the save and the test body (the secret-preservation contract).
//  11. Root folders take their total size from the disk that holds them.
//  12. Tests and saves run as BACKGROUND JOBS for `async: true` (a 120 s wait
//      outlives what a reverse proxy holds a request — the 37a lesson): 202
//      { job }, polled at `?job=`, answering exactly what the synchronous route
//      would; the same call while one runs is joined (no second test, no rate
//      token); another admin's poll and a lost job are 404 with the PROVIDER
//      message. A background save that timed out is re-read until the arr
//      holds the change — saved within the window → 200 AND audited; never →
//      504, not audited. Without `async` the request still waits (one read-back).
//  13. Both polled pages tick through the load gate as a POLL, and the queue's
//      poll pauses while its title manager is open.
//
// Harness: the same as tests/arr-manage-routes.test.mts (in-memory prisma,
// scripted Radarr/Sonarr behind a fetch stub, a synthetic request scope).
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import dns from "node:dns/promises";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { AsyncLocalStorage } from "node:async_hooks";

(globalThis as { AsyncLocalStorage?: unknown }).AsyncLocalStorage = AsyncLocalStorage;

process.env.TOKEN_ENCRYPTION_KEY = "ab".repeat(32);
process.env.NEXTAUTH_SECRET = "arr-fix-system-test-secret-0123456789abcdef";
process.env.AUTH_URL = "http://localhost:3000";
process.env.TRUST_PROXY = "true";
delete process.env.TMDB_READ_TOKEN;
(process.env as Record<string, string | undefined>).NODE_ENV = "test";

const fakeLookup = async () => [{ address: "10.0.0.250", family: 4 }];
(dns as { lookup: unknown }).lookup = fakeLookup;
if ((dns as { lookup: unknown }).lookup !== fakeLookup) throw new Error("could not stub dns.lookup");

console.warn = () => {};
console.error = () => {};

// Every request's timeout, read off the AbortSignal.timeout safeFetch builds for it.
const timeoutOf = new WeakMap<AbortSignal, number>();
const realTimeout = AbortSignal.timeout.bind(AbortSignal);
AbortSignal.timeout = (ms: number) => {
  const s = realTimeout(ms);
  timeoutOf.set(s, ms);
  return s;
};

// ── scripted Radarr/Sonarr ───────────────────────────────────────────────────
const RADARR = "http://10.0.0.5:7878";
const SONARR = "http://10.0.0.7:8989";
const SECRET = "c0ffee0123456789c0ffee0123456789";
type Call = { origin: string; method: string; path: string; query: URLSearchParams; body: unknown; timeoutMs: number | undefined };
let calls: Call[] = [];
type Responder = (c: Call) => Response | undefined | Promise<Response | undefined>;
let responder: Responder = () => undefined;
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const timedOut = () => {
  const e = new Error("The operation was aborted due to timeout");
  e.name = "TimeoutError";
  return e;
};

globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
  const url = new URL(String(input));
  const method = init?.method ?? "GET";
  let body: unknown;
  if (typeof init?.body === "string" && init.body !== "") {
    try { body = JSON.parse(init.body); } catch { body = init.body; }
  }
  const call: Call = {
    origin: url.origin, method, path: url.pathname, query: url.searchParams, body,
    timeoutMs: init?.signal ? timeoutOf.get(init.signal) : undefined,
  };
  calls.push(call);
  const res = await responder(call);
  if (res instanceof Error) throw res;
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
const { _setProviderSettlePauseForTests, PROVIDER_SETTLE_READS } = await import("../src/lib/arr-system-data.ts");
const { _resetReleaseSearchJobsForTests } = await import("../src/lib/release-search-jobs.ts");
const {
  bulkActionCommand, createLoadGate, diskFor, MAX_COMMANDS, MAX_UNMAPPED, projectCommands, projectFailures, projectIndexers,
  projectRootFolders, projectTestAll, taskRisk, testResultOf,
} = await import("../src/lib/arr-system.ts");

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
async function mintSession(): Promise<string> {
  sessionSeq++;
  const userId = `user-${sessionSeq}`;
  const sessionId = `sess-${sessionSeq}`;
  const permissions = Permission.ADMIN.toString();
  usersById.set(userId, {
    role: "ADMIN", permissions: BigInt(permissions), mediaServer: null, sessionsRevokedAt: null,
    passwordChangedAt: null, deactivatedAt: null, email: `u${sessionSeq}@example.com`, notificationEmail: null,
  });
  sessionRows.add(sessionId);
  const iat = Math.floor(Date.now() / 1000);
  return signSessionJwt(
    { id: userId, role: "ADMIN", permissions, provider: "credentials", sessionId, expiresAt: iat + 86_400 },
    { expiresInSeconds: 7_200, iat },
  );
}
const COOKIE = getSessionCookieName();

// ── data stubs ───────────────────────────────────────────────────────────────
const settings = new Map<string, string>();
shadowPrismaModel(prisma, "setting", {
  findMany: async (args?: { where?: { key?: { in?: string[] } } }) => {
    const keys = args?.where?.key?.in;
    return [...settings.entries()].filter(([k]) => !keys || keys.includes(k)).map(([key, value]) => ({ key, value }));
  },
  findUnique: async (args: { where: { key: string } }) => {
    const v = settings.get(args.where.key);
    return v === undefined ? null : { key: args.where.key, value: v };
  },
  upsert: async () => ({}),
});
const audits: Array<{ action: string; target: string | null; details: unknown }> = [];
shadowPrismaModel(prisma, "auditLog", {
  create: async (args: { data: { action: string; target?: string | null; details?: unknown } }) => {
    audits.push({ action: args.data.action, target: args.data.target ?? null, details: args.data.details });
    return {};
  },
});

const tasksRoute = await import("../src/app/api/admin/arr/tasks/route.ts");
const providersRoute = await import("../src/app/api/admin/arr/providers/route.ts");
const testRoute = await import("../src/app/api/admin/arr/providers/test/route.ts");
const storageRoute = await import("../src/app/api/admin/arr/storage/route.ts");

function inScope<T>(fn: () => Promise<T>): Promise<T> {
  const workStore = { route: "/arr-fix-system.test", forceStatic: false, dynamicShouldError: false, afterContext: { after: () => {} } };
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
const call = (handler: unknown, token: string, path: string, init: { method?: string; body?: unknown } = {}) =>
  inScope(() => (handler as Handler)(
    new NextRequest(`http://localhost:3000/api${path}`, {
      method: init.method ?? "GET",
      headers: { cookie: `${COOKIE}=${token}`, ...(init.body !== undefined ? { "content-type": "application/json" } : {}) },
      ...(init.body !== undefined ? { body: JSON.stringify(init.body) } : {}),
    }),
    undefined,
  ));
const arrCalls = () => calls.filter((c) => c.origin !== "http://localhost:3000");
const writes = () => arrCalls().filter((c) => c.method !== "GET");
const patch = (token: string, body: Record<string, unknown>) =>
  call(providersRoute.PATCH, token, "/admin/arr/providers", { method: "PATCH", body: { service: "radarr", ...body } });
const testProvider = (token: string, body: Record<string, unknown>) =>
  call(testRoute.POST, token, "/admin/arr/providers/test", { method: "POST", body: { service: "radarr", ...body } });

// ── fixtures ─────────────────────────────────────────────────────────────────
// The arr hands back a stored secret as "********" and keeps it when that same
// placeholder comes back in a save or a test.
const INDEXER = {
  id: 3, name: "NZBgeek", implementationName: "Newznab", protocol: "usenet", priority: 25,
  enableRss: true, enableAutomaticSearch: false, enableInteractiveSearch: true, tags: [2],
  fields: [{ name: "baseUrl", value: "https://api.nzbgeek.info" }, { name: "apiKey", value: "********" }],
};
const CLIENT = {
  id: 1, name: "SAB", implementationName: "SABnzbd", protocol: "usenet", priority: 1, enable: false,
  removeCompletedDownloads: false, removeFailedDownloads: true, tags: [],
  fields: [{ name: "password", value: "********" }],
};
// A /test or save 400's failure as the arr writes it (its runtime type,
// NzbDroneValidationFailure): `severity` is "error" on warnings too —
// FluentValidation's default, which neither arr ever changes.
const warning = (msg: string) => ({ isWarning: true, propertyName: "", errorMessage: msg, severity: "error" });
const failure = (msg: string) => ({ isWarning: false, propertyName: "BaseUrl", errorMessage: msg, severity: "error" });

beforeEach(() => {
  calls = [];
  audits.length = 0;
  responder = () => undefined;
  settings.clear();
  for (const [k, v] of Object.entries({ radarrUrl: RADARR, radarrApiKey: "radarr-key", sonarrUrl: SONARR, sonarrApiKey: "sonarr-key" })) settings.set(k, v);
  invalidateFeatureFlagCache();
});

// ── 1: polling ───────────────────────────────────────────────────────────────

test("a poll tick never supersedes a load in flight; a manual load does, and only the newest writes", () => {
  const gate = createLoadGate();
  const first = gate.begin("poll");
  assert.equal(first, 1);
  assert.equal(gate.begin("poll"), null, "a tick while the slow load is out is skipped, not stacked");
  assert.equal(gate.begin("poll"), null);
  assert.equal(gate.settle(first!), true, "the slow load finally lands and may write");
  assert.notEqual(gate.begin("poll"), null, "the next tick runs once nothing is out");

  const g2 = createLoadGate();
  const slow = g2.begin("poll")!;
  const manual = g2.begin("manual");
  assert.ok(manual !== null && manual !== slow, "Reload starts at once, over the in-flight poll");
  assert.equal(g2.begin("poll"), null, "and polls still wait for it");
  assert.equal(g2.settle(slow), false, "the superseded load may not write");
  assert.equal(g2.begin("poll"), null, "nor does it free the gate");
  assert.equal(g2.settle(manual), true);
  assert.notEqual(g2.begin("poll"), null);
});

// ── 2: commands ──────────────────────────────────────────────────────────────

test("queued and running commands are always listed; only finished ones are capped", () => {
  const finished = Array.from({ length: MAX_COMMANDS + 10 }, (_, i) => ({
    id: 100 + i, name: "RssSync", commandName: "Rss Sync", status: "completed",
    started: new Date(Date.UTC(2026, 9, 10, 12, i)).toISOString(),
  }));
  // Started an hour before every finished one: by start time it sorts last.
  const search = { id: 7, name: "MissingMoviesSearch", commandName: "Missing Movies Search", status: "started", started: "2026-10-10T11:00:00Z" };
  const queued = { id: 8, name: "Backup", commandName: "Backup", status: "queued", queued: "2026-10-10T10:00:00Z" };
  const rows = projectCommands([...finished, search, queued]);
  assert.deepEqual(rows.slice(0, 2).map((r) => r.id), [7, 8], "active first, newest first");
  assert.equal(rows.length, MAX_COMMANDS + 2);
  assert.equal(rows.filter((r) => r.status === "completed").length, MAX_COMMANDS);
  assert.equal(rows[2].id, 100 + MAX_COMMANDS + 9, "then the newest finished");
});

// ── 3: library-wide searches ─────────────────────────────────────────────────

test("Radarr's library-wide searches send no `monitored` (Radarr has none); Sonarr's send monitored:true", async () => {
  assert.deepEqual(bulkActionCommand("radarr", "searchMissing"), { name: "MissingMoviesSearch" });
  assert.deepEqual(bulkActionCommand("radarr", "searchCutoff"), { name: "CutoffUnmetMoviesSearch" });
  assert.deepEqual(bulkActionCommand("sonarr", "searchMissing"), { name: "MissingEpisodeSearch", monitored: true });
  assert.deepEqual(bulkActionCommand("sonarr", "searchCutoff"), { name: "CutoffUnmetEpisodeSearch", monitored: true });

  const token = await mintSession();
  responder = (c) => (c.path === "/api/v3/command" && c.method === "POST" ? json({ id: 9 }, 201) : undefined);
  for (const action of ["searchMissing", "searchCutoff"]) {
    assert.equal((await call(tasksRoute.POST, token, "/admin/arr/tasks", { method: "POST", body: { service: "radarr", action } })).status, 202);
  }
  assert.deepEqual(writes().map((c) => [c.origin, c.body]), [[RADARR, { name: "MissingMoviesSearch" }], [RADARR, { name: "CutoffUnmetMoviesSearch" }]]);
});

test("the update check and a library refresh are flagged for a confirm; ordinary tasks are not", () => {
  assert.equal(taskRisk("ApplicationCheckUpdate"), "update", "Radarr");
  assert.equal(taskRisk("ApplicationUpdateCheck"), "update", "Sonarr");
  assert.equal(taskRisk("RefreshMovie"), "refreshLibrary");
  assert.equal(taskRisk("RefreshSeries"), "refreshLibrary");
  for (const name of ["RssSync", "Backup", "UpdateSceneMapping", "RefreshMonitoredDownloads", "RefreshCollections", "CheckHealth"]) {
    assert.equal(taskRisk(name), null, name);
  }
});

// ── 4: cancel race ───────────────────────────────────────────────────────────

test("a cancel that loses the race with the command starting is 'no longer queued', not the arr's raw refusal", async () => {
  const token = await mintSession();
  for (const upstream of [409, 400]) {
    calls = [];
    responder = (c) => {
      if (c.origin !== RADARR) return undefined;
      if (c.path === "/api/v3/command" && c.method === "GET") return json([{ id: 5, name: "Backup", commandName: "Backup", status: "queued" }]);
      if (c.path === "/api/v3/command/5" && c.method === "DELETE") return json({ message: "Unable to cancel task" }, upstream);
      return undefined;
    };
    const res = await call(tasksRoute.DELETE, token, "/admin/arr/tasks?service=radarr&commandId=5", { method: "DELETE" });
    assert.equal(res.status, 409, `upstream ${upstream}`);
    const body = (await res.json()) as { error: string };
    assert.match(body.error, /no longer queued/, `upstream ${upstream}`);
    assert.deepEqual(writes().map((c) => [c.method, c.path]), [["DELETE", "/api/v3/command/5"]]);
  }
});

// ── 5: the providers read ────────────────────────────────────────────────────

test("the providers read makes no /indexerstatus call, names tags from /tag, and flags Prowlarr's indexers by name", async () => {
  settings.set("feature.integration.sonarr", "false");
  invalidateFeatureFlagCache();
  const token = await mintSession();
  const PROWLARR = { ...INDEXER, id: 4, name: "NZBgeek (Prowlarr)" };
  let tagStatus = 200;
  responder = (c) => {
    if (c.path === "/api/v3/indexer") return json([INDEXER, PROWLARR]);
    if (c.path === "/api/v3/downloadclient") return json([CLIENT]);
    if (c.path === "/api/v3/tag") return json([{ id: 2, label: "anime" }], tagStatus);
    return undefined;
  };
  const res = await call(providersRoute.GET, token, "/admin/arr/providers");
  const body = (await res.json()) as { errors: unknown[]; results: Array<{ indexers: Array<Record<string, unknown>>; downloadClients: Array<Record<string, unknown>>; tags: unknown[] }> };
  assert.deepEqual(arrCalls().map((c) => c.path).sort(), ["/api/v3/downloadclient", "/api/v3/indexer", "/api/v3/tag"]);
  const [r] = body.results;
  assert.deepEqual(r.tags, [{ id: 2, label: "anime" }]);
  assert.deepEqual(r.indexers.map((ix) => [ix.id, ix.managedByProwlarr]), [[3, false], [4, true]]);
  assert.ok(r.indexers.every((ix) => !("status" in ix) && !("fields" in ix)));
  assert.deepEqual([r.downloadClients[0].removeCompletedDownloads, r.downloadClients[0].removeFailedDownloads], [false, true]);

  calls = [];
  tagStatus = 500;
  const degraded = (await (await call(providersRoute.GET, token, "/admin/arr/providers")).json()) as typeof body;
  assert.deepEqual(degraded.errors, [], "a failed tag read fails nothing");
  assert.deepEqual(degraded.results[0].tags, []);
  assert.equal(degraded.results[0].indexers.length, 2);

  // Prowlarr is read from the name, never from `fields`.
  assert.equal(projectIndexers([{ ...INDEXER, fields: [{ name: "prowlarr", value: "(Prowlarr)" }] }])[0].managedByProwlarr, false);
});

// ── 6: forceSave ─────────────────────────────────────────────────────────────

test("forceSave only when a change turns things OFF: a mixed ON+OFF indexer change and a client ON are tested", async () => {
  const token = await mintSession();
  responder = (c) => {
    if (c.origin !== RADARR) return undefined;
    if (c.path === "/api/v3/indexer/3" && c.method === "GET") return json(INDEXER);
    if (c.path === "/api/v3/downloadclient/1" && c.method === "GET") return json(CLIENT);
    if (c.method === "PUT") return json({ ...(c.body as object) }, 202);
    return undefined;
  };
  assert.equal((await patch(token, { kind: "indexer", id: 3, enableRss: false, enableAutomaticSearch: true })).status, 200);
  assert.equal((await patch(token, { kind: "downloadClient", id: 1, enable: true })).status, 200);
  assert.equal((await patch(token, { kind: "downloadClient", id: 1, enable: false })).status, 200);
  assert.deepEqual(
    writes().map((c) => [c.path, c.query.get("forceSave")]),
    [["/api/v3/indexer/3", null], ["/api/v3/downloadclient/1", null], ["/api/v3/downloadclient/1", "true"]],
  );
  assert.deepEqual(audits.map((a) => a.action), ["ARR_PROVIDER_CHANGE", "ARR_PROVIDER_CHANGE", "ARR_PROVIDER_CHANGE"]);
});

test("a stored secret the arr hands back as \"********\" goes back to it unchanged, in the save and in the test", async () => {
  const token = await mintSession();
  responder = (c) => {
    if (c.origin !== RADARR) return undefined;
    if (c.path === "/api/v3/indexer/3" && c.method === "GET") return json(INDEXER);
    if (c.path === "/api/v3/indexer/3" && c.method === "PUT") return json({ ...(c.body as object) }, 202);
    if (c.path === "/api/v3/indexer/test") return new Response("{}", { status: 200 });
    return undefined;
  };
  assert.equal((await patch(token, { kind: "indexer", id: 3, enableRss: false })).status, 200);
  assert.equal((await testProvider(token, { kind: "indexer", id: 3 })).status, 200);
  assert.deepEqual(writes().map((c) => [c.path, c.body]), [
    ["/api/v3/indexer/3", { ...INDEXER, enableRss: false }],
    ["/api/v3/indexer/test", INDEXER],
  ]);
});

// ── 7: warnings ──────────────────────────────────────────────────────────────

test("a switch-ON refused for warnings alone is 409 { warningsOnly }, masked and not audited; accepting re-tests server-side, then saves with forceSave", async () => {
  const token = await mintSession();
  let testBody: unknown[] = [warning(`Indexer returned no results for its RSS: https://api.nzbgeek.info/rss?apikey=${SECRET}`)];
  responder = (c) => {
    if (c.origin !== RADARR) return undefined;
    if (c.path === "/api/v3/indexer/3" && c.method === "GET") return json(INDEXER);
    if (c.path === "/api/v3/indexer/3" && c.method === "PUT") {
      return c.query.get("forceSave") === "true" ? json({ ...(c.body as object) }, 202) : json(testBody, 400);
    }
    if (c.path === "/api/v3/indexer/test") return testBody.length === 0 ? new Response("{}", { status: 200 }) : json(testBody, 400);
    return undefined;
  };
  const held = await patch(token, { kind: "indexer", id: 3, enableAutomaticSearch: true });
  assert.equal(held.status, 409);
  const heldText = await held.text();
  assert.ok(!heldText.includes(SECRET), "masked");
  const heldBody = JSON.parse(heldText) as { warningsOnly: boolean; messages: string[] };
  assert.equal(heldBody.warningsOnly, true);
  assert.match(heldBody.messages[0], /no results for its RSS/);
  assert.equal(audits.length, 0, "nothing was saved");

  calls = [];
  const accepted = await patch(token, { kind: "indexer", id: 3, enableAutomaticSearch: true, acceptWarnings: true });
  assert.equal(accepted.status, 200);
  const changed = { ...INDEXER, enableAutomaticSearch: true };
  assert.deepEqual(writes().map((c) => [c.path, c.query.get("forceSave"), c.body]), [
    ["/api/v3/indexer/test", null, changed],
    ["/api/v3/indexer/3", "true", changed],
  ], "the arr's own test is re-run on the changed resource first");
  assert.deepEqual(audits.map((a) => [a.action, (JSON.parse(String(a.details)) as { acceptedWarnings?: boolean }).acceptedWarnings]), [["ARR_PROVIDER_CHANGE", true]]);

  // An error beside the warning: accepting cannot save it.
  calls = [];
  audits.length = 0;
  testBody = [warning("No results"), failure(`Unable to connect: https://api.nzbgeek.info/api?apikey=${SECRET}`)];
  const refused = await patch(token, { kind: "indexer", id: 3, enableAutomaticSearch: true, acceptWarnings: true });
  assert.equal(refused.status, 400);
  assert.ok(!(await refused.text()).includes(SECRET));
  assert.deepEqual(writes().map((c) => c.path), ["/api/v3/indexer/test"], "no save");
  assert.equal(audits.length, 0);

  // A plain error on the ON save is still a refusal, never a warning to accept.
  calls = [];
  const plain = await patch(token, { kind: "indexer", id: 3, enableAutomaticSearch: true });
  assert.equal(plain.status, 400);
  assert.ok(!(await plain.text()).includes("warningsOnly"));

  calls = [];
  assert.equal((await patch(token, { kind: "indexer", id: 3, enableRss: true, acceptWarnings: "yes" })).status, 400, "acceptWarnings must be a boolean");
  assert.deepEqual(arrCalls(), [], "refused before anything reaches the arr");
});

test("an error with no message still counts as an error; the arr's isWarning decides over severity", () => {
  assert.equal(projectFailures([warning("a"), { errorMessage: "", isWarning: false }]).warningsOnly, false);
  assert.equal(projectFailures([warning("a"), "garbage"]).warningsOnly, false);
  assert.equal(projectFailures([]).warningsOnly, false, "no failure is not 'warnings only'");
  assert.equal(projectFailures([{ errorMessage: "x", severity: "warning" }]).warningsOnly, true, "severity when isWarning is absent");
  assert.equal(projectFailures([{ errorMessage: "x", isWarning: false, severity: "warning" }]).warningsOnly, false, "isWarning wins");
  assert.deepEqual(testResultOf(1, false, projectFailures([warning("slow")])), { id: 1, ok: true, warning: true, messages: ["slow"] });
  assert.deepEqual(testResultOf(1, false, projectFailures([failure("down")])), { id: 1, ok: false, warning: false, messages: ["down"] });
  assert.deepEqual(projectTestAll([{ id: 2, isValid: false, validationFailures: [warning("slow")] }]), [{ id: 2, ok: true, warning: true, messages: ["slow"] }]);
});

test("a warnings-only test reads as working with warnings, single and Test All; a Test All 400 that isn't the list is a masked refusal", async () => {
  const token = await mintSession();
  let testAll: () => Response = () => json([{ id: 3, isValid: false, validationFailures: [warning("RSS feed is empty")] }, { id: 4, isValid: false, validationFailures: [failure("down")] }], 400);
  responder = (c) => {
    if (c.origin !== RADARR) return undefined;
    if (c.path === "/api/v3/indexer/3" && c.method === "GET") return json(INDEXER);
    if (c.path === "/api/v3/indexer/test") return json([warning("RSS feed is empty")], 400);
    if (c.path === "/api/v3/indexer/testall") return testAll();
    return undefined;
  };
  const one = (await (await testProvider(token, { kind: "indexer", id: 3 })).json()) as { results: unknown[] };
  assert.deepEqual(one.results, [{ id: 3, ok: true, warning: true, messages: ["RSS feed is empty"] }]);
  const all = (await (await testProvider(token, { kind: "indexer" })).json()) as { results: Array<{ id: number; ok: boolean; warning: boolean }> };
  assert.deepEqual(all.results.map((r) => [r.id, r.ok, r.warning]), [[3, true, true], [4, false, false]]);

  for (const body of [JSON.stringify({ message: `Indexer test failed: apikey=${SECRET}` }), `Internal error token=${SECRET}`]) {
    testAll = () => new Response(body, { status: 400 });
    const res = await testProvider(token, { kind: "indexer" });
    assert.equal(res.status, 400);
    const text = await res.text();
    assert.ok(!text.includes(SECRET), body);
    assert.match(text, /refused/);
  }
});

test("an STJ arr's Test All 400 (no isWarning on any entry) reaches the page as uncertain, the single test as working with warnings", async () => {
  const token = await mintSession();
  // Radarr develop's /testall: ValidationFailures is declared List<ValidationFailure>,
  // so System.Text.Json writes only the base properties — no isWarning.
  const stj = (msg: string) => ({ propertyName: "", errorMessage: msg, severity: "error" });
  responder = (c) => {
    if (c.origin !== RADARR) return undefined;
    if (c.path === "/api/v3/indexer/3" && c.method === "GET") return json(INDEXER);
    if (c.path === "/api/v3/indexer/test") return json([warning("Jackett's all endpoint is not supported, please add indexers individually")], 400);
    if (c.path === "/api/v3/indexer/testall") {
      return json([
        { id: 3, isValid: false, validationFailures: [stj("Jackett's all endpoint is not supported, please add indexers individually")] },
        { id: 4, isValid: true, validationFailures: [] },
      ], 400);
    }
    return undefined;
  };
  const res = await testProvider(token, { kind: "indexer" });
  assert.equal(res.status, 200, "the per-provider list, not the arr's refusal");
  const all = (await res.json()) as { results: unknown[] };
  assert.deepEqual(all.results, [
    { id: 3, ok: false, warning: false, messages: ["Jackett's all endpoint is not supported, please add indexers individually"], uncertain: true },
    { id: 4, ok: true, warning: false, messages: [] },
  ]);
  const one = (await (await testProvider(token, { kind: "indexer", id: 3 })).json()) as { results: unknown[] };
  assert.deepEqual(one.results, [{ id: 3, ok: true, warning: true, messages: ["Jackett's all endpoint is not supported, please add indexers individually"] }]);
});

test("Test All and single tests have their own rate limits — testing rows one by one never locks out Test All", async () => {
  const token = await mintSession();
  responder = (c) => {
    if (c.path === "/api/v3/indexer/3" && c.method === "GET") return json(INDEXER);
    if (c.path === "/api/v3/indexer/test") return new Response("{}", { status: 200 });
    if (c.path === "/api/v3/indexer/testall") return json([{ id: 3, isValid: true, validationFailures: [] }]);
    return undefined;
  };
  for (let i = 0; i < 20; i++) assert.equal((await testProvider(token, { kind: "indexer", id: 3 })).status, 200, `single test ${i + 1}`);
  assert.equal((await testProvider(token, { kind: "indexer", id: 3 })).status, 429);
  for (let i = 0; i < 6; i++) assert.equal((await testProvider(token, { kind: "indexer" })).status, 200, `Test All ${i + 1}`);
  assert.equal((await testProvider(token, { kind: "indexer" })).status, 429);
});

// ── 8: timeouts ──────────────────────────────────────────────────────────────

test("tests and testing saves wait 120 s, an OFF save the default, and the polled task reads 10 s", async () => {
  const token = await mintSession();
  responder = (c) => {
    if (c.origin !== RADARR) return undefined;
    if (c.path === "/api/v3/indexer/3" && c.method === "GET") return json(INDEXER);
    if (c.path === "/api/v3/indexer/3" && c.method === "PUT") return json({ ...(c.body as object) }, 202);
    if (c.path === "/api/v3/indexer/test") return new Response("{}", { status: 200 });
    if (c.path === "/api/v3/indexer/testall") return json([]);
    if (c.path === "/api/v3/system/task") return json([]);
    if (c.path === "/api/v3/command") return json([]);
    return undefined;
  };
  await testProvider(token, { kind: "indexer" });
  await testProvider(token, { kind: "indexer", id: 3 });
  await patch(token, { kind: "indexer", id: 3, enableAutomaticSearch: true });
  await patch(token, { kind: "indexer", id: 3, enableRss: false });
  assert.deepEqual(writes().map((c) => [c.path, c.query.get("forceSave"), c.timeoutMs]), [
    ["/api/v3/indexer/testall", null, 120_000],
    ["/api/v3/indexer/test", null, 120_000],
    ["/api/v3/indexer/3", null, 120_000],
    ["/api/v3/indexer/3", "true", 30_000],
  ]);
  settings.set("feature.integration.sonarr", "false");
  invalidateFeatureFlagCache();
  calls = [];
  await call(tasksRoute.GET, token, "/admin/arr/tasks");
  assert.deepEqual(arrCalls().map((c) => [c.path, c.timeoutMs]).sort(), [["/api/v3/command", 10_000], ["/api/v3/system/task", 10_000]]);
});

test("a testing save that times out is read back: saved → 200 and audited, not saved → 504 with the arr's copy, not audited", async () => {
  const token = await mintSession();
  let stored: Record<string, unknown> = { ...INDEXER };
  responder = (c) => {
    if (c.origin !== RADARR) return undefined;
    if (c.path === "/api/v3/indexer/3" && c.method === "GET") return json(stored);
    if (c.path === "/api/v3/indexer/3" && c.method === "PUT") return timedOut() as unknown as Response;
    return undefined;
  };
  // Still testing when re-read: nothing saved yet.
  const pending = await patch(token, { kind: "indexer", id: 3, enableAutomaticSearch: true });
  assert.equal(pending.status, 504);
  const pendingBody = (await pending.json()) as { timedOut: boolean; provider: { enableAutomaticSearch: boolean } };
  assert.equal(pendingBody.timedOut, true);
  assert.equal(pendingBody.provider.enableAutomaticSearch, false, "the arr's real state");
  assert.equal(audits.length, 0);

  // The arr finished its test and saved while we waited.
  stored = { ...INDEXER, enableAutomaticSearch: true };
  const landed = await patch(token, { kind: "indexer", id: 3, enableAutomaticSearch: true });
  assert.equal(landed.status, 200);
  assert.deepEqual(await landed.json(), { provider: { ...projectIndexers([stored])[0] }, timedOut: true });
  assert.deepEqual(audits.map((a) => a.action), ["ARR_PROVIDER_CHANGE"]);
});

// ── 11: storage ──────────────────────────────────────────────────────────────

test("a root folder's total size comes from the disk that holds it — the longest whole-segment prefix", async () => {
  const disks = [
    { path: "/", label: null, freeSpace: 1e10, totalSpace: 1e11 },
    { path: "/mnt/media", label: null, freeSpace: 2e12, totalSpace: 8e12 },
    { path: "C:\\", label: null, freeSpace: 1, totalSpace: 5e11 },
  ];
  assert.equal(diskFor("/mnt/media/movies/", disks)?.path, "/mnt/media");
  assert.equal(diskFor("/mnt/media", disks)?.path, "/mnt/media");
  assert.equal(diskFor("/mnt/media2/movies", disks)?.path, "/", "not a whole segment");
  assert.equal(diskFor("c:/Movies", disks)?.path, "C:\\");
  assert.equal(diskFor("D:\\Movies", [{ path: "C:\\", label: null, freeSpace: 1, totalSpace: 1 }]), null);

  const many = Array.from({ length: MAX_UNMAPPED + 7 }, (_, i) => ({ name: `Folder ${i}`, path: `/mnt/media/movies/Folder ${i}` }));
  const [root] = projectRootFolders([{ id: 1, path: "/mnt/media/movies/", accessible: true, freeSpace: 2e12, unmappedFolders: many }], disks);
  assert.equal(root.totalSpace, 8e12);
  assert.equal(root.unmappedFolders.length, MAX_UNMAPPED, "the list is bounded");
  assert.equal(root.unmappedCount, MAX_UNMAPPED + 7, "the count is the true one");
  assert.equal(projectRootFolders([{ id: 1, path: "/elsewhere", freeSpace: 1 }], [])[0].totalSpace, null);

  settings.set("feature.integration.sonarr", "false");
  invalidateFeatureFlagCache();
  const token = await mintSession();
  responder = (c) => {
    if (c.path === "/api/v3/rootfolder") return json([{ id: 1, path: "/mnt/media/movies", accessible: true, freeSpace: 2e12, unmappedFolders: [] }]);
    if (c.path === "/api/v3/diskspace") return json(disks);
    return undefined;
  };
  const body = (await (await call(storageRoute.GET, token, "/admin/arr/storage")).json()) as { results: Array<{ rootFolders: Array<{ totalSpace: number | null }> }> };
  assert.equal(body.results[0].rootFolders[0].totalSpace, 8e12);
});

// ── 12: tests and saves as background jobs ───────────────────────────────────

function deferred<T>() {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((r) => { resolve = r; });
  return { promise, resolve };
}
const tickJobs = () => new Promise((r) => setImmediate(r));
/** An `async` call answers at once — never held for the arr (a held one would sit behind the test's gate). */
function prompt<T>(p: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const held = new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error("the request was held for the arr")), 2_000); });
  return Promise.race([p, held]).finally(() => clearTimeout(timer));
}
const pollTest = (token: string, job: string) => call(testRoute.GET, token, `/admin/arr/providers/test?job=${job}`);
const pollSave = (token: string, job: string) => call(providersRoute.GET, token, `/admin/arr/providers?job=${job}`);
/** Polls until the job answers something other than 202. */
async function settled(poll: () => Promise<Response>): Promise<Response> {
  for (let i = 0; i < 200; i++) {
    const res = await poll();
    if (res.status !== 202) return res;
    await tickJobs();
  }
  throw new Error("the job never finished");
}

test("an async test answers 202 { job } at once, polls 202 while the arr tests, then the test's own answer; joined, not re-sent; another admin's poll is 404", async () => {
  _resetReleaseSearchJobsForTests();
  const token = await mintSession();
  const other = await mintSession();
  const gate = deferred<void>();
  responder = async (c) => {
    if (c.path === "/api/v3/indexer/testall") {
      await gate.promise;
      return json([{ id: 3, isValid: true, validationFailures: [] }]);
    }
    return undefined;
  };
  const start = await prompt(testProvider(token, { kind: "indexer", async: true }));
  assert.equal(start.status, 202, "answered before the arr did");
  const { job } = (await start.json()) as { job: string };
  assert.match(job, /^[0-9a-f]{32}$/);
  const again = await prompt(testProvider(token, { kind: "indexer", async: true }));
  assert.equal(((await again.json()) as { job: string }).job, job, "the same test while it runs is joined");
  assert.equal(arrCalls().filter((c) => c.path === "/api/v3/indexer/testall").length, 1, "the arr is asked once");
  const running = await pollTest(token, job);
  assert.equal(running.status, 202);
  assert.deepEqual(await running.json(), { job, running: true });
  const foreign = await pollTest(other, job);
  assert.equal(foreign.status, 404, "only its owner can read it");
  assert.match(((await foreign.json()) as { error: string }).error, /no longer being followed/, "the provider message, never 'search again'");
  gate.resolve();
  const done = await settled(() => pollTest(token, job));
  assert.equal(done.status, 200);
  assert.deepEqual(await done.json(), { results: [{ id: 3, ok: true, warning: false, messages: [] }] });
  assert.equal((await pollTest(token, "0".repeat(32))).status, 404, "a job that isn't there");
  assert.equal((await call(testRoute.GET, token, "/admin/arr/providers/test")).status, 404, "no job named");
});

test("a joined async test spends no rate token; a refused one is the synchronous route's answer, as a job", async () => {
  _resetReleaseSearchJobsForTests();
  const token = await mintSession();
  const gate = deferred<void>();
  responder = async (c) => {
    if (c.path === "/api/v3/indexer/testall") {
      await gate.promise;
      return new Response(JSON.stringify({ message: `refused apikey=${SECRET}` }), { status: 400 });
    }
    return undefined;
  };
  const { job } = (await (await prompt(testProvider(token, { kind: "indexer", async: true }))).json()) as { job: string };
  for (let i = 0; i < 10; i++) assert.equal((await prompt(testProvider(token, { kind: "indexer", async: true }))).status, 202, `join ${i + 1}`);
  gate.resolve();
  const done = await settled(() => pollTest(token, job));
  assert.equal(done.status, 400);
  const text = await done.text();
  assert.ok(!text.includes(SECRET), "masked, as the synchronous answer is");
  assert.match(text, /refused/);
  // Six Test Alls a minute: the first spent one, the ten joins none.
  for (let i = 0; i < 5; i++) assert.notEqual((await testProvider(token, { kind: "indexer" })).status, 429, `Test All ${i + 2}`);
  assert.equal((await testProvider(token, { kind: "indexer" })).status, 429);
  assert.equal((await testProvider(token, { kind: "indexer", async: "yes" })).status, 400, "async must be a boolean");
});

test("an async save that times out is re-read until the arr holds the change: saved within the window → 200 and audited", async () => {
  _resetReleaseSearchJobsForTests();
  const pauses: number[] = [];
  _setProviderSettlePauseForTests(async (ms) => { pauses.push(ms); });
  try {
    const token = await mintSession();
    let reads = 0;
    responder = (c) => {
      if (c.origin !== RADARR) return undefined;
      if (c.path === "/api/v3/indexer/3" && c.method === "GET") {
        reads++;
        // The first read is the save's own; the arr finishes its test on the third read-back.
        return json(reads >= 4 ? { ...INDEXER, enableAutomaticSearch: true } : INDEXER);
      }
      if (c.path === "/api/v3/indexer/3" && c.method === "PUT") return timedOut() as unknown as Response;
      return undefined;
    };
    const start = await patch(token, { kind: "indexer", id: 3, enableAutomaticSearch: true, async: true });
    assert.equal(start.status, 202);
    const { job } = (await start.json()) as { job: string };
    const done = await settled(() => pollSave(token, job));
    assert.equal(done.status, 200);
    assert.deepEqual(await done.json(), { provider: projectIndexers([{ ...INDEXER, enableAutomaticSearch: true }])[0], timedOut: true });
    assert.equal(reads, 4, "read once to save, then until it held the change");
    assert.equal(pauses.length, 2, "a pause before each read-back after the first");
    await tickJobs();
    assert.deepEqual(audits.map((a) => [a.action, a.target]), [["ARR_PROVIDER_CHANGE", "radarr::indexer:3"]], "audited — the change is in the arr");
  } finally {
    _setProviderSettlePauseForTests(null);
  }
});

test("an async save the arr never finishes within the window → 504 with the arr's copy, not audited; the synchronous save reads back once", async () => {
  _resetReleaseSearchJobsForTests();
  _setProviderSettlePauseForTests(async () => {});
  try {
    const token = await mintSession();
    let reads = 0;
    responder = (c) => {
      if (c.origin !== RADARR) return undefined;
      if (c.path === "/api/v3/indexer/3" && c.method === "GET") {
        reads++;
        return json(INDEXER);
      }
      if (c.path === "/api/v3/indexer/3" && c.method === "PUT") return timedOut() as unknown as Response;
      return undefined;
    };
    const { job } = (await (await patch(token, { kind: "indexer", id: 3, enableAutomaticSearch: true, async: true })).json()) as { job: string };
    const done = await settled(() => pollSave(token, job));
    assert.equal(done.status, 504);
    const body = (await done.json()) as { timedOut: boolean; provider: { enableAutomaticSearch: boolean } };
    assert.equal(body.timedOut, true);
    assert.equal(body.provider.enableAutomaticSearch, false);
    assert.equal(reads, 1 + 1 + PROVIDER_SETTLE_READS, "the save's read, the read-back, then every settle read");
    assert.equal(audits.length, 0);

    reads = 0;
    assert.equal((await patch(token, { kind: "indexer", id: 3, enableAutomaticSearch: true })).status, 504);
    assert.equal(reads, 2, "without async: the save's read and ONE read-back — the browser is waiting");
  } finally {
    _setProviderSettlePauseForTests(null);
  }
});

test("the same async save while one runs is joined (one PUT); a lost job is 404 with the provider message", async () => {
  _resetReleaseSearchJobsForTests();
  const token = await mintSession();
  const gate = deferred<void>();
  responder = async (c) => {
    if (c.origin !== RADARR) return undefined;
    if (c.path === "/api/v3/indexer/3" && c.method === "GET") return json(INDEXER);
    if (c.path === "/api/v3/indexer/3" && c.method === "PUT") {
      await gate.promise;
      return json({ ...(c.body as object) }, 202);
    }
    return undefined;
  };
  const a = (await (await prompt(patch(token, { kind: "indexer", id: 3, enableAutomaticSearch: true, async: true }))).json()) as { job: string };
  const b = (await (await prompt(patch(token, { kind: "indexer", id: 3, enableAutomaticSearch: true, async: true }))).json()) as { job: string };
  assert.equal(b.job, a.job);
  gate.resolve();
  assert.equal((await settled(() => pollSave(token, a.job))).status, 200);
  assert.equal(writes().filter((c) => c.method === "PUT").length, 1, "one save sent");
  await tickJobs();
  assert.equal(audits.length, 1);
  _resetReleaseSearchJobsForTests();
  const gone = await pollSave(token, a.job);
  assert.equal(gone.status, 404);
  assert.match(((await gone.json()) as { error: string }).error, /no longer being followed/);
  assert.equal((await patch(token, { kind: "indexer", id: 3, enableRss: false, async: 1 })).status, 400, "async must be a boolean");
});

test("Arr System runs its provider tests and saves as polled jobs, counting polls — never holding the request, never reading the clock", () => {
  const src = readFileSync(new URL("../src/components/admin/arr-system.tsx", import.meta.url), "utf8");
  assert.match(src, /body: \{ \.\.\.init\.body, async: true \}/, "sent with async");
  assert.match(src, /\$\{path\}\?job=\$\{encodeURIComponent\(job\)\}/, "polled at ?job=");
  assert.match(src, /if \(polls >= JOB_MAX_POLLS\)/, "a counted cap");
  assert.equal((src.match(/callJob<[^>]*>\(\s*"\/api\/admin\/arr\/providers(\/test)?"/g) ?? []).length, 2, "both the test and the save");
  assert.doesNotMatch(src, /Date\.now\(\)|new Date\(\)/);
});

// ── 13: the polled pages tick through the gate ───────────────────────────────

test("the queue and Arr System poll through the load gate as a POLL; the queue's poll pauses while its title manager is open", () => {
  const src = (f: string) => readFileSync(new URL(`../src/components/admin/${f}`, import.meta.url), "utf8");
  const interval = /window\.setInterval\(\(\) => \{([^}]*)\}/;
  for (const file of ["download-queue.tsx", "arr-system.tsx"]) {
    const body = interval.exec(src(file))?.[1] ?? "";
    assert.match(body, /void load\("poll"\)/, `${file}: a tick is a poll — skipped while a read is out, never superseding it`);
  }
  const queue = src("download-queue.tsx");
  const effect = /useEffect\(\(\) => \{\s*if \(([^)]*)\) return;\s*const \w+ = window\.setInterval\([\s\S]*?\}, \[([^\]]*)\]\);/.exec(queue);
  assert.ok(effect, "the queue's poll effect");
  assert.match(effect[1], /\bmanaging\b/, "no poll while the title manager is open");
  assert.match(effect[2], /\bmanaging\b/, "and it resumes when it closes");
});
