// Audit fixes (wave B2, unit "title-lib"):
//
//   C010 — a release grab that failed BEFORE POST /api/v3/release was sent
//          (no config, the title lookup, the tvdb resolution) hands the claimed
//          handle back: nothing reached the arr, so the retry must not cost a
//          whole new indexer search. A failure DURING the grab still spends it
//          (the outcome is unknown — never send it twice).
//   C095 — grabStateOf reads a grab with no downloadId (Blackhole clients) as
//          already failed once a newer failure names the same release (and,
//          for Sonarr, the same episode), so the list stops offering Mark
//          failed on it again.
//   g-sonarr#4 — Sonarr v3's single `language` object is read on the Files tab
//          and the Download Queue, not only on releases and history.
//
// Harness for the route part: tests/audit-fix-release.test.mts — the real
// wrapped handler with a signed session JWT in a synthetic request scope,
// in-memory prisma stubs, Radarr scripted behind a fetch stub.
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import dns from "node:dns/promises";
import { createRequire } from "node:module";
import { AsyncLocalStorage } from "node:async_hooks";

(globalThis as { AsyncLocalStorage?: unknown }).AsyncLocalStorage = AsyncLocalStorage;

process.env.TOKEN_ENCRYPTION_KEY = "ab".repeat(32);
process.env.NEXTAUTH_SECRET = "audit-fix-title-lib-test-secret-0123456789";
process.env.AUTH_URL = "http://localhost:3000";
process.env.TRUST_PROXY = "true";
(process.env as Record<string, string | undefined>).NODE_ENV = "test";

const fakeLookup = async () => [{ address: "10.0.0.250", family: 4 }];
(dns as { lookup: unknown }).lookup = fakeLookup;
if ((dns as { lookup: unknown }).lookup !== fakeLookup) throw new Error("could not stub dns.lookup");

console.warn = () => {};
console.error = () => {};

// ── scripted Radarr/Sonarr ───────────────────────────────────────────────────
type Call = { origin: string; method: string; path: string; query: URLSearchParams; body: unknown };
let calls: Call[] = [];
type Responder = (c: Call) => Response | Promise<Response> | undefined;
let responder: Responder = () => undefined;
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
  const url = new URL(String(input));
  const method = init?.method ?? "GET";
  const body = typeof init?.body === "string" ? JSON.parse(init.body) : undefined;
  const call = { origin: url.origin, method, path: url.pathname, query: url.searchParams, body };
  calls.push(call);
  const res = await responder(call);
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
const { _resetReleaseHandlesForTests } = await import("../src/lib/release-handles.ts");

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
  findMany: async () => [],
  update: async () => ({}),
});
let sessionSeq = 0;
async function mintSession(): Promise<string> {
  sessionSeq++;
  const userId = `user-${sessionSeq}`;
  const sessionId = `sess-${sessionSeq}`;
  usersById.set(userId, {
    role: "ADMIN", permissions: Permission.ADMIN, mediaServer: null, sessionsRevokedAt: null,
    passwordChangedAt: null, deactivatedAt: null, email: `u${sessionSeq}@example.com`, notificationEmail: null,
  });
  sessionRows.add(sessionId);
  const iat = Math.floor(Date.now() / 1000);
  return signSessionJwt(
    { id: userId, role: "ADMIN", permissions: Permission.ADMIN.toString(), provider: "credentials", sessionId, expiresAt: iat + 86_400 },
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
});
type ReqRow = { id: string; mediaType: "MOVIE" | "TV"; tmdbId: number; tvdbId: number | null; status: string; arrInstance: string };
let requests: ReqRow[] = [];
shadowPrismaModel(prisma, "mediaRequest", {
  findUnique: async (args: { where: { id: string } }) => requests.find((r) => r.id === args.where.id) ?? null,
});
shadowPrismaModel(prisma, "auditLog", { create: async () => ({}) });

const requestReleases = await import("../src/app/api/requests/[id]/releases/route.ts");

// ── request scope ────────────────────────────────────────────────────────────
function inScope<T>(fn: () => Promise<T>): Promise<T> {
  const workStore = { route: "/audit-fix-title-lib.test", forceStatic: false, dynamicShouldError: false, afterContext: { after: () => {} } };
  const h = new Headers();
  const requestStore = {
    type: "request", phase: "render",
    headers: HeadersAdapter.seal(h),
    cookies: RequestCookiesAdapter.seal(new RequestCookies(h)),
    usedDynamic: false,
  };
  return workAsyncStorage.run(workStore, () => workUnitAsyncStorage.run(requestStore, fn));
}
type Handler = (req: InstanceType<typeof NextRequest>, ctx: { params: Promise<{ id: string }> }) => Promise<Response>;
async function call(handler: unknown, token: string, path: string, id: string, init: { method?: string; body?: unknown } = {}): Promise<Response> {
  const req = new NextRequest(`http://localhost:3000/api${path}`, {
    method: init.method ?? "GET",
    headers: { cookie: `${COOKIE}=${token}`, "content-type": "application/json", origin: "http://localhost:3000" },
    ...(init.body !== undefined ? { body: JSON.stringify(init.body) } : {}),
  });
  return inScope(() => (handler as Handler)(req, { params: Promise.resolve({ id }) }));
}

// Every test gets its own Radarr origin: arr.ts caches a quality profile per
// (url, profile id), so a shared origin would carry one test's into the next.
let originSeq = 0;
let RADARR = "";
const RELEASE = {
  guid: "http://indexer.example/details/1", title: "The.Matrix.1999.1080p", size: 1e9, indexerId: 3, indexer: "NZBgeek", qualityWeight: 10,
  protocol: "usenet", quality: { quality: { id: 7, name: "Bluray-1080p" }, revision: { version: 1 } }, age: 2, rejected: false, rejections: [],
  downloadAllowed: true,
};

beforeEach(() => {
  originSeq++;
  RADARR = `http://10.0.${originSeq}.5:7878`;
  settings.clear();
  settings.set("radarrUrl", RADARR);
  settings.set("radarrApiKey", "radarr-key");
  calls = [];
  requests = [{ id: "r1", mediaType: "MOVIE", tmdbId: 603, tvdbId: null, status: "APPROVED", arrInstance: "" }];
  _resetReleaseHandlesForTests();
});

const grabPosts = () => calls.filter((c) => c.method === "POST" && c.path === "/api/v3/release");

// ═══════════════════ C010 — a failure before the grab hands the handle back ═

test("C010: request Pick release — the movie lookup before the grab fails (network, then a gateway 503): the handle is handed back and the retry grabs", async () => {
  let lookup: "ok" | "network" | "503" = "ok";
  responder = (c) => {
    if (c.method === "GET" && c.path === "/api/v3/movie") {
      if (lookup === "network") throw new TypeError("fetch failed");
      if (lookup === "503") return json({ message: "busy" }, 503);
      return json([{ id: 44, tmdbId: 603 }]);
    }
    if (c.method === "GET" && c.path === "/api/v3/release") return json([RELEASE]);
    if (c.method === "POST" && c.path === "/api/v3/release") return json({});
    return undefined;
  };
  const token = await mintSession();
  const listed = await (await call(requestReleases.GET, token, "/requests/r1/releases", "r1")).json() as { releases: Array<{ guid: string }> };
  const handle = listed.releases[0].guid;
  const grab = () => call(requestReleases.POST, token, "/requests/r1/releases", "r1", { method: "POST", body: { release: handle } });

  lookup = "network";
  assert.notEqual((await grab()).status, 200);
  lookup = "503";
  assert.notEqual((await grab()).status, 200);
  assert.equal(grabPosts().length, 0, "nothing reached the arr's grab");
  lookup = "ok";
  assert.equal((await grab()).status, 200, "the handle was handed back — no second indexer search");
  assert.equal(grabPosts().length, 1);
  assert.equal((await grab()).status, 410, "spent once the grab was accepted");
});

test("C010: request Pick release — a failure DURING the grab (no answer) still spends the handle", async () => {
  responder = (c) => {
    if (c.method === "GET" && c.path === "/api/v3/movie") return json([{ id: 44, tmdbId: 603 }]);
    if (c.method === "GET" && c.path === "/api/v3/release") return json([RELEASE]);
    if (c.method === "POST" && c.path === "/api/v3/release") throw new TypeError("fetch failed");
    return undefined;
  };
  const token = await mintSession();
  const listed = await (await call(requestReleases.GET, token, "/requests/r1/releases", "r1")).json() as { releases: Array<{ guid: string }> };
  const handle = listed.releases[0].guid;
  const grab = () => call(requestReleases.POST, token, "/requests/r1/releases", "r1", { method: "POST", body: { release: handle } });
  assert.notEqual((await grab()).status, 200);
  assert.equal((await grab()).status, 410, "the arr may have taken it — never sent twice");
  assert.equal(grabPosts().length, 1);
});

// ═══════════════════ C095 — the list reads an id-less grab's failure ═════════

const { groupHistoryEvents, grabStateOf, projectHistoryRecords } = await import("../src/lib/arr-history.ts");

test("C095: grabStateOf — a grab with no downloadId is failed by a newer failure naming the same release and episode, never another's", () => {
  const events = projectHistoryRecords("sonarr", "", [
    { id: 80, seriesId: 21, eventType: "grabbed", date: "2026-10-01T10:00:00Z", sourceTitle: "Show.S02.1080p", episodeId: 201 },
    { id: 81, seriesId: 21, eventType: "grabbed", date: "2026-10-01T10:00:00Z", sourceTitle: "Show.S02.1080p", episodeId: 202 },
    { id: 82, seriesId: 21, eventType: "grabbed", date: "2026-10-01T10:00:00Z", sourceTitle: "Other.Release", episodeId: 203 },
    { id: 83, seriesId: 21, eventType: "downloadFailed", date: "2026-10-01T11:00:00Z", sourceTitle: "Show.S02.1080p", episodeId: 201 },
    // Another series' failure of the same release name and episode id is not this grab's.
    { id: 84, seriesId: 99, eventType: "downloadFailed", date: "2026-10-01T11:00:00Z", sourceTitle: "Other.Release", episodeId: 203 },
    // The same episode's failure of ANOTHER release is that release's.
    { id: 85, seriesId: 21, eventType: "grabbed", date: "2026-10-01T10:00:00Z", sourceTitle: "Release.A", episodeId: 204 },
    { id: 86, seriesId: 21, eventType: "downloadFailed", date: "2026-10-01T11:00:00Z", sourceTitle: "Release.B", episodeId: 204 },
  ]);
  const rows = groupHistoryEvents(events);
  const stateOf = (id: number) => grabStateOf(rows.find((r) => r.lead.id === id)!, events);
  assert.deepEqual(stateOf(80), { failed: true, imported: false }, "the arr's manual mark of an id-less grab writes exactly this failure");
  assert.deepEqual(stateOf(81), { failed: false, imported: false }, "another episode's record is its own download");
  assert.deepEqual(stateOf(82), { failed: false, imported: false });
  assert.deepEqual(stateOf(85), { failed: false, imported: false });
  // No episode id on either record: which episode the failure answers can't be told — not joined.
  const unknownEp = projectHistoryRecords("sonarr", "", [
    { id: 60, seriesId: 21, eventType: "grabbed", sourceTitle: "Show.S02.1080p" },
    { id: 61, seriesId: 21, eventType: "downloadFailed", sourceTitle: "Show.S02.1080p" },
  ]);
  assert.deepEqual(grabStateOf(groupHistoryEvents(unknownEp).find((r) => r.lead.id === 60)!, unknownEp), { failed: false, imported: false });
  // A failure OLDER than the grab never counts.
  const older = projectHistoryRecords("radarr", "", [
    { id: 90, movieId: 11, eventType: "downloadFailed", date: "2026-09-01T11:00:00Z", sourceTitle: "Movie.1080p" },
    { id: 91, movieId: 11, eventType: "grabbed", date: "2026-10-01T10:00:00Z", sourceTitle: "Movie.1080p" },
  ]);
  const olderRows = groupHistoryEvents(older);
  assert.deepEqual(grabStateOf(olderRows.find((r) => r.lead.id === 91)!, older), { failed: false, imported: false });
});

// ═══════════════════ g-sonarr#4 — Sonarr v3's single `language` ══════════════

const { projectFiles } = await import("../src/lib/arr-title.ts");
const { foldQueueRecords } = await import("../src/lib/arr-queue.ts");
const { languageNamesOf } = await import("../src/lib/arr-parse.ts");

test("g-sonarr#4: the Files tab reads Sonarr v3's single `language`, and a v4 list is unchanged", () => {
  const [v3] = projectFiles("sonarr", [{ id: 5, relativePath: "S01E01.mkv", size: 1, language: { id: 2, name: "French" } }]);
  assert.deepEqual(v3.languages, ["French"]);
  const [v4] = projectFiles("sonarr", [{ id: 6, relativePath: "S01E02.mkv", size: 1, languages: [{ id: 8, name: "Japanese" }], language: { id: 2, name: "French" } }]);
  assert.deepEqual(v4.languages, ["Japanese"], "the list wins when both are sent");
});

test("g-sonarr#4: the Download Queue reads Sonarr v3's single `language` on a row", () => {
  const rec = (id: number) => ({
    id, downloadId: "PACK", title: "Show.S01.FRENCH.1080p", seriesId: 21, series: { title: "Show", tvdbId: 1 }, episode: { seasonNumber: 1, episodeNumber: id },
    quality: { quality: { name: "WEBDL-1080p" } }, language: { id: 2, name: "French" }, size: 1e9, sizeleft: 5e8, status: "downloading",
    trackedDownloadStatus: "ok", trackedDownloadState: "downloading", protocol: "torrent",
  });
  const [row] = foldQueueRecords("sonarr", "", [rec(1), rec(2)]);
  assert.deepEqual(row.languages, ["French"]);
});

test("g-sonarr#4: languageNamesOf — list first, the single object only when the list is empty, junk ignored", () => {
  assert.deepEqual(languageNamesOf({ languages: [{ name: "English" }] }), ["English"]);
  assert.deepEqual(languageNamesOf({ languages: [], language: { name: "German" } }), ["German"]);
  assert.deepEqual(languageNamesOf({ language: "German" }), []);
  assert.deepEqual(languageNamesOf({ language: [{ name: "German" }] }), []);
  assert.deepEqual(languageNamesOf({}), []);
});

// ═══════════════════ C048 — the rename preview's select all ══════════════════

test("C048: the rename preview has a select-all toggle over the files it lists (a long show pre-ticks thousands)", async () => {
  const { readFileSync } = await import("node:fs");
  const src = readFileSync(new URL("../src/components/admin/arr-title/files-tab.tsx", import.meta.url), "utf8");
  const panel = src.slice(src.indexOf("adminArr.files.renameNone"), src.indexOf("{renames.map("));
  assert.match(panel, /type="checkbox"[\s\S]*checked=\{renames\.every\(\(r\) => renameSelected\.has\(r\.fileId\)\)\}/);
  assert.match(panel, /setRenameSelected\(e\.target\.checked \? new Set\(renames\.map\(\(r\) => r\.fileId\)\) : new Set\(\)\)/);
});
