// "Why is this request stuck?" — GET /api/requests/[id]/arr-status and its
// pure judge (src/lib/request-arr-status.ts + request-arr-status-data.ts).
//
// What is pinned:
//   1. The verdict PRECEDENCE, one scenario per edge: the arr already having
//      everything beats a queued upgrade; a download beats monitoring and
//      release dates; unmonitored beats not-released; a failure counts only
//      since the request's approval and only with nothing queued; a failed
//      read is `unreachable`, never a guess.
//   2. Sonarr completeness is guardrail 14a's sonarrSeriesCompletion — a
//      monitored special with no file never holds a series incomplete.
//   3. MANAGE_REQUESTS (a plain USER is 403 and reaches nothing); only
//      APPROVED/AVAILABLE (409); an unconfigured instance is 422 BEFORE any
//      upstream call; the check is bound to the request's OWN title and
//      instance (guardrail 32) — nothing in the URL can redirect it.
//   4. The answer is COARSE (guardrail 5e): planted output paths, download
//      ids, client and indexer names, release titles, the arr's URL and API
//      key never appear in the JSON a delegate reads, while the arr's message
//      still does, scrubbed.
//   5. Reads are taken only where the verdict needs them, each filtered to
//      records naming the title; the library check counts only servers the
//      REQUESTER can see (guardrail 35); per-caller rate limit.
//
// Harness: tests/arr-ops-routes.test.mts — real wrapped handlers with a signed
// session JWT in a synthetic request scope, in-memory prisma stubs,
// Radarr/Sonarr scripted on RFC1918 literals.
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import dns from "node:dns/promises";
import { createRequire } from "node:module";
import { AsyncLocalStorage } from "node:async_hooks";

(globalThis as { AsyncLocalStorage?: unknown }).AsyncLocalStorage = AsyncLocalStorage;

process.env.TOKEN_ENCRYPTION_KEY = "ab".repeat(32);
process.env.NEXTAUTH_SECRET = "request-arr-status-test-secret-0123456789abcdef";
process.env.AUTH_URL = "http://localhost:3000";
process.env.TRUST_PROXY = "true";
delete process.env.TMDB_READ_TOKEN;
(process.env as Record<string, string | undefined>).NODE_ENV = "test";

const fakeLookup = async () => [{ address: "10.0.0.250", family: 4 }];
(dns as { lookup: unknown }).lookup = fakeLookup;
if ((dns as { lookup: unknown }).lookup !== fakeLookup) throw new Error("could not stub dns.lookup");

let warnLines: string[] = [];
console.warn = (...a: unknown[]) => { warnLines.push(a.map(String).join(" ")); };
console.error = () => {};

// ── scripted Radarr/Sonarr ───────────────────────────────────────────────────
const RADARR = "http://10.0.0.5:7878";
const RADARR_4K = "http://10.0.0.6:7878";
const SONARR = "http://10.0.0.7:8989";
type Call = { origin: string; method: string; path: string; query: URLSearchParams };
let calls: Call[] = [];
type Responder = (c: Call) => Response | undefined;
let responder: Responder = () => undefined;
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
  const url = new URL(String(input));
  const call = { origin: url.origin, method: init?.method ?? "GET", path: url.pathname, query: url.searchParams };
  calls.push(call);
  const res = responder(call);
  if (res) return res;
  throw new Error(`unexpected ${call.method} ${url}`);
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
const { judgeRequestArrStatus, titleFacts, scrubMessage, countFailedDownloads } = await import("../src/lib/request-arr-status.ts");
const { foldQueueRecords } = await import("../src/lib/arr-queue.ts");
const { projectHistoryRecords } = await import("../src/lib/arr-history.ts");
type Inputs = Parameters<typeof judgeRequestArrStatus>[0];

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
const tmdbCacheRows = new Map<string, string>();
const future = new Date(Date.now() + 86_400_000);
shadowPrismaModel(prisma, "tmdbCache", {
  findUnique: async (args: { where: { key: string } }) => {
    const data = tmdbCacheRows.get(args.where.key);
    return data === undefined ? null : { key: args.where.key, data, expiresAt: future };
  },
  findMany: async () => [],
  upsert: async () => ({}),
  deleteMany: async () => ({ count: 0 }),
});
type ReqRow = {
  id: string; mediaType: "MOVIE" | "TV"; tmdbId: number; status: string; arrInstance: string;
  requestedBy: string; approvedAt: Date | null; createdAt: Date;
};
let requests: ReqRow[] = [];
shadowPrismaModel(prisma, "mediaRequest", {
  findUnique: async (args: { where: { id: string } }) => requests.find((r) => r.id === args.where.id) ?? null,
});
type LibRow = { tmdbId: number; mediaType: string; serverInstance: string };
let plexRows: LibRow[] = [];
let jellyfinRows: LibRow[] = [];
const libStub = (rows: () => LibRow[]) => ({
  findFirst: async (args: { where: { tmdbId: number; mediaType: string; serverInstance: { in: string[] } } }) =>
    rows().find((r) => r.tmdbId === args.where.tmdbId && r.mediaType === args.where.mediaType && args.where.serverInstance.in.includes(r.serverInstance)) ?? null,
});
shadowPrismaModel(prisma, "plexLibraryItem", libStub(() => plexRows));
shadowPrismaModel(prisma, "jellyfinLibraryItem", libStub(() => jellyfinRows));

const statusRoute = await import("../src/app/api/requests/[id]/arr-status/route.ts");

// ── request scope ────────────────────────────────────────────────────────────
function inScope<T>(fn: () => Promise<T>): Promise<T> {
  const workStore = { route: "/request-arr-status.test", forceStatic: false, dynamicShouldError: false, afterContext: { after: () => {} } };
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
const get = (token: string | null, id: string, query = "") =>
  inScope(() => (statusRoute.GET as unknown as Handler)(
    new NextRequest(`http://localhost:3000/api/requests/${id}/arr-status${query}`, {
      headers: token ? { cookie: `${COOKIE}=${token}` } : {},
    }),
    { params: Promise.resolve({ id }) },
  ));
type StatusBody = {
  verdict: string; errorKind: string | null; service: string; monitored: boolean | null; released: boolean | null;
  inLibrary: boolean; canOpenQueue: boolean; episodes: { withFile: number; total: number } | null;
  downloads: Array<{ phase: string; progress: number; attention: boolean; messages: string[]; quality: string | null; episodes: number }>;
  downloadCount: number; failures: { count: number; lastAt: string | null; message: string | null }; error?: string;
};
const arrCalls = () => calls.filter((c) => c.origin !== "http://localhost:3000");

// ── fixtures ─────────────────────────────────────────────────────────────────
const APPROVED_AT = new Date("2026-09-01T00:00:00Z");
const REQUESTER = "requester-1";
const movieRow = (extra: Record<string, unknown> = {}) => ({
  id: 10, tmdbId: 603, title: "The Matrix", year: 1999, monitored: true, hasFile: false, isAvailable: true,
  physicalRelease: "1999-09-21T00:00:00Z", digitalRelease: null, ...extra,
});
// A Sonarr series with season 0 (one monitored special, no file) and two
// regular seasons. Sonarr's own series-level block SUMS season 0 (guardrail 14a).
const seriesRow = (s1: [number, number], s2: [number, number], extra: Record<string, unknown> = {}) => ({
  id: 30, tvdbId: 3000, tmdbId: 300, title: "Show", monitored: true,
  statistics: { episodeFileCount: s1[0] + s2[0], episodeCount: s1[1] + s2[1] + 1 },
  seasons: [
    { seasonNumber: 0, monitored: true, statistics: { episodeFileCount: 0, episodeCount: 1, previousAiring: "2020-01-01T00:00:00Z" } },
    { seasonNumber: 1, monitored: true, statistics: { episodeFileCount: s1[0], episodeCount: s1[1], previousAiring: "2021-01-01T00:00:00Z" } },
    { seasonNumber: 2, monitored: true, statistics: { episodeFileCount: s2[0], episodeCount: s2[1], previousAiring: "2022-01-01T00:00:00Z" } },
  ],
  ...extra,
});

beforeEach(() => {
  calls = [];
  warnLines = [];
  responder = () => undefined;
  plexRows = [];
  jellyfinRows = [];
  requests = [];
  settings.clear();
  for (const [k, v] of Object.entries({
    radarrUrl: RADARR, radarrApiKey: "radarr-key",
    radarr4kUrl: RADARR_4K, radarr4kApiKey: "radarr4k-key",
    sonarrUrl: SONARR, sonarrApiKey: "sonarr-key",
  })) settings.set(k, v);
  tmdbCacheRows.clear();
  tmdbCacheRows.set("tmdb-to-tvdb:300", JSON.stringify({ tvdbId: 3000 }));
  usersById.set(REQUESTER, { role: "USER", permissions: 0n, mediaServerGrants: null });
});

// ── 1: the pure judge ────────────────────────────────────────────────────────

const NOW = Date.parse("2026-10-11T12:00:00Z");
const SINCE = APPROVED_AT.getTime();
const ok = <T,>(value: T) => ({ ok: true as const, value });
const queueItem = (extra: Record<string, unknown> = {}) =>
  foldQueueRecords("radarr", "", [{ id: 1, movieId: 10, size: 2e9, sizeleft: 1e9, status: "downloading", trackedDownloadStatus: "ok", trackedDownloadState: "downloading", ...extra }])[0];
const failedEvent = (date: string, extra: Record<string, unknown> = {}) =>
  projectHistoryRecords("radarr", "", [{ id: 5, movieId: 10, eventType: "downloadFailed", date, sourceTitle: "Rel", data: { message: "Download failed" }, ...extra }])[0];
const judge = (over: Partial<Inputs>) => judgeRequestArrStatus({
  service: "radarr", instance: "", resource: ok(movieRow()), queue: ok([]), failures: ok([]), inLibrary: false, sinceMs: SINCE, nowMs: NOW, ...over,
}).verdict;

test("precedence: unreachable → notInArr → has-everything (ready / waiting for sync) BEFORE any queue entry", () => {
  assert.equal(judge({ resource: { ok: false, kind: "auth" } }), "unreachable");
  assert.equal(judgeRequestArrStatus({ service: "radarr", instance: "", resource: { ok: false, kind: "timeout" }, queue: null, failures: null, inLibrary: false, sinceMs: SINCE, nowMs: NOW }).errorKind, "timeout");
  assert.equal(judge({ resource: ok(null) }), "notInArr");
  assert.equal(judge({ resource: ok(movieRow({ hasFile: true })), inLibrary: true }), "ready");
  assert.equal(judge({ resource: ok(movieRow({ hasFile: true })), inLibrary: false }), "inArrNotInLibrary");
  // A queued UPGRADE that needs attention is not why the request is stuck.
  assert.equal(judge({ resource: ok(movieRow({ hasFile: true })), inLibrary: true, queue: ok([queueItem({ trackedDownloadState: "importBlocked" })]) }), "ready");
  // The arr having everything never needs the queue or history read.
  assert.equal(judge({ resource: ok(movieRow({ hasFile: true })), queue: null, failures: null }), "inArrNotInLibrary");
  // The library marking pass needs nothing from Radarr for a MOVIE, nor from an
  // arr that doesn't track the title — but a series Sonarr calls incomplete
  // stays held back however much of it the library has (guardrail 14a).
  assert.equal(judge({ resource: ok(movieRow({ hasFile: false })), inLibrary: true, queue: null, failures: null }), "ready");
  assert.equal(judge({ resource: ok(null), inLibrary: true }), "ready");
  assert.equal(judgeRequestArrStatus({ service: "sonarr", instance: "", resource: ok(null), queue: null, failures: null, inLibrary: true, sinceMs: SINCE, nowMs: NOW }).verdict, "ready");
});

test("precedence: a download in flight beats monitoring and release dates; attention beats plain downloading", () => {
  const unmonitoredUnreleased = ok(movieRow({ monitored: false, physicalRelease: "2027-05-01T00:00:00Z" }));
  assert.equal(judge({ resource: unmonitoredUnreleased, queue: ok([queueItem()]) }), "downloading");
  assert.equal(judge({ resource: unmonitoredUnreleased, queue: ok([queueItem(), queueItem({ id: 2, trackedDownloadState: "importBlocked" })]) }), "importBlocked");
  assert.equal(judge({ queue: ok([queueItem({ trackedDownloadStatus: "warning" })]) }), "importBlocked");
  // A failed queue read is unknown, never "nothing queued".
  const v = judgeRequestArrStatus({ service: "radarr", instance: "", resource: ok(movieRow()), queue: { ok: false, kind: "unreachable" }, failures: ok([]), inLibrary: false, sinceMs: SINCE, nowMs: NOW });
  assert.equal(v.verdict, "unreachable");
  assert.equal(v.errorKind, "unreachable");
});

test("precedence: unmonitored → notReleased → failure since approval → waiting", () => {
  const failure = ok([failedEvent("2026-09-10T00:00:00Z")]);
  assert.equal(judge({ resource: ok(movieRow({ monitored: false, physicalRelease: "2027-05-01T00:00:00Z" })), failures: failure }), "unmonitored");
  assert.equal(judge({ resource: ok(movieRow({ physicalRelease: "2027-05-01T00:00:00Z" })), failures: failure }), "notReleased");
  assert.equal(judge({ failures: failure }), "downloadFailed");
  // A failure from before the approval is history, not the reason.
  assert.equal(judge({ failures: ok([failedEvent("2026-08-31T23:59:59Z")]) }), "waiting");
  // A history read that failed is unknown.
  assert.equal(judge({ failures: { ok: false, kind: "server" } }), "unreachable");
  // A non-failure event the arr returned anyway (an ignored eventType filter) never counts.
  assert.equal(judge({ failures: ok(projectHistoryRecords("radarr", "", [{ id: 6, movieId: 10, eventType: "grabbed", date: "2026-09-10T00:00:00Z" }])) }), "waiting");
});

test("failures count DOWNLOADS: one failed 10-episode Sonarr pack is 1, not 10; the same id failing again hours later is 2", () => {
  const rec = (id: number, date: string, downloadId: string | null, ep = 1) => projectHistoryRecords("sonarr", "", [{
    id, seriesId: 30, eventType: "downloadFailed", date, sourceTitle: "Show.S02", downloadId,
    episode: { seasonNumber: 2, episodeNumber: ep }, data: { message: "Download failed" },
  }])[0];
  const pack = Array.from({ length: 10 }, (_, i) => rec(100 + i, "2026-09-10T00:00:00Z", "PACK", i + 1));
  assert.equal(countFailedDownloads(pack), 1);
  // A record written a few seconds into the next minute is still that failure.
  assert.equal(countFailedDownloads([...pack, rec(120, "2026-09-10T00:00:40Z", "PACK", 11)]), 1);
  // The same torrent (same info hash) re-grabbed and failing again later is a second failed download.
  assert.equal(countFailedDownloads([...pack, rec(130, "2026-09-10T05:00:00Z", "PACK")]), 2);
  // Records with no download id are each their own; two different downloads are two.
  assert.equal(countFailedDownloads([rec(1, "2026-09-10T00:00:00Z", null), rec(2, "2026-09-10T00:00:00Z", null), rec(3, "2026-09-10T00:00:00Z", "OTHER")]), 3);

  const status = judgeRequestArrStatus({
    service: "sonarr", instance: "", resource: ok(seriesRow([8, 8], [2, 10])), queue: ok([]), failures: ok(pack), inLibrary: false, sinceMs: SINCE, nowMs: NOW,
  });
  assert.equal(status.verdict, "downloadFailed");
  assert.equal(status.failures.count, 1, "the panel says 1 failed download for one failed pack");
});

test("release dates reuse the Missing rule (physical/digital); an UNDATED movie falls back to Radarr's own isAvailable", () => {
  const facts = (row: Record<string, unknown>) => titleFacts("radarr", "", movieRow(row), NOW)!;
  assert.equal(facts({ physicalRelease: "2026-10-01T00:00:00Z" }).released, true);
  const upcoming = facts({ physicalRelease: "2027-05-01T00:00:00Z", digitalRelease: "2027-03-01T00:00:00Z", inCinemas: "2026-09-01T00:00:00Z" });
  assert.equal(upcoming.released, false, "in cinemas only is not released");
  assert.equal(upcoming.expectedAt, "2027-03-01T00:00:00.000Z");
  assert.equal(facts({ physicalRelease: null, digitalRelease: null, isAvailable: true }).released, true);
  assert.equal(facts({ physicalRelease: null, digitalRelease: null, isAvailable: false }).released, false);
});

test("a series is judged by sonarrSeriesCompletion (guardrail 14a): a monitored special never holds it incomplete, and only a REGULAR episode airing counts as released", () => {
  const complete = titleFacts("sonarr", "", seriesRow([8, 8], [10, 10]), NOW)!;
  assert.equal(complete.hasEverything, true, "season 0's missing special is excluded");
  assert.deepEqual(complete.episodes, { withFile: 18, total: 18 });
  const partial = judgeRequestArrStatus({ service: "sonarr", instance: "", resource: ok(seriesRow([8, 8], [2, 10])), queue: ok([]), failures: ok([]), inLibrary: true, sinceMs: SINCE, nowMs: NOW });
  assert.equal(partial.verdict, "incomplete");
  assert.deepEqual(partial.episodes, { withFile: 10, total: 18 });
  assert.equal(judgeRequestArrStatus({ service: "sonarr", instance: "", resource: ok(seriesRow([0, 8], [0, 10])), queue: ok([]), failures: ok([]), inLibrary: false, sinceMs: SINCE, nowMs: NOW }).verdict, "waiting");
  // Only a special has aired: nothing to download yet.
  const specialOnly = {
    id: 31, tvdbId: 3100, monitored: true,
    seasons: [
      { seasonNumber: 0, monitored: true, statistics: { episodeFileCount: 0, episodeCount: 0, previousAiring: "2026-01-01T00:00:00Z" } },
      { seasonNumber: 1, monitored: true, statistics: { episodeFileCount: 0, episodeCount: 0, previousAiring: null, nextAiring: "2027-01-01T00:00:00Z" } },
    ],
  };
  const facts = titleFacts("sonarr", "", specialOnly, NOW)!;
  assert.equal(facts.released, false);
  assert.equal(facts.expectedAt, "2027-01-01T00:00:00.000Z");
});

test("scrubMessage removes credentials, paths, file names and every named private value — and keeps the reason", () => {
  const s = scrubMessage(
    "Import failed for Secret.Release-GRP: No files found are eligible for import in /mnt/dl/other path apikey=TOPSECRET (C:\\dl\\x) see Secret.Release-GRP.mkv via SecretClient at http://10.9.9.9:7878/api",
    ["Secret.Release-GRP", "SecretClient", null, ""],
  )!;
  for (const leaked of ["Secret.Release", "/mnt/dl", "TOPSECRET", "C:\\dl", ".mkv", "SecretClient", "10.9.9.9", "7878"]) assert.ok(!s.includes(leaked), `${leaked} in ${s}`);
  assert.match(s, /No files found are eligible for import in/);
  assert.equal(scrubMessage("/only/a/path", []), null);
  // A status entry that is only the file's name says nothing a delegate may read.
  assert.equal(scrubMessage("Show - S01E01 - Pilot WEBDL-1080p.mkv", []), null);
  assert.equal(scrubMessage("Not an upgrade for existing movie file. Existing quality: Bluray-1080p.", []), "Not an upgrade for existing movie file. Existing quality: Bluray-1080p.");
  // A URL goes whole, scheme and all.
  assert.equal(scrubMessage("Indexer unreachable: https://idx.example/api?t=search", []), "Indexer unreachable: …");
});

// ── 2: the route ─────────────────────────────────────────────────────────────

const approvedMovie = (extra: Partial<ReqRow> = {}): ReqRow => ({
  id: "r1", mediaType: "MOVIE", tmdbId: 603, status: "APPROVED", arrInstance: "", requestedBy: REQUESTER,
  approvedAt: APPROVED_AT, createdAt: new Date("2026-08-01T00:00:00Z"), ...extra,
});
const radarrResponder = (movie: Record<string, unknown> | null, queue: unknown[] = [], history: unknown[] = []): Responder => (c) => {
  if (c.path === "/api/v3/movie") return json(movie ? [movie] : []);
  if (c.path === "/api/v3/queue/details") return json(queue);
  if (c.path === "/api/v3/history/movie") return json(history);
  return undefined;
};

test("MANAGE_REQUESTS only: a plain USER is 403 and reaches nothing; anonymous is 401; a delegate is let through", async () => {
  requests = [approvedMovie()];
  responder = radarrResponder(movieRow());
  assert.equal((await get(null, "r1")).status, 401);
  assert.equal((await get(await mintSession({ role: "USER", permissions: 0n }), "r1")).status, 403);
  assert.deepEqual(arrCalls(), []);
  assert.equal((await get(await mintSession({ role: "USER", permissions: Permission.MANAGE_REQUESTS }), "r1")).status, 200);
});

test("only APPROVED/AVAILABLE (409); unknown 404; an unconfigured or invalid instance is refused BEFORE any upstream call", async () => {
  const token = await mintSession();
  requests = [
    approvedMovie({ id: "pending", status: "PENDING" }),
    approvedMovie({ id: "declined", status: "DECLINED" }),
    approvedMovie({ id: "available", status: "AVAILABLE" }),
    approvedMovie({ id: "anime", arrInstance: "anime" }),
    approvedMovie({ id: "bad", arrInstance: "../x" }),
  ];
  responder = radarrResponder(movieRow({ hasFile: true }));
  assert.equal((await get(token, "pending")).status, 409);
  assert.equal((await get(token, "declined")).status, 409);
  assert.equal((await get(token, "missing")).status, 404);
  assert.deepEqual(arrCalls(), []);
  assert.equal((await get(token, "anime")).status, 422);
  assert.equal((await get(token, "bad")).status, 400);
  assert.deepEqual(arrCalls(), []);
  assert.equal((await get(token, "available")).status, 200);
});

test("bound to the request's own title and instance: a 4K request reads only the 4K Radarr, by the request's tmdbId — URL params change nothing", async () => {
  requests = [approvedMovie({ arrInstance: "4k" })];
  responder = radarrResponder(movieRow({ hasFile: true }));
  const res = await get(await mintSession(), "r1", "?instance=&tmdbId=999&service=sonarr&movieId=1");
  assert.equal(res.status, 200);
  assert.ok(arrCalls().length > 0 && arrCalls().every((c) => c.origin === RADARR_4K), JSON.stringify(arrCalls()));
  assert.equal(arrCalls().find((c) => c.path === "/api/v3/movie")!.query.get("tmdbId"), "603");
});

test("a movie the requester's library already holds is ready without Radarr's file — and its queue and history are never read", async () => {
  requests = [approvedMovie()];
  jellyfinRows = [{ tmdbId: 603, mediaType: "MOVIE", serverInstance: "" }];
  responder = radarrResponder(movieRow({ hasFile: false }));
  const body = await (await get(await mintSession(), "r1")).json() as StatusBody;
  assert.equal(body.verdict, "ready");
  assert.equal(body.inLibrary, true);
  assert.deepEqual(arrCalls().map((c) => c.path), ["/api/v3/movie"]);
});

test("a title the arr already has is never asked about its queue or history", async () => {
  requests = [approvedMovie()];
  plexRows = [{ tmdbId: 603, mediaType: "MOVIE", serverInstance: "" }];
  responder = radarrResponder(movieRow({ hasFile: true }));
  const body = await (await get(await mintSession(), "r1")).json() as StatusBody;
  assert.equal(body.verdict, "ready");
  assert.deepEqual(arrCalls().map((c) => c.path), ["/api/v3/movie"]);
});

test("COARSE for delegates: no output path, download id, client, indexer, release title, arr URL or key — the arr's reason still shows, scrubbed", async () => {
  requests = [approvedMovie()];
  const planted = {
    title: "Planted.Release.Title.2160p-GRP", downloadId: "PLANTEDDOWNLOADID0123456789", downloadClient: "PlantedClientName",
    // A path with spaces: only the exact value is removed whole.
    indexer: "PlantedIndexerName", outputPath: "/planted/output dir/Planted Movie (1999)",
  };
  const blocked = {
    id: 7, movieId: 10, movie: { title: "The Matrix", tmdbId: 603 }, ...planted,
    size: 4e9, sizeleft: 0, status: "completed", trackedDownloadStatus: "warning", trackedDownloadState: "importBlocked",
    quality: { quality: { name: "Remux-2160p" } },
    statusMessages: [
      { title: "Planted.Release.Title.2160p-GRP", messages: [`No files found are eligible for import in ${planted.outputPath}`] },
      { title: "x", messages: ["Unpack failed at /planted/elsewhere/file.part01.rar via http://10.0.0.5:7878/api?apikey=radarr-key"] },
      { title: "y", messages: [`PlantedClientName reported Planted.Release.Title.2160p-GRP from PlantedIndexerName as stalled (${planted.downloadId})`] },
    ],
  };
  // A record of ANOTHER movie (an arr that ignored the movieId filter) is never read.
  const foreign = { id: 8, movieId: 99, title: "Foreign.Release", downloadId: "FOREIGN", status: "downloading", size: 1, sizeleft: 1, outputPath: "/foreign/path" };
  const history = [{ id: 3, movieId: 10, eventType: "downloadFailed", date: "2026-09-02T00:00:00Z", sourceTitle: planted.title, downloadId: planted.downloadId,
    data: { indexer: planted.indexer, downloadClientName: planted.downloadClient, downloadUrl: "https://idx/get?apikey=IDXKEY", guid: "https://idx/get?apikey=IDXKEY", message: "failed" } }];
  responder = radarrResponder(movieRow(), [blocked, foreign], history);
  const delegate = await mintSession({ role: "USER", permissions: Permission.MANAGE_REQUESTS });
  const res = await get(delegate, "r1");
  const text = await res.text();
  assert.equal(res.status, 200);
  for (const secret of [...Object.values(planted), "Planted", "/planted", "PlantedClient", "PlantedIndexer", "PLANTEDDOWNLOADID", "FOREIGN", "/foreign",
    "10.0.0.5", "7878", "radarr-key", "IDXKEY", "outputPath", "downloadId", "downloadClient", "indexer"]) {
    assert.ok(!text.includes(secret), `${secret} leaked: ${text}`);
  }
  const body = JSON.parse(text) as StatusBody;
  assert.equal(body.verdict, "importBlocked");
  assert.equal(body.canOpenQueue, false, "the Download Queue is ADMIN-only");
  assert.equal(body.downloadCount, 1, "the foreign record is not this title's");
  assert.equal(body.downloads[0].quality, "Remux-2160p");
  assert.equal(body.downloads[0].attention, true);
  assert.ok(body.downloads[0].messages.some((m) => m.startsWith("No files found are eligible for import in")), JSON.stringify(body.downloads[0].messages));
  assert.ok(body.downloads[0].messages.some((m) => m.includes("as stalled")), JSON.stringify(body.downloads[0].messages));
  // The reads were the title's own queue and history, by its arr id.
  const queueCall = arrCalls().find((c) => c.path === "/api/v3/queue/details")!;
  assert.equal(queueCall.query.get("movieId"), "10");
  assert.equal(arrCalls().find((c) => c.path === "/api/v3/history/movie")!.query.get("eventType"), "4");
  // An admin is pointed at the queue page.
  assert.equal((await (await get(await mintSession(), "r1")).json() as StatusBody).canOpenQueue, true);
});

test("Sonarr: completion is guardrail 14a's, the queue and history are read by series id, and a pack folds into one download", async () => {
  requests = [{ id: "t1", mediaType: "TV", tmdbId: 300, status: "APPROVED", arrInstance: "", requestedBy: REQUESTER, approvedAt: APPROVED_AT, createdAt: APPROVED_AT }];
  const pack = (id: number, ep: number) => ({ id, seriesId: 30, downloadId: "pack", title: "Show.S02", episode: { seasonNumber: 2, episodeNumber: ep },
    size: 5e9, sizeleft: 2.5e9, status: "downloading", trackedDownloadStatus: "ok", trackedDownloadState: "downloading", timeleft: "01:30:00" });
  let series = seriesRow([8, 8], [2, 10]);
  responder = (c) => {
    if (c.origin !== SONARR) return undefined;
    if (c.path === "/api/v3/series") return json([series]);
    if (c.path === "/api/v3/queue/details") return json([pack(1, 3), pack(2, 4)]);
    if (c.path === "/api/v3/history/series") return json([]);
    return undefined;
  };
  const token = await mintSession();
  const body = await (await get(token, "t1")).json() as StatusBody;
  assert.equal(body.verdict, "downloading");
  assert.equal(body.downloadCount, 1);
  assert.equal(body.downloads[0].episodes, 2);
  assert.equal(body.downloads[0].progress, 0.5);
  const q = arrCalls().find((c) => c.path === "/api/v3/queue/details")!;
  assert.equal(q.query.get("seriesId"), "30");
  assert.equal(q.query.get("includeEpisode"), "true");
  assert.equal(arrCalls().find((c) => c.path === "/api/v3/history/series")!.query.get("eventType"), "4");
  assert.equal(arrCalls().find((c) => c.path === "/api/v3/series")!.query.get("tvdbId"), "3000");

  // Every regular episode on disk, the special still missing: complete.
  series = seriesRow([8, 8], [10, 10]);
  calls = [];
  const done = await (await get(token, "t1")).json() as StatusBody;
  assert.equal(done.verdict, "inArrNotInLibrary");
  assert.deepEqual(done.episodes, { withFile: 18, total: 18 });
});

test("Sonarr found only through its lookup: the series' own resource is read by its id; gone by then reads as not in Sonarr", async () => {
  tmdbCacheRows.clear(); // no TVDB cross-reference: findTitle falls back to Sonarr's lookup
  requests = [{ id: "t1", mediaType: "TV", tmdbId: 300, status: "APPROVED", arrInstance: "", requestedBy: REQUESTER, approvedAt: APPROVED_AT, createdAt: APPROVED_AT }];
  let gone = false;
  responder = (c) => {
    if (c.origin !== SONARR) return undefined;
    if (c.path === "/api/v3/series/lookup") return json([{ id: 30, tmdbId: 300, tvdbId: 3000, title: "Show" }]);
    if (c.path === "/api/v3/series/30") return gone ? new Response("nope", { status: 404 }) : json(seriesRow([8, 8], [10, 10]));
    return undefined;
  };
  const token = await mintSession();
  const body = await (await get(token, "t1")).json() as StatusBody;
  assert.equal(body.verdict, "inArrNotInLibrary");
  assert.deepEqual(body.episodes, { withFile: 18, total: 18 });
  gone = true;
  assert.equal((await (await get(token, "t1")).json() as StatusBody).verdict, "notInArr");
});

test("a failed read is the `unreachable` verdict with its kind — never a 500, never a guess", async () => {
  requests = [approvedMovie()];
  const token = await mintSession();
  responder = (c) => (c.path === "/api/v3/movie" ? new Response("down", { status: 503 }) : undefined);
  let body = await (await get(token, "r1")).json() as StatusBody;
  assert.equal(body.verdict, "unreachable");
  assert.equal(body.errorKind, "unreachable");
  responder = (c) => (c.path === "/api/v3/movie" ? json([movieRow()]) : c.path === "/api/v3/queue/details" ? new Response("no", { status: 401 }) : c.path === "/api/v3/history/movie" ? json([]) : undefined);
  body = await (await get(token, "r1")).json() as StatusBody;
  assert.equal(body.verdict, "unreachable");
  assert.equal(body.errorKind, "auth");
  assert.ok(warnLines.some((l) => l.includes("[request-arr-status]") && l.includes("queue read")), warnLines.join("\n"));
});

test("a failure counts from the request's APPROVAL, not its creation", async () => {
  requests = [approvedMovie({ approvedAt: APPROVED_AT, createdAt: new Date("2026-08-01T00:00:00Z") })];
  const failure = (date: string) => ({ id: 3, movieId: 10, eventType: "downloadFailed", date, sourceTitle: "x", data: {} });
  const token = await mintSession();
  responder = radarrResponder(movieRow(), [], [failure("2026-08-15T00:00:00Z")]);
  assert.equal((await (await get(token, "r1")).json() as StatusBody).verdict, "waiting");
  responder = radarrResponder(movieRow(), [], [failure("2026-09-15T00:00:00Z")]);
  const body = await (await get(token, "r1")).json() as StatusBody;
  assert.equal(body.verdict, "downloadFailed");
  assert.equal(body.failures.count, 1);
  // A request with no recorded approval counts from its creation.
  requests = [approvedMovie({ approvedAt: null })];
  responder = radarrResponder(movieRow(), [], [failure("2026-08-15T00:00:00Z")]);
  assert.equal((await (await get(token, "r1")).json() as StatusBody).verdict, "downloadFailed");
});

test("the library check counts only servers the REQUESTER can see (guardrail 35)", async () => {
  requests = [approvedMovie()];
  settings.set("plexInstances", JSON.stringify([{ slug: "remote", name: "Remote", restricted: true }]));
  plexRows = [{ tmdbId: 603, mediaType: "MOVIE", serverInstance: "remote" }];
  responder = radarrResponder(movieRow({ hasFile: true }));
  const token = await mintSession();
  assert.equal((await (await get(token, "r1")).json() as StatusBody).verdict, "inArrNotInLibrary");
  usersById.set(REQUESTER, { role: "USER", permissions: 0n, mediaServerGrants: { plex: { remote: { view: true } } } });
  assert.equal((await (await get(token, "r1")).json() as StatusBody).verdict, "ready");
});

test("rate limited per caller", async () => {
  requests = [approvedMovie()];
  responder = radarrResponder(movieRow({ hasFile: true }));
  const token = await mintSession();
  let last = 0;
  for (let i = 0; i < 31; i++) last = (await get(token, "r1")).status;
  assert.equal(last, 429);
  assert.equal((await get(await mintSession(), "r1")).status, 200, "another caller has their own budget");
});
