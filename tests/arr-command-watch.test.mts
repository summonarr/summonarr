// Live feedback for the Radarr/Sonarr commands Summonarr starts:
//   GET /api/admin/arr/commands  (the status read the pages poll)
//   the command ids the starting routes now answer with
//     /api/admin/arr/title/command, /api/admin/arr/title/rename,
//     /api/admin/arr/blocklist/clear
//   lib/arr-command-status.ts (the projection, the summary line, the pacing
//   and the polling loop the browser hook runs)
//
// What is pinned:
//   1. The read route is ADMIN ONLY (guardrail 6a), names a CONFIGURED
//      instance (guardrail 32), takes at most COMMAND_READ_MAX_IDS (200)
//      positive integer ids — anything else is 400 with nothing sent upstream
//      — and reads each command once, at most COMMAND_READ_CONCURRENCY at a
//      time; the first failure stops the rest. A Sonarr "search missing" on a
//      long series (one SeasonSearch per season) is followed without a 400,
//      and a watch with more ids than one read takes splits them across reads.
//   2. It answers Arr System's explicit command fields, message masked, and
//      NEVER the command body (guardrail 5e). A 404 is { id, status: "gone" }.
//   3. A polled failure is logged once per unchanged condition (guardrail 7b)
//      and it is rate-limited per admin.
//   4. Every command-starting route answers with the arr's command id(s),
//      additively (the old fields unchanged).
//   5. The watch reads one at a time, from each answer; stops on all-terminal
//      (calling onDone once), on a refusal, after consecutive failures, at the
//      poll cap, and on stop — after which nothing it had in flight is acted on.
//      The cap is only declared on an ANSWER (a tab hidden past it reads on
//      return, and a failed or 429 read past the cap retries — at most
//      WATCH_MAX_FAILED_READS of them), and each poll reads only the ids still
//      queued or running.
//   4a. A Sonarr "search missing" refused part-way answers 202 with the ids it
//      did queue and `partial: true`; one on a series the instance no longer
//      has is a 404, never "nothing missing".
//   6. The four pages no longer guess completion with a fixed timer.
//
// Harness: the same as tests/arr-manage-routes.test.mts.
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import dns from "node:dns/promises";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { AsyncLocalStorage } from "node:async_hooks";

(globalThis as { AsyncLocalStorage?: unknown }).AsyncLocalStorage = AsyncLocalStorage;

process.env.TOKEN_ENCRYPTION_KEY = "ab".repeat(32);
process.env.NEXTAUTH_SECRET = "arr-command-watch-test-secret-0123456789abcdef";
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
const SONARR = "http://10.0.0.7:8989";
type Call = { origin: string; method: string; path: string; query: URLSearchParams; body: unknown };
let calls: Call[] = [];
type Responder = (c: Call) => Response | undefined | Promise<Response | undefined>;
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
const { invalidateFeatureFlagCache } = await import("../src/lib/features.ts");
const { resetLogDedup } = await import("../src/lib/log-dedup.ts");
const status = await import("../src/lib/arr-command-status.ts");
const { COMMAND_READ_CONCURRENCY } = await import("../src/lib/arr-admin.ts");
type ArrCommandState = import("../src/lib/arr-command-status.ts").ArrCommandState;
type WatchRead = import("../src/lib/arr-command-status.ts").WatchRead;

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
const audits: Array<{ action: string; target: string | null; details: unknown }> = [];
shadowPrismaModel(prisma, "auditLog", {
  create: async (args: { data: { action: string; target?: string | null; details?: unknown } }) => {
    audits.push({ action: args.data.action, target: args.data.target ?? null, details: args.data.details });
    return {};
  },
});

const commandsRoute = await import("../src/app/api/admin/arr/commands/route.ts");
const commandRoute = await import("../src/app/api/admin/arr/title/command/route.ts");
const renameRoute = await import("../src/app/api/admin/arr/title/rename/route.ts");
const clearRoute = await import("../src/app/api/admin/arr/blocklist/clear/route.ts");
const missingSearchRoute = await import("../src/app/api/admin/missing/search/route.ts");

// ── request scope ────────────────────────────────────────────────────────────
function inScope<T>(fn: () => Promise<T>): Promise<T> {
  const workStore = { route: "/arr-command-watch.test", forceStatic: false, dynamicShouldError: false, afterContext: { after: () => {} } };
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
const call = (handler: unknown, token: string | null, path: string, init: { method?: string; body?: unknown } = {}) =>
  inScope(() => (handler as Handler)(
    new NextRequest(`http://localhost:3000/api${path}`, {
      method: init.method ?? "GET",
      headers: {
        ...(token ? { cookie: `${COOKIE}=${token}` } : {}),
        ...(init.body !== undefined ? { "content-type": "application/json" } : {}),
      },
      ...(init.body !== undefined ? { body: JSON.stringify(init.body) } : {}),
    }),
    undefined,
  ));
const arrCalls = () => calls.filter((c) => c.origin !== "http://localhost:3000");
const writes = () => arrCalls().filter((c) => c.method !== "GET");

const APIKEY = "s3cr3t-indexer-apikey";
// The arr's CommandResource: `name` is the command, `commandName` its label.
const commandResource = (id: number, over: Record<string, unknown> = {}) => ({
  id, name: "MoviesSearch", commandName: "Movies Search", status: "started", trigger: "manual",
  queued: "2026-10-11T10:00:00Z", started: "2026-10-11T10:00:01Z", duration: "00:00:04.5000000",
  message: "Searching 41 of 212",
  body: { movieIds: [11], sendUpdatesToClient: true, secretPath: "/data/private/thing.mkv" },
  ...over,
});
const commandGets: Responder = (c) => {
  const m = /^\/api\/v3\/command\/(\d+)$/.exec(c.path);
  if (c.method !== "GET" || !m) return undefined;
  const id = Number(m[1]);
  if (id === 404) return new Response("{}", { status: 404 });
  return json(commandResource(id));
};
const both = (...rs: Responder[]): Responder => async (c) => {
  for (const r of rs) {
    const res = await r(c);
    if (res) return res;
  }
  return undefined;
};

beforeEach(() => {
  calls = [];
  audits.length = 0;
  warnLines = [];
  resetLogDedup();
  responder = commandGets;
  settings.clear();
  for (const [k, v] of Object.entries({
    radarrUrl: RADARR, radarrApiKey: "radarr-key",
    sonarrUrl: SONARR, sonarrApiKey: "sonarr-key",
  })) settings.set(k, v);
  invalidateFeatureFlagCache();
});

const read = (token: string | null, q: string) => call(commandsRoute.GET, token, `/admin/arr/commands?${q}`);

// ── 1: the read route's front door ───────────────────────────────────────────

test("commands read: anonymous is 401 and a delegated manager 403 — nothing reaches Radarr/Sonarr", async () => {
  const manager = await mintSession({ role: "USER", permissions: Permission.MANAGE_REQUESTS | Permission.MANAGE_ISSUES });
  assert.equal((await read(null, "service=radarr&ids=1")).status, 401);
  assert.equal((await read(manager, "service=radarr&ids=1")).status, 403);
  assert.deepEqual(arrCalls(), []);
});

const idList = (n: number, from = 1) => Array.from({ length: n }, (_, i) => i + from);

test("commands read: at most COMMAND_READ_MAX_IDS (200) positive integer ids — anything else is 400 with nothing sent upstream", async () => {
  const token = await mintSession();
  assert.equal(status.COMMAND_READ_MAX_IDS, 200);
  const tooMany = idList(status.COMMAND_READ_MAX_IDS + 1).join(",");
  for (const ids of ["", "0", "-1", "a", "1,,2", "1.5", "1e3", tooMany]) {
    assert.equal((await read(token, `service=radarr&ids=${encodeURIComponent(ids)}`)).status, 400, `ids=${ids.slice(0, 20)}`);
  }
  assert.equal((await read(token, "service=radarr")).status, 400, "no ids at all");
  assert.equal((await read(token, "service=lidarr&ids=1")).status, 400, "not a service");
  assert.deepEqual(arrCalls(), []);
  const max = idList(status.COMMAND_READ_MAX_IDS).join(",");
  assert.equal((await read(token, `service=radarr&ids=${max}`)).status, 200);
  assert.equal(arrCalls().length, status.COMMAND_READ_MAX_IDS);
});

test("commands read: 25 ids are all read, in the order asked, never more than COMMAND_READ_CONCURRENCY at once", async () => {
  const token = await mintSession();
  let inFlight = 0;
  let maxInFlight = 0;
  responder = async (c) => {
    inFlight++;
    maxInFlight = Math.max(maxInFlight, inFlight);
    await new Promise((r) => setImmediate(r));
    inFlight--;
    return commandGets(c);
  };
  const ids = idList(25, 100);
  const res = await read(token, `service=sonarr&ids=${ids.join(",")}`);
  assert.equal(res.status, 200);
  const body = (await res.json()) as { commands: Array<{ id: number }> };
  assert.deepEqual(body.commands.map((c) => c.id), ids);
  assert.equal(arrCalls().length, 25, "each read once");
  assert.ok(COMMAND_READ_CONCURRENCY > 1 && COMMAND_READ_CONCURRENCY < 25);
  assert.equal(maxInFlight, COMMAND_READ_CONCURRENCY, "bounded, and still concurrent");
});

test("commands read: the first failure stops the rest — the ids not yet started are never sent, even after the answer", async () => {
  const token = await mintSession();
  responder = async (c) => {
    if (c.path === "/api/v3/command/1") return new Response("boom", { status: 500 });
    for (let i = 0; i < 3; i++) await new Promise((r) => setImmediate(r));
    return commandGets(c);
  };
  assert.equal((await read(token, `service=radarr&ids=${idList(25).join(",")}`)).status, 502);
  // The other workers' reads were already out; nothing after them is started.
  for (let i = 0; i < 50; i++) await new Promise((r) => setImmediate(r));
  assert.equal(arrCalls().length, COMMAND_READ_CONCURRENCY, "only the reads already in flight");
});

test("commands read: a slug naming no configured instance is refused before any upstream call", async () => {
  const token = await mintSession();
  const res = await read(token, "service=radarr&instance=anime&ids=1");
  assert.equal(res.status, 404);
  assert.deepEqual(arrCalls(), []);
});

test("commands read: duplicates collapse, each id is read once on THAT instance, in the order asked", async () => {
  const token = await mintSession();
  const res = await read(token, "service=sonarr&ids=8,7,8");
  assert.equal(res.status, 200);
  const body = (await res.json()) as { commands: Array<{ id: number }> };
  assert.deepEqual(body.commands.map((c) => c.id), [8, 7]);
  assert.deepEqual(arrCalls().map((c) => `${c.method} ${c.origin}${c.path}`), [
    `GET ${SONARR}/api/v3/command/8`,
    `GET ${SONARR}/api/v3/command/7`,
  ]);
});

test("commands read: the ids are read concurrently, not one after another", async () => {
  const token = await mintSession();
  let inFlight = 0;
  let maxInFlight = 0;
  responder = async (c) => {
    inFlight++;
    maxInFlight = Math.max(maxInFlight, inFlight);
    await new Promise((r) => setImmediate(r));
    inFlight--;
    return commandGets(c);
  };
  assert.equal((await read(token, "service=radarr&ids=1,2,3")).status, 200);
  assert.equal(maxInFlight, 3);
});

// ── 2: what the read answers ─────────────────────────────────────────────────

test("commands read: Arr System's command fields, message masked — never the body, never the trigger", async () => {
  const token = await mintSession();
  responder = (c) => (c.path === "/api/v3/command/5"
    ? json(commandResource(5, { message: `Failed: https://indexer.example/api?apikey=${APIKEY}`, status: "failed", ended: "2026-10-11T10:00:05Z" }))
    : undefined);
  const res = await read(token, "service=radarr&ids=5");
  const text = await res.text();
  assert.equal(res.status, 200);
  assert.ok(!text.includes(APIKEY), "credentials masked");
  assert.ok(!text.includes("secretPath") && !text.includes("/data/private"), "no command body");
  const [cmd] = (JSON.parse(text) as { commands: Array<Record<string, unknown>> }).commands;
  assert.deepEqual(Object.keys(cmd).sort(), ["commandName", "durationSeconds", "ended", "id", "message", "name", "queued", "started", "status"]);
  assert.deepEqual([cmd.id, cmd.name, cmd.commandName, cmd.status, cmd.durationSeconds], [5, "Movies Search", "MoviesSearch", "failed", 4]);
  assert.match(String(cmd.message), /apikey=••••••••/);
});

test("commands read: an id the arr answers 404 for is gone; the others are still reported", async () => {
  const token = await mintSession();
  const res = await read(token, "service=radarr&ids=404,6");
  assert.equal(res.status, 200);
  const body = (await res.json()) as { commands: Array<Record<string, unknown>> };
  assert.deepEqual(body.commands[0], { id: 404, status: "gone" });
  assert.equal(body.commands[1].status, "started");
});

test("commands read: an answer naming ANOTHER command is never reported as this one", async () => {
  const token = await mintSession();
  responder = (c) => (c.path === "/api/v3/command/5" ? json(commandResource(6, { status: "completed" })) : undefined);
  const body = (await (await read(token, "service=radarr&ids=5")).json()) as { commands: Array<Record<string, unknown>> };
  assert.deepEqual([body.commands[0].id, body.commands[0].status], [5, "unknown"]);
});

// ── 3: polling hygiene ───────────────────────────────────────────────────────

test("commands read: a down instance is 502, logged ONCE across polls, and again after it recovered", async () => {
  const token = await mintSession();
  let up = false;
  responder = (c) => (up ? commandGets(c) : new Response("boom", { status: 500 }));
  assert.equal((await read(token, "service=radarr&ids=1")).status, 502);
  assert.equal((await read(token, "service=radarr&ids=1")).status, 502);
  assert.equal(warnLines.filter((l) => l.includes("command status read failed")).length, 1, "one unchanged condition, one line");
  up = true;
  assert.equal((await read(token, "service=radarr&ids=1")).status, 200);
  up = false;
  assert.equal((await read(token, "service=radarr&ids=1")).status, 502);
  assert.equal(warnLines.filter((l) => l.includes("command status read failed")).length, 2, "a new outage is logged");
});

test("commands read: rate-limited per admin at 120 a minute (429 with Retry-After), and never audited", async () => {
  const token = await mintSession();
  for (let i = 0; i < 120; i++) assert.equal((await read(token, "service=radarr&ids=1")).status, 200, `read ${i + 1}`);
  const limited = await read(token, "service=radarr&ids=1");
  assert.equal(limited.status, 429);
  assert.equal(limited.headers.get("Retry-After"), "60");
  assert.equal(arrCalls().length, 120, "the refused read reached nothing");
  assert.equal(audits.length, 0);
  // Another admin has their own budget.
  assert.equal((await read(await mintSession(), "service=radarr&ids=1")).status, 200);
});

// ── 4: the routes that start commands answer with their ids ──────────────────

const MOVIE = { id: 11, tmdbId: 603, title: "The Matrix", year: 1999, monitored: true, qualityProfileId: 1, rootFolderPath: "/movies/", path: "/movies/The Matrix (1999)", tags: [], hasFile: true, status: "released" };
const SERIES = {
  id: 21, tvdbId: 81189, tmdbId: 1396, title: "Breaking Bad", year: 2008, monitored: true, qualityProfileId: 1, rootFolderPath: "/tv/", tags: [],
  seasons: [
    { seasonNumber: 2, monitored: true, statistics: { episodeCount: 2, episodeFileCount: 1, totalEpisodeCount: 2 } },
    { seasonNumber: 3, monitored: true, statistics: { episodeCount: 2, episodeFileCount: 0, totalEpisodeCount: 2 } },
  ],
};
const EPISODES = [
  { id: 201, seriesId: 21, seasonNumber: 2, episodeNumber: 1, title: "a", monitored: true, hasFile: true, airDateUtc: "2009-03-09T02:00:00Z" },
  { id: 202, seriesId: 21, seasonNumber: 2, episodeNumber: 2, title: "b", monitored: true, hasFile: false, airDateUtc: "2009-03-16T02:00:00Z" },
  { id: 301, seriesId: 21, seasonNumber: 3, episodeNumber: 1, title: "c", monitored: true, hasFile: false, airDateUtc: "2010-03-21T02:00:00Z" },
  { id: 302, seriesId: 21, seasonNumber: 3, episodeNumber: 2, title: "d", monitored: true, hasFile: false, airDateUtc: "2010-03-28T02:00:00Z" },
];
const library: Responder = (c) => {
  if (c.method !== "GET") return undefined;
  if (c.origin === RADARR && c.path === "/api/v3/movie/11") return json(MOVIE);
  if (c.origin === SONARR && c.path === "/api/v3/series/21") return json(SERIES);
  if (c.origin === SONARR && c.path === "/api/v3/episode" && c.query.get("seriesId") === "21") return json(EPISODES);
  const one = c.origin === SONARR ? /^\/api\/v3\/episode\/(\d+)$/.exec(c.path) : null;
  if (one) {
    const ep = EPISODES.find((e) => String(e.id) === one[1]);
    return ep ? json(ep) : new Response("{}", { status: 404 });
  }
  return undefined;
};
// POST /api/v3/command answers 201 with the queued command, ids counting up.
function queueing(ids: Array<number | null>): Responder {
  let n = 0;
  return (c) => {
    if (c.method !== "POST" || c.path !== "/api/v3/command") return undefined;
    const id = ids[Math.min(n++, ids.length - 1)];
    return json(id === null ? { status: "queued" } : { id, name: (c.body as { name?: string }).name, status: "queued" }, 201);
  };
}
const postCommand = (token: string, body: Record<string, unknown>) => call(commandRoute.POST, token, "/admin/arr/title/command", { method: "POST", body });

test("title commands answer { commands, commandIds } — the arr's id for what it queued", async () => {
  const token = await mintSession();
  responder = both(queueing([5, 6, 7, 8]), library);
  const cases: Array<[Record<string, unknown>, number]> = [
    [{ service: "radarr", id: 11, action: "search" }, 5],
    [{ service: "radarr", id: 11, action: "refresh" }, 6],
    [{ service: "sonarr", id: 21, action: "searchSeason", seasonNumber: 3 }, 7],
    [{ service: "sonarr", id: 21, action: "searchEpisodes", episodeIds: [202] }, 8],
  ];
  for (const [body, id] of cases) {
    const res = await postCommand(token, body);
    assert.equal(res.status, 202, String(body.action));
    assert.deepEqual(await res.json(), { commands: 1, commandIds: [id] }, String(body.action));
  }
});

test("Sonarr 'search missing' answers the id of EVERY command it queued — one per season searched whole, plus one", async () => {
  const token = await mintSession();
  responder = both(queueing([41, 42]), library);
  const res = await postCommand(token, { service: "sonarr", id: 21, action: "searchMissing" });
  assert.equal(res.status, 202);
  assert.deepEqual(await res.json(), { commands: 2, seasons: [3], episodes: 1, commandIds: [41, 42] });
  assert.deepEqual(writes().map((c) => c.body), [
    { name: "SeasonSearch", seriesId: 21, seasonNumber: 3 },
    { name: "EpisodeSearch", episodeIds: [202] },
  ]);
});

test("a long series' 'search missing' (a SeasonSearch per season, 30 of them) is followed by one read — never a 400", async () => {
  const token = await mintSession();
  const seasons = 30;
  const episodes = Array.from({ length: seasons }, (_, s) => [
    { id: 1000 + s * 2, seriesId: 21, seasonNumber: s + 1, episodeNumber: 1, title: "a", monitored: true, hasFile: false, airDateUtc: "2001-01-01T02:00:00Z" },
    { id: 1001 + s * 2, seriesId: 21, seasonNumber: s + 1, episodeNumber: 2, title: "b", monitored: true, hasFile: false, airDateUtc: "2001-01-08T02:00:00Z" },
  ]).flat();
  responder = both(
    queueing(idList(seasons, 500)),
    (c) => (c.method === "GET" && c.origin === SONARR && c.path === "/api/v3/episode" ? json(episodes) : undefined),
    commandGets,
  );
  const started = await postCommand(token, { service: "sonarr", id: 21, action: "searchMissing" });
  assert.equal(started.status, 202);
  const { commandIds } = (await started.json()) as { commandIds: number[] };
  assert.equal(commandIds.length, seasons, "one SeasonSearch per fully missing season");
  const res = await read(token, `service=sonarr&ids=${commandIds.join(",")}`);
  assert.equal(res.status, 200);
  assert.deepEqual(((await res.json()) as { commands: Array<{ id: number }> }).commands.map((c) => c.id), commandIds);
});

// Three fully missing seasons (each 2 episodes, none on disk), then the rest.
const THREE_SEASONS = [1, 2, 3].flatMap((sn) => [1, 2].map((e) => (
  { id: sn * 100 + e, seriesId: 21, seasonNumber: sn, episodeNumber: e, title: "x", monitored: true, hasFile: false, airDateUtc: "2001-01-01T02:00:00Z" }
)));
const threeSeasons: Responder = (c) =>
  (c.method === "GET" && c.origin === SONARR && c.path === "/api/v3/episode" && c.query.get("seriesId") === "21" ? json(THREE_SEASONS) : undefined);
// POST /api/v3/command: the first `accepted` ids are queued, every later POST is a 503.
function queueingThen503(accepted: number[]): Responder {
  let n = 0;
  return (c) => {
    if (c.method !== "POST" || c.path !== "/api/v3/command") return undefined;
    const id = accepted[n++];
    return id === undefined ? new Response("busy", { status: 503 }) : json({ id, name: (c.body as { name?: string }).name, status: "queued" }, 201);
  };
}
const postMissingSearch = (token: string, body: Record<string, unknown>) =>
  call(missingSearchRoute.POST, token, "/admin/missing/search", { method: "POST", body });

test("Sonarr 'search missing' refused part-way answers 202 with the ids it DID queue and partial: true — never a failure that drops them", async () => {
  const token = await mintSession();
  responder = both(queueingThen503([11, 12]), threeSeasons);
  const res = await postCommand(token, { service: "sonarr", id: 21, action: "searchMissing" });
  assert.equal(res.status, 202);
  assert.deepEqual(await res.json(), { commands: 2, seasons: [1, 2], episodes: 0, partial: true, commandIds: [11, 12] });
  assert.deepEqual(writes().map((c) => (c.body as { seasonNumber?: number }).seasonNumber), [1, 2, 3], "it stopped at the refusal");
  assert.ok(warnLines.some((l) => l.includes("stopped after 2 command(s)")), "the stop is logged");

  // The Missing page's own search carries the same additive flag.
  calls = [];
  responder = both(queueingThen503([31]), threeSeasons);
  const page = await postMissingSearch(token, { service: "sonarr", instance: "", arrId: 21 });
  assert.equal(page.status, 202);
  assert.deepEqual(await page.json(), { commands: 1, seasons: [1], episodes: 0, partial: true });
});

test("Sonarr 'search missing' refused on its FIRST command is still a failure, with no ids", async () => {
  const token = await mintSession();
  responder = both(queueingThen503([]), threeSeasons);
  const res = await postCommand(token, { service: "sonarr", id: 21, action: "searchMissing" });
  assert.equal(res.status, 502);
  const body = (await res.json()) as Record<string, unknown>;
  assert.equal("commandIds" in body, false);
  assert.equal("partial" in body, false);
  assert.equal((await postMissingSearch(token, { service: "sonarr", instance: "", arrId: 21 })).status, 502);
});

test("Sonarr 'search missing' on a series the instance no longer has is not found — never 'nothing missing'", async () => {
  const token = await mintSession();
  // Sonarr answers an unknown seriesId's episode list with 200 []; its series read 404s.
  let seriesExists = false;
  responder = (c) => {
    if (c.method !== "GET" || c.origin !== SONARR) return undefined;
    if (c.path === "/api/v3/episode" && c.query.get("seriesId") === "99") return json([]);
    if (c.path === "/api/v3/series/99") return seriesExists ? json({ id: 99, title: "Empty", seasons: [] }) : new Response("{}", { status: 404 });
    return undefined;
  };
  assert.equal((await postCommand(token, { service: "sonarr", id: 99, action: "searchMissing" })).status, 404);
  assert.equal((await postMissingSearch(token, { service: "sonarr", instance: "", arrId: 99 })).status, 404);
  assert.deepEqual(writes(), [], "nothing queued");
  // A series that exists with no episodes is genuinely complete.
  seriesExists = true;
  assert.equal((await postCommand(token, { service: "sonarr", id: 99, action: "searchMissing" })).status, 409);
  assert.equal((await postMissingSearch(token, { service: "sonarr", instance: "", arrId: 99 })).status, 409);
  // A non-empty episode list never pays for the series read.
  calls = [];
  responder = both(queueing([41, 42]), library);
  assert.equal((await postCommand(token, { service: "sonarr", id: 21, action: "searchMissing" })).status, 202);
  assert.ok(!arrCalls().some((c) => c.path === "/api/v3/series/21"));
});

test("a duplicate push (the arr answering with the command already queued) is one id; an answer with no id is none", async () => {
  const token = await mintSession();
  responder = both(queueing([41, 41]), library);
  assert.deepEqual(((await (await postCommand(token, { service: "sonarr", id: 21, action: "searchMissing" })).json()) as { commandIds: number[] }).commandIds, [41]);
  responder = both(queueing([null]), library);
  const res = await postCommand(token, { service: "radarr", id: 11, action: "search" });
  assert.equal(res.status, 202, "queued all the same");
  assert.deepEqual(await res.json(), { commands: 1, commandIds: [] });
});

test("rename answers { files, commandIds }, still audited after the arr accepted it", async () => {
  const token = await mintSession();
  responder = both(queueing([9]), (c) => (c.method === "GET" && c.path === "/api/v3/rename"
    ? json([{ movieId: 11, movieFileId: 7, existingPath: "matrix.mkv", newPath: "The Matrix (1999).mkv" }])
    : undefined));
  const res = await call(renameRoute.POST, token, "/admin/arr/title/rename", { method: "POST", body: { service: "radarr", id: 11, fileIds: [7] } });
  assert.equal(res.status, 202);
  assert.deepEqual(await res.json(), { files: 1, commandIds: [9] });
  assert.deepEqual(audits.map((a) => a.action), ["ARR_FILE_RENAME"]);
});

test("Clear blocklist answers { ok, commandIds }, still audited", async () => {
  const token = await mintSession();
  responder = queueing([3]);
  const res = await call(clearRoute.POST, token, "/admin/arr/blocklist/clear", { method: "POST", body: { service: "sonarr", count: 4 } });
  assert.equal(res.status, 202);
  assert.deepEqual(await res.json(), { ok: true, commandIds: [3] });
  assert.deepEqual(writes().map((c) => [c.origin, c.body]), [[SONARR, { name: "ClearBlocklist" }]]);
  assert.deepEqual(audits.map((a) => a.action), ["ARR_BLOCKLIST_CHANGE"]);
});

// ── 5: the pure half ─────────────────────────────────────────────────────────

const st = (id: number, s: string, message: string | null = null): ArrCommandState =>
  s === "gone"
    ? { id, status: "gone" }
    : { id, status: s as never, name: "X", commandName: "X", queued: null, started: null, ended: null, durationSeconds: null, message };

test("terminal: only queued and started are still going", () => {
  for (const s of ["queued", "started"] as const) assert.equal(status.isTerminalCommandStatus(s), false, s);
  for (const s of ["completed", "failed", "aborted", "cancelled", "orphaned", "unknown", "gone"] as const) {
    assert.equal(status.isTerminalCommandStatus(s), true, s);
  }
});

test("summary: running shows the started command's progress; done reports the WORST outcome with its own message", () => {
  assert.deepEqual(status.summarizeCommands([st(1, "queued"), st(2, "started", "Searching 3 of 9"), st(3, "completed", "ok")]),
    { done: false, status: "started", message: "Searching 3 of 9", finished: 1, total: 3 });
  assert.deepEqual(status.summarizeCommands([st(1, "queued")]), { done: false, status: "queued", message: null, finished: 0, total: 1 });
  assert.deepEqual(status.summarizeCommands([st(1, "completed", "1 reports downloaded"), st(2, "failed", "No indexers"), st(3, "completed")]),
    { done: true, status: "failed", message: "No indexers", finished: 3, total: 3 });
  assert.equal(status.summarizeCommands([st(1, "completed"), st(2, "gone")]).status, "gone", "a forgotten command is never claimed completed");
  assert.equal(status.summarizeCommands([st(1, "cancelled"), st(2, "aborted")]).status, "aborted");
  assert.deepEqual(status.summarizeCommands([st(1, "completed", "Search completed. 2 reports downloaded.")]),
    { done: true, status: "completed", message: "Search completed. 2 reports downloaded.", finished: 1, total: 1 });
});

test("line: waiting until the first read, then running, then how it ended; ended beats a stop", () => {
  assert.deepEqual(status.commandLine(null, null), { kind: "waiting" });
  assert.equal(status.commandLine([st(1, "started", "x")], null).kind, "running");
  assert.equal(status.commandLine([st(1, "started")], "timeout").kind, "timeout");
  assert.deepEqual(status.commandLine(null, "error", "nope"), { kind: "error", error: "nope" });
  assert.equal(status.commandLine([st(1, "completed")], "timeout").kind, "done");
  const tone = (s: string) => status.commandLineTone(status.commandLine([st(1, s)], null));
  assert.deepEqual(["completed", "failed", "aborted", "orphaned", "cancelled", "gone", "unknown", "started"].map(tone),
    ["success", "danger", "danger", "danger", "neutral", "neutral", "neutral", "progress"]);
  assert.equal(status.isLineActive(status.commandLine(null, null)), true, "the button stays disabled before the first status");
  assert.equal(status.isLineActive(status.commandLine([st(1, "queued")], null)), true);
  assert.equal(status.isLineActive(status.commandLine([st(1, "failed")], null)), false);
  assert.equal(status.isLineActive(status.commandLine([st(1, "queued")], "timeout")), false);
});

test("parse: exactly one well-formed state per id, in the order asked — anything else is a failed read", () => {
  const good = { commands: [{ id: 2, status: "gone" }, { id: 1, status: "started", name: "A", commandName: "a", message: "m", queued: null, started: null, ended: null, durationSeconds: 1 }] };
  const parsed = status.parseCommandStates(good, [1, 2]);
  assert.deepEqual(parsed?.map((s) => [s.id, s.status]), [[1, "started"], [2, "gone"]]);
  assert.equal(status.parseCommandStates(good, [1, 2, 3]), null, "an id missing");
  assert.equal(status.parseCommandStates({ commands: [{ id: 1, status: "exploded" }] }, [1]), null, "a status nobody sends");
  assert.equal(status.parseCommandStates({ commands: [{ id: "1", status: "queued" }] }, [1]), null);
  assert.equal(status.parseCommandStates([], [1]), null);
  const odd = status.parseCommandStates({ commands: [{ id: 1, status: "failed", message: { html: "<b>" } }] }, [1]);
  assert.deepEqual(odd && "message" in odd[0] ? odd[0].message : "missing", null, "a non-string message is dropped, never rendered");
});

test("projection: the explicit field list, masked; an answer for another id is unknown", () => {
  const s = status.projectCommandState(commandResource(5, { message: `apikey=${APIKEY}` }), 5);
  assert.ok(!JSON.stringify(s).includes(APIKEY));
  assert.ok(!("body" in s) && !("trigger" in s));
  assert.equal(status.projectCommandState(commandResource(6), 5).status, "unknown");
  assert.equal(status.projectCommandState(null, 5).status, "unknown");
});

test("pacing: done when every command ended; a refusal stops at once; five failures in a row stop; an answer resets the count", () => {
  const c0 = { polls: 0, failures: 0 };
  const running: WatchRead = { kind: "ok", states: [st(1, "started")] };
  assert.equal(status.watchStep({ kind: "ok", states: [st(1, "completed"), st(2, "gone")] }, c0).step.next, "done");
  assert.deepEqual(status.watchStep(running, c0).step, { next: "poll", delayMs: status.WATCH_POLL_MS, states: running.states });
  assert.deepEqual(status.watchStep({ kind: "refused", error: "x" }, c0).step, { next: "stop", stopped: "error", error: "x" });
  let c = c0;
  for (let i = 0; i < status.WATCH_MAX_FAILED_READS - 1; i++) {
    const r = status.watchStep({ kind: "failed", error: "e" }, c);
    assert.equal(r.step.next, "poll", `failure ${i + 1}`);
    c = r.counters;
  }
  assert.equal(status.watchStep(running, c).counters.failures, 0, "an answer resets the count");
  assert.deepEqual(status.watchStep({ kind: "failed", error: "e" }, c).step, { next: "stop", stopped: "error", error: "e" });
});

test("pacing: the cap is a COUNT of polls (~10 minutes); a hidden tab's poll counts; a 429 waits and counts five", () => {
  assert.equal(status.WATCH_MAX_POLLS * status.WATCH_POLL_MS, 600_000);
  const running: WatchRead = { kind: "ok", states: [st(1, "started")] };
  assert.equal(status.watchStep(running, { polls: status.WATCH_MAX_POLLS - 2, failures: 0 }).step.next, "poll");
  assert.deepEqual(status.watchStep(running, { polls: status.WATCH_MAX_POLLS - 1, failures: 0 }).step, { next: "stop", stopped: "timeout", error: "" });
  // A hidden poll counts, but it read nothing — the cap waits for one real read.
  const hiddenAtCap = status.watchStep({ kind: "skipped" }, { polls: status.WATCH_MAX_POLLS - 1, failures: 0 });
  assert.equal(hiddenAtCap.step.next, "poll", "a skipped poll never declares the timeout");
  assert.equal(hiddenAtCap.counters.polls, status.WATCH_MAX_POLLS, "it still counts");
  assert.equal(status.watchStep({ kind: "skipped" }, { polls: status.WATCH_MAX_POLLS + 50, failures: 0 }).step.next, "poll");
  // Past the cap, the first real read decides: done if everything ended, else the timeout.
  assert.deepEqual(status.watchStep(running, { polls: status.WATCH_MAX_POLLS, failures: 0 }).step, { next: "stop", stopped: "timeout", error: "" });
  assert.equal(status.watchStep({ kind: "ok", states: [st(1, "completed")] }, { polls: status.WATCH_MAX_POLLS, failures: 0 }).step.next, "done");
  const limited = status.watchStep({ kind: "rateLimited" }, { polls: 0, failures: 0 });
  assert.deepEqual(limited, { step: { next: "poll", delayMs: status.WATCH_RATE_LIMITED_POLLS * status.WATCH_POLL_MS, states: null }, counters: { polls: status.WATCH_RATE_LIMITED_POLLS, failures: 0, overrun: 0 } });
});

test("pacing: past the cap a failed or 429 read is no answer — it retries, on a budget of its own, and only an answer or that budget ends it", () => {
  const atCap = { polls: status.WATCH_MAX_POLLS, failures: 0 };
  const failed = status.watchStep({ kind: "failed", error: "e" }, atCap);
  assert.deepEqual(failed.step, { next: "poll", delayMs: status.WATCH_POLL_MS, states: null }, "one failed read past the cap is not the timeout");
  assert.equal(failed.counters.overrun, 1);
  const limited = status.watchStep({ kind: "rateLimited" }, atCap);
  assert.deepEqual(limited.step, { next: "poll", delayMs: status.WATCH_RATE_LIMITED_POLLS * status.WATCH_POLL_MS, states: null }, "nor is a 429");
  assert.equal(limited.counters.overrun, 1);
  // A read crossing the cap counts as past it.
  assert.equal(status.watchStep({ kind: "failed", error: "e" }, { polls: status.WATCH_MAX_POLLS - 1, failures: 0 }).counters.overrun, 1);
  assert.equal(status.watchStep({ kind: "failed", error: "e" }, { polls: 0, failures: 0 }).counters.overrun, 0, "before the cap nothing is overrun");
  assert.equal(status.watchStep({ kind: "skipped" }, atCap).counters.overrun, 0, "a hidden poll spends none of it");
  // The bound: WATCH_MAX_FAILED_READS reads past the cap without an answer.
  let c: { polls: number; failures: number; overrun?: number } = atCap;
  for (let i = 0; i < status.WATCH_MAX_FAILED_READS - 1; i++) {
    const r = status.watchStep({ kind: "rateLimited" }, c);
    assert.equal(r.step.next, "poll", `429 ${i + 1} past the cap`);
    c = r.counters;
  }
  assert.deepEqual(status.watchStep({ kind: "rateLimited" }, c).step, { next: "stop", stopped: "timeout", error: "" });
  // Consecutive failures past the cap still stop as the error they are.
  c = atCap;
  for (let i = 0; i < status.WATCH_MAX_FAILED_READS - 1; i++) c = status.watchStep({ kind: "failed", error: "e" }, c).counters;
  assert.deepEqual(status.watchStep({ kind: "failed", error: "e" }, c).step, { next: "stop", stopped: "error", error: "e" });
  // Then the first answer decides.
  const afterBlip = status.watchStep({ kind: "failed", error: "e" }, atCap).counters;
  assert.equal(status.watchStep({ kind: "ok", states: [st(1, "completed")] }, afterBlip).step.next, "done");
  assert.deepEqual(status.watchStep({ kind: "ok", states: [st(1, "started")] }, afterBlip).step, { next: "stop", stopped: "timeout", error: "" });
});

test("a watch reads its ids COMMAND_READ_MAX_IDS at a time, one request after another, merged in order; the first non-answer ends the poll", async () => {
  const ids = idList(450);
  const chunks: number[][] = [];
  let inFlight = 0;
  let maxInFlight = 0;
  const ok = await status.readCommandsInChunks(ids, async (chunk) => {
    chunks.push([...chunk]);
    inFlight++;
    maxInFlight = Math.max(maxInFlight, inFlight);
    await new Promise((r) => setImmediate(r));
    inFlight--;
    return { kind: "ok", states: chunk.map((id) => st(id, "started")) };
  });
  assert.deepEqual(chunks.map((c) => c.length), [200, 200, 50]);
  assert.equal(maxInFlight, 1, "never two reads at once against the route's rate limit");
  assert.equal(ok.kind, "ok");
  assert.deepEqual(ok.kind === "ok" ? ok.states.map((s) => s.id) : [], ids);

  let reads = 0;
  const limited = await status.readCommandsInChunks(ids, async (chunk) => {
    reads++;
    return reads === 2 ? { kind: "rateLimited" } : { kind: "ok", states: chunk.map((id) => st(id, "queued")) };
  });
  assert.deepEqual(limited, { kind: "rateLimited" });
  assert.equal(reads, 2, "the third chunk is never read");
  const src = readFileSync(new URL("../src/components/admin/arr-command-watch.tsx", import.meta.url), "utf8");
  assert.match(src, /readCommandsInChunks\(ids, \(chunk\) => readChunk\(target, chunk\)\)/, "the browser hook polls through it");
});

// ── the polling loop, driven by hand ─────────────────────────────────────────

function harness() {
  type Timer = { fn: () => void; ms: number; cancelled: boolean; fired: boolean };
  const timers: Timer[] = [];
  const reads: Array<{ ids: readonly number[]; resolve: (r: WatchRead) => void }> = [];
  const updates: Array<[string, Record<string, unknown>]> = [];
  let hidden = false;
  const watcher = status.createCommandWatcher({
    read: (_target, ids) => new Promise<WatchRead>((resolve) => reads.push({ ids, resolve })),
    schedule: (fn, ms) => {
      const t: Timer = { fn, ms, cancelled: false, fired: false };
      timers.push(t);
      return t;
    },
    cancel: (h) => { (h as Timer).cancelled = true; },
    hidden: () => hidden,
    update: (key, change) => { updates.push([key, change as Record<string, unknown>]); },
  });
  const pending = () => timers.filter((t) => !t.cancelled && !t.fired);
  const flush = () => new Promise((r) => setImmediate(r));
  return {
    watcher, reads, updates, pending,
    setHidden(v: boolean) { hidden = v; },
    async fire() {
      const [t] = pending();
      assert.ok(t, "a poll is scheduled");
      t.fired = true;
      t.fn();
      await flush();
      return t.ms;
    },
    async answer(r: WatchRead) {
      const next = reads.shift();
      assert.ok(next, "a read is out");
      next.resolve(r);
      await flush();
    },
  };
}
const target = { service: "radarr" as const, instance: "" };

test("watcher: one read at a time — the next poll is scheduled only from the answer, 2 s after it", async () => {
  const h = harness();
  assert.equal(h.watcher.start("k", target, [5, 5, 6]), true);
  assert.deepEqual(h.pending().map((t) => t.ms), [status.WATCH_FIRST_POLL_MS]);
  await h.fire();
  assert.deepEqual(h.reads.map((r) => r.ids), [[5, 6]], "duplicates collapse");
  assert.equal(h.pending().length, 0, "nothing scheduled while the read is out");
  await h.answer({ kind: "ok", states: [st(5, "started", "Searching"), st(6, "queued")] });
  assert.deepEqual(h.pending().map((t) => t.ms), [status.WATCH_POLL_MS]);
  assert.deepEqual(h.updates.at(-1)?.[1].states, [st(5, "started", "Searching"), st(6, "queued")]);
});

test("watcher: every command ended → onDone once, no further poll", async () => {
  const h = harness();
  const done: unknown[] = [];
  h.watcher.start("k", target, [5], (states) => done.push(states));
  await h.fire();
  await h.answer({ kind: "ok", states: [st(5, "started")] });
  await h.fire();
  await h.answer({ kind: "ok", states: [st(5, "completed")] });
  assert.deepEqual(done, [[st(5, "completed")]]);
  assert.equal(h.pending().length, 0);
  assert.equal(h.watcher.isRunning("k"), false);
});

test("watcher: stop() while a read is out — its answer is dropped: no update, no onDone, no poll", async () => {
  const h = harness();
  let done = 0;
  h.watcher.start("k", target, [5], () => done++);
  await h.fire();
  h.watcher.stop();
  const before = h.updates.length;
  await h.answer({ kind: "ok", states: [st(5, "completed")] });
  assert.equal(done, 0);
  assert.equal(h.updates.length, before);
  assert.equal(h.pending().length, 0);
});

test("watcher: stop(key) cancels a scheduled poll; a newer watch under the same key retires the old one", async () => {
  const h = harness();
  h.watcher.start("k", target, [5]);
  h.watcher.stop("k");
  assert.equal(h.pending().length, 0, "the scheduled poll is cancelled");

  let oldDone = 0;
  h.watcher.start("k", target, [5], () => oldDone++);
  await h.fire();
  h.watcher.start("k", target, [9]);
  await h.answer({ kind: "ok", states: [st(5, "completed")] });
  assert.equal(oldDone, 0, "the retired watch's answer is dropped");
  assert.deepEqual(h.pending().map((t) => t.ms), [status.WATCH_FIRST_POLL_MS], "only the new watch is scheduled");
  // Another key is untouched by either.
  h.watcher.start("other", target, [1]);
  h.watcher.stop("k");
  assert.equal(h.watcher.isRunning("other"), true);
});

test("watcher: gives up at the poll cap with a timeout", async () => {
  const h = harness();
  h.watcher.start("k", target, [5]);
  for (let i = 0; i < status.WATCH_MAX_POLLS; i++) {
    await h.fire();
    await h.answer({ kind: "ok", states: [st(5, "started")] });
  }
  assert.equal(h.pending().length, 0);
  assert.deepEqual(h.updates.at(-1), ["k", { stopped: "timeout", error: "" }]);
});

test("watcher: a tab hidden for the whole budget reads nothing and never times out unread — shown again, one read decides, and onDone runs", async () => {
  const h = harness();
  const done: unknown[] = [];
  h.watcher.start("k", target, [5, 6], (states) => done.push(states));
  h.setHidden(true);
  for (let i = 0; i < status.WATCH_MAX_POLLS + 10; i++) await h.fire();
  assert.equal(h.reads.length, 0, "nothing read while hidden");
  assert.equal(h.pending().length, 1, "still waiting for the tab");
  assert.ok(!h.updates.some(([, c]) => c.stopped === "timeout"), "no timeout the watch never checked");
  h.setHidden(false);
  await h.fire();
  assert.deepEqual(h.reads.map((r) => r.ids), [[5, 6]], "one real read");
  await h.answer({ kind: "ok", states: [st(5, "completed"), st(6, "failed", "No indexers")] });
  assert.deepEqual(done, [[st(5, "completed"), st(6, "failed", "No indexers")]], "the page re-reads what the commands changed");
  assert.deepEqual(h.updates.at(-1), ["k", { states: [st(5, "completed"), st(6, "failed", "No indexers")], error: "" }]);
  assert.equal(h.pending().length, 0);

  // Still running when it is finally read: that read is the timeout, with no second one.
  const h2 = harness();
  let done2 = 0;
  h2.watcher.start("k", target, [7], () => done2++);
  h2.setHidden(true);
  for (let i = 0; i < status.WATCH_MAX_POLLS; i++) await h2.fire();
  h2.setHidden(false);
  await h2.fire();
  await h2.answer({ kind: "ok", states: [st(7, "started")] });
  assert.deepEqual(h2.updates.at(-1), ["k", { stopped: "timeout", error: "" }]);
  assert.equal(done2, 0);
  assert.equal(h2.pending().length, 0);
});

test("watcher: hidden past the cap, the first read back failing or rate-limited is retried — the answer after it decides, and onDone runs", async () => {
  for (const blip of [{ kind: "failed", error: "Failed to fetch" }, { kind: "rateLimited" }] as WatchRead[]) {
    const h = harness();
    const done: unknown[] = [];
    h.watcher.start("k", target, [5], (states) => done.push(states));
    h.setHidden(true);
    for (let i = 0; i < status.WATCH_MAX_POLLS + 10; i++) await h.fire();
    h.setHidden(false);
    await h.fire();
    await h.answer(blip);
    assert.ok(!h.updates.some(([, c]) => c.stopped), `${blip.kind}: no stop on a read that brought no answer`);
    assert.equal(h.pending().length, 1, `${blip.kind}: it reads again`);
    await h.fire();
    await h.answer({ kind: "ok", states: [st(5, "completed")] });
    assert.deepEqual(done, [[st(5, "completed")]], `${blip.kind}: the page re-reads what the command changed`);
    assert.equal(h.pending().length, 0);
  }

  // Bounded: WATCH_MAX_FAILED_READS 429s past the cap end it as a timeout, no onDone.
  const h = harness();
  let done = 0;
  h.watcher.start("k", target, [5], () => done++);
  h.setHidden(true);
  for (let i = 0; i < status.WATCH_MAX_POLLS; i++) await h.fire();
  h.setHidden(false);
  for (let i = 0; i < status.WATCH_MAX_FAILED_READS; i++) {
    await h.fire();
    await h.answer({ kind: "rateLimited" });
  }
  assert.deepEqual(h.updates.at(-1), ["k", { stopped: "timeout", error: "" }]);
  assert.equal(h.pending().length, 0, "no read after the budget");
  assert.equal(done, 0);
});

test("watcher: each poll reads only the ids still going — an ended command keeps its state and is never read again", async () => {
  const h = harness();
  const done: unknown[] = [];
  h.watcher.start("k", target, [1, 2, 3], (states) => done.push(states));
  await h.fire();
  assert.deepEqual(h.reads.map((r) => r.ids), [[1, 2, 3]]);
  await h.answer({ kind: "ok", states: [st(1, "completed", "1 report"), st(2, "started", "Searching"), st(3, "queued")] });
  await h.fire();
  assert.deepEqual(h.reads.map((r) => r.ids), [[2, 3]], "the completed command is not read again");
  await h.answer({ kind: "ok", states: [st(2, "completed"), st(3, "started")] });
  assert.deepEqual(h.updates.at(-1)?.[1].states, [st(1, "completed", "1 report"), st(2, "completed"), st(3, "started")],
    "every id, in the order started, the ended one with the state it ended with");
  await h.fire();
  assert.deepEqual(h.reads.map((r) => r.ids), [[3]]);
  await h.answer({ kind: "ok", states: [st(3, "completed")] });
  assert.deepEqual(done, [[st(1, "completed", "1 report"), st(2, "completed"), st(3, "completed")]]);

  // An answer that leaves out an id it was asked about is a failed read, never "ended".
  const h2 = harness();
  h2.watcher.start("k", target, [1, 2]);
  await h2.fire();
  await h2.answer({ kind: "ok", states: [st(1, "completed")] });
  assert.equal(h2.updates.length, 0, "nothing reported from a partial answer");
  await h2.fire();
  assert.deepEqual(h2.reads.map((r) => r.ids), [[1, 2]], "and nothing was stored from it");
});

test("watcher: a refusal stops at once; a read that throws counts as a failure", async () => {
  const h = harness();
  h.watcher.start("k", target, [5]);
  await h.fire();
  await h.answer({ kind: "refused", error: "Not an admin" });
  assert.deepEqual(h.updates.at(-1), ["k", { stopped: "error", error: "Not an admin" }]);
  assert.equal(h.pending().length, 0);

  const updates: Array<Record<string, unknown>> = [];
  const timers: Array<() => void> = [];
  const w = status.createCommandWatcher({
    read: async () => { throw new Error("offline"); },
    schedule: (fn) => { timers.push(fn); return fn; },
    cancel: () => {},
    hidden: () => false,
    update: (_k, change) => { updates.push(change as Record<string, unknown>); },
  });
  w.start("k", target, [1]);
  for (let i = 0; i < status.WATCH_MAX_FAILED_READS; i++) {
    timers.shift()!();
    await new Promise((r) => setImmediate(r));
  }
  assert.deepEqual(updates.at(-1), { stopped: "error", error: "offline" });
  assert.equal(timers.length, 0);
});

test("watcher: an empty id list follows nothing", () => {
  const h = harness();
  assert.equal(h.watcher.start("k", target, []), false);
  assert.equal(h.pending().length, 0);
  assert.equal(h.watcher.isRunning("k"), false);
});

// ── 6: the pages follow the command instead of guessing ──────────────────────

test("the four pages no longer guess completion with a fixed timer — they follow the command and re-read on onDone", () => {
  const src = (p: string) => readFileSync(new URL(`../src/components/admin/${p}`, import.meta.url), "utf8");
  const pages: Array<[string, RegExp]> = [
    ["arr-title/title-manager.tsx", /onDone: reread \? reload : undefined/],
    ["arr-title/files-tab.tsx", /watch\("rename",[^;]*onDone: \(\) => void load\(\)/],
    ["arr-download-history.tsx", /watchCommand\("clear",[\s\S]*?onDone: \(\) => void loadRef\.current\(\)/],
    ["arr-system.tsx", /watch\(key, \{ service, instance \}, \[id\], \{ pendingText: done, onDone: \(\) => void load\(\) \}\)/],
  ];
  for (const [file, follows] of pages) {
    const code = src(file);
    assert.match(code, /useArrCommandWatch\(\)/, `${file} follows its commands`);
    assert.match(code, follows, `${file} re-reads when the command ends`);
    assert.doesNotMatch(code, /setTimeout\([^)]*\)?[^;]*\b(1_500|2_000|3_000|4_000)\b/, `${file} has no fixed re-read timer`);
  }
  assert.doesNotMatch(src("arr-command-watch.tsx"), /setInterval/, "polls are a setTimeout chain, never overlapping");
});
