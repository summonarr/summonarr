// "Replace file" on an issue: GET/POST /api/issues/[id]/files and its pure
// half, src/lib/issue-replace.ts.
//
// Why the feature exists: while a file is on disk Radarr/Sonarr only take an
// UPGRADE of it, so the issue's Refetch can never replace a broken file that
// is already at the profile's cutoff. Replace file deletes it first.
//
// What is pinned:
//   1. ADMIN ONLY (guardrail 6a): anonymous is 401, an ISSUE_ADMIN — who keeps
//      Refetch and Replace-release — is 403, and nothing reaches Radarr/Sonarr.
//   2. Scope: only the files the issue is about are offered and deletable
//      (FULL: all; SEASON: that season's; EPISODE: the file holding the S/E).
//      An id outside the scope, or not the title's, is 409 with NOTHING
//      deleted and the issue untouched (guardrail 5e — re-read at POST time).
//   3. Grab mapping: a file's grab is the newest grab of the download its
//      newest import came from — a re-grabbed torrent (same info hash) maps to
//      the second grab; a deletion after the import (other than an upgrade's)
//      makes the grab unknown; a movie with two files needs the import's path.
//   4. Mark failed is ONE mark per download (guardrail 5c) — a season pack's
//      two episode files are one POST /history/failed — and the arr's own
//      Redownload Failed decides whether we also search: on ⇒ no search of
//      ours; off ⇒ we search. A file with no grab is searched for instead.
//   5. Searches are scoped and never SeriesSearch: an EPISODE issue is one
//      EpisodeSearch for the deleted file's episodes; a SEASON issue with files
//      left in the season is an EpisodeSearch (a SeasonSearch beside files on
//      disk hunts upgrades), with the whole season gone a SeasonSearch.
//   6. The issue flips OPEN → IN_PROGRESS with the release grab's CAS BEFORE
//      the delete; a CAS that loses (resolved meanwhile) deletes nothing. An
//      IssueGrab row is recorded on the issue's instance.
//   7. Audits after the arr accepted each write (guardrail 26): the flip,
//      ARR_FILE_DELETE with exactly the deleted ids (a Radarr delete that
//      stops part-way audits the part that happened), ARR_MARK_FAILED per mark;
//      a failing audit write never fails the replace.
//   8. "Unmonitor Deleted Movies/Episodes": what the delete unmonitored — and
//      only that — is set back to monitored BEFORE the mark or the search
//      (a SeasonSearch, the Missing plan and the arr's redownload all search
//      monitored items only), audited ARR_TITLE_EDIT. A failed re-monitor, or
//      an episode the admin had unmonitored, is searched for BY NAME
//      (EpisodeSearch) and no mark counts as covering it.
//   9. "Redownload Failed from Interactive Search": a grab picked by hand
//      (data.releaseSource InteractiveSearch) is redownloaded by the arr only
//      when that switch is on too; off ⇒ we search. Absent (an older arr) ⇒
//      the main switch decides.
//  10. The listing names each file's episodes by SONARR's titles, and carries
//      the series type (anime numbering can differ from the media server's).
//
// Harness: tests/issues-routes.test.mts's request scope + session fixture over
// tests/arr-manage-routes.test.mts's scripted Radarr/Sonarr fetch.
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import dns from "node:dns/promises";
import { createRequire } from "node:module";
import { AsyncLocalStorage } from "node:async_hooks";

(globalThis as { AsyncLocalStorage?: unknown }).AsyncLocalStorage = AsyncLocalStorage;

process.env.TOKEN_ENCRYPTION_KEY = "ab".repeat(32);
process.env.NEXTAUTH_SECRET = "issue-replace-file-test-secret-0123456789abcdef";
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

// ── one ordered log of DB writes and arr calls ───────────────────────────────
let seq: string[] = [];

// ── scripted Radarr/Sonarr ───────────────────────────────────────────────────
const RADARR = "http://10.0.0.5:7878";
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
  if (method !== "GET") seq.push(`arr:${method} ${url.pathname}`);
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
const { projectHistoryRecords } = await import("../src/lib/arr-history.ts");
const { projectEpisodes, projectFiles } = await import("../src/lib/arr-title.ts");
const { _resetReleaseSearchJobsForTests } = await import("../src/lib/release-search-jobs.ts");
const { _resetMarkClaimsForTests } = await import("../src/lib/arr-title-data.ts");
const replace = await import("../src/lib/issue-replace.ts");

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

let issueRow: Record<string, unknown> | null = null;
let casCount = 1;
// Runs once, right after the route's read — e.g. another admin resolving the issue meanwhile.
let afterIssueRead: (() => void) | null = null;
shadowPrismaModel(prisma, "issue", {
  findUnique: async () => {
    const row = issueRow ? { ...issueRow } : null;
    const after = afterIssueRead;
    afterIssueRead = null;
    after?.();
    return row;
  },
  // Honours the CAS's own predicate (`status: { not: "RESOLVED" }`), so a route
  // that dropped it would flip a resolved issue — and the test below would see it.
  updateMany: async (args: { where: { id?: string; status?: { not?: string } }; data: Record<string, unknown> }) => {
    seq.push("db:issue.updateMany");
    const refused = args.where.status?.not !== undefined && issueRow?.status === args.where.status.not;
    const count = casCount > 0 && issueRow && !refused ? 1 : 0;
    if (count > 0 && issueRow) Object.assign(issueRow, args.data);
    return { count };
  },
});
const grabs: Array<Record<string, unknown>> = [];
shadowPrismaModel(prisma, "issueGrab", {
  create: async (args: { data: Record<string, unknown> }) => {
    seq.push("db:issueGrab.create");
    grabs.push(args.data);
    return { id: `grab-${grabs.length}`, ...args.data };
  },
});
const audits: Array<{ action: string; details: Record<string, unknown> }> = [];
let auditThrows = false;
shadowPrismaModel(prisma, "auditLog", {
  create: async (args: { data: { action: string; details?: unknown } }) => {
    if (auditThrows) throw new Error("stubbed audit write failure");
    audits.push({ action: args.data.action, details: JSON.parse(String(args.data.details ?? "{}")) as Record<string, unknown> });
    return {};
  },
});

const route = await import("../src/app/api/issues/[id]/files/route.ts");

function inScope<T>(fn: () => Promise<T>): Promise<T> {
  const workStore = { route: "/issue-replace-file.test", forceStatic: false, dynamicShouldError: false, afterContext: { after: () => {} } };
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
const ctx = (id: string) => ({ params: Promise.resolve({ id }) });
const getFiles = (token: string | null, id: string, query = "") =>
  inScope(() => (route.GET as unknown as Handler)(
    new NextRequest(`http://localhost:3000/api/issues/${id}/files${query}`, { headers: token ? { cookie: `${COOKIE}=${token}` } : {} }),
    ctx(id),
  ));
const postFiles = (token: string | null, id: string, body: unknown) =>
  inScope(() => (route.POST as unknown as Handler)(
    new NextRequest(`http://localhost:3000/api/issues/${id}/files`, {
      method: "POST",
      headers: { ...(token ? { cookie: `${COOKIE}=${token}` } : {}), "content-type": "application/json" },
      body: JSON.stringify(body),
    }),
    ctx(id),
  ));
const arrCalls = () => calls.filter((c) => c.origin !== "http://localhost:3000");
const writes = () => arrCalls().filter((c) => c.method !== "GET");
const commands = () => writes().filter((c) => c.path === "/api/v3/command").map((c) => c.body as Record<string, unknown>);

// ── fixtures ─────────────────────────────────────────────────────────────────
const MOVIE_FILE_PATH = "/movies/The Matrix (1999)/The Matrix.mkv";
const movie = { id: 11, tmdbId: 603, title: "The Matrix", year: 1999, monitored: true, hasFile: true, path: "/movies/The Matrix (1999)" };
let movieFiles: Array<Record<string, unknown>> = [];
let movieHistory: Array<Record<string, unknown>> = [];
const series = {
  id: 21, tvdbId: 81189, tmdbId: 1396, title: "Breaking Bad", monitored: true, path: "/tv/Breaking Bad",
  seasons: [
    { seasonNumber: 1, monitored: true, statistics: { episodeCount: 2, episodeFileCount: 2 } },
    { seasonNumber: 2, monitored: true, statistics: { episodeCount: 2, episodeFileCount: 2 } },
  ],
};
const EPISODES = [
  { id: 101, seriesId: 21, seasonNumber: 1, episodeNumber: 1, title: "Pilot", monitored: true, hasFile: true, episodeFileId: 501, airDateUtc: "2008-01-20T02:00:00Z" },
  { id: 102, seriesId: 21, seasonNumber: 1, episodeNumber: 2, title: "Cat's in the Bag", monitored: true, hasFile: true, episodeFileId: 502, airDateUtc: "2008-01-27T02:00:00Z" },
  { id: 201, seriesId: 21, seasonNumber: 2, episodeNumber: 1, title: "Seven Thirty-Seven", monitored: true, hasFile: true, episodeFileId: 503, airDateUtc: "2009-03-09T02:00:00Z" },
  { id: 202, seriesId: 21, seasonNumber: 2, episodeNumber: 2, title: "Grilled", monitored: true, hasFile: true, episodeFileId: 504, airDateUtc: "2009-03-16T02:00:00Z" },
];
const EPISODE_FILES = [
  { id: 501, seriesId: 21, seasonNumber: 1, relativePath: "Season 01/S01E01.mkv", path: "/tv/Breaking Bad/Season 01/S01E01.mkv", size: 1e9, quality: { quality: { name: "Bluray-1080p" } } },
  { id: 502, seriesId: 21, seasonNumber: 1, relativePath: "Season 01/S01E02.mkv", path: "/tv/Breaking Bad/Season 01/S01E02.mkv", size: 1e9, quality: { quality: { name: "Bluray-1080p" } } },
  { id: 503, seriesId: 21, seasonNumber: 2, relativePath: "Season 02/S02E01.mkv", path: "/tv/Breaking Bad/Season 02/S02E01.mkv", size: 2e9, quality: { quality: { name: "Bluray-1080p" } } },
  { id: 504, seriesId: 21, seasonNumber: 2, relativePath: "Season 02/S02E02.mkv", path: "/tv/Breaking Bad/Season 02/S02E02.mkv", size: 2e9, quality: { quality: { name: "Bluray-1080p" } } },
];
const ep = (s: number, e: number) => ({ seasonNumber: s, episodeNumber: e });
const APIKEY = "s3cr3t-indexer-apikey";
// S01E01: its own grab + import. S01E02: no history at all (copied in by hand).
// Season 2: one pack — Sonarr writes a grab and an import PER EPISODE.
const SERIES_HISTORY = [
  { id: 60, seriesId: 21, episodeId: 101, episode: ep(1, 1), eventType: "grabbed", date: "2026-09-01T10:00:00Z", sourceTitle: "Breaking.Bad.S01E01.1080p", downloadId: "E1",
    data: { downloadUrl: `https://indexer.example/getnzb?apikey=${APIKEY}`, guid: `https://indexer.example/d/1?apikey=${APIKEY}` } },
  { id: 61, seriesId: 21, episodeId: 101, episode: ep(1, 1), eventType: "downloadFolderImported", date: "2026-09-01T11:00:00Z", sourceTitle: "Breaking.Bad.S01E01.1080p", downloadId: "E1",
    data: { importedPath: "/tv/Breaking Bad/Season 01/S01E01.mkv" } },
  { id: 70, seriesId: 21, episodeId: 201, episode: ep(2, 1), eventType: "grabbed", date: "2026-10-01T10:00:00Z", sourceTitle: "Breaking.Bad.S02.1080p", downloadId: "PACK" },
  { id: 71, seriesId: 21, episodeId: 202, episode: ep(2, 2), eventType: "grabbed", date: "2026-10-01T10:00:00Z", sourceTitle: "Breaking.Bad.S02.1080p", downloadId: "PACK" },
  { id: 72, seriesId: 21, episodeId: 201, episode: ep(2, 1), eventType: "downloadFolderImported", date: "2026-10-01T11:00:00Z", sourceTitle: "Breaking.Bad.S02.1080p", downloadId: "PACK", data: { importedPath: "/tv/Breaking Bad/Season 02/S02E01.mkv" } },
  { id: 73, seriesId: 21, episodeId: 202, episode: ep(2, 2), eventType: "downloadFolderImported", date: "2026-10-01T11:00:00Z", sourceTitle: "Breaking.Bad.S02.1080p", downloadId: "PACK", data: { importedPath: "/tv/Breaking Bad/Season 02/S02E02.mkv" } },
];
let seriesHistory: Array<Record<string, unknown>> = [];
// What Sonarr has deleted this test: its episodes read back without a file
// (and unmonitored, when its "Unmonitor Deleted Episodes" is on).
let deletedEpisodeFiles = new Set<number>();
let unmonitorDeleted = false;
// Monitoring set since the fixture: by the admin before the test, or by PUT /episode/monitor.
let episodeMonitored = new Map<number, boolean>();
let monitorPutFails = false;
// A Sonarr command that answers 503 (Sonarr under import load) — matched on the command body.
let sonarrCommandFails: ((body: Record<string, unknown>) => boolean) | null = null;
const liveEpisodes = () => EPISODES.map((e) => {
  const gone = deletedEpisodeFiles.has(e.episodeFileId);
  const base = episodeMonitored.get(e.id) ?? e.monitored;
  return gone ? { ...e, hasFile: false, episodeFileId: 0, monitored: base } : { ...e, monitored: base };
});
let redownloadConfig: unknown = { autoRedownloadFailed: true };
let radarrDeleteFailsFor: number | null = null;
// Radarr's movie: unmonitored by a delete while "Unmonitor Deleted Movies" is on.
let movieMonitored = true;
let movieEditorFails = false;
// Radarr's `isAvailable` (Minimum Availability reached); undefined = the arr doesn't say.
let movieIsAvailable: boolean | undefined;
const liveMovie = () => ({ ...movie, monitored: movieMonitored, ...(movieIsAvailable === undefined ? {} : { isAvailable: movieIsAvailable }) });

const radarr: Responder = (c) => {
  if (c.origin !== RADARR) return undefined;
  if (c.method === "GET") {
    if (c.path === "/api/v3/movie" && c.query.get("tmdbId") === "603") return json([liveMovie()]);
    if (c.path === "/api/v3/movie") return json([]);
    if (c.path === "/api/v3/movie/11") return json(liveMovie());
    if (c.path === "/api/v3/moviefile") return json(movieFiles);
    if (c.path === "/api/v3/history/movie") return json(movieHistory);
    if (c.path === "/api/v3/config/downloadclient") return json(redownloadConfig);
  }
  if (c.method === "DELETE" && c.path.startsWith("/api/v3/moviefile/")) {
    if (Number(c.path.split("/").pop()) === radarrDeleteFailsFor) return json({ message: "locked" }, 500);
    if (unmonitorDeleted) movieMonitored = false;
    return new Response("", { status: 200 });
  }
  if (c.method === "PUT" && c.path === "/api/v3/movie/editor") {
    if (movieEditorFails) return json({ message: "database is locked" }, 500);
    const b = c.body as { movieIds: number[]; monitored?: boolean };
    if (b.movieIds.includes(11) && typeof b.monitored === "boolean") movieMonitored = b.monitored;
    return json([liveMovie()], 202);
  }
  if (c.method === "POST" && c.path.startsWith("/api/v3/history/failed/")) return json({});
  if (c.method === "POST" && c.path === "/api/v3/command") return json({ id: 5 }, 201);
  return undefined;
};
const sonarr: Responder = (c) => {
  if (c.origin !== SONARR) return undefined;
  if (c.method === "GET") {
    if (c.path === "/api/v3/series" && c.query.get("tvdbId") === "81189") return json([series]);
    if (c.path === "/api/v3/series/21") return json(series);
    if (c.path === "/api/v3/episode" && c.query.get("seriesId") === "21") {
      const season = c.query.get("seasonNumber");
      return json(season === null ? liveEpisodes() : liveEpisodes().filter((e) => String(e.seasonNumber) === season));
    }
    const one = /^\/api\/v3\/episode\/(\d+)$/.exec(c.path);
    if (one) {
      const e = liveEpisodes().find((x) => String(x.id) === one[1]);
      return e ? json(e) : new Response("{}", { status: 404 });
    }
    if (c.path === "/api/v3/episodefile") return json(EPISODE_FILES.filter((f) => !deletedEpisodeFiles.has(f.id)));
    if (c.path === "/api/v3/history/series") return json(seriesHistory);
    if (c.path === "/api/v3/config/downloadclient") return json(redownloadConfig);
  }
  if (c.method === "DELETE" && c.path === "/api/v3/episodefile/bulk") {
    for (const id of (c.body as { episodeFileIds: number[] }).episodeFileIds) {
      deletedEpisodeFiles.add(id);
      // Sonarr's "Unmonitor Deleted Episodes": the episodes the file held go unmonitored.
      if (unmonitorDeleted) for (const e of EPISODES) if (e.episodeFileId === id) episodeMonitored.set(e.id, false);
    }
    return new Response("", { status: 200 });
  }
  if (c.method === "PUT" && c.path === "/api/v3/episode/monitor") {
    if (monitorPutFails) return json({ message: "database is locked" }, 500);
    const b = c.body as { episodeIds: number[]; monitored: boolean };
    for (const id of b.episodeIds) episodeMonitored.set(id, b.monitored);
    return json([], 202);
  }
  if (c.method === "POST" && c.path.startsWith("/api/v3/history/failed/")) return json({});
  if (c.method === "POST" && c.path === "/api/v3/command") {
    if (sonarrCommandFails?.(c.body as Record<string, unknown>)) return json({ message: "Service Unavailable" }, 503);
    return json({ id: 6 }, 201);
  }
  return undefined;
};

const issue = (over: Record<string, unknown>) => ({
  id: "issue-1", status: "OPEN", reportedBy: "reporter-1", title: "x", tvdbId: null,
  scope: "FULL", seasonNumber: null, episodeNumber: null, ...over,
});
const MOVIE_ISSUE = issue({ tmdbId: 603, mediaType: "MOVIE", title: "The Matrix" });
const SEASON_ISSUE = issue({ tmdbId: 1396, mediaType: "TV", title: "Breaking Bad", scope: "SEASON", seasonNumber: 2 });
const EPISODE_ISSUE = issue({ tmdbId: 1396, mediaType: "TV", title: "Breaking Bad", scope: "EPISODE", seasonNumber: 1, episodeNumber: 1 });

beforeEach(() => {
  calls = [];
  seq = [];
  audits.length = 0;
  grabs.length = 0;
  warnLines = [];
  auditThrows = false;
  casCount = 1;
  afterIssueRead = null;
  _resetReleaseSearchJobsForTests();
  _resetMarkClaimsForTests();
  redownloadConfig = { autoRedownloadFailed: true };
  radarrDeleteFailsFor = null;
  deletedEpisodeFiles = new Set();
  unmonitorDeleted = false;
  episodeMonitored = new Map();
  monitorPutFails = false;
  sonarrCommandFails = null;
  movieMonitored = true;
  movieEditorFails = false;
  movieIsAvailable = undefined;
  movieFiles = [{ id: 7, movieId: 11, relativePath: "The Matrix.mkv", path: MOVIE_FILE_PATH, size: 4e9, quality: { quality: { name: "Remux-1080p" } } }];
  movieHistory = [
    { id: 900, movieId: 11, eventType: "grabbed", date: "2026-10-01T10:00:00Z", sourceTitle: "The.Matrix.1999.1080p", downloadId: "abc",
      data: { downloadUrl: `https://indexer.example/getnzb?apikey=${APIKEY}` } },
    { id: 901, movieId: 11, eventType: "downloadFolderImported", date: "2026-10-01T11:00:00Z", sourceTitle: "The.Matrix.1999.1080p", downloadId: "abc", data: { importedPath: MOVIE_FILE_PATH } },
  ];
  seriesHistory = SERIES_HISTORY.map((r) => ({ ...r }));
  responder = (c) => radarr(c) ?? sonarr(c);
  issueRow = null;
  tmdbCacheRows.clear();
  tmdbCacheRows.set("tmdb-to-tvdb:1396", JSON.stringify({ tvdbId: 81189 }));
  settings.clear();
  for (const [k, v] of Object.entries({
    radarrUrl: RADARR, radarrApiKey: "radarr-key",
    sonarrUrl: SONARR, sonarrApiKey: "sonarr-key",
  })) settings.set(k, v);
  invalidateFeatureFlagCache();
});

// ── pure: scope and grab mapping ─────────────────────────────────────────────

const sonarrFiles = () => projectFiles("sonarr", EPISODE_FILES, projectEpisodes(EPISODES));
const sonarrHistory = (raw: unknown[] = SERIES_HISTORY) => projectHistoryRecords("sonarr", "", raw);

test("scope: a movie is the movie, FULL every file, SEASON its season's, EPISODE the file holding the S/E; a TV scope without its numbers is null", () => {
  const files = sonarrFiles();
  const ids = (s: Parameters<typeof replace.fileInScope>[1]) => files.filter((f) => replace.fileInScope(f, s)).map((f) => f.id);
  assert.deepEqual(replace.replaceScopeOf({ mediaType: "MOVIE", scope: "EPISODE", seasonNumber: 1, episodeNumber: 1 }), { kind: "movie" });
  assert.deepEqual(ids({ kind: "series" }), [501, 502, 503, 504]);
  assert.deepEqual(ids(replace.replaceScopeOf({ mediaType: "TV", scope: "SEASON", seasonNumber: 2, episodeNumber: null })!), [503, 504]);
  assert.deepEqual(ids(replace.replaceScopeOf({ mediaType: "TV", scope: "EPISODE", seasonNumber: 1, episodeNumber: 2 })!), [502]);
  assert.equal(replace.replaceScopeOf({ mediaType: "TV", scope: "SEASON", seasonNumber: null, episodeNumber: null }), null);
  assert.equal(replace.replaceScopeOf({ mediaType: "TV", scope: "EPISODE", seasonNumber: 1, episodeNumber: null }), null);
});

test("grab mapping: each file's grab is the newest grab of the download its import came from; a file with no import has none", () => {
  const files = replace.replaceableFiles("sonarr", { kind: "series" }, sonarrFiles(), sonarrHistory());
  assert.deepEqual(files.map((f) => [f.id, f.grab?.event.id ?? null, f.grab?.failed ?? null]), [
    [501, 60, false],
    [502, null, null],
    // A pack: both episodes' grabs name the download — the newest stands for it.
    [503, 71, false],
    [504, 71, false],
  ]);
  // The projected grab never carries the release's download URL or guid.
  assert.ok(!JSON.stringify(files).includes(APIKEY));
});

test("grab mapping: a torrent re-grabbed after a failure (same info hash) maps to the SECOND grab; a failure after the grab marks it failed", () => {
  const regrab = [
    { id: 50, seriesId: 21, episode: ep(1, 1), eventType: "grabbed", sourceTitle: "old", downloadId: "HASH" },
    { id: 51, seriesId: 21, episode: ep(1, 1), eventType: "downloadFailed", sourceTitle: "old", downloadId: "HASH" },
    { id: 60, seriesId: 21, episode: ep(1, 1), eventType: "grabbed", sourceTitle: "new", downloadId: "HASH" },
    { id: 61, seriesId: 21, episode: ep(1, 1), eventType: "downloadFolderImported", sourceTitle: "new", downloadId: "HASH" },
  ];
  const [f] = replace.replaceableFiles("sonarr", { kind: "episode", seasonNumber: 1, episodeNumber: 1 }, sonarrFiles(), sonarrHistory(regrab));
  assert.deepEqual([f.grab?.event.id, f.grab?.failed], [60, false]);
  // Grabbed AGAIN after the import (same hash, still downloading): not the grab that made the file on disk.
  const regrabbedSince = [...regrab, { id: 63, seriesId: 21, episode: ep(1, 1), eventType: "grabbed", sourceTitle: "again", downloadId: "HASH" }];
  assert.equal(replace.replaceableFiles("sonarr", { kind: "episode", seasonNumber: 1, episodeNumber: 1 }, sonarrFiles(), sonarrHistory(regrabbedSince))[0].grab?.event.id, 60);
  const failedSince = [...regrab, { id: 62, seriesId: 21, episode: ep(1, 1), eventType: "downloadFailed", sourceTitle: "new", downloadId: "HASH" }];
  const [g] = replace.replaceableFiles("sonarr", { kind: "episode", seasonNumber: 1, episodeNumber: 1 }, sonarrFiles(), sonarrHistory(failedSince));
  assert.deepEqual([g.grab?.event.id, g.grab?.failed], [60, true]);
});

test("grab mapping: a deletion after the import makes the grab unknown — except the upgrade deletion that makes room for an import", () => {
  const scope = { kind: "episode", seasonNumber: 1, episodeNumber: 1 } as const;
  const deleted = [...SERIES_HISTORY, { id: 62, seriesId: 21, episode: ep(1, 1), eventType: "episodeFileDeleted", sourceTitle: "x", data: { reason: "Manual" } }];
  assert.equal(replace.replaceableFiles("sonarr", scope, sonarrFiles(), sonarrHistory(deleted))[0].grab, null);
  const upgrade = [...SERIES_HISTORY, { id: 62, seriesId: 21, episode: ep(1, 1), eventType: "episodeFileDeleted", sourceTitle: "x", data: { reason: "Upgrade" } }];
  assert.equal(replace.replaceableFiles("sonarr", scope, sonarrFiles(), sonarrHistory(upgrade))[0].grab?.event.id, 60);
});

test("grab mapping: a movie with two files needs an import naming the file's path; a multi-episode file's episodes must agree on one download", () => {
  const twoFiles = projectFiles("radarr", [
    { id: 7, movieId: 11, relativePath: "a.mkv", path: "/m/a.mkv", size: 1 },
    { id: 8, movieId: 11, relativePath: "b.mkv", path: "/m/b.mkv", size: 1 },
  ]);
  const hist = projectHistoryRecords("radarr", "", [
    { id: 1, movieId: 11, eventType: "grabbed", sourceTitle: "A", downloadId: "A" },
    { id: 2, movieId: 11, eventType: "downloadFolderImported", sourceTitle: "A", downloadId: "A", data: { importedPath: "/m/a.mkv" } },
    { id: 3, movieId: 11, eventType: "grabbed", sourceTitle: "B", downloadId: "B" },
    { id: 4, movieId: 11, eventType: "downloadFolderImported", sourceTitle: "B", downloadId: "B", data: { importedPath: "/elsewhere/b.mkv" } },
  ]);
  const files = replace.replaceableFiles("radarr", { kind: "movie" }, twoFiles, hist);
  assert.deepEqual(files.map((f) => [f.id, f.grab?.event.id ?? null]), [[7, 1], [8, null]]);

  // One file holding S02E01-E02 whose two episodes were imported from DIFFERENT downloads.
  const multi = projectFiles("sonarr", [{ id: 600, seriesId: 21, seasonNumber: 2, relativePath: "S02E01-E02.mkv", size: 1 }], projectEpisodes([
    { ...EPISODES[2], episodeFileId: 600 }, { ...EPISODES[3], episodeFileId: 600 },
  ]));
  const split = sonarrHistory([
    { id: 1, seriesId: 21, episode: ep(2, 1), eventType: "grabbed", sourceTitle: "x", downloadId: "X" },
    { id: 2, seriesId: 21, episode: ep(2, 2), eventType: "grabbed", sourceTitle: "y", downloadId: "Y" },
    { id: 3, seriesId: 21, episode: ep(2, 1), eventType: "downloadFolderImported", sourceTitle: "x", downloadId: "X" },
    { id: 4, seriesId: 21, episode: ep(2, 2), eventType: "downloadFolderImported", sourceTitle: "y", downloadId: "Y" },
  ]);
  assert.equal(replace.replaceableFiles("sonarr", { kind: "series" }, multi, split)[0].grab, null);
});

test("grab mapping: an import naming ANOTHER path is a guess — unknown unless a later rename of the unit names this file; an import with no path still stands", () => {
  const scope = { kind: "episode", seasonNumber: 1, episodeNumber: 1 } as const;
  // The import on record put a DIFFERENT file there (a manual in-folder import since wrote no history).
  const other = SERIES_HISTORY.map((r) => (r.id === 61 ? { ...r, data: { importedPath: "/tv/Breaking Bad/Season 01/OTHER.mkv" } } : r));
  assert.equal(replace.replaceableFiles("sonarr", scope, sonarrFiles(), sonarrHistory(other))[0].grab, null);
  // Renamed afterwards to the file on disk (the rename record's relative path): the same file, attributed.
  const renamed = [...other, { id: 62, seriesId: 21, episode: ep(1, 1), eventType: "episodeFileRenamed", sourceTitle: "x", data: { sourceRelativePath: "Season 01/OTHER.mkv", relativePath: "Season 01/S01E01.mkv" } }];
  assert.equal(replace.replaceableFiles("sonarr", scope, sonarrFiles(), sonarrHistory(renamed))[0].grab?.event.id, 60);
  // A rename to some other name, or one BEFORE the import, proves nothing.
  const renamedElsewhere = [...other, { id: 62, seriesId: 21, episode: ep(1, 1), eventType: "episodeFileRenamed", sourceTitle: "x", data: { relativePath: "Season 01/ELSE.mkv" } }];
  assert.equal(replace.replaceableFiles("sonarr", scope, sonarrFiles(), sonarrHistory(renamedElsewhere))[0].grab, null);
  const renamedBefore = [...other, { id: 59, seriesId: 21, episode: ep(1, 1), eventType: "episodeFileRenamed", sourceTitle: "x", data: { relativePath: "Season 01/S01E01.mkv" } }];
  assert.equal(replace.replaceableFiles("sonarr", scope, sonarrFiles(), sonarrHistory(renamedBefore))[0].grab, null);
  // A single-file movie whose import names another path: the same rule.
  const movieFile = projectFiles("radarr", [{ id: 7, movieId: 11, relativePath: "The Matrix.mkv", path: MOVIE_FILE_PATH, size: 1 }]);
  const movieHist = (path: string | null) => projectHistoryRecords("radarr", "", [
    { id: 1, movieId: 11, eventType: "grabbed", sourceTitle: "A", downloadId: "A" },
    { id: 2, movieId: 11, eventType: "downloadFolderImported", sourceTitle: "A", downloadId: "A", data: path === null ? {} : { importedPath: path } },
  ]);
  assert.equal(replace.replaceableFiles("radarr", { kind: "movie" }, movieFile, movieHist("/movies/The Matrix (1999)/old.mkv"))[0].grab, null);
  assert.equal(replace.replaceableFiles("radarr", { kind: "movie" }, movieFile, movieHist(null))[0].grab?.event.id, 1, "no path on record: still the movie's import");
});

test("grab mapping: a title FOLDER that moved since the import keeps its attribution — the import names the same relative file", () => {
  const scope = { kind: "episode", seasonNumber: 1, episodeNumber: 1 } as const;
  // The series moved /old → /tv (no history record for a move): same relative path, other folder.
  const moved = SERIES_HISTORY.map((r) => (r.id === 61 ? { ...r, data: { importedPath: "/old/Breaking Bad/Season 01/S01E01.mkv" } } : r));
  assert.equal(replace.replaceableFiles("sonarr", scope, sonarrFiles(), sonarrHistory(moved))[0].grab?.event.id, 60);
  // A Windows-separated import path is the same file too.
  const movedWin = SERIES_HISTORY.map((r) => (r.id === 61 ? { ...r, data: { importedPath: "D:\\TV\\Breaking Bad\\Season 01\\S01E01.mkv" } } : r));
  assert.equal(replace.replaceableFiles("sonarr", scope, sonarrFiles(), sonarrHistory(movedWin))[0].grab?.event.id, 60);
  // A suffix that isn't on a separator boundary is a different file.
  const notBoundary = SERIES_HISTORY.map((r) => (r.id === 61 ? { ...r, data: { importedPath: "/old/Breaking Bad/XSeason 01/S01E01.mkv" } } : r));
  assert.equal(replace.replaceableFiles("sonarr", scope, sonarrFiles(), sonarrHistory(notBoundary))[0].grab, null);
  // The Radarr twin.
  const movieFile = projectFiles("radarr", [{ id: 7, movieId: 11, relativePath: "The Matrix.mkv", path: MOVIE_FILE_PATH, size: 1 }]);
  const movieHist = projectHistoryRecords("radarr", "", [
    { id: 1, movieId: 11, eventType: "grabbed", sourceTitle: "A", downloadId: "A" },
    { id: 2, movieId: 11, eventType: "downloadFolderImported", sourceTitle: "A", downloadId: "A", data: { importedPath: "/old/The Matrix (1999)/The Matrix.mkv" } },
  ]);
  assert.equal(replace.replaceableFiles("radarr", { kind: "movie" }, movieFile, movieHist)[0].grab?.event.id, 1);
});

test("marks: ONE per download — a season pack's files share one mark; a failed or unknown grab gets none", () => {
  const files = replace.replaceableFiles("sonarr", { kind: "series" }, sonarrFiles(), sonarrHistory());
  const marks = replace.planMarks(files);
  assert.deepEqual(marks.map((m) => [m.grab.id, m.fileIds]), [[60, [501]], [71, [503, 504]]]);
  const failed = files.map((f) => (f.grab ? { ...f, grab: { ...f.grab, failed: true } } : f));
  assert.deepEqual(replace.planMarks(failed), []);
});

test("follow-up search: scoped, and never a whole-season search beside files still on disk", () => {
  const files = sonarrFiles();
  const byId = (...ids: number[]) => files.filter((f) => ids.includes(f.id));
  const season2 = { kind: "season", seasonNumber: 2 } as const;
  // The whole season deleted (2 episodes, nothing of it left) → a season pack can come back.
  assert.deepEqual(replace.followUpSearch(season2, byId(503, 504), false, byId(501, 502)), { kind: "season", seasonNumber: 2 });
  // One of its files deleted, the other still on disk → just that episode.
  assert.deepEqual(replace.followUpSearch(season2, byId(503), false, byId(501, 502, 504)), { kind: "episodes", episodes: [ep(2, 1)] });
  // Part of the deletion covered by a mark's redownload → exactly the rest.
  assert.deepEqual(replace.followUpSearch(season2, byId(504), true, byId(501, 502)), { kind: "episodes", episodes: [ep(2, 2)] });
  // A series: the DELETED episodes only, never the series' missing backlog — files left in both seasons ⇒ named one by one.
  assert.deepEqual(replace.followUpSearch({ kind: "series" }, byId(501, 503), false, byId(502, 504)), { kind: "plan", seasons: [], episodes: [ep(1, 1), ep(2, 1)] });
  // A whole season gone (2+ episodes, nothing of it left) ⇒ a season pack; one episode of the other ⇒ by name.
  assert.deepEqual(replace.followUpSearch({ kind: "series" }, byId(501, 503, 504), false, byId(502)), { kind: "plan", seasons: [2], episodes: [ep(1, 1)] });
  assert.deepEqual(replace.followUpSearch({ kind: "episode", seasonNumber: 1, episodeNumber: 1 }, byId(501), false, []), { kind: "episodes", episodes: [ep(1, 1)] });
  assert.deepEqual(replace.followUpSearch({ kind: "movie" }, [files[0]], false, []), { kind: "movie" });
  assert.equal(replace.followUpSearch({ kind: "movie" }, [files[0]], true, []), null, "a mark's redownload already searches the movie");
  assert.equal(replace.followUpSearch(season2, [], true, []), null);
});

test("follow-up search: a FULL series names deleted specials and episodes in any season — specials are never a season pack; no episode data ⇒ the Missing plan", () => {
  // Two specials + a whole regular season deleted, nothing left anywhere.
  const files = projectFiles("sonarr", [
    { id: 801, seriesId: 21, seasonNumber: 0, relativePath: "Specials/S00E01.mkv", size: 1 },
    { id: 802, seriesId: 21, seasonNumber: 0, relativePath: "Specials/S00E02.mkv", size: 1 },
    { id: 803, seriesId: 21, seasonNumber: 3, relativePath: "Season 03/S03E01.mkv", size: 1 },
    { id: 804, seriesId: 21, seasonNumber: 3, relativePath: "Season 03/S03E02.mkv", size: 1 },
  ], projectEpisodes([
    { id: 1, seriesId: 21, seasonNumber: 0, episodeNumber: 1, episodeFileId: 801, hasFile: true },
    { id: 2, seriesId: 21, seasonNumber: 0, episodeNumber: 2, episodeFileId: 802, hasFile: true },
    // No air date at all: the Missing plan would never reach it.
    { id: 3, seriesId: 21, seasonNumber: 3, episodeNumber: 1, episodeFileId: 803, hasFile: true },
    { id: 4, seriesId: 21, seasonNumber: 3, episodeNumber: 2, episodeFileId: 804, hasFile: true },
  ]));
  assert.deepEqual(replace.followUpSearch({ kind: "series" }, files, false, []), { kind: "plan", seasons: [3], episodes: [ep(0, 1), ep(0, 2)] });
  // A lone deleted special beside the rest of the show.
  assert.deepEqual(replace.followUpSearch({ kind: "series" }, files.slice(0, 1), false, files.slice(1)), { kind: "plan", seasons: [], episodes: [ep(0, 1)] });
  // Files that name no episodes at all: nothing to name, so the Missing page's plan.
  const bare = files.map((f) => ({ ...f, episodes: [] }));
  assert.deepEqual(replace.followUpSearch({ kind: "series" }, bare, false, []), { kind: "missing" });
});

test("the Redownload Failed switch is read as the arr reports it, null when it doesn't say", () => {
  assert.equal(replace.redownloadSetting({ autoRedownloadFailed: false }), false);
  assert.equal(replace.redownloadSetting({ autoRedownloadFailed: true }), true);
  assert.equal(replace.redownloadSetting({}), null);
  assert.equal(replace.redownloadSetting([{ autoRedownloadFailed: true }]), null);
});

// ── route: auth, listing, refusals ───────────────────────────────────────────

test("ADMIN only: anonymous is 401, an issue admin 403 — nothing reaches Radarr/Sonarr, nothing is written", async () => {
  issueRow = { ...MOVIE_ISSUE };
  const issueAdmin = await mintSession({ role: "ISSUE_ADMIN", permissions: Permission.MANAGE_ISSUES });
  for (const [token, status] of [[null, 401], [issueAdmin, 403]] as const) {
    assert.equal((await getFiles(token, "issue-1")).status, status);
    assert.equal((await postFiles(token, "issue-1", { instance: "", fileIds: [7], then: "search" })).status, status);
  }
  assert.deepEqual(arrCalls(), []);
  assert.deepEqual(seq, []);
  assert.equal(audits.length, 0);
});

test("GET lists the issue's files with their grabs; a title the instance lacks, an unknown issue and a resolved one are refused", async () => {
  const token = await mintSession();
  issueRow = { ...SEASON_ISSUE };
  const res = await getFiles(token, "issue-1");
  assert.equal(res.status, 200);
  const text = await res.text();
  assert.ok(!text.includes(APIKEY), "no release download URL or guid");
  const body = JSON.parse(text) as { arrId: number; files: Array<{ id: number; path: string; grab: { event: { id: number; sourceTitle: string } } | null }>; otherFiles: number };
  assert.equal(body.arrId, 21);
  assert.deepEqual(body.files.map((f) => [f.id, f.grab?.event.id ?? null]), [[503, 71], [504, 71]]);
  assert.equal(body.otherFiles, 2);
  assert.deepEqual(writes(), []);

  issueRow = { ...MOVIE_ISSUE, tmdbId: 999 };
  const missing = await getFiles(token, "issue-1");
  assert.equal(missing.status, 404);
  assert.match(((await missing.json()) as { error: string }).error, /Radarr doesn't have this title/);

  issueRow = null;
  assert.equal((await getFiles(token, "issue-1")).status, 404);
  issueRow = { ...MOVIE_ISSUE, status: "RESOLVED" };
  calls = [];
  assert.equal((await getFiles(token, "issue-1")).status, 409);
  assert.equal((await getFiles(token, "issue-1", "?instance=Bad Slug")).status, 409, "resolved is refused before anything else");
  issueRow = { ...MOVIE_ISSUE };
  assert.equal((await getFiles(token, "issue-1", "?instance=Bad%20Slug")).status, 400);
  assert.equal((await getFiles(token, "issue-1", "?instance=anime")).status, 404, "a slug naming no configured instance");
  assert.deepEqual(arrCalls(), []);
});

test("POST naming a file outside the issue's scope (or not the title's) is 409 — nothing deleted, the issue untouched", async () => {
  const token = await mintSession();
  issueRow = { ...SEASON_ISSUE };
  for (const fileIds of [[503, 501], [503, 999]]) {
    const res = await postFiles(token, "issue-1", { instance: "", fileIds, then: "markFailed" });
    assert.equal(res.status, 409, JSON.stringify(fileIds));
  }
  assert.deepEqual(writes(), []);
  assert.deepEqual(seq, [], "no CAS, no delete");
  assert.equal(issueRow.status, "OPEN");
  assert.equal(audits.length, 0);
  for (const body of [{ instance: "", fileIds: [503] }, { instance: "", fileIds: [], then: "search" }, { instance: "", fileIds: ["503"], then: "search" }, { instance: "", fileIds: [503], then: "seriesSearch" }]) {
    assert.equal((await postFiles(token, "issue-1", body)).status, 400, JSON.stringify(body));
  }
  assert.deepEqual(arrCalls().filter((c) => c.method !== "GET"), []);
});

test("an issue resolved before the delete (the CAS loses) deletes nothing", async () => {
  const token = await mintSession();
  issueRow = { ...MOVIE_ISSUE };
  casCount = 0;
  const res = await postFiles(token, "issue-1", { instance: "", fileIds: [7], then: "search" });
  assert.equal(res.status, 409);
  assert.deepEqual(writes(), []);
  assert.deepEqual(seq, ["db:issue.updateMany"]);
  assert.equal(audits.length, 0);
});

test("an issue resolved AFTER the route's read is refused by the CAS's own predicate — nothing deleted, nothing audited", async () => {
  const token = await mintSession();
  issueRow = { ...MOVIE_ISSUE };
  // The early `status === "RESOLVED"` check passes on the OPEN copy; only the CAS can refuse now.
  afterIssueRead = () => { issueRow!.status = "RESOLVED"; };
  const res = await postFiles(token, "issue-1", { instance: "", fileIds: [7], then: "search" });
  assert.equal(res.status, 409);
  assert.equal(issueRow.status, "RESOLVED", "a resolved issue is never flipped back to IN_PROGRESS");
  assert.deepEqual(writes(), []);
  assert.deepEqual(seq, ["db:issue.updateMany"]);
  assert.equal(audits.length, 0);
});

// A DELETE /episodefile/bulk that waits until `open()` — parks a replace mid-flight.
function parkSonarrDelete(): { open: () => void } {
  let open!: () => void;
  const gate = new Promise<void>((r) => { open = r; });
  responder = (c) => (c.origin === SONARR && c.method === "DELETE" && c.path === "/api/v3/episodefile/bulk"
    ? (gate.then(() => sonarr(c)!) as unknown as Response)
    : radarr(c) ?? sonarr(c));
  return { open };
}
// Bounded: answers whether `cond` came true — a mutant must fail, never hang on the gate.
async function until(cond: () => boolean): Promise<boolean> {
  for (let i = 0; i < 500 && !cond(); i++) await new Promise((r) => setImmediate(r));
  return cond();
}
function tracked<T>(p: Promise<T>): { p: Promise<T>; settled: () => boolean } {
  let done = false;
  return { p: p.finally(() => { done = true; }), settled: () => done };
}
const deletes = () => writes().filter((c) => c.method === "DELETE");

test("one replace per issue at a time: a second POST while one runs is 409 with nothing written or sent; the claim is released when it ends", async () => {
  issueRow = { ...SEASON_ISSUE };
  const { open } = parkSonarrDelete();
  const first = postFiles(await mintSession(), "issue-1", { instance: "", fileIds: [503], then: "markFailed" });
  assert.ok(await until(() => deletes().length === 1));
  const casesBefore = seq.filter((x) => x === "db:issue.updateMany").length;
  const secondCall = tracked(postFiles(await mintSession(), "issue-1", { instance: "", fileIds: [504], then: "markFailed" }));
  const answeredWhileParked = await until(secondCall.settled);
  const deletesWhileParked = deletes().length;
  open();
  const second = await secondCall.p;
  assert.ok(answeredWhileParked, "refused at once, while the first is still running");
  assert.equal(deletesWhileParked, 1, "no second delete");
  assert.equal(second.status, 409);
  assert.match(((await second.json()) as { error: string }).error, /already running/);
  assert.equal(seq.filter((x) => x === "db:issue.updateMany").length, casesBefore, "no second CAS");
  assert.equal((await first).status, 200);
  // Released: the next replace of the issue goes through.
  const third = await postFiles(await mintSession(), "issue-1", { instance: "", fileIds: [504], then: "search" });
  assert.equal(third.status, 200);
  assert.equal(deletes().length, 2);
});

test("a refusal after the claim (the CAS losing) releases it", async () => {
  issueRow = { ...MOVIE_ISSUE };
  casCount = 0;
  assert.equal((await postFiles(await mintSession(), "issue-1", { instance: "", fileIds: [7], then: "search" })).status, 409);
  casCount = 1;
  assert.equal((await postFiles(await mintSession(), "issue-1", { instance: "", fileIds: [7], then: "search" })).status, 200);
});

test("async: 202 { job } at once, the replace runs once in the background, and the poll answers exactly what the synchronous POST would", async () => {
  issueRow = { ...SEASON_ISSUE };
  const token = await mintSession();
  const { open } = parkSonarrDelete();
  const call = tracked(postFiles(token, "issue-1", { instance: "", fileIds: [503, 504], then: "markFailed", async: true }));
  const answeredFirst = await until(call.settled);
  if (!answeredFirst) open();
  assert.ok(answeredFirst, "answered before the delete finished");
  const res = await call.p;
  assert.equal(res.status, 202);
  const { job } = (await res.json()) as { job: string };
  assert.match(job, /^[0-9a-f]{32}$/);
  assert.ok(await until(() => deletes().length === 1));
  // Running: the poll says so; the same admin posting again JOINS it — no second read, delete or rate token.
  assert.equal((await getFiles(token, "issue-1", `?job=${job}`)).status, 202);
  const readsBefore = arrCalls().length;
  const againCall = tracked(postFiles(token, "issue-1", { instance: "", fileIds: [503, 504], then: "markFailed", async: true }));
  const againAnswered = await until(againCall.settled);
  if (!againAnswered) open();
  assert.ok(againAnswered, "joined at once");
  const again = await againCall.p;
  assert.equal(again.status, 202);
  assert.equal(((await again.json()) as { job: string }).job, job);
  assert.equal(arrCalls().length, readsBefore, "joining reads nothing");
  // Another admin is refused while it runs, and cannot read this admin's job.
  const other = await mintSession();
  const otherCall = tracked(postFiles(other, "issue-1", { instance: "", fileIds: [503], then: "search", async: true }));
  const otherAnswered = await until(otherCall.settled);
  open();
  assert.ok(otherAnswered);
  assert.equal((await otherCall.p).status, 409);
  let poll: Response;
  for (;;) {
    poll = await getFiles(token, "issue-1", `?job=${job}`);
    if (poll.status !== 202) break;
    await new Promise((r) => setImmediate(r));
  }
  assert.equal(poll.status, 200);
  assert.deepEqual(await poll.json(), { deleted: 2, requested: 2, marked: 1, unmarked: 0, searched: false, redownload: true, redownloading: 1, remonitored: 0, remonitorFailed: false, nothingMissing: false });
  assert.equal(deletes().length, 1, "deleted once");
  assert.equal((await getFiles(other, "issue-1", `?job=${job}`)).status, 404, "a job is its owner's only");
  assert.equal((await getFiles(token, "issue-1", "?job=not-a-job")).status, 404);
  assert.deepEqual(audits.map((a) => a.action), ["ISSUE_STATUS_CHANGE", "ARR_FILE_DELETE", "ARR_MARK_FAILED"]);
  // The job released the claim: the issue can be replaced again.
  deletedEpisodeFiles = new Set();
  responder = (c) => radarr(c) ?? sonarr(c);
  assert.equal((await postFiles(other, "issue-1", { instance: "", fileIds: [503], then: "search" })).status, 200);
  assert.equal((await postFiles(token, "issue-1", { instance: "", fileIds: [504], then: "search", async: "yes" })).status, 400, "`async` must be a boolean");
});

// ── route: the replace ───────────────────────────────────────────────────────

test("markFailed on a season pack: the CAS first, ONE bulk delete, ONE mark for the download, no search of ours while Redownload Failed is on — audited", async () => {
  const token = await mintSession();
  issueRow = { ...SEASON_ISSUE };
  const res = await postFiles(token, "issue-1", { instance: "", fileIds: [503, 504], then: "markFailed" });
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { deleted: 2, requested: 2, marked: 1, unmarked: 0, searched: false, redownload: true, redownloading: 1, remonitored: 0, remonitorFailed: false, nothingMissing: false });
  assert.deepEqual(seq, [
    "db:issue.updateMany",
    "arr:DELETE /api/v3/episodefile/bulk",
    "arr:POST /api/v3/history/failed/71",
    "db:issueGrab.create",
  ]);
  assert.deepEqual(writes()[0].body, { episodeFileIds: [503, 504] });
  assert.equal(issueRow.status, "IN_PROGRESS");
  assert.deepEqual(audits.map((a) => a.action), ["ISSUE_STATUS_CHANGE", "ARR_FILE_DELETE", "ARR_MARK_FAILED"]);
  assert.deepEqual(audits[1].details.fileIds, [503, 504]);
  assert.equal(audits[2].details.historyId, 71);
  assert.ok(!JSON.stringify(audits).includes(APIKEY));
  assert.deepEqual(grabs.map((g) => [g.arrInstance, g.scope, g.seasonNumber, g.tvdbId]), [["", "SEASON", 2, 81189]]);
});

test("markFailed with Redownload Failed OFF: the release is still blocklisted, and the replacement is searched for here", async () => {
  const token = await mintSession();
  issueRow = { ...SEASON_ISSUE };
  redownloadConfig = { autoRedownloadFailed: false };
  const res = await postFiles(token, "issue-1", { instance: "", fileIds: [503, 504], then: "markFailed" });
  assert.equal(res.status, 200);
  assert.equal(((await res.json()) as { searched: boolean }).searched, true);
  assert.deepEqual(writes().filter((c) => c.path.startsWith("/api/v3/history/failed/")).map((c) => c.path), ["/api/v3/history/failed/71"]);
  // The whole season went: a season pack may come back.
  assert.deepEqual(commands(), [{ name: "SeasonSearch", seriesId: 21, seasonNumber: 2 }]);
});

test("markFailed on a file with no grab on record searches for it instead — an EpisodeSearch for its episode, never SeriesSearch", async () => {
  const token = await mintSession();
  issueRow = { ...issue({ tmdbId: 1396, mediaType: "TV", scope: "EPISODE", seasonNumber: 1, episodeNumber: 2 }) };
  const res = await postFiles(token, "issue-1", { instance: "", fileIds: [502], then: "markFailed" });
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { deleted: 1, requested: 1, marked: 0, unmarked: 0, searched: true, redownload: null, redownloading: 0, remonitored: 0, remonitorFailed: false, nothingMissing: false });
  assert.ok(!writes().some((c) => c.path.startsWith("/api/v3/history/failed")), "nothing to mark");
  assert.ok(!calls.some((c) => c.path === "/api/v3/config/downloadclient"), "no mark ⇒ the switch isn't read");
  assert.deepEqual(commands(), [{ name: "EpisodeSearch", episodeIds: [102] }]);
});

test("search on an EPISODE issue: delete, then one EpisodeSearch for the file's episode — no mark", async () => {
  const token = await mintSession();
  issueRow = { ...EPISODE_ISSUE };
  const res = await postFiles(token, "issue-1", { instance: "", fileIds: [501], then: "search" });
  assert.equal(res.status, 200);
  assert.deepEqual(writes().map((c) => [c.method, c.path]), [
    ["DELETE", "/api/v3/episodefile/bulk"],
    ["POST", "/api/v3/command"],
  ]);
  assert.deepEqual(commands(), [{ name: "EpisodeSearch", episodeIds: [101] }]);
  assert.deepEqual(audits.map((a) => a.action), ["ISSUE_STATUS_CHANGE", "ARR_FILE_DELETE"], "a search is not audited (guardrail 5e)");
});

test("search on a SEASON issue with a file of the season left on disk is an EpisodeSearch, not a SeasonSearch", async () => {
  const token = await mintSession();
  issueRow = { ...SEASON_ISSUE };
  assert.equal((await postFiles(token, "issue-1", { instance: "", fileIds: [503], then: "search" })).status, 200);
  assert.deepEqual(commands(), [{ name: "EpisodeSearch", episodeIds: [201] }]);
});

test("a movie: delete through Radarr, mark the grab, and Radarr's redownload is the search — then search mode is MoviesSearch", async () => {
  const token = await mintSession();
  issueRow = { ...MOVIE_ISSUE };
  const res = await postFiles(token, "issue-1", { instance: "", fileIds: [7], then: "markFailed" });
  assert.equal(res.status, 200);
  assert.deepEqual(writes().map((c) => [c.method, c.path]), [["DELETE", "/api/v3/moviefile/7"], ["POST", "/api/v3/history/failed/900"]]);
  assert.deepEqual(grabs.map((g) => [g.mediaType, g.arrInstance]), [["MOVIE", ""]]);

  calls = [];
  issueRow = { ...MOVIE_ISSUE };
  assert.equal((await postFiles(await mintSession(), "issue-1", { instance: "", fileIds: [7], then: "search" })).status, 200);
  assert.deepEqual(commands(), [{ name: "MoviesSearch", movieIds: [11] }]);
});

test("a Radarr delete that stops part-way audits exactly what was deleted, replaces that, and answers 502", async () => {
  const token = await mintSession();
  issueRow = { ...MOVIE_ISSUE };
  movieFiles = [
    { id: 7, movieId: 11, relativePath: "a.mkv", path: "/m/a.mkv", size: 1 },
    { id: 8, movieId: 11, relativePath: "b.mkv", path: "/m/b.mkv", size: 1 },
  ];
  radarrDeleteFailsFor = 8;
  const res = await postFiles(token, "issue-1", { instance: "", fileIds: [7, 8], then: "search" });
  assert.equal(res.status, 502);
  const body = (await res.json()) as { deleted: number; requested: number; searched: boolean; error: string };
  assert.deepEqual([body.deleted, body.requested, body.searched], [1, 2, true]);
  assert.match(body.error, /Deleted 1 of 2/);
  const del = audits.find((a) => a.action === "ARR_FILE_DELETE");
  assert.deepEqual(del?.details.fileIds, [7]);
});

test("a delete that stops part-way blocklists only the releases of the files actually deleted", async () => {
  const token = await mintSession();
  issueRow = { ...MOVIE_ISSUE };
  movieFiles = [
    { id: 7, movieId: 11, relativePath: "a.mkv", path: "/m/a.mkv", size: 1 },
    { id: 8, movieId: 11, relativePath: "b.mkv", path: "/m/b.mkv", size: 1 },
  ];
  movieHistory = [
    { id: 1, movieId: 11, eventType: "grabbed", sourceTitle: "A", downloadId: "A" },
    { id: 2, movieId: 11, eventType: "downloadFolderImported", sourceTitle: "A", downloadId: "A", data: { importedPath: "/m/a.mkv" } },
    { id: 3, movieId: 11, eventType: "grabbed", sourceTitle: "B", downloadId: "B" },
    { id: 4, movieId: 11, eventType: "downloadFolderImported", sourceTitle: "B", downloadId: "B", data: { importedPath: "/m/b.mkv" } },
  ];
  radarrDeleteFailsFor = 8;
  const res = await postFiles(token, "issue-1", { instance: "", fileIds: [7, 8], then: "markFailed" });
  assert.equal(res.status, 502);
  assert.deepEqual(writes().filter((c) => c.path.startsWith("/api/v3/history/failed/")).map((c) => c.path), ["/api/v3/history/failed/1"]);
});

test("a failing audit write never fails the replace (guardrail 26)", async () => {
  const token = await mintSession();
  issueRow = { ...SEASON_ISSUE };
  auditThrows = true;
  const res = await postFiles(token, "issue-1", { instance: "", fileIds: [503, 504], then: "markFailed" });
  assert.equal(res.status, 200);
  assert.equal(((await res.json()) as { deleted: number }).deleted, 2);
});

test("a FULL series issue applies the Missing page's season-pack rule to the deleted files — a whole season gone is a SeasonSearch, never SeriesSearch", async () => {
  const token = await mintSession();
  issueRow = { ...issue({ tmdbId: 1396, mediaType: "TV", scope: "FULL" }) };
  assert.equal((await postFiles(token, "issue-1", { instance: "", fileIds: [503, 504], then: "search" })).status, 200);
  assert.deepEqual(commands(), [{ name: "SeasonSearch", seriesId: 21, seasonNumber: 2 }]);
});

test("a FULL plan that stops part-way still counts as searched — the queued SeasonSearch is running, so the IssueGrab is recorded and no 502", async () => {
  const token = await mintSession();
  issueRow = { ...issue({ tmdbId: 1396, mediaType: "TV", scope: "FULL" }) };
  // Both seasons emptied: one SeasonSearch each; Sonarr accepts S1 and 503s S2.
  sonarrCommandFails = (b) => b.name === "SeasonSearch" && b.seasonNumber === 2;
  const res = await postFiles(token, "issue-1", { instance: "", fileIds: [501, 502, 503, 504], then: "search" });
  assert.equal(res.status, 200);
  const body = (await res.json()) as { searched: boolean; error?: string };
  assert.equal(body.searched, true);
  assert.equal(body.error, undefined);
  assert.deepEqual(commands().map((c) => c.seasonNumber), [1, 2], "S1 queued, S2 refused");
  assert.equal(grabs.length, 1, "the replacement's import is still announced");
  assert.ok(warnLines.some((l) => l.includes("replacement search for series 21 stopped after 1 command(s)")));
});

test("a FULL plan whose FIRST command fails queued nothing — still the 502 searchFailed, with no IssueGrab", async () => {
  const token = await mintSession();
  issueRow = { ...issue({ tmdbId: 1396, mediaType: "TV", scope: "FULL" }) };
  sonarrCommandFails = (b) => b.name === "SeasonSearch";
  const res = await postFiles(token, "issue-1", { instance: "", fileIds: [501, 502, 503, 504], then: "search" });
  assert.equal(res.status, 502);
  assert.equal(((await res.json()) as { searched: boolean }).searched, false);
  assert.equal(grabs.length, 0);
});

test("a FULL series issue searches only what was DELETED — a long-missing episode of another season is not searched", async () => {
  const token = await mintSession();
  issueRow = { ...issue({ tmdbId: 1396, mediaType: "TV", scope: "FULL" }) };
  // S01E02 has been missing for years (monitored, aired, no file) — nobody deleted it.
  deletedEpisodeFiles.add(502);
  const res = await postFiles(token, "issue-1", { instance: "", fileIds: [503], then: "search" });
  assert.equal(res.status, 200);
  assert.equal(((await res.json()) as { searched: boolean }).searched, true);
  assert.deepEqual(commands(), [{ name: "EpisodeSearch", episodeIds: [201] }], "the deleted episode only — never S01E02, never a SeasonSearch beside S02E02");
});

test("a FULL issue with Unmonitor Deleted Episodes on: the delete's unmonitoring is undone first, so the SeasonSearch sees the season again", async () => {
  const token = await mintSession();
  issueRow = { ...issue({ tmdbId: 1396, mediaType: "TV", scope: "FULL" }) };
  unmonitorDeleted = true;
  const res = await postFiles(token, "issue-1", { instance: "", fileIds: [503, 504], then: "search" });
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { deleted: 2, requested: 2, marked: 0, unmarked: 0, searched: true, redownload: null, redownloading: 0, remonitored: 2, remonitorFailed: false, nothingMissing: false });
  assert.deepEqual(seq, ["db:issue.updateMany", "arr:DELETE /api/v3/episodefile/bulk", "arr:PUT /api/v3/episode/monitor", "arr:POST /api/v3/command", "db:issueGrab.create"]);
  assert.deepEqual(commands(), [{ name: "SeasonSearch", seriesId: 21, seasonNumber: 2 }]);
});

// ── 8: what the delete unmonitored is set back ───────────────────────────────

test("pure: only ids that went monitored → unmonitored are re-monitored; one the admin had unmonitored, or the re-read didn't return, is left alone", () => {
  const before = [{ id: 1, monitored: true }, { id: 2, monitored: false }, { id: 3, monitored: true }, { id: 4, monitored: true }];
  const after = [{ id: 1, monitored: false }, { id: 2, monitored: false }, { id: 3, monitored: true }];
  assert.deepEqual(replace.unmonitoredByDelete(before, after), [1]);
  assert.deepEqual(replace.unmonitoredByDelete([], after), []);
});

test("a SEASON search with Unmonitor Deleted Episodes on: the episodes are re-monitored BEFORE the SeasonSearch (monitored-only) — audited ARR_TITLE_EDIT", async () => {
  const token = await mintSession();
  issueRow = { ...SEASON_ISSUE };
  unmonitorDeleted = true;
  const res = await postFiles(token, "issue-1", { instance: "", fileIds: [503, 504], then: "search" });
  assert.equal(res.status, 200);
  const body = (await res.json()) as { remonitored: number; remonitorFailed: boolean; searched: boolean };
  assert.deepEqual([body.remonitored, body.remonitorFailed, body.searched], [2, false, true]);
  assert.deepEqual(seq, ["db:issue.updateMany", "arr:DELETE /api/v3/episodefile/bulk", "arr:PUT /api/v3/episode/monitor", "arr:POST /api/v3/command", "db:issueGrab.create"]);
  assert.deepEqual(writes().find((c) => c.path === "/api/v3/episode/monitor")?.body, { episodeIds: [201, 202], monitored: true });
  assert.deepEqual(commands(), [{ name: "SeasonSearch", seriesId: 21, seasonNumber: 2 }]);
  assert.deepEqual(audits.map((a) => a.action), ["ISSUE_STATUS_CHANGE", "ARR_FILE_DELETE", "ARR_TITLE_EDIT"]);
  assert.deepEqual(
    { ...audits[2].details },
    { service: "sonarr", instance: "", arrId: 21, fields: ["episodes"], episodes: 2, monitored: true, trigger: "replaceFile", issueId: "issue-1" },
  );
});

test("with Unmonitor Deleted Episodes OFF nothing is re-monitored — no write beyond the delete and the search", async () => {
  const token = await mintSession();
  issueRow = { ...SEASON_ISSUE };
  assert.equal((await postFiles(token, "issue-1", { instance: "", fileIds: [503, 504], then: "search" })).status, 200);
  assert.ok(!writes().some((c) => c.path === "/api/v3/episode/monitor"));
  assert.ok(!audits.some((a) => a.action === "ARR_TITLE_EDIT"));
});

test("markFailed with Unmonitor Deleted Episodes on: re-monitor, THEN mark — the arr's redownload covers the pack, no search of ours", async () => {
  const token = await mintSession();
  issueRow = { ...SEASON_ISSUE };
  unmonitorDeleted = true;
  const res = await postFiles(token, "issue-1", { instance: "", fileIds: [503, 504], then: "markFailed" });
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { deleted: 2, requested: 2, marked: 1, unmarked: 0, searched: false, redownload: true, redownloading: 1, remonitored: 2, remonitorFailed: false, nothingMissing: false });
  assert.deepEqual(seq, [
    "db:issue.updateMany",
    "arr:DELETE /api/v3/episodefile/bulk",
    "arr:PUT /api/v3/episode/monitor",
    "arr:POST /api/v3/history/failed/71",
    "db:issueGrab.create",
  ]);
  assert.deepEqual(commands(), []);
});

test("a failed re-monitor is reported, and the replacement is searched for BY NAME — no mark counts as covering an unmonitored episode", async () => {
  const token = await mintSession();
  issueRow = { ...SEASON_ISSUE };
  unmonitorDeleted = true;
  monitorPutFails = true;
  const res = await postFiles(token, "issue-1", { instance: "", fileIds: [503, 504], then: "markFailed" });
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { deleted: 2, requested: 2, marked: 1, unmarked: 0, searched: true, redownload: true, redownloading: 0, remonitored: 0, remonitorFailed: true, nothingMissing: false });
  // The release is still blocklisted; the search names the episodes — a SeasonSearch would find nothing unmonitored.
  assert.deepEqual(writes().filter((c) => c.path.startsWith("/api/v3/history/failed/")).map((c) => c.path), ["/api/v3/history/failed/71"]);
  assert.deepEqual(commands(), [{ name: "EpisodeSearch", episodeIds: [201, 202] }]);
  assert.ok(!audits.some((a) => a.action === "ARR_TITLE_EDIT"), "nothing the arr refused is audited");
  assert.ok(warnLines.some((l) => l.includes("re-monitoring the episodes")));
});

test("an episode the ADMIN had unmonitored stays unmonitored, and is searched for by name", async () => {
  const token = await mintSession();
  issueRow = { ...SEASON_ISSUE };
  unmonitorDeleted = true;
  episodeMonitored.set(202, false);
  const res = await postFiles(token, "issue-1", { instance: "", fileIds: [503, 504], then: "search" });
  assert.equal(res.status, 200);
  assert.equal(((await res.json()) as { remonitored: number }).remonitored, 1);
  assert.deepEqual(writes().find((c) => c.path === "/api/v3/episode/monitor")?.body, { episodeIds: [201], monitored: true });
  assert.deepEqual(commands(), [{ name: "EpisodeSearch", episodeIds: [201, 202] }]);
});

test("a movie with Unmonitor Deleted Movies on: re-monitored through the movie editor before the mark; a failed re-monitor falls back to a manual MoviesSearch", async () => {
  const token = await mintSession();
  issueRow = { ...MOVIE_ISSUE };
  unmonitorDeleted = true;
  const res = await postFiles(token, "issue-1", { instance: "", fileIds: [7], then: "markFailed" });
  assert.equal(res.status, 200);
  const body = (await res.json()) as { remonitored: number; redownloading: number; searched: boolean };
  assert.deepEqual([body.remonitored, body.redownloading, body.searched], [1, 1, false]);
  assert.deepEqual(writes().map((c) => [c.method, c.path]), [
    ["DELETE", "/api/v3/moviefile/7"],
    ["PUT", "/api/v3/movie/editor"],
    ["POST", "/api/v3/history/failed/900"],
  ]);
  assert.deepEqual(writes()[1].body, { movieIds: [11], monitored: true, moveFiles: false }, "only `monitored` is sent");
  assert.deepEqual(audits.find((a) => a.action === "ARR_TITLE_EDIT")?.details.fields, ["monitored"]);

  calls = [];
  audits.length = 0;
  // A fresh scenario on an unchanged scripted history: drop the first mark's claim.
  _resetMarkClaimsForTests();
  movieMonitored = true;
  movieEditorFails = true;
  issueRow = { ...MOVIE_ISSUE };
  const failed = await postFiles(await mintSession(), "issue-1", { instance: "", fileIds: [7], then: "markFailed" });
  assert.equal(failed.status, 200);
  const fb = (await failed.json()) as { remonitorFailed: boolean; redownloading: number; searched: boolean; marked: number };
  assert.deepEqual([fb.remonitorFailed, fb.marked, fb.redownloading, fb.searched], [true, 1, 0, true]);
  assert.deepEqual(commands(), [{ name: "MoviesSearch", movieIds: [11] }], "a manual MoviesSearch searches an unmonitored movie");
});

// ── 9: interactive grabs ─────────────────────────────────────────────────────

test("pure: both redownload switches; an interactive grab is covered only with the interactive switch on, and an older arr's main switch decides", () => {
  assert.deepEqual(replace.redownloadSettings({ autoRedownloadFailed: true, autoRedownloadFailedFromInteractiveSearch: false }), { failed: true, interactive: false });
  assert.deepEqual(replace.redownloadSettings({ autoRedownloadFailed: true }), { failed: true, interactive: null });
  assert.deepEqual(replace.redownloadSettings(null), { failed: null, interactive: null });
  assert.equal(replace.redownloadCovers({ failed: true, interactive: false }, true), false);
  assert.equal(replace.redownloadCovers({ failed: true, interactive: false }, false), true);
  assert.equal(replace.redownloadCovers({ failed: true, interactive: true }, true), true);
  assert.equal(replace.redownloadCovers({ failed: true, interactive: null }, true), true, "no interactive switch: the main one decides");
  assert.equal(replace.redownloadCovers({ failed: false, interactive: true }, false), false);
  assert.equal(replace.redownloadCovers({ failed: null, interactive: null }, false), false, "unreadable ⇒ we search");
  // A Radarr movie not yet "available": its redownload is an automatic search that Minimum Availability rejects.
  assert.equal(replace.redownloadCovers({ failed: true, interactive: true }, false, false), false);
  assert.equal(replace.redownloadCovers({ failed: true, interactive: true }, false, true), true);
});

test("markFailed on a Radarr movie that isn't 'available' yet: blocklisted, and OUR manual MoviesSearch runs — Radarr's automatic redownload would reject every release", async () => {
  const token = await mintSession();
  issueRow = { ...MOVIE_ISSUE };
  movieIsAvailable = false;
  const res = await postFiles(token, "issue-1", { instance: "", fileIds: [7], then: "markFailed" });
  assert.equal(res.status, 200);
  const body = (await res.json()) as { marked: number; redownloading: number; searched: boolean };
  assert.deepEqual([body.marked, body.redownloading, body.searched], [1, 0, true]);
  assert.deepEqual(writes().filter((c) => c.path.startsWith("/api/v3/history/failed/")).map((c) => c.path), ["/api/v3/history/failed/900"]);
  assert.deepEqual(commands(), [{ name: "MoviesSearch", movieIds: [11] }]);
  // Available (or not said): Radarr's redownload covers it — no search of ours.
  for (const avail of [true, undefined]) {
    calls = [];
    _resetMarkClaimsForTests();
    issueRow = { ...MOVIE_ISSUE };
    movieIsAvailable = avail;
    const again = (await (await postFiles(await mintSession(), "issue-1", { instance: "", fileIds: [7], then: "markFailed" })).json()) as { redownloading: number; searched: boolean };
    assert.deepEqual([again.redownloading, again.searched], [1, false], String(avail));
    assert.deepEqual(commands(), []);
  }
});

test("pure: a grab is interactive when any grab of its download says releaseSource InteractiveSearch (either key case); another title's record never counts", () => {
  const [grab] = projectHistoryRecords("sonarr", "", [SERIES_HISTORY[3]]);
  const raw = (src: string, extra: Record<string, unknown> = {}) => [
    { ...SERIES_HISTORY[2], data: { releaseSource: "Rss" } },
    { ...SERIES_HISTORY[3], data: { ReleaseSource: src }, ...extra },
  ];
  assert.equal(replace.isInteractiveGrab("sonarr", 21, raw("InteractiveSearch"), grab), true);
  assert.equal(replace.isInteractiveGrab("sonarr", 21, raw("interactivesearch"), grab), true);
  assert.equal(replace.isInteractiveGrab("sonarr", 21, raw("UserInvokedSearch"), grab), false);
  assert.equal(replace.isInteractiveGrab("sonarr", 21, raw("InteractiveSearch", { seriesId: 99 }), grab), false);
  assert.equal(replace.isInteractiveGrab("sonarr", 21, raw("InteractiveSearch", { eventType: "downloadFolderImported" }), grab), false, "only a grab record says how it was grabbed");
  assert.equal(replace.isInteractiveGrab("sonarr", 21, null, grab), false);
});

test("markFailed on a grab picked by hand while Redownload Failed from Interactive Search is OFF: blocklisted, and searched for here", async () => {
  const token = await mintSession();
  issueRow = { ...SEASON_ISSUE };
  redownloadConfig = { autoRedownloadFailed: true, autoRedownloadFailedFromInteractiveSearch: false };
  seriesHistory = SERIES_HISTORY.map((r) => (r.downloadId === "PACK" && r.eventType === "grabbed" ? { ...r, data: { releaseSource: "InteractiveSearch" } } : { ...r }));
  const res = await postFiles(token, "issue-1", { instance: "", fileIds: [503, 504], then: "markFailed" });
  assert.equal(res.status, 200);
  const body = (await res.json()) as { marked: number; redownloading: number; searched: boolean };
  assert.deepEqual([body.marked, body.redownloading, body.searched], [1, 0, true]);
  assert.deepEqual(commands(), [{ name: "SeasonSearch", seriesId: 21, seasonNumber: 2 }]);
  assert.ok(calls.some((c) => c.path === "/api/v3/history/series" && c.query.get("includeEpisode") === null), "the grab's releaseSource was read");

  // The same grab with the switch ON (or absent, an older arr): the arr redownloads it — no search of ours.
  for (const cfg of [{ autoRedownloadFailed: true, autoRedownloadFailedFromInteractiveSearch: true }, { autoRedownloadFailed: true }]) {
    calls = [];
    _resetMarkClaimsForTests();
    deletedEpisodeFiles = new Set();
    issueRow = { ...SEASON_ISSUE };
    redownloadConfig = cfg;
    const again = await postFiles(await mintSession(), "issue-1", { instance: "", fileIds: [503, 504], then: "markFailed" });
    const b = (await again.json()) as { redownloading: number; searched: boolean };
    assert.deepEqual([b.redownloading, b.searched], [1, false], JSON.stringify(cfg));
    // (markHistoryFailed's own read carries includeEpisode; the releaseSource read doesn't.)
    assert.ok(!calls.some((c) => c.path === "/api/v3/history/series" && c.query.get("includeEpisode") === null),
      "the raw history is only read when the interactive switch is off");
  }

  // A grab NOT picked by hand is redownloaded even with the interactive switch off.
  calls = [];
  _resetMarkClaimsForTests();
  deletedEpisodeFiles = new Set();
  issueRow = { ...SEASON_ISSUE };
  redownloadConfig = { autoRedownloadFailed: true, autoRedownloadFailedFromInteractiveSearch: false };
  seriesHistory = SERIES_HISTORY.map((r) => (r.downloadId === "PACK" && r.eventType === "grabbed" ? { ...r, data: { releaseSource: "Rss" } } : { ...r }));
  const rss = await postFiles(await mintSession(), "issue-1", { instance: "", fileIds: [503, 504], then: "markFailed" });
  assert.deepEqual(((await rss.json()) as { redownloading: number }).redownloading, 1);
  assert.deepEqual(commands(), []);

  // The releaseSource read failing: every grab counts as interactive — we search rather than trust a redownload.
  calls = [];
  _resetMarkClaimsForTests();
  deletedEpisodeFiles = new Set();
  issueRow = { ...SEASON_ISSUE };
  responder = (c) => (c.origin === SONARR && c.path === "/api/v3/history/series" && c.query.get("includeEpisode") === null
    ? json({ message: "boom" }, 500)
    : radarr(c) ?? sonarr(c));
  const unread = await postFiles(await mintSession(), "issue-1", { instance: "", fileIds: [503, 504], then: "markFailed" });
  const ub = (await unread.json()) as { marked: number; redownloading: number; searched: boolean };
  assert.deepEqual([ub.marked, ub.redownloading, ub.searched], [1, 0, true]);
});

// ── 10: the listing names episodes by Sonarr's titles ────────────────────────

test("GET names each file's episodes by Sonarr's own titles and carries the series type", async () => {
  const token = await mintSession();
  issueRow = { ...SEASON_ISSUE };
  const body = (await (await getFiles(token, "issue-1")).json()) as { seriesType: string | null; files: Array<{ id: number; episodes: Array<{ seasonNumber: number; episodeNumber: number; title: string | null }> }> };
  assert.deepEqual(body.files.map((f) => [f.id, f.episodes]), [
    [503, [{ seasonNumber: 2, episodeNumber: 1, title: "Seven Thirty-Seven" }]],
    [504, [{ seasonNumber: 2, episodeNumber: 2, title: "Grilled" }]],
  ]);
  assert.equal(body.seriesType, null);
  const anime = { ...series, seriesType: "anime" };
  responder = (c) => (c.origin === SONARR && c.method === "GET" && c.path === "/api/v3/series" ? json([anime]) : radarr(c) ?? sonarr(c));
  assert.equal(((await (await getFiles(token, "issue-1")).json()) as { seriesType: string }).seriesType, "anime");
});

test("the replace is rate-limited per admin", async () => {
  const token = await mintSession();
  issueRow = { ...SEASON_ISSUE };
  for (let i = 0; i < 10; i++) {
    assert.equal((await postFiles(token, "issue-1", { instance: "", fileIds: [501], then: "search" })).status, 409, `call ${i + 1}`);
  }
  calls = [];
  assert.equal((await postFiles(token, "issue-1", { instance: "", fileIds: [501], then: "search" })).status, 429);
  assert.deepEqual(arrCalls(), [], "refused before Radarr/Sonarr is read");
  assert.equal((await postFiles(await mintSession(), "issue-1", { instance: "", fileIds: [501], then: "search" })).status, 409, "another admin has their own budget");
});
