// Admin → Download History: the History page's arr read, the Blocklist tab's
// removal (its verify scan, the viewed-page hint, the instance it reads, the
// audit), the "too old for the blocklist" answer, and the pure row helpers the
// History list folds Sonarr's per-episode records with. Only Sonarr records
// fold, only within one series, and only while each record follows the one
// before within HISTORY_FOLD_GAP_MS — a re-grab of the same info hash or a
// second import is its own row, kind filter or not.
//
//   /api/admin/arr/history, /api/admin/arr/blocklist{,/clear}
//   groupHistoryEvents, grabStateOf, projectHistoryRecord/projectBlocklistRecords
//   (the singular `language`), removedBlocklistEntry
//
// Harness: the same as tests/arr-manage-routes.test.mts (scripted Radarr/Sonarr
// behind a stubbed fetch + DNS, in-memory prisma, a synthetic request scope).
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import dns from "node:dns/promises";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { AsyncLocalStorage } from "node:async_hooks";

(globalThis as { AsyncLocalStorage?: unknown }).AsyncLocalStorage = AsyncLocalStorage;

process.env.TOKEN_ENCRYPTION_KEY = "ab".repeat(32);
process.env.NEXTAUTH_SECRET = "arr-fix-history-test-secret-0123456789abcdef";
process.env.AUTH_URL = "http://localhost:3000";
process.env.TRUST_PROXY = "true";
delete process.env.TMDB_READ_TOKEN;
(process.env as Record<string, string | undefined>).NODE_ENV = "test";

const fakeLookup = async () => [{ address: "10.0.0.250", family: 4 }];
(dns as { lookup: unknown }).lookup = fakeLookup;
if ((dns as { lookup: unknown }).lookup !== fakeLookup) throw new Error("could not stub dns.lookup");

console.warn = () => {};
console.error = () => {};

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
  let body: unknown;
  if (typeof init?.body === "string" && init.body !== "") {
    try { body = JSON.parse(init.body); } catch { body = init.body; }
  }
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
const { translatorFor } = await import("../src/lib/i18n/server-locale.ts");
const {
  HISTORY_FOLD_GAP_MS,
  grabStateOf,
  groupHistoryEvents,
  lastPageIfStranded,
  projectBlocklistRecords,
  projectHistoryRecord,
  projectHistoryRecords,
  removedBlocklistEntry,
} = await import("../src/lib/arr-history.ts");
type ArrHistoryEvent = import("../src/lib/arr-history.ts").ArrHistoryEvent;

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

const historyRoute = await import("../src/app/api/admin/arr/history/route.ts");
const blocklistRoute = await import("../src/app/api/admin/arr/blocklist/route.ts");
const clearRoute = await import("../src/app/api/admin/arr/blocklist/clear/route.ts");

// ── request scope ────────────────────────────────────────────────────────────
function inScope<T>(fn: () => Promise<T>): Promise<T> {
  const workStore = { route: "/arr-fix-history.test", forceStatic: false, dynamicShouldError: false, afterContext: { after: () => {} } };
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
      headers: {
        cookie: `${COOKIE}=${token}`,
        ...(init.body !== undefined ? { "content-type": "application/json" } : {}),
      },
      ...(init.body !== undefined ? { body: JSON.stringify(init.body) } : {}),
    }),
    undefined,
  ));
const arrCalls = () => calls.filter((c) => c.origin !== "http://localhost:3000");
// logAudit stores details as a JSON string.
const detailsOf = (a: { details: unknown }) => (typeof a.details === "string" ? JSON.parse(a.details) : a.details) as Record<string, unknown>;
const writes = () => arrCalls().filter((c) => c.method !== "GET");
const blocklistReads = () => arrCalls().filter((c) => c.method === "GET" && c.path === "/api/v3/blocklist");

/**
 * A blocklist of `total` records, ids 1..total in the arr's newest-first order,
 * paged as the arr pages it. `extra` overrides fields by id.
 */
function blocklistOf(total: number, extra: Record<number, Record<string, unknown>> = {}): Responder {
  return (c) => {
    if (c.method !== "GET" || c.path !== "/api/v3/blocklist") return undefined;
    const page = Number(c.query.get("page"));
    const size = Number(c.query.get("pageSize"));
    const records = [];
    for (let id = (page - 1) * size + 1; id <= Math.min(total, page * size); id++) {
      records.push({ id, movieId: 11, sourceTitle: `Release.${id}`, ...extra[id] });
    }
    return json({ page, pageSize: size, totalRecords: total, records });
  };
}
const bulkDelete: Responder = (c) => (c.method === "DELETE" && c.path === "/api/v3/blocklist/bulk" ? new Response("", { status: 200 }) : undefined);
const both = (...rs: Responder[]): Responder => (c) => {
  for (const r of rs) {
    const res = r(c);
    if (res) return res;
  }
  return undefined;
};

beforeEach(() => {
  calls = [];
  audits.length = 0;
  responder = () => undefined;
  settings.clear();
  for (const [k, v] of Object.entries({
    radarrUrl: RADARR, radarrApiKey: "radarr-key",
    radarr4kUrl: RADARR_4K, radarr4kApiKey: "radarr4k-key",
    sonarrUrl: SONARR, sonarrApiKey: "sonarr-key",
  })) settings.set(k, v);
  invalidateFeatureFlagCache();
});

// ── the History page's read ──────────────────────────────────────────────────

test("the History read sends the page, its size, a newest-first date sort and the includes to the arr", async () => {
  const token = await mintSession();
  responder = (c) => (c.path === "/api/v3/history" ? json({ page: 3, pageSize: 25, totalRecords: 0, records: [] }) : undefined);
  assert.equal((await call(historyRoute.GET, token, "/admin/arr/history?service=radarr&page=3&pageSize=25")).status, 200);
  assert.equal((await call(historyRoute.GET, token, "/admin/arr/history?service=sonarr&page=2&pageSize=50")).status, 200);
  const [radarr, sonarr] = arrCalls();
  assert.deepEqual(
    [radarr.origin, radarr.query.get("page"), radarr.query.get("pageSize"), radarr.query.get("sortKey"), radarr.query.get("sortDirection"), radarr.query.get("includeMovie")],
    [RADARR, "3", "25", "date", "descending", "true"],
  );
  assert.deepEqual(
    [sonarr.origin, sonarr.query.get("page"), sonarr.query.get("pageSize"), sonarr.query.get("sortKey"), sonarr.query.get("sortDirection"), sonarr.query.get("includeSeries"), sonarr.query.get("includeEpisode")],
    [SONARR, "2", "50", "date", "descending", "true", "true"],
  );
});

// ── blocklist removal: the verify scan ───────────────────────────────────────

test("an id on the scan's second page is found and removed in one bulk call", async () => {
  const token = await mintSession();
  responder = both(blocklistOf(1_500), bulkDelete);
  const res = await call(blocklistRoute.DELETE, token, "/admin/arr/blocklist?service=radarr&ids=1200", { method: "DELETE" });
  assert.equal(res.status, 200);
  assert.deepEqual(blocklistReads().map((c) => [c.query.get("page"), c.query.get("pageSize"), c.query.get("sortKey"), c.query.get("sortDirection")]), [
    ["1", "1000", "date", "descending"],
    ["2", "1000", "date", "descending"],
  ]);
  assert.deepEqual(writes().map((c) => [c.method, c.path, c.body]), [["DELETE", "/api/v3/blocklist/bulk", { ids: [1200] }]]);
});

test("the scan reads at most 20 pages: an id past them is 409 and nothing is removed", async () => {
  const token = await mintSession();
  responder = both(blocklistOf(25_000), bulkDelete);
  const res = await call(blocklistRoute.DELETE, token, "/admin/arr/blocklist?service=radarr&ids=20500", { method: "DELETE" });
  assert.equal(res.status, 409);
  assert.equal(blocklistReads().length, 20);
  assert.deepEqual(writes(), []);
  assert.equal(audits.length, 0);
});

test("ids are judged on the TARGET instance: one only Radarr holds is 409 on the 4K instance, nothing written anywhere", async () => {
  const token = await mintSession();
  responder = (c) => {
    if (c.method === "GET" && c.path === "/api/v3/blocklist") {
      return c.origin === RADARR
        ? json({ page: 1, pageSize: 1000, totalRecords: 1, records: [{ id: 3, movieId: 11, sourceTitle: "Radarr.Only" }] })
        : json({ page: 1, pageSize: 1000, totalRecords: 0, records: [] });
    }
    return bulkDelete(c);
  };
  const res = await call(blocklistRoute.DELETE, token, "/admin/arr/blocklist?service=radarr&instance=4k&ids=3", { method: "DELETE" });
  assert.equal(res.status, 409);
  assert.deepEqual(arrCalls().map((c) => c.origin), [RADARR_4K], "only the 4K instance is read");
  assert.deepEqual(writes(), []);
});

test("the page the admin viewed is re-read first: a hit needs no scan, a miss falls back to it", async () => {
  const token = await mintSession();
  responder = both(blocklistOf(400), bulkDelete);
  // Hit: id 107 sits on page 3 of 50.
  assert.equal((await call(blocklistRoute.DELETE, token, "/admin/arr/blocklist?service=radarr&ids=107&page=3&pageSize=50", { method: "DELETE" })).status, 200);
  assert.deepEqual(blocklistReads().map((c) => [c.query.get("page"), c.query.get("pageSize"), c.query.get("sortKey"), c.query.get("sortDirection")]), [["3", "50", "date", "descending"]]);
  assert.deepEqual(writes().map((c) => c.body), [{ ids: [107] }]);

  // Miss: id 7 moved off page 3 — the scan finds it.
  calls = [];
  assert.equal((await call(blocklistRoute.DELETE, token, "/admin/arr/blocklist?service=radarr&ids=107,7&page=3&pageSize=50", { method: "DELETE" })).status, 200);
  assert.deepEqual(blocklistReads().map((c) => [c.query.get("page"), c.query.get("pageSize")]), [["3", "50"], ["1", "1000"]]);
  assert.deepEqual(writes().map((c) => c.body), [{ ids: [107, 7] }]);

  // A malformed hint is refused before any upstream call.
  calls = [];
  assert.equal((await call(blocklistRoute.DELETE, token, "/admin/arr/blocklist?service=radarr&ids=107&page=0&pageSize=50", { method: "DELETE" })).status, 400);
  assert.equal((await call(blocklistRoute.DELETE, token, "/admin/arr/blocklist?service=radarr&ids=107&pageSize=500", { method: "DELETE" })).status, 400);
  assert.deepEqual(arrCalls(), []);
});

// ── audit ────────────────────────────────────────────────────────────────────

test("the removal audit names each release and its title; a clear records the count the admin confirmed", async () => {
  const token = await mintSession();
  responder = both(
    blocklistOf(5, { 3: { sourceTitle: "The.Matrix.1999.CAM" }, 4: { sourceTitle: "x".repeat(800), movieId: 12 } }),
    bulkDelete,
    (c) => (c.method === "POST" && c.path === "/api/v3/command" ? json({ id: 1 }, 201) : undefined),
  );
  assert.equal((await call(blocklistRoute.DELETE, token, "/admin/arr/blocklist?service=radarr&ids=3,4", { method: "DELETE" })).status, 200);
  const removal = detailsOf(audits[0]);
  assert.equal(audits[0].action, "ARR_BLOCKLIST_CHANGE");
  assert.deepEqual(removal.removed, [3, 4]);
  assert.deepEqual(removal.releases, [
    { id: 3, release: "The.Matrix.1999.CAM", movieId: 11 },
    { id: 4, release: "x".repeat(500), movieId: 12 },
  ]);

  assert.equal((await call(clearRoute.POST, token, "/admin/arr/blocklist/clear", { method: "POST", body: { service: "radarr", count: 42 } })).status, 202);
  assert.equal((await call(clearRoute.POST, token, "/admin/arr/blocklist/clear", { method: "POST", body: { service: "radarr" } })).status, 202);
  assert.equal((await call(clearRoute.POST, token, "/admin/arr/blocklist/clear", { method: "POST", body: { service: "radarr", count: "lots" } })).status, 202);
  assert.deepEqual(audits.slice(1).map(detailsOf).map((d) => [d.cleared, d.count]), [[true, 42], [true, null], [true, null]]);
});

test("the Sonarr removal audit names the series", async () => {
  const token = await mintSession();
  responder = both(
    (c) => (c.method === "GET" && c.path === "/api/v3/blocklist"
      ? json({ page: 1, pageSize: 1000, totalRecords: 1, records: [{ id: 9, seriesId: 21, episodeIds: [101, 102], sourceTitle: "Breaking.Bad.S01" }] })
      : undefined),
    bulkDelete,
  );
  assert.equal((await call(blocklistRoute.DELETE, token, "/admin/arr/blocklist?service=sonarr&ids=9", { method: "DELETE" })).status, 200);
  assert.deepEqual(detailsOf(audits[0]).releases, [{ id: 9, release: "Breaking.Bad.S01", seriesId: 21 }]);
});

// ── an arr older than the /blocklist API ─────────────────────────────────────

test("an arr that answers /blocklist with 404 is named too old for it — never 'no longer has that item'", async () => {
  const token = await mintSession();
  const en = translatorFor("en");
  responder = (c) => (c.path === "/api/v3/blocklist" ? new Response("", { status: 404 }) : undefined);
  const read = await call(blocklistRoute.GET, token, "/admin/arr/blocklist?service=radarr");
  assert.equal(read.status, 404);
  assert.equal(((await read.json()) as { error: string }).error, en("apiAdmin.arr.blocklistTooOld.radarr"));
  const sonarr = await call(blocklistRoute.GET, token, "/admin/arr/blocklist?service=sonarr");
  assert.equal(((await sonarr.json()) as { error: string }).error, en("apiAdmin.arr.blocklistTooOld.sonarr"));
  const remove = await call(blocklistRoute.DELETE, token, "/admin/arr/blocklist?service=radarr&ids=3", { method: "DELETE" });
  assert.equal(remove.status, 404);
  assert.equal(((await remove.json()) as { error: string }).error, en("apiAdmin.arr.blocklistTooOld.radarr"));
  assert.deepEqual(writes(), []);
  assert.notEqual(en("apiAdmin.arr.blocklistTooOld.radarr"), "apiAdmin.arr.blocklistTooOld.radarr", "the key has English text");
});

// ── pure: the singular `language` ────────────────────────────────────────────

test("history and blocklist records read Sonarr v3's / older Radarr's singular `language` when `languages` is absent", () => {
  const v3 = projectHistoryRecord("sonarr", "", { id: 1, seriesId: 21, eventType: "grabbed", language: { id: 1, name: "English" } });
  assert.deepEqual(v3?.languages, ["English"]);
  const both = projectHistoryRecord("radarr", "", { id: 2, movieId: 11, eventType: "grabbed", languages: [{ id: 3, name: "French" }], language: { id: 1, name: "English" } });
  assert.deepEqual(both?.languages, ["French"], "the list wins when the arr sends one");
  const none = projectHistoryRecord("radarr", "", { id: 3, movieId: 11, eventType: "grabbed" });
  assert.deepEqual(none?.languages, []);
  const [entry] = projectBlocklistRecords("radarr", "", [{ id: 4, movieId: 11, language: { id: 2, name: "German" } }]);
  assert.deepEqual(entry.languages, ["German"]);
});

test("removedBlocklistEntry keeps the id, a bounded release name and the title's arr id", () => {
  assert.deepEqual(removedBlocklistEntry("radarr", { id: 5, movieId: 11, sourceTitle: "a".repeat(700) }), { id: 5, release: "a".repeat(500), arrMediaId: 11 });
  assert.deepEqual(removedBlocklistEntry("sonarr", { id: 6, seriesId: 21, movieId: 99, sourceTitle: "S" }), { id: 6, release: "S", arrMediaId: 21 });
  assert.equal(removedBlocklistEntry("radarr", { sourceTitle: "no id" }), null);
});

// ── pure: rows and grab state ────────────────────────────────────────────────

const ep = (id: number, kind: string, downloadId: string | null, episode: [number, number] | null, extra: Record<string, unknown> = {}): ArrHistoryEvent => {
  const e = projectHistoryRecord("sonarr", "", {
    id, seriesId: 21, eventType: kind, downloadId, date: "2026-10-01T10:00:00Z", sourceTitle: "Breaking.Bad.S02.1080p",
    ...(episode ? { episode: { seasonNumber: episode[0], episodeNumber: episode[1], title: `Ep ${episode[1]}` } } : {}),
    ...extra,
  });
  assert.ok(e);
  return e;
};

test("Sonarr's per-episode records of one download fold into one row: its episodes, seasons and newest record", () => {
  // Newest first, as the arr pages it.
  const events = [
    ep(13, "downloadFolderImported", "PACK", [2, 3]),
    ep(12, "downloadFolderImported", "PACK", [2, 2]),
    ep(11, "downloadFolderImported", "PACK", [2, 1]),
    ep(10, "grabbed", "PACK", [2, 3]),
    ep(9, "grabbed", "PACK", [2, 1]),
    ep(8, "grabbed", "PACK", [2, 2]),
    ep(7, "grabbed", "SOLO", [1, 5]),
    ep(6, "episodeFileDeleted", null, [1, 5], { data: { reason: "Upgrade" } }),
  ];
  const rows = groupHistoryEvents(events);
  assert.deepEqual(rows.map((r) => [r.lead.id, r.lead.kind, r.events.map((e) => e.id), r.episodeCount, r.seasons]), [
    [13, "imported", [11, 12, 13], 3, [2]],
    [10, "grabbed", [9, 8, 10], 3, [2]],
    [7, "grabbed", [7], 1, [1]],
    [6, "deleted", [6], 1, [1]],
  ]);
  assert.deepEqual(rows[1].episodes.map((e) => [e.seasonNumber, e.episodeNumber]), [[2, 1], [2, 2], [2, 3]]);
  assert.equal(new Set(rows.map((r) => r.key)).size, rows.length, "row keys are unique");
});

test("one download grabbed, failed and grabbed again is three events — and only a NEWER failure fails a grab", () => {
  const events = [
    ep(22, "grabbed", "HASH", [1, 1]),
    ep(21, "downloadFailed", "HASH", [1, 1]),
    ep(20, "grabbed", "HASH", [1, 1]),
  ];
  const rows = groupHistoryEvents(events);
  assert.deepEqual(rows.map((r) => r.lead.id), [22, 21, 20]);
  assert.deepEqual(grabStateOf(rows[0], events), { failed: false, imported: false }, "the re-grab postdates the failure");
  assert.deepEqual(grabStateOf(rows[2], events), { failed: true, imported: false });
  assert.deepEqual(grabStateOf(rows[1], events), { failed: false, imported: false }, "only a grab has a state");
});

test("a grab's state: imported since, failed since (a pack's per-episode failures), nothing from another download", () => {
  const pack = [
    ep(15, "downloadFailed", "PACK", [2, 2]),
    ep(14, "downloadFailed", "PACK", [2, 1]),
    ep(13, "downloadFolderImported", "PACK", [2, 1]),
    ep(10, "grabbed", "PACK", [2, 2]),
    ep(9, "grabbed", "PACK", [2, 1]),
    ep(5, "downloadFailed", "OTHER", [3, 1]),
  ];
  const rows = groupHistoryEvents(pack);
  const grab = rows.find((r) => r.lead.id === 10);
  assert.ok(grab);
  assert.deepEqual(grabStateOf(grab, pack), { failed: true, imported: true });
  const imported = pack.filter((e) => e.kind !== "failed");
  assert.deepEqual(grabStateOf(groupHistoryEvents(imported).find((r) => r.lead.id === 10)!, imported), { failed: false, imported: true });
  const grabsOnly = pack.filter((e) => e.kind === "grabbed");
  assert.deepEqual(grabStateOf(groupHistoryEvents(grabsOnly)[0], grabsOnly), { failed: false, imported: false }, "a list filtered to grabs knows neither");
  const elsewhere = [ep(12, "downloadFailed", "ELSE", [2, 1]), ep(11, "downloadFolderImported", "ELSE", [2, 1]), ...grabsOnly];
  assert.deepEqual(grabStateOf(groupHistoryEvents(elsewhere).find((r) => r.lead.id === 10)!, elsewhere), { failed: false, imported: false }, "another download's newer records say nothing");
  const noId = [ep(30, "grabbed", null, [1, 1]), ep(31, "downloadFailed", null, [1, 1])];
  assert.deepEqual(grabStateOf(groupHistoryEvents(noId).find((r) => r.lead.id === 30)!, noId), { failed: false, imported: false }, "no downloadId, no join");
});

test("a folded Sonarr row at a paged list's edge says it may continue; a single record, a movie or an unpaged list never does", () => {
  const top = [ep(40, "grabbed", "TOP", [1, 2]), ep(39, "grabbed", "TOP", [1, 1])];
  const middle = [ep(30, "grabbed", "MID", [2, 1])];
  const bottom = [ep(21, "grabbed", "BOT", [3, 2]), ep(20, "grabbed", "BOT", [3, 1])];
  const events = [...top, ...middle, ...bottom];
  const flags = (edges: { hasPrevious: boolean; hasNext: boolean } | null) =>
    groupHistoryEvents(events, edges).map((r) => [r.lead.id, r.continuesBefore, r.continuesAfter]);
  assert.deepEqual(flags({ hasPrevious: true, hasNext: true }), [[40, true, false], [30, false, false], [21, false, true]]);
  assert.deepEqual(flags({ hasPrevious: false, hasNext: false }), [[40, false, false], [30, false, false], [21, false, false]]);
  assert.deepEqual(flags(null), [[40, false, false], [30, false, false], [21, false, false]]);
  // A lone record at the edge, and a movie's (one record per event) — nothing to say.
  const lone = [ep(50, "grabbed", "LONE", [1, 1])];
  assert.deepEqual(groupHistoryEvents(lone, { hasPrevious: true, hasNext: true }).map((r) => [r.continuesBefore, r.continuesAfter]), [[false, false]]);
  const movies = projectHistoryRecords("radarr", "", [
    { id: 61, movieId: 11, eventType: "downloadFolderImported", downloadId: "M", date: "2026-10-01T10:00:00Z" },
    { id: 60, movieId: 11, eventType: "downloadFolderImported", downloadId: "M", date: "2026-10-01T10:00:00Z" },
  ]);
  const movieRows = groupHistoryEvents(movies, { hasPrevious: true, hasNext: true });
  assert.deepEqual(movieRows.map((r) => [r.lead.id, r.continuesBefore, r.continuesAfter, r.episodeCount]), [[61, false, false, 0], [60, false, false, 0]]);
});

test("Radarr records never fold: a download imported twice, or grabbed twice on a list filtered to grabs, is two rows", () => {
  const radarr = (records: Array<Record<string, unknown>>) =>
    projectHistoryRecords("radarr", "", records.map((r) => ({ movieId: 11, downloadId: "HASH", date: "2026-10-01T10:00:00Z", ...r })));
  const twice = radarr([{ id: 71, eventType: "downloadFolderImported" }, { id: 70, eventType: "downloadFolderImported" }]);
  assert.deepEqual(groupHistoryEvents(twice).map((r) => [r.lead.id, r.events.length]), [[71, 1], [70, 1]]);
  const grabs = radarr([{ id: 81, eventType: "grabbed" }, { id: 80, eventType: "grabbed" }]);
  const rows = groupHistoryEvents(grabs);
  assert.deepEqual(rows.map((r) => r.lead.id), [81, 80], "each grab keeps its own Mark failed");
});

test("Sonarr folds one download's records only within one series", () => {
  const events = [
    ep(92, "grabbed", "SAME", [1, 2]),
    ep(91, "grabbed", "SAME", [1, 1], { seriesId: 33 }),
    ep(90, "grabbed", "SAME", [1, 1]),
  ];
  assert.deepEqual(groupHistoryEvents(events).map((r) => [r.lead.id, r.events.map((e) => e.id)]), [[92, [90, 92]], [91, [91]]]);
});

test("Sonarr folds a run only while each record follows the one before within the gap: a pack's slow import is one row, a later re-grab or re-import is another", () => {
  assert.equal(HISTORY_FOLD_GAP_MS, 5 * 60_000);
  const at = (minutes: number) => new Date(Date.UTC(2026, 9, 1, 10, 0) + minutes * 60_000).toISOString();
  // A 4-file pack copied across disks: files land 4 minutes apart — 12 minutes end to end.
  const slowImport = [
    ep(104, "downloadFolderImported", "PACK", [2, 4], { date: at(12) }),
    ep(103, "downloadFolderImported", "PACK", [2, 3], { date: at(8) }),
    ep(102, "downloadFolderImported", "PACK", [2, 2], { date: at(4) }),
    ep(101, "downloadFolderImported", "PACK", [2, 1], { date: at(0) }),
  ];
  assert.deepEqual(groupHistoryEvents(slowImport).map((r) => [r.lead.id, r.episodeCount]), [[104, 4]]);

  // A list filtered to grabs: the failure between the two grabs isn't there to cut the run.
  const regrab = [
    ep(114, "grabbed", "HASH", [3, 2], { date: at(130) }),
    ep(113, "grabbed", "HASH", [3, 1], { date: at(130) }),
    ep(112, "grabbed", "HASH", [3, 2], { date: at(0) }),
    ep(111, "grabbed", "HASH", [3, 1], { date: at(0) }),
  ];
  assert.deepEqual(groupHistoryEvents(regrab).map((r) => [r.lead.id, r.events.map((e) => e.id)]), [[114, [113, 114]], [112, [111, 112]]]);

  // Imported, then imported again an hour later (a manual re-import).
  const reimport = [
    ep(122, "downloadFolderImported", "PACK2", [4, 1], { date: at(60) }),
    ep(121, "downloadFolderImported", "PACK2", [4, 1], { date: at(0) }),
  ];
  assert.equal(groupHistoryEvents(reimport).length, 2);

  // An undated record can't be shown to belong to the same moment.
  const undated = [ep(131, "grabbed", "U", [5, 2], { date: null }), ep(130, "grabbed", "U", [5, 1])];
  assert.equal(groupHistoryEvents(undated).length, 2);
});

test("a row counts distinct episodes by S/E, else by Sonarr's episode id (v4's per-series history embeds no episode)", () => {
  const v4 = [
    ep(3, "grabbed", "P", null, { episodeId: 103 }),
    ep(2, "grabbed", "P", null, { episodeId: 102 }),
    ep(1, "grabbed", "P", null, { episodeId: 102 }),
  ];
  const [row] = groupHistoryEvents(v4);
  assert.deepEqual([row.episodeCount, row.episodes, row.seasons], [2, [], []]);
});

test("a page that came back empty past the end of a non-empty list jumps to the last page, by the arr's page size", () => {
  const empty = (totalRecords: number, pageSize = 50) => ({ records: [], totalRecords, pageSize });
  assert.equal(lastPageIfStranded(4, empty(120)), 3, "120 records of 50 end on page 3");
  assert.equal(lastPageIfStranded(4, empty(120, 100)), 2, "the size the arr answered with, not the one asked for");
  assert.equal(lastPageIfStranded(2, empty(40)), 1);
  assert.equal(lastPageIfStranded(1, empty(40)), null, "page 1 has nowhere to go");
  assert.equal(lastPageIfStranded(4, empty(0)), null, "an empty list is just empty");
  assert.equal(lastPageIfStranded(3, empty(120)), null, "an arr whose total its pages don't hold: no loop");
  assert.equal(lastPageIfStranded(4, { records: [{}], totalRecords: 120, pageSize: 50 }), null, "a page with records stands");
});

test("History, Blocklist and Calendar re-read their list when the title manager removes a title", () => {
  const src = (f: string) => readFileSync(new URL(`../src/components/admin/${f}`, import.meta.url), "utf8");
  const blocks = (f: string) => [...src(f).matchAll(/<ManageTitleButton\b[\s\S]*?\/>/g)].map((m) => m[0]);
  const history = blocks("arr-download-history.tsx");
  assert.equal(history.length, 2, "the History rows and the Blocklist rows");
  for (const b of history) assert.match(b, /onRemoved=\{\(\) => void loadRef\.current\(\)\}/);
  const calendar = blocks("arr-calendar.tsx");
  assert.equal(calendar.length, 1);
  assert.match(calendar[0], /onRemoved=\{\(\) => \{\s*if \(start !== null\) void load\(start, unmonitored\);\s*\}\}/);
});
