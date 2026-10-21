// Audit fixes, unit cal-missing-cmd (Arr Calendar Search, the Missing search,
// the title-command route and the live command watch):
//
//   C035 — a command watch started AFTER the hook's owner unmounted (a
//          command POST still in flight at unmount / tab switch / close)
//          follows nothing: the hook disposes the watcher on unmount, a
//          disposed watcher's start() is false with nothing scheduled, read or
//          called back, and the effect body resumes it (StrictMode keeps the
//          same watcher across its simulated remount). The release dialog's
//          movie / title-target branch invalidating on close is pinned in
//          tests/audit-fix-release-queue.test.mts.
//   C032 — only the routes' NOTHING-MISSING 409 carries `nothingMissing: true`
//          (additive); an episode id no longer on the series and the arr's own
//          409 do not, and the calendar shows "nothing left" only for the flag
//          — every other 409 is a failure with the route's message.
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
process.env.NEXTAUTH_SECRET = "audit-fix-cal-missing-cmd-secret-0123456789abcdef";
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
  const c = { origin: url.origin, method, path: url.pathname, query: url.searchParams, body };
  calls.push(c);
  const res = responder(c);
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
const status = await import("../src/lib/arr-command-status.ts");
type WatchRead = import("../src/lib/arr-command-status.ts").WatchRead;
type ArrCommandState = import("../src/lib/arr-command-status.ts").ArrCommandState;

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
shadowPrismaModel(prisma, "tmdbMediaCore", { findMany: async () => [] });
shadowPrismaModel(prisma, "auditLog", { create: async () => ({}) });

const commandRoute = await import("../src/app/api/admin/arr/title/command/route.ts");
const missingSearchRoute = await import("../src/app/api/admin/missing/search/route.ts");

function inScope<T>(fn: () => Promise<T>): Promise<T> {
  const workStore = { route: "/audit-fix-cal-missing-cmd.test", forceStatic: false, dynamicShouldError: false, afterContext: { after: () => {} } };
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
const post = (handler: unknown, token: string, path: string, body: unknown) =>
  inScope(() => (handler as Handler)(
    new NextRequest(`http://localhost:3000/api${path}`, {
      method: "POST",
      headers: { cookie: `${COOKIE}=${token}`, "content-type": "application/json" },
      body: JSON.stringify(body),
    }),
    undefined,
  ));
const writes = () => calls.filter((c) => c.origin !== "http://localhost:3000" && c.method !== "GET");

// ── fixtures ─────────────────────────────────────────────────────────────────
const SERIES = { id: 21, tvdbId: 81189, tmdbId: 1396, title: "Breaking Bad", monitored: true, seasons: [] };
const EPISODES = [
  { id: 201, seriesId: 21, seasonNumber: 2, episodeNumber: 1, title: "Seven Thirty-Seven", monitored: true, hasFile: true, episodeFileId: 503, airDateUtc: "2009-03-09T02:00:00Z" },
  { id: 202, seriesId: 21, seasonNumber: 2, episodeNumber: 2, title: "Grilled", monitored: true, hasFile: false, episodeFileId: 0, airDateUtc: "2009-03-16T02:00:00Z" },
  // Another series' episode, reachable by id: NotOnTitleError → 409, never "nothing missing".
  { id: 901, seriesId: 99, seasonNumber: 1, episodeNumber: 1, title: "Elsewhere", monitored: true, hasFile: false, episodeFileId: 0, airDateUtc: "2010-01-01T00:00:00Z" },
];
const MOVIES = [
  { id: 1, tmdbId: 101, title: "Released, no file", monitored: true, hasFile: false, digitalRelease: "2020-01-01T00:00:00Z" },
  { id: 3, tmdbId: 103, title: "Has file", monitored: true, hasFile: true, physicalRelease: "2020-01-01T00:00:00Z" },
];
let commandAnswer: () => Response = () => json({ id: 5 }, 201);
const base: Responder = (c) => {
  if (c.method === "POST" && c.path === "/api/v3/command") return commandAnswer();
  if (c.method !== "GET") return undefined;
  if (c.origin === SONARR) {
    if (c.path === "/api/v3/series/21") return json(SERIES);
    const one = /^\/api\/v3\/episode\/(\d+)$/.exec(c.path);
    if (one) {
      const ep = EPISODES.find((e) => String(e.id) === one[1]);
      return ep ? json(ep) : new Response("{}", { status: 404 });
    }
  }
  if (c.origin === RADARR) {
    const one = /^\/api\/v3\/movie\/(\d+)$/.exec(c.path);
    if (one) {
      const m = MOVIES.find((x) => String(x.id) === one[1]);
      return m ? json(m) : new Response("{}", { status: 404 });
    }
  }
  return undefined;
};

beforeEach(() => {
  calls = [];
  commandAnswer = () => json({ id: 5 }, 201);
  responder = base;
  settings.clear();
  for (const [k, v] of Object.entries({
    radarrUrl: RADARR, radarrApiKey: "radarr-key",
    sonarrUrl: SONARR, sonarrApiKey: "sonarr-key",
  })) settings.set(k, v);
  invalidateFeatureFlagCache();
});

const src = (p: string) => readFileSync(new URL(`../src/${p}`, import.meta.url), "utf8");

// ── C032: the nothing-missing 409 is flagged, the other 409s are not ─────────

test("C032: the calendar's Sonarr search — nothing left is 409 { nothingMissing: true }; a stale episode id and the arr's own 409 carry no flag", async () => {
  const token = await mintSession();
  const search = (episodeIds: number[]) => post(commandRoute.POST, token, "/admin/arr/title/command", { service: "sonarr", id: 21, action: "searchEpisodes", episodeIds, missingOnly: true });

  const nothing = await search([201]);
  assert.equal(nothing.status, 409);
  const nothingBody = (await nothing.json()) as { error?: unknown; nothingMissing?: unknown };
  assert.equal(nothingBody.nothingMissing, true, "201 has a file — the nothing-missing answer is flagged");
  assert.equal(typeof nothingBody.error, "string", "the old field is unchanged");
  assert.deepEqual(writes(), []);

  const stale = await search([901]);
  assert.equal(stale.status, 409, "an episode no longer on series 21");
  const staleBody = (await stale.json()) as { error?: unknown; nothingMissing?: unknown };
  assert.equal(staleBody.nothingMissing, undefined, "NotOnTitle is a failure, never 'nothing left'");
  assert.equal(typeof staleBody.error, "string");
  assert.deepEqual(writes(), []);

  // The arr refusing the command itself (relayed by arrFailure) is a 409 too — unflagged.
  commandAnswer = () => json({ message: "Unable to queue" }, 409);
  const refused = await search([202]);
  assert.equal(refused.status, 409);
  assert.equal(((await refused.json()) as { nothingMissing?: unknown }).nothingMissing, undefined);
});

test("C032: the Missing search (the calendar's Radarr path) flags its nothing-missing 409; a search that queues answers 202 as before", async () => {
  const token = await mintSession();
  const nothing = await post(missingSearchRoute.POST, token, "/admin/missing/search", { service: "radarr", instance: "", arrId: 3, mode: "missing" });
  assert.equal(nothing.status, 409);
  const body = (await nothing.json()) as { error?: unknown; nothingMissing?: unknown };
  assert.equal(body.nothingMissing, true);
  assert.equal(typeof body.error, "string");
  assert.deepEqual(writes(), []);

  const queued = await post(missingSearchRoute.POST, token, "/admin/missing/search", { service: "radarr", instance: "", arrId: 1, mode: "missing" });
  assert.equal(queued.status, 202);
  assert.deepEqual(writes().map((c) => c.body), [{ name: "MoviesSearch", movieIds: [1] }]);
});

test("C032: the calendar shows 'nothing left' only for a 409 carrying nothingMissing — any other 409 is a failure with the route's message", () => {
  const code = src("components/admin/arr-calendar.tsx");
  const fn = /async function search\(cell: CalendarCell\) \{([\s\S]*?)\n  \}\n/.exec(code)?.[1] ?? "";
  assert.ok(fn, "the calendar's search() is found");
  // The body is read before the 409 is judged, and the nothing state needs the flag.
  assert.match(fn, /const data = res\.ok \? null : \(\(await res\.json\(\)/);
  assert.match(fn, /if \(res\.status === 409 && data\?\.nothingMissing === true\) \{\s*setSearches\(\(s\) => \(\{ \.\.\.s, \[cell\.key\]: \{ phase: "nothing" \} \}\)\);/);
  // No other path reaches the "nothing" phase.
  assert.equal(fn.match(/phase: "nothing"/g)?.length, 1);
  assert.doesNotMatch(fn, /if \(res\.status === 409\) \{/, "a bare 409 check is the old any-409-is-nothing mapping");
  // The failure branch keeps the route's own message.
  assert.match(fn, /\{ phase: "failed", message: data\?\.error \?\? t\("adminArr\.manage\.commandFailed"\) \}/);
});

// ── C035: a disposed watcher follows nothing ─────────────────────────────────

function harness() {
  type Timer = { fn: () => void; ms: number; cancelled: boolean; fired: boolean };
  const timers: Timer[] = [];
  const reads: Array<{ ids: readonly number[]; resolve: (r: WatchRead) => void }> = [];
  const updates: Array<[string, Record<string, unknown>]> = [];
  const watcher = status.createCommandWatcher({
    read: (_target, ids) => new Promise<WatchRead>((resolve) => reads.push({ ids, resolve })),
    schedule: (fn, ms) => {
      const t: Timer = { fn, ms, cancelled: false, fired: false };
      timers.push(t);
      return t;
    },
    cancel: (h) => { (h as Timer).cancelled = true; },
    hidden: () => false,
    update: (key, change) => { updates.push([key, change as Record<string, unknown>]); },
  });
  const pending = () => timers.filter((t) => !t.cancelled && !t.fired);
  const flush = () => new Promise((r) => setImmediate(r));
  return {
    watcher, reads, updates, pending,
    async fire() {
      const [t] = pending();
      assert.ok(t, "a poll is scheduled");
      t.fired = true;
      t.fn();
      await flush();
    },
    async answer(r: WatchRead) {
      const next = reads.shift();
      assert.ok(next, "a read is out");
      next.resolve(r);
      await flush();
    },
  };
}
const target = { service: "sonarr" as const, instance: "" };
const done = (id: number): ArrCommandState =>
  ({ id, status: "completed", name: "EpisodeSearch", commandName: "EpisodeSearch", queued: null, started: null, ended: null, durationSeconds: null, message: null });

test("C035: a watch started after dispose() (a POST that resolved after unmount) follows nothing — no poll, no read, no update, no onDone", async () => {
  const h = harness();
  let calledBack = 0;
  h.watcher.dispose();
  assert.equal(h.watcher.start("search", target, [1, 2], () => calledBack++), false);
  assert.equal(h.pending().length, 0, "nothing scheduled");
  assert.equal(h.watcher.isRunning("search"), false);
  assert.equal(h.reads.length, 0);
  assert.equal(h.updates.length, 0);
  assert.equal(calledBack, 0);
});

test("C035: dispose() also ends the watches already running — an answer in flight is dropped", async () => {
  const h = harness();
  let calledBack = 0;
  h.watcher.start("a", target, [1], () => calledBack++);
  h.watcher.start("b", target, [2], () => calledBack++);
  await h.fire(); // "a" reads
  h.watcher.dispose();
  assert.equal(h.pending().length, 0, "b's scheduled poll is cancelled");
  assert.equal(h.watcher.isRunning("a"), false);
  assert.equal(h.watcher.isRunning("b"), false);
  const before = h.updates.length;
  await h.answer({ kind: "ok", states: [done(1)] });
  assert.equal(h.updates.length, before);
  assert.equal(calledBack, 0);
});

test("C035: resume() (StrictMode's remount of the same watcher) makes start() follow again; a plain stop() never disposes", async () => {
  const h = harness();
  h.watcher.dispose();
  h.watcher.resume();
  const calledBack: unknown[] = [];
  assert.equal(h.watcher.start("k", target, [7], (s) => calledBack.push(s)), true);
  await h.fire();
  await h.answer({ kind: "ok", states: [done(7)] });
  assert.equal(calledBack.length, 1, "onDone runs once the command ended");

  // The title manager's close calls stop(): a later watch (reopened, still mounted) still runs.
  h.watcher.stop();
  assert.equal(h.watcher.start("k", target, [8]), true);
  assert.equal(h.pending().length, 1);
});

test("C035: the hook resumes the watcher in its effect body and disposes it on unmount — never a bare stop()", () => {
  const code = src("components/admin/arr-command-watch.tsx");
  assert.match(code, /useEffect\(\(\) => \{\s*watcher\.resume\(\);\s*return \(\) => watcher\.dispose\(\);\s*\}, \[watcher\]\);/);
  assert.doesNotMatch(code, /useEffect\(\(\) => \(\) => watcher\.stop\(\)/, "stop() alone lets a late watch() start an orphan poll");
});
