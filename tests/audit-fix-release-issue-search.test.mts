// Audit fixes (unit "release") for an issue's Replace RELEASE search,
// GET/POST /api/issues/[id]/releases:
//
//   C024 — the search runs as a BACKGROUND JOB on `&async=1` (the guardrail-37a
//          pattern the request "Pick release" and the title manager already
//          use): 202 { job } at once, `?job=` polls answer 202 while it runs,
//          then the search's own body; polls are the starting admin's only, and
//          the same admin re-searching joins the running job (one indexer
//          sweep). Without `async` the answer stays the synchronous bare
//          `[ArrRelease]` list the iOS app decodes.
//   C112 — Sonarr searches a season or an episode ONLY: `/api/v3/release` with
//          just a `seriesId` is the indexers' RSS feed (other shows' episodes,
//          grabbable). A whole-series (FULL) TV issue — or a SEASON issue with
//          no season — gets a 422 with no upstream call, from the search AND
//          the grab, and arr.ts itself refuses to build the series-only query.
//
// Plus the shared client loop (src/lib/client/release-search-job.ts) and
// structural pins on the two components that run it.
//
// Harness: the tests/issues-routes.test.mts idiom, trimmed to what the
// releases route reads — real withIssueAdmin handlers with a signed session
// JWT inside a synthetic request scope, in-memory prisma stubs, a scripted
// Sonarr behind a stubbed DNS lookup.
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { AsyncLocalStorage } from "node:async_hooks";
import { readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import dns from "node:dns/promises";

(globalThis as { AsyncLocalStorage?: unknown }).AsyncLocalStorage = AsyncLocalStorage;

process.env.TOKEN_ENCRYPTION_KEY = "ab".repeat(32);
process.env.NEXTAUTH_SECRET = "issue-release-search-test-secret-0123456789";
process.env.AUTH_URL = "http://localhost:3000";
process.env.TRUST_PROXY = "true";
delete process.env.TMDB_READ_TOKEN;
(process.env as Record<string, string | undefined>).NODE_ENV = "test";

const fakeLookup = async () => [{ address: "10.0.0.250", family: 4 }];
(dns as { lookup: unknown }).lookup = fakeLookup;
if ((dns as { lookup: unknown }).lookup !== fakeLookup) throw new Error("could not stub dns.lookup");

console.warn = () => {};
console.error = () => {};

// ── scripted Sonarr / Radarr ────────────────────────────────────────────────
const SONARR = "http://10.0.0.7:8989";
const RADARR = "http://10.0.0.5:7878";
const fetchCalls: Array<{ method: string; url: URL }> = [];
let releaseGate: Promise<void> | null = null;
const rawRelease = (over: Record<string, unknown> = {}) => ({
  guid: "indexer-guid-1", title: "Show.S01.1080p.WEB", size: 9e9, indexerId: 3, indexer: "NZBGeek",
  quality: { quality: { id: 3, name: "WEBDL-1080p" }, revision: { version: 1 } },
  qualityWeight: 10, releaseWeight: 1, protocol: "usenet", seeders: null, leechers: null, age: 2,
  rejected: false, rejections: [], downloadAllowed: true, ...over,
});
globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
  const url = new URL(String(input));
  const method = init?.method ?? "GET";
  fetchCalls.push({ method, url });
  const json = (body: unknown) => Response.json(body);
  if (url.origin === SONARR) {
    if (method === "GET" && url.pathname === "/api/v3/series" && url.searchParams.get("tvdbId") === "81189") return json([{ id: 21, tvdbId: 81189 }]);
    if (method === "GET" && url.pathname === "/api/v3/release") {
      if (releaseGate) await releaseGate;
      return json([rawRelease()]);
    }
    if (method === "GET" && url.pathname === "/api/v3/episode") return json([{ id: 501, seasonNumber: 1, episodeNumber: 2 }]);
    if (method === "POST" && url.pathname === "/api/v3/release") return json({});
  }
  if (url.origin === RADARR) {
    if (method === "GET" && url.pathname === "/api/v3/movie") return json([{ id: 42, tmdbId: 603 }]);
    if (method === "GET" && url.pathname === "/api/v3/release") return json([rawRelease({ title: "Movie.2160p" })]);
  }
  throw new Error(`unexpected fetch ${method} ${url}`);
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
const { _resetReleaseSearchJobsForTests } = await import("../src/lib/release-search-jobs.ts");
const { _resetReleaseHandlesForTests } = await import("../src/lib/release-handles.ts");
const { functionBody, functionBodyRange, stripComments } = await import("./audit-fix2-R8b-tests-vacuous-source.mts");

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
async function mintSession(role = "ISSUE_ADMIN"): Promise<string> {
  sessionSeq++;
  const userId = `user-${sessionSeq}`;
  const sessionId = `sess-${sessionSeq}`;
  usersById.set(userId, {
    role, permissions: 0n, mediaServer: null, sessionsRevokedAt: null,
    passwordChangedAt: null, deactivatedAt: null, email: `u${sessionSeq}@example.com`, notificationEmail: null,
  });
  sessionRows.add(sessionId);
  const iat = Math.floor(Date.now() / 1000);
  return signSessionJwt(
    { id: userId, role, permissions: "0", provider: "credentials", sessionId, expiresAt: iat + 86_400 },
    { expiresInSeconds: 7_200, iat },
  );
}
const COOKIE = getSessionCookieName();

// ── data stubs ───────────────────────────────────────────────────────────────
const settings = new Map<string, string>();
shadowPrismaModel(prisma, "setting", {
  findUnique: async (args: { where: { key: string } }) => {
    const v = settings.get(args.where.key);
    return v === undefined ? null : { key: args.where.key, value: v };
  },
  findMany: async (args: { where?: { key?: { in?: string[] } } }) => {
    const keys = args?.where?.key?.in;
    return [...settings.entries()].filter(([k]) => !keys || keys.includes(k)).map(([key, value]) => ({ key, value }));
  },
});
let issueRow: Record<string, unknown> | null = null;
const issueWrites: unknown[] = [];
shadowPrismaModel(prisma, "issue", {
  findUnique: async () => (issueRow ? { ...issueRow } : null),
  updateMany: async (args: { data: Record<string, unknown> }) => {
    issueWrites.push(args);
    if (issueRow) Object.assign(issueRow, args.data);
    return { count: 1 };
  },
});
shadowPrismaModel(prisma, "issueGrab", { create: async (args: { data: Record<string, unknown> }) => ({ id: "grab-1", ...args.data }) });
shadowPrismaModel(prisma, "auditLog", { create: async () => ({}) });
shadowPrismaModel(prisma, "notificationAgent", { findMany: async () => [] });
shadowPrismaModel(prisma, "tmdbCache", { findUnique: async () => null, upsert: async () => ({}), deleteMany: async () => ({ count: 0 }) });

const { GET, POST } = await import("../src/app/api/issues/[id]/releases/route.ts");
const { getReleasesForSeries, ReleaseSeasonRequiredError } = await import("../src/lib/arr.ts");
const { seriesReleaseScopeSearchable } = await import("../src/lib/release-scope.ts");
const { runReleaseSearchJob } = await import("../src/lib/client/release-search-job.ts");

function inScope<T>(fn: () => Promise<T>): Promise<T> {
  const workStore = { route: "/issue-release-search.test", forceStatic: false, dynamicShouldError: false, afterContext: { after: () => {} } };
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
const getReleases = (token: string, id: string, query = "") =>
  inScope(() => (GET as unknown as Handler)(
    new NextRequest(`http://localhost:3000/api/issues/${id}/releases${query}`, { headers: { cookie: `${COOKIE}=${token}` } }),
    ctx(id),
  ));
const postRelease = (token: string, id: string, body: unknown) =>
  inScope(() => (POST as unknown as Handler)(
    new NextRequest(`http://localhost:3000/api/issues/${id}/releases`, {
      method: "POST",
      headers: { cookie: `${COOKIE}=${token}`, "content-type": "application/json" },
      body: JSON.stringify(body),
    }),
    ctx(id),
  ));
const releaseReads = () => fetchCalls.filter((c) => c.method === "GET" && c.url.pathname === "/api/v3/release");
const releasePosts = () => fetchCalls.filter((c) => c.method === "POST" && c.url.pathname === "/api/v3/release");
async function settle(pred: () => boolean | Promise<boolean>, ticks = 500): Promise<boolean> {
  for (let i = 0; i < ticks; i++) {
    if (await pred()) return true;
    await new Promise((r) => setImmediate(r));
  }
  return pred();
}

const tvIssue = (over: Record<string, unknown> = {}) => ({
  id: "issue-tv", status: "OPEN", reportedBy: "r", title: "Breaking Bad", mediaType: "TV", tmdbId: 1396,
  tvdbId: 81189, scope: "SEASON", seasonNumber: 1, episodeNumber: null, ...over,
});

beforeEach(() => {
  fetchCalls.length = 0;
  issueWrites.length = 0;
  releaseGate = null;
  _resetReleaseSearchJobsForTests();
  _resetReleaseHandlesForTests();
  settings.clear();
  settings.set("sonarrUrl", SONARR);
  settings.set("sonarrApiKey", "sonarr-key");
  settings.set("radarrUrl", RADARR);
  settings.set("radarrApiKey", "radarr-key");
  issueRow = tvIssue();
});

// ── C024: the background search ──────────────────────────────────────────────

test("C024: ?async=1 answers 202 { job }; the owner's poll is 202 while it runs, then the bare release list; another admin's poll is 404", { timeout: 10_000 }, async () => {
  const owner = await mintSession();
  const other = await mintSession("ADMIN");
  let open!: () => void;
  releaseGate = new Promise<void>((r) => { open = r; });
  const started = await getReleases(owner, "issue-tv", "?instance=&async=1");
  assert.equal(started.status, 202);
  const { job } = (await started.json()) as { job: string };
  assert.match(job, /^[0-9a-f]{32}$/);

  assert.ok(await settle(() => releaseReads().length === 1), "the search reached Sonarr and is parked");
  assert.equal((await getReleases(owner, "issue-tv", `?job=${job}`)).status, 202, "still running");
  assert.equal((await getReleases(other, "issue-tv", `?job=${job}`)).status, 404, "a job is readable by its owner only");

  open();
  let done: Response | null = null;
  assert.ok(await settle(async () => {
    const r = await getReleases(owner, "issue-tv", `?job=${job}`);
    if (r.status === 202) return false;
    done = r;
    return true;
  }));
  assert.equal(done!.status, 200);
  const list = (await done!.json()) as Array<{ guid: string; title: string }>;
  assert.ok(Array.isArray(list), "the same bare-array body the synchronous route sends");
  assert.equal(list.length, 1);
  assert.match(list[0].guid, /^[0-9a-f]{32}$/, "the guid is a handle, as on the synchronous path");
  assert.equal(list[0].title, "Show.S01.1080p.WEB");
});

test("C024: the same admin searching again while one runs JOINS it — one indexer sweep, not two", { timeout: 10_000 }, async () => {
  const owner = await mintSession();
  let open!: () => void;
  releaseGate = new Promise<void>((r) => { open = r; });
  const a = (await (await getReleases(owner, "issue-tv", "?instance=&async=1")).json()) as { job: string };
  assert.ok(await settle(() => releaseReads().length === 1));
  const second = await getReleases(owner, "issue-tv", "?instance=&async=1");
  assert.equal(second.status, 202);
  assert.equal(((await second.json()) as { job: string }).job, a.job);
  open();
  assert.ok(await settle(async () => (await getReleases(owner, "issue-tv", `?job=${a.job}`)).status === 200));
  assert.equal(releaseReads().length, 1, "exactly one /api/v3/release read");
});

test("C024: without async the GET is still the synchronous bare [ArrRelease] list (the iOS contract)", async () => {
  const res = await getReleases(await mintSession(), "issue-tv", "?instance=");
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.ok(Array.isArray(body));
  assert.equal(body.length, 1);
});

test("C024: a background search's failure is the search's own answer (502 + translated generic), not a hang", async () => {
  settings.set("sonarrUrl", "http://10.0.0.9:8989"); // nothing scripted there — every call throws
  const owner = await mintSession();
  const { job } = (await (await getReleases(owner, "issue-tv", "?instance=&async=1")).json()) as { job: string };
  let done: Response | null = null;
  assert.ok(await settle(async () => {
    const r = await getReleases(owner, "issue-tv", `?job=${job}`);
    if (r.status === 202) return false;
    done = r;
    return true;
  }));
  assert.equal(done!.status, 502);
  assert.deepEqual(await done!.json(), { error: "Arr service request failed" });
});

// ── C112: never the series-only (RSS) query ──────────────────────────────────

test("C112: a whole-series (FULL) TV issue's search is a 422 with NO upstream call — sync and async alike", async () => {
  issueRow = tvIssue({ scope: "FULL", seasonNumber: null });
  const token = await mintSession();
  for (const q of ["?instance=", "?instance=&async=1"]) {
    const res = await getReleases(token, "issue-tv", q);
    assert.equal(res.status, 422, q);
    assert.deepEqual(await res.json(), { error: "Sonarr can only search a season or an episode, not a whole series — use Refetch for this issue" });
  }
  assert.deepEqual(fetchCalls, [], "nothing reached Sonarr — not even the series lookup");
});

test("C112: a SEASON issue with no season, and an EPISODE issue with no episode, are refused the same way", async () => {
  const token = await mintSession();
  for (const over of [{ scope: "SEASON", seasonNumber: null }, { scope: "EPISODE", seasonNumber: 1, episodeNumber: null }]) {
    issueRow = tvIssue(over);
    assert.equal((await getReleases(token, "issue-tv", "?instance=")).status, 422, JSON.stringify(over));
  }
  assert.deepEqual(releaseReads(), []);
});

test("C112: the grab of a FULL TV issue is refused 422 BEFORE the handle claim and the IN_PROGRESS CAS — nothing is sent", async () => {
  issueRow = tvIssue({ scope: "FULL", seasonNumber: null });
  const res = await postRelease(await mintSession(), "issue-tv", { guid: "0".repeat(32), indexerId: 3, instance: "" });
  assert.equal(res.status, 422);
  assert.deepEqual(issueWrites, [], "the issue is not flipped to IN_PROGRESS");
  assert.deepEqual(releasePosts(), []);
  assert.equal(issueRow!.status, "OPEN");
});

test("C112: a SEASON issue's search names its season; an EPISODE issue's names its episode", async () => {
  const token = await mintSession();
  assert.equal((await getReleases(token, "issue-tv", "?instance=")).status, 200);
  assert.equal(releaseReads()[0].url.searchParams.get("seasonNumber"), "1");
  assert.equal(releaseReads()[0].url.searchParams.get("seriesId"), "21");

  fetchCalls.length = 0;
  issueRow = tvIssue({ scope: "EPISODE", seasonNumber: 1, episodeNumber: 2 });
  assert.equal((await getReleases(token, "issue-tv", "?instance=")).status, 200);
  assert.equal(releaseReads()[0].url.searchParams.get("episodeId"), "501");
});

test("C112: a movie issue is unaffected (scope FULL is a movie's normal scope)", async () => {
  issueRow = { id: "issue-m", status: "OPEN", reportedBy: "r", title: "The Matrix", mediaType: "MOVIE", tmdbId: 603, tvdbId: null, scope: "FULL", seasonNumber: null, episodeNumber: null };
  const res = await getReleases(await mintSession(), "issue-m", "?instance=");
  assert.equal(res.status, 200);
  assert.equal(((await res.json()) as unknown[]).length, 1);
});

test("C112: getReleasesForSeries itself refuses a series-only query — it throws before any Sonarr call", async () => {
  for (const [scope, season, episode] of [["FULL", null, null], ["SEASON", null, null], ["EPISODE", 1, null], ["EPISODE", null, 2]] as const) {
    fetchCalls.length = 0;
    await assert.rejects(getReleasesForSeries(81189, scope, season, episode, ""), (e: unknown) => e instanceof ReleaseSeasonRequiredError, scope);
    assert.deepEqual(fetchCalls, [], `${scope}: no call`);
  }
});

test("C112: no source builds a series-only /api/v3/release query", () => {
  // Every file under src/, comments stripped. Two shapes reach the endpoint:
  //   1. a literal `/api/v3/release?seriesId=…` — must name a season;
  //   2. the generic `/api/v3/release?${query}` builder, whose query is built
  //      somewhere else — it may live ONLY in searchReleasesByArrId, whose one
  //      caller feeds it releaseQuery's answer (the title manager; its season,
  //      episode and no-scope behaviour is pinned against a scripted Sonarr in
  //      tests/audit-fix2-R8b-tests-vacuous-title-releases.test.mts).
  // Each count must be non-zero, so the scan can't pass by matching nothing.
  const srcDir = join(dirname(fileURLToPath(import.meta.url)), "..", "src");
  const files: Array<{ path: string; code: string }> = [];
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const name = entry.name;
      const p = join(dir, name);
      if (entry.isDirectory()) { if (name !== "generated") walk(p); continue; }
      if (/\.(ts|tsx)$/.test(name)) files.push({ path: p, code: stripComments(readFileSync(p, "utf8")) });
    }
  };
  walk(srcDir);
  let literal = 0;
  for (const f of files) {
    for (const m of f.code.matchAll(/\/api\/v3\/release\?seriesId=[^`"'\n]*/g)) {
      literal++;
      assert.match(m[0], /seasonNumber=/, `${f.path}: a series release query must name a season: ${m[0]}`);
    }
  }
  assert.ok(literal > 0, "found the issue/request season query");

  const generic = files.flatMap((f) => [...f.code.matchAll(/\/api\/v3\/release\?\$\{/g)].map((m) => ({ path: f.path, index: m.index })));
  const arrPath = join(srcDir, "lib", "arr.ts");
  const [start, end] = functionBodyRange(readFileSync(arrPath, "utf8"), "export async function searchReleasesByArrId(");
  assert.deepEqual(generic.map((g) => g.path === arrPath && g.index >= start && g.index < end), [true], "one generic builder, inside searchReleasesByArrId");

  const callers = files.flatMap((f) => [...f.code.matchAll(/\bsearchReleasesByArrId\(([^)]*)\)/g)]
    .filter((m) => !/^export async function /.test(f.code.slice(f.code.lastIndexOf("\n", m.index) + 1, m.index).trimStart()))
    .map((m) => ({ path: f.path, args: m[1], code: f.code })));
  assert.equal(callers.length, 1, "searchReleasesByArrId has one caller");
  assert.ok(callers[0].path.endsWith(join("lib", "arr-title-data.ts")));
  const body = functionBody(callers[0].code, "export async function searchTitleReleases(");
  assert.match(body, /const \{ query, profile \} = await releaseQuery\(cfg, service, arrId, scope\);\s*return searchReleasesByArrId\(cfg, query, profile\);/);
});

test("C112: seriesReleaseScopeSearchable — a season or an episode with its numbers, never a whole series", () => {
  assert.equal(seriesReleaseScopeSearchable("FULL", 1, 2), false);
  assert.equal(seriesReleaseScopeSearchable("SEASON", 1, null), true);
  assert.equal(seriesReleaseScopeSearchable("SEASON", 0, null), true, "specials are a season");
  assert.equal(seriesReleaseScopeSearchable("SEASON", null, null), false);
  assert.equal(seriesReleaseScopeSearchable("EPISODE", 1, 2), true);
  assert.equal(seriesReleaseScopeSearchable("EPISODE", 1, null), false);
  assert.equal(seriesReleaseScopeSearchable("EPISODE", null, 2), false);
  assert.equal(seriesReleaseScopeSearchable("WHATEVER", 1, 2), false);
});

// ── the shared client loop ───────────────────────────────────────────────────

type Scripted = { status: number; body: unknown };
function scriptedFetch(answers: Scripted[]) {
  const seen: string[] = [];
  const fn = (async (input: RequestInfo | URL) => {
    seen.push(String(input));
    const next = answers.shift();
    if (!next) throw new Error("no more answers");
    return new Response(JSON.stringify(next.body), { status: next.status, headers: { "content-type": "application/json" } });
  }) as unknown as typeof fetch;
  return { fn, seen };
}
const now = async () => {};

test("client: runReleaseSearchJob asks with async=1, polls the job until it answers, and returns that answer", async () => {
  const s = scriptedFetch([
    { status: 202, body: { job: "j1" } },
    { status: 202, body: { job: "j1" } },
    { status: 200, body: [{ guid: "h" }] },
  ]);
  const polls: number[] = [];
  const answer = await runReleaseSearchJob(s.fn, "/base/api/issues/i/releases?instance=4k", { sleep: now, onPoll: (n) => polls.push(n) });
  assert.deepEqual(answer, { status: 200, data: [{ guid: "h" }] });
  assert.deepEqual(s.seen, [
    "/base/api/issues/i/releases?instance=4k&async=1",
    "/base/api/issues/i/releases?job=j1",
    "/base/api/issues/i/releases?job=j1",
  ]);
  assert.deepEqual(polls, [0, 1], "counted, one per wait");
});

test("client: a URL without a query gets ?async=1; a 404 poll (job gone) is returned like any answer", async () => {
  const s = scriptedFetch([{ status: 202, body: { job: "j" } }, { status: 404, body: { error: "search again" } }]);
  const answer = await runReleaseSearchJob(s.fn, "/api/requests/r/releases", { sleep: now });
  assert.deepEqual(answer, { status: 404, data: { error: "search again" } });
  assert.equal(s.seen[0], "/api/requests/r/releases?async=1");
});

test("client: a 202 with no job id, or past maxPolls, gives up with status 0", async () => {
  assert.deepEqual(await runReleaseSearchJob(scriptedFetch([{ status: 202, body: {} }]).fn, "/x", { sleep: now }), { status: 0, data: null });
  const s = scriptedFetch(Array.from({ length: 10 }, () => ({ status: 202, body: { job: "j" } })));
  assert.deepEqual(await runReleaseSearchJob(s.fn, "/x", { sleep: now, maxPolls: 3 }), { status: 0, data: null });
  assert.equal(s.seen.length, 4, "the start plus exactly maxPolls polls");
});

test("client: once isAlive turns false (superseded, or the dialog closed) it stops polling and answers null", async () => {
  const s = scriptedFetch(Array.from({ length: 10 }, () => ({ status: 202, body: { job: "j" } })));
  let alive = true;
  const answer = await runReleaseSearchJob(s.fn, "/x", {
    sleep: async () => { if (s.seen.length >= 2) alive = false; },
    isAlive: () => alive,
  });
  assert.equal(answer, null);
  assert.equal(s.seen.length, 2, "no poll after it was superseded");
});

// ── structural: both components run the shared loop ──────────────────────────

const here = dirname(fileURLToPath(import.meta.url));
const read = (p: string) => readFileSync(join(here, "..", p), "utf8");

test("structural (C024): the issue Replace panel searches through the background job, superseded by a newer search or a close", () => {
  const src = read("src/components/admin/issue-actions.tsx");
  const load = src.slice(src.indexOf("async function loadReleases("), src.indexOf("async function openReplacePicker("));
  assert.match(load, /runReleaseSearchJob\(\s*fetch,\s*withBasePath\(`\/api\/issues\/\$\{issueId\}\/releases\?instance=/);
  assert.match(load, /isAlive: \(\) => reqId === releaseReqRef\.current/);
  assert.doesNotMatch(load, /await fetch\(/, "no synchronous search left in the panel");
  assert.match(src, /function closeReplacePicker\(\) \{\s*releaseReqRef\.current\+\+;/);
  assert.match(src, /onOpenChange=\{\(o\) => \{ if \(!o && loading !== "grab"\) closeReplacePicker\(\); \}\}/);
});

test("structural (C112): the Replace release button is offered only for a searchable TV scope", () => {
  const src = read("src/components/admin/issue-actions.tsx");
  assert.match(src, /const canReplace = mediaType === "MOVIE"\s*\|\| \(seriesReleaseScopeSearchable\(scope, seasonNumber, episodeNumber\)/);
});

test("structural (C024): ReleaseSearchDialog runs the same shared loop", () => {
  const src = read("src/components/admin/release-search-dialog.tsx");
  assert.match(src, /runReleaseSearchJob\(fetch, withBasePath\(url\), \{\s*isAlive: \(\) => id === seq\.current,/);
  assert.doesNotMatch(src, /while \(res\.status === 202\)/, "no private copy of the poll loop");
});
