// Personal iCal feed: selection rules, token handling, the public route, the
// profile management route, and the cron warm.
//
//   src/lib/calendar-events.ts              pure release-date → event rules
//   src/lib/calendar-token.ts               hash-only token, timing-safe compare
//   src/lib/calendar-feed.ts                prisma loader, token resolve, warm
//   GET  /api/calendar/feed/[token]         PUBLIC (isPublicPath), token-authed
//   GET/POST/DELETE /api/profile/calendar   withAuth
//
// What each is risky for:
//   1. SELECTION. A declined request must never appear; requests and watchlist
//      entries for one title collapse to one set of events; nothing outside the
//      ~30-days-back/1-year-ahead window is emitted.
//   2. THE TOKEN IS THE CREDENTIAL. Only a hash is stored; regenerating must
//      revoke the old URL; a disabled or purged owner (incl. the legacy
//      tombstone shape with a NULL purgedAt) must get 404, not a feed.
//   3. NO AVAILABILITY LEAK. The feed reads release-date caches only. It must
//      never touch a library table — TVEpisodeCache in particular cannot be
//      scoped to a restricted media-server instance (guardrail 35). The library
//      models are stubbed to THROW, so any read fails the test that caused it.
//   4. CACHE-ONLY ROUTE. A poll never fetches upstream; the warm (in the
//      upcoming cron) is bounded, skips fresh and settled titles, and stops on
//      abort (guardrails 31/41).
//
// Harness: the tests/personal-lists-routes.test.mts idiom — real wrapped
// handlers, genuine signed session JWTs, a synthetic request scope, in-memory
// prisma stubs, scripted fetch. No DB, no network.
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { AsyncLocalStorage } from "node:async_hooks";
import dns from "node:dns/promises";

(globalThis as { AsyncLocalStorage?: unknown }).AsyncLocalStorage = AsyncLocalStorage;

process.env.TOKEN_ENCRYPTION_KEY = "ab".repeat(32);
process.env.NEXTAUTH_SECRET = "calendar-feed-test-secret-0123456789abcd";
process.env.AUTH_URL = "https://summonarr.example.com";
process.env.BASE_PATH = "/req";
process.env.TRUST_PROXY = "true";
process.env.TMDB_READ_TOKEN = "test-tmdb-read-token";
(process.env as Record<string, string | undefined>).NODE_ENV = "test";

const fakeLookup = async () => [{ address: "93.184.216.34", family: 4 }];
(dns as { lookup: unknown }).lookup = fakeLookup;
if ((dns as { lookup: unknown }).lookup !== fakeLookup) {
  throw new Error("could not stub dns.lookup — aborting before a real DNS query can leave the process");
}

const warns: string[] = [];
const errors: string[] = [];
console.warn = (...args: unknown[]) => { warns.push(args.map(String).join(" ")); };
console.error = (...args: unknown[]) => { errors.push(args.map(String).join(" ")); };

// ── scripted fetch — TMDB only, and only the warm may call it ───────────────
const fetchCalls: URL[] = [];
globalThis.fetch = (async (input: RequestInfo | URL) => {
  const url = new URL(String(input));
  fetchCalls.push(url);
  if (url.hostname !== "api.themoviedb.org") throw new Error(`unexpected fetch: ${url}`);
  const json = (b: unknown) => new Response(JSON.stringify(b), { status: 200, headers: { "content-type": "application/json" } });
  const movie = url.pathname.match(/^\/3\/movie\/(\d+)$/);
  if (movie) {
    return json({
      id: Number(movie[1]),
      release_date: "2026-11-01",
      release_dates: { results: [{ iso_3166_1: "US", release_dates: [{ type: 4, release_date: "2026-12-01T00:00:00.000Z" }] }] },
    });
  }
  const season = url.pathname.match(/^\/3\/tv\/(\d+)\/season\/(\d+)$/);
  if (season) {
    return json({ episodes: [{ episode_number: 1, season_number: Number(season[2]), name: "Pilot", air_date: "2026-10-20" }] });
  }
  const tv = url.pathname.match(/^\/3\/tv\/(\d+)$/);
  if (tv) {
    return json({
      id: Number(tv[1]),
      status: "Returning Series",
      last_air_date: "2026-09-01",
      seasons: [{ season_number: 1, episode_count: 8, air_date: "2026-09-01" }],
      next_episode_to_air: { air_date: "2026-10-20", season_number: 1, episode_number: 1, name: "Pilot" },
    });
  }
  throw new Error(`unscripted TMDB path ${url.pathname}`);
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
const { purgedEmailFor } = await import("../src/lib/account-lifecycle.ts");

const events = await import("../src/lib/calendar-events.ts");
const tokenLib = await import("../src/lib/calendar-token.ts");

// ── state ───────────────────────────────────────────────────────────────────
type DbUser = {
  id: string;
  name: string | null;
  email: string;
  role: string;
  permissions: bigint;
  mediaServer: string | null;
  sessionsRevokedAt: Date | null;
  passwordChangedAt: Date | null;
  deactivatedAt: Date | null;
  purgedAt: Date | null;
  notificationEmail: string | null;
  calendarTokenHash: string | null;
  calendarTokenCreatedAt: Date | null;
};
const usersById = new Map<string, DbUser>();
const sessionRows = new Set<string>();
type Req = { requestedBy: string; tmdbId: number; mediaType: "MOVIE" | "TV"; title: string; status: string; createdAt: Date };
let requests: Req[] = [];
type Wl = { userId: string; tmdbId: number; mediaType: "MOVIE" | "TV"; title: string; createdAt: Date };
let watchlist: Wl[] = [];
const cache = new Map<string, { key: string; data: string; expiresAt: Date; cachedAt: Date }>();
const settings = new Map<string, string>();
const reads: string[] = [];
let wrongRowFor: string | null = null;

// ── prisma stubs ────────────────────────────────────────────────────────────
shadowPrismaModel(prisma, "authSession", {
  findUnique: async (args: { where: { sessionId: string } }) =>
    sessionRows.has(args.where.sessionId) ? { id: `row-${args.where.sessionId}`, sessionId: args.where.sessionId } : null,
  update: async () => ({}),
});

shadowPrismaModel(prisma, "user", {
  findUnique: async (args: { where: { id?: string; calendarTokenHash?: string } }) => {
    reads.push(`user.findUnique:${Object.keys(args.where).join(",")}`);
    if (args.where.id !== undefined) {
      const u = usersById.get(args.where.id);
      return u ? { ...u } : null;
    }
    if (args.where.calendarTokenHash !== undefined) {
      if (wrongRowFor) return { ...usersById.get(wrongRowFor)! };
      for (const u of usersById.values()) if (u.calendarTokenHash === args.where.calendarTokenHash) return { ...u };
      return null;
    }
    throw new Error("unexpected user.findUnique where");
  },
  updateMany: async (args: { where: { id: string; deactivatedAt?: null; purgedAt?: null }; data: Partial<DbUser> }) => {
    const u = usersById.get(args.where.id);
    if (!u) return { count: 0 };
    if ("deactivatedAt" in args.where && u.deactivatedAt !== null) return { count: 0 };
    if ("purgedAt" in args.where && u.purgedAt !== null) return { count: 0 };
    Object.assign(u, args.data);
    return { count: 1 };
  },
  update: async () => ({}),
});

function matchStatus(status: string, where: { not?: string } | string | undefined): boolean {
  if (where === undefined) return true;
  if (typeof where === "string") return status === where;
  if (where.not !== undefined) return status !== where.not;
  return true;
}
shadowPrismaModel(prisma, "mediaRequest", {
  findMany: async (args: { where: { requestedBy?: string; status?: { not?: string } }; take?: number }) => {
    reads.push("mediaRequest.findMany");
    return requests
      .filter((r) => (args.where.requestedBy === undefined || r.requestedBy === args.where.requestedBy) && matchStatus(r.status, args.where.status))
      .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())
      .slice(0, args.take ?? Infinity)
      .map((r) => ({ tmdbId: r.tmdbId, mediaType: r.mediaType, title: r.title }));
  },
});
shadowPrismaModel(prisma, "watchlistItem", {
  findMany: async (args: { where: { userId?: string; user?: { deactivatedAt: null } }; take?: number }) => {
    reads.push("watchlistItem.findMany");
    return watchlist
      .filter((w) => args.where.userId === undefined || w.userId === args.where.userId)
      .filter((w) => !args.where.user || usersById.get(w.userId)?.deactivatedAt === null)
      .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())
      .slice(0, args.take ?? Infinity)
      .map((w) => ({ tmdbId: w.tmdbId, mediaType: w.mediaType, title: w.title }));
  },
});
shadowPrismaModel(prisma, "tmdbCache", {
  findMany: async (args: { where: { key: { in: string[] }; expiresAt?: { gt: Date } } }) => {
    reads.push("tmdbCache.findMany");
    return args.where.key.in.flatMap((k) => {
      const r = cache.get(k);
      if (!r) return [];
      if (args.where.expiresAt && !(r.expiresAt > args.where.expiresAt.gt)) return [];
      return [{ ...r }];
    });
  },
  findUnique: async (args: { where: { key: string } }) => cache.get(args.where.key) ?? null,
  upsert: async (args: { where: { key: string }; create: { key: string; data: string; cachedAt: Date; expiresAt: Date } }) => {
    cache.set(args.where.key, args.create);
    return args.create;
  },
  deleteMany: async () => ({ count: 0 }),
});
shadowPrismaModel(prisma, "setting", {
  findUnique: async (args: { where: { key: string } }) => {
    const v = settings.get(args.where.key);
    return v === undefined ? null : { key: args.where.key, value: v };
  },
  findMany: async (args: { where?: { key?: { in?: string[] } } } = {}) => {
    const keys = args.where?.key?.in;
    return [...settings.entries()].filter(([k]) => !keys || keys.includes(k)).map(([key, value]) => ({ key, value }));
  },
  upsert: async () => ({}),
});
// Library tables: any read is a restricted-instance leak (guardrail 35).
for (const m of ["plexLibraryItem", "jellyfinLibraryItem", "tVEpisodeCache", "activeSession", "playHistory"]) {
  const boom = () => { throw new Error(`calendar feed read library table ${m}`); };
  shadowPrismaModel(prisma, m, { findMany: boom, findFirst: boom, findUnique: boom, count: boom });
}

const { loadCalendarTitles, buildCalendarFeed, resolveCalendarToken, warmCalendarCache, MAX_CALENDAR_WARM_FETCHES } =
  await import("../src/lib/calendar-feed.ts");
const feedRoute = await import("../src/app/api/calendar/feed/[token]/route.ts");
const profileRoute = await import("../src/app/api/profile/calendar/route.ts");

// ── helpers ─────────────────────────────────────────────────────────────────
const DAY = 86_400_000;
const iso = (offsetDays: number) => new Date(Date.now() + offsetDays * DAY).toISOString().slice(0, 10);
const FAR = new Date(Date.now() + 30 * DAY);

function putCache(key: string, data: unknown, expiresAt: Date = FAR) {
  cache.set(key, { key, data: JSON.stringify(data), expiresAt, cachedAt: new Date() });
}

let seq = 0;
function addUser(over: Partial<DbUser> = {}): DbUser {
  seq++;
  const id = over.id ?? `cal-user-${seq}`;
  const u: DbUser = {
    id,
    name: `User ${seq}`,
    email: `user-${seq}@example.com`,
    role: "USER",
    permissions: 0n,
    mediaServer: null,
    sessionsRevokedAt: null,
    passwordChangedAt: null,
    deactivatedAt: null,
    purgedAt: null,
    notificationEmail: null,
    calendarTokenHash: null,
    calendarTokenCreatedAt: null,
    ...over,
  };
  usersById.set(id, u);
  return u;
}

async function mintSession(u: DbUser): Promise<string> {
  const sessionId = `sess-${u.id}`;
  sessionRows.add(sessionId);
  const iat = Math.floor(Date.now() / 1000);
  return signSessionJwt(
    { id: u.id, role: u.role, permissions: u.permissions.toString(), provider: "credentials", sessionId, expiresAt: iat + 86_400 },
    { expiresInSeconds: 7_200, iat },
  );
}

function withToken(u: DbUser): string {
  const t = tokenLib.generateCalendarToken();
  u.calendarTokenHash = tokenLib.hashCalendarToken(t);
  u.calendarTokenCreatedAt = new Date();
  return t;
}

function inScope<T>(fn: () => Promise<T>): Promise<T> {
  const workStore = { route: "/calendar-feed.test", forceStatic: false, dynamicShouldError: false, afterContext: { after: () => {} } };
  const reqHeaders = new Headers();
  const requestStore = {
    type: "request",
    phase: "render",
    headers: HeadersAdapter.seal(reqHeaders),
    cookies: RequestCookiesAdapter.seal(new RequestCookies(reqHeaders)),
    usedDynamic: false,
  };
  return workAsyncStorage.run(workStore, () => workUnitAsyncStorage.run(requestStore, fn));
}

let ipSeq = 0;
async function getFeed(segment: string, query = "", headers: Record<string, string> = {}) {
  ipSeq++;
  const req = new NextRequest(`http://localhost:3000/api/calendar/feed/${segment}${query}`, {
    headers: { "x-forwarded-for": `198.51.100.${ipSeq % 250}`, ...headers },
  });
  return inScope(() => feedRoute.GET(req, { params: Promise.resolve({ token: segment }) }));
}

const COOKIE = getSessionCookieName();
function profileReq(method: string, jwt: string | null) {
  return new NextRequest("http://localhost:3000/api/profile/calendar", {
    method,
    headers: jwt ? { cookie: `${COOKIE}=${jwt}` } : {},
  });
}

beforeEach(() => {
  requests = [];
  watchlist = [];
  cache.clear();
  settings.clear();
  reads.length = 0;
  fetchCalls.length = 0;
  warns.length = 0;
  errors.length = 0;
  invalidateFeatureFlagCache();
});

// ── 1. pure selection rules ─────────────────────────────────────────────────

const W = { from: "2026-09-01", to: "2027-10-01" };

test("calendarWindow is ~30 days back to ~1 year ahead, as UTC days", () => {
  const w = events.calendarWindow(new Date("2026-10-01T23:30:00Z"));
  assert.deepEqual(w, { from: "2026-09-01", to: "2027-10-01" });
});

test("movie: theatrical/digital/physical each become an event, only inside the window", () => {
  const out = events.buildCalendarEvents(
    [{ tmdbId: 693134, mediaType: "movie", title: "Dune: Part Two" }],
    {
      movies: new Map([[693134, { primary: "2026-08-31", digital: "2026-12-01T00:00:00.000Z", physical: "2027-10-02" }]]),
      tv: new Map(),
      episodes: new Map(),
    },
    W,
    "https://x.example/req",
  );
  // primary is one day before the window and physical one day after: both out.
  assert.deepEqual(out.map((e) => [e.uid, e.date, e.summary]), [
    ["movie-693134-digital@summonarr", "2026-12-01", "Dune: Part Two (Digital)"],
  ]);
  assert.equal(out[0].url, "https://x.example/req/movie/693134");
  assert.match(out[0].description ?? "", /Digital release\nhttps:\/\/x\.example\/req\/movie\/693134/);
});

test("window bounds are inclusive at both ends", () => {
  const out = events.buildCalendarEvents(
    [{ tmdbId: 1, mediaType: "movie", title: "M" }],
    { movies: new Map([[1, { primary: W.from, physical: W.to }]]), tv: new Map(), episodes: new Map() },
    W,
    null,
  );
  assert.deepEqual(out.map((e) => e.date), [W.from, W.to]);
  assert.equal(out[0].url, undefined, "no site URL ⇒ no link");
});

test("one title requested AND watchlisted produces one set of events (dedupe)", () => {
  const titles = [
    { tmdbId: 1, mediaType: "movie" as const, title: "Requested Title" },
    { tmdbId: 1, mediaType: "movie" as const, title: "Watchlist Title" },
    { tmdbId: 1, mediaType: "tv" as const, title: "Same id, other type" },
  ];
  const out = events.buildCalendarEvents(
    titles,
    {
      movies: new Map([[1, { digital: "2026-10-10" }]]),
      tv: new Map([[1, { seasons: [], nextEpisode: { airDate: "2026-10-11" } }]]),
      episodes: new Map(),
    },
    W,
    null,
  );
  assert.deepEqual(out.map((e) => e.summary), ["Requested Title (Digital)", "Same id, other type – New episode"]);
});

test("tv: episodes in window get SxxEyy summaries; specials and placeholders handled", () => {
  const out = events.buildCalendarEvents(
    [{ tmdbId: 95396, mediaType: "tv", title: "Severance" }],
    {
      movies: new Map(),
      tv: new Map([[95396, { seasons: [{ seasonNumber: 2, airDate: "2026-09-10" }], nextEpisode: { airDate: "2026-10-01", seasonNumber: 2, episodeNumber: 3 } }]]),
      episodes: new Map([[95396, [
        { seasonNumber: 0, episodeNumber: 1, name: "Special", airDate: "2026-10-01" },
        { seasonNumber: 2, episodeNumber: 3, name: "Who Is Alive?", airDate: "2026-10-01" },
        { seasonNumber: 2, episodeNumber: 4, name: "Episode 4", airDate: "2026-10-08" },
        { seasonNumber: 2, episodeNumber: 1, name: "Old", airDate: "2026-08-01" },
      ]]]),
    },
    W,
    null,
  );
  assert.deepEqual(out.map((e) => [e.uid, e.summary]), [
    ["tv-95396-s2e3@summonarr", "Severance S02E03 – Who Is Alive?"],
    ["tv-95396-s2e4@summonarr", "Severance S02E04"],
  ]);
});

test("tv: a season premiere with no episode list, and a bare next-episode date, each yield one event", () => {
  const out = events.buildCalendarEvents(
    [{ tmdbId: 7, mediaType: "tv", title: "Show" }],
    {
      movies: new Map(),
      tv: new Map([[7, { seasons: [{ seasonNumber: 3, airDate: "2027-01-05" }], nextEpisode: { airDate: "2026-11-01" } }]]),
      episodes: new Map(),
    },
    W,
    null,
  );
  assert.deepEqual(out.map((e) => [e.uid, e.date, e.summary]), [
    ["tv-7-next@summonarr", "2026-11-01", "Show – New episode"],
    ["tv-7-s3-premiere@summonarr", "2027-01-05", "Show – Season 3 premiere"],
  ]);
});

test("tv: next episode is suppressed only when the lists already carry THAT episode", () => {
  const run = (eps: Array<{ seasonNumber: number; episodeNumber: number; airDate: string }>, next: { airDate: string; seasonNumber?: number; episodeNumber?: number }) =>
    events.buildCalendarEvents(
      [{ tmdbId: 9, mediaType: "tv", title: "S" }],
      { movies: new Map(), tv: new Map([[9, { seasons: [], nextEpisode: next }]]), episodes: new Map([[9, eps]]) },
      W,
      null,
    ).map((e) => e.uid);
  // Listed episode (any date) ⇒ the list's event only.
  assert.deepEqual(run([{ seasonNumber: 1, episodeNumber: 2, airDate: "2026-10-17" }], { airDate: "2026-10-18", seasonNumber: 1, episodeNumber: 2 }), ["tv-9-s1e2@summonarr"]);
  // A stale list that lacks the next episode ⇒ the next episode still shows.
  assert.deepEqual(
    run([{ seasonNumber: 1, episodeNumber: 1, airDate: "2026-10-10" }], { airDate: "2026-10-17", seasonNumber: 1, episodeNumber: 2 }),
    ["tv-9-s1e1@summonarr", "tv-9-next@summonarr"],
  );
  // A bare date (no SxxEyy) already covered by a listed episode that day ⇒ suppressed.
  assert.deepEqual(run([{ seasonNumber: 1, episodeNumber: 1, airDate: "2026-10-10" }], { airDate: "2026-10-10" }), ["tv-9-s1e1@summonarr"]);
});

test("tv: a season premiere and a bare next-episode date on the same day are one event", () => {
  const out = events.buildCalendarEvents(
    [{ tmdbId: 8, mediaType: "tv", title: "Show" }],
    { movies: new Map(), tv: new Map([[8, { seasons: [{ seasonNumber: 3, airDate: "2027-01-05" }], nextEpisode: { airDate: "2027-01-05" } }]]), episodes: new Map() },
    W,
    null,
  );
  assert.deepEqual(out.map((e) => e.uid), ["tv-8-s3-premiere@summonarr"]);
});

test("seasonsToRead: newest two premiered seasons plus next-episode's; none for a long-ended show", () => {
  const info = {
    status: "Returning Series",
    seasons: [1, 2, 3, 4].map((n) => ({ seasonNumber: n, airDate: n === 4 ? "2028-01-01" : `202${n}-01-01` })),
    nextEpisode: { airDate: "2026-10-10", seasonNumber: 4 },
  };
  assert.deepEqual(events.seasonsToRead(info, W), [2, 3, 4]);
  assert.deepEqual(events.seasonsToRead({ ...info, status: "Ended", lastAirDate: "2020-01-01", nextEpisode: null }, W), []);
});

// ── 2. token primitives ─────────────────────────────────────────────────────

test("token: 43-char base64url, only its SHA-256 is stored, compare is exact", () => {
  const t = tokenLib.generateCalendarToken();
  assert.ok(tokenLib.isWellFormedCalendarToken(t));
  const h = tokenLib.hashCalendarToken(t);
  assert.match(h, /^[0-9a-f]{64}$/);
  assert.notEqual(h, t);
  assert.ok(tokenLib.calendarTokenMatches(h, t));
  assert.ok(!tokenLib.calendarTokenMatches(h, tokenLib.generateCalendarToken()));
  assert.ok(!tokenLib.calendarTokenMatches(null, t));
  assert.ok(!tokenLib.calendarTokenMatches("abc", t), "a malformed stored hash never matches (and never throws)");
  assert.ok(!tokenLib.isWellFormedCalendarToken(`${t}x`));
  assert.ok(!tokenLib.isWellFormedCalendarToken("../../etc/passwd"));
  assert.equal(tokenLib.tokenFromFeedSegment(`${t}.ics`), t);
  assert.equal(tokenLib.tokenFromFeedSegment(t), t);
});

test("the compare is timing-safe (crypto.timingSafeEqual), not ===", async () => {
  const { readFileSync } = await import("node:fs");
  const src = readFileSync(new URL("../src/lib/calendar-token.ts", import.meta.url), "utf8");
  assert.match(src, /timingSafeEqual\(/);
});

// ── 3. loader: selection from stubbed prisma ────────────────────────────────

test("personal titles = own non-declined requests + own watchlist; declined and others' excluded", async () => {
  const me = addUser();
  const other = addUser();
  const now = new Date();
  requests = [
    { requestedBy: me.id, tmdbId: 1, mediaType: "MOVIE", title: "Pending", status: "PENDING", createdAt: now },
    { requestedBy: me.id, tmdbId: 2, mediaType: "TV", title: "Available", status: "AVAILABLE", createdAt: now },
    { requestedBy: me.id, tmdbId: 3, mediaType: "MOVIE", title: "Declined", status: "DECLINED", createdAt: now },
    { requestedBy: other.id, tmdbId: 4, mediaType: "MOVIE", title: "Theirs", status: "APPROVED", createdAt: now },
  ];
  watchlist = [
    { userId: me.id, tmdbId: 5, mediaType: "MOVIE", title: "Saved", createdAt: now },
    { userId: other.id, tmdbId: 6, mediaType: "MOVIE", title: "TheirSaved", createdAt: now },
  ];
  const titles = await loadCalendarTitles({ kind: "user", userId: me.id });
  assert.deepEqual(titles.map((t) => t.title).sort(), ["Available", "Pending", "Saved"]);
  const all = await loadCalendarTitles({ kind: "all" });
  assert.deepEqual(all.map((t) => t.title).sort(), ["Available", "Pending", "Theirs"], "all = every non-declined request, no watchlists");
});

test("buildCalendarFeed: end-to-end from cache rows; declined title absent; links carry AUTH_URL + BASE_PATH", async () => {
  const me = addUser();
  const now = new Date();
  requests = [
    { requestedBy: me.id, tmdbId: 10, mediaType: "MOVIE", title: "Keep, Me", status: "APPROVED", createdAt: now },
    { requestedBy: me.id, tmdbId: 11, mediaType: "MOVIE", title: "Declined Movie", status: "DECLINED", createdAt: now },
    { requestedBy: me.id, tmdbId: 20, mediaType: "TV", title: "Show", status: "PENDING", createdAt: now },
  ];
  watchlist = [{ userId: me.id, tmdbId: 10, mediaType: "MOVIE", title: "Keep, Me", createdAt: now }];
  putCache("movie:10:release-info:v2", { primary: iso(-400), digital: iso(10), physical: null });
  putCache("movie:11:release-info:v2", { primary: iso(5), digital: null, physical: null });
  putCache("tv:20:calendar:v1", {
    status: "Returning Series",
    lastAirDate: iso(-3),
    seasons: [{ seasonNumber: 1, airDate: iso(-3), episodeCount: 2 }],
    nextEpisode: { airDate: iso(4), seasonNumber: 1, episodeNumber: 2, name: "Two" },
  });
  putCache("tv:20:season:1", [
    { seasonNumber: 1, episodeNumber: 1, name: "One", airDate: iso(-3) },
    { seasonNumber: 1, episodeNumber: 2, name: "Two", airDate: iso(4) },
  ]);
  const ics = await buildCalendarFeed({ kind: "user", userId: me.id });
  const unfolded = ics.replace(/\r\n /g, "");
  assert.ok(unfolded.includes("SUMMARY:Keep\\, Me (Digital)"));
  assert.ok(!unfolded.includes("Declined Movie"), "a declined request must never reach the feed");
  assert.ok(!unfolded.includes("(Theatrical)"), "a primary date 400 days back is outside the window");
  assert.ok(unfolded.includes("SUMMARY:Show S01E01 – One"));
  assert.ok(unfolded.includes("SUMMARY:Show S01E02 – Two"));
  assert.equal((unfolded.match(/UID:tv-20-s1e2@summonarr/g) ?? []).length, 1, "next episode not duplicated");
  assert.equal((unfolded.match(/BEGIN:VEVENT/g) ?? []).length, 3);
  assert.ok(unfolded.includes("URL:https://summonarr.example.com/req/movie/10"));
  assert.ok(!unfolded.includes(me.email) && !unfolded.includes(me.id), "no PII beyond titles");
  assert.equal(fetchCalls.length, 0, "the feed is cache-read only");
});

test("resolveCalendarToken re-checks the found row's hash (a lookup that returns the wrong row is refused)", async () => {
  const victim = addUser();
  withToken(victim);
  const attackerToken = tokenLib.generateCalendarToken();
  // Simulate a lookup that ignores the hash (e.g. a collation/driver bug):
  wrongRowFor = victim.id;
  try {
    assert.equal(await resolveCalendarToken(attackerToken), null);
  } finally {
    wrongRowFor = null;
  }
});

test("resolveCalendarToken: live owner resolves; deactivated, purged and legacy-purged do not", async () => {
  const live = addUser();
  const t1 = withToken(live);
  assert.equal((await resolveCalendarToken(t1))?.id, live.id);

  const disabled = addUser({ deactivatedAt: new Date() });
  assert.equal(await resolveCalendarToken(withToken(disabled)), null);

  const purged = addUser({ deactivatedAt: new Date(), purgedAt: new Date() });
  assert.equal(await resolveCalendarToken(withToken(purged)), null);

  // Pre-split anonymize shape: tombstone email, NULL purgedAt (guardrail 33).
  const legacy = addUser({ id: "legacy-1", email: purgedEmailFor("legacy-1"), deactivatedAt: null, purgedAt: null });
  assert.equal(await resolveCalendarToken(withToken(legacy)), null);

  reads.length = 0;
  assert.equal(await resolveCalendarToken("not-a-token"), null);
  assert.equal(reads.length, 0, "a malformed token is rejected before any DB read");
});

// ── 4. the public feed route ────────────────────────────────────────────────

test("feed route: reachable WITHOUT a session for a valid token — 200 text/calendar", async () => {
  const me = addUser();
  const t = withToken(me);
  requests = [{ requestedBy: me.id, tmdbId: 30, mediaType: "MOVIE", title: "Soon", status: "APPROVED", createdAt: new Date() }];
  putCache("movie:30:release-info:v2", { primary: iso(3), digital: null, physical: null });
  const res = await getFeed(`${t}.ics`);
  assert.equal(res.status, 200);
  assert.equal(res.headers.get("content-type"), "text/calendar; charset=utf-8");
  assert.match(res.headers.get("content-disposition") ?? "", /^inline; filename="summonarr\.ics"$/);
  assert.match(res.headers.get("cache-control") ?? "", /private/);
  const body = await res.text();
  assert.ok(body.startsWith("BEGIN:VCALENDAR\r\n"));
  assert.ok(body.includes("SUMMARY:Soon (Theatrical)"));
});

test("feed route: bad, unknown, revoked and disabled-owner tokens are all a bare 404", async () => {
  const shapes = ["garbage.ics", `${"a".repeat(43)}.ics`, ""];
  for (const s of shapes) assert.equal((await getFeed(s)).status, 404, `segment ${JSON.stringify(s)}`);

  const gone = addUser({ deactivatedAt: new Date() });
  assert.equal((await getFeed(`${withToken(gone)}.ics`)).status, 404);
  assert.equal(errors.length, 0);
});

test("feed route: ?scope=all needs MANAGE_REQUESTS, re-checked per poll; other scopes 404", async () => {
  const user = addUser();
  const tUser = withToken(user);
  assert.equal((await getFeed(`${tUser}.ics`, "?scope=all")).status, 404);
  assert.equal((await getFeed(`${tUser}.ics`, "?scope=everything")).status, 404);

  const mgr = addUser({ permissions: Permission.MANAGE_REQUESTS });
  const tMgr = withToken(mgr);
  const other = addUser();
  requests = [{ requestedBy: other.id, tmdbId: 40, mediaType: "MOVIE", title: "Someone Else's", status: "PENDING", createdAt: new Date() }];
  putCache("movie:40:release-info:v2", { primary: iso(2) });
  const ok = await getFeed(`${tMgr}.ics`, "?scope=all");
  assert.equal(ok.status, 200);
  assert.ok((await ok.text()).includes("Someone Else's"));

  // Demotion takes effect on the next poll — the live row is read every time.
  mgr.permissions = 0n;
  assert.equal((await getFeed(`${tMgr}.ics`, "?scope=all")).status, 404);
});

test("feed route: feature switched off ⇒ 404 even for a valid token", async () => {
  const me = addUser();
  const t = withToken(me);
  settings.set("feature.integration.calendar", "false");
  invalidateFeatureFlagCache();
  assert.equal((await getFeed(`${t}.ics`)).status, 404);
});

test("feed route: per-token rate limit returns 429", async () => {
  const me = addUser();
  const t = withToken(me);
  let last = 0;
  for (let i = 0; i < 25; i++) last = (await getFeed(`${t}.ics`)).status;
  assert.equal(last, 429);
});

// ── 5. the profile management route ─────────────────────────────────────────

test("profile/calendar: anonymous callers get 401 on every verb", async () => {
  for (const m of ["GET", "POST", "DELETE"] as const) {
    const res = await inScope(() => profileRoute[m](profileReq(m, null), undefined));
    assert.equal(res.status, 401, m);
  }
});

test("POST mints a URL once; the stored value is the hash; regenerating revokes the old URL", async () => {
  const me = addUser();
  const jwt = await mintSession(me);

  const first = await inScope(() => profileRoute.POST(profileReq("POST", jwt), undefined));
  assert.equal(first.status, 201);
  assert.equal(first.headers.get("cache-control"), "no-store");
  const a = await first.json();
  assert.equal(a.url, `https://summonarr.example.com/req/api/calendar/feed/${a.token}.ics`);
  assert.equal(a.webcalUrl, `webcal://summonarr.example.com/req/api/calendar/feed/${a.token}.ics`);
  assert.equal(a.allUrl, null, "no all-requests URL without MANAGE_REQUESTS");
  assert.equal(me.calendarTokenHash, tokenLib.hashCalendarToken(a.token), "only the hash is stored");
  assert.notEqual(me.calendarTokenHash, a.token);
  assert.equal((await getFeed(`${a.token}.ics`)).status, 200);

  const status = await (await inScope(() => profileRoute.GET(profileReq("GET", jwt), undefined))).json();
  assert.equal(status.enabled, true);
  assert.equal("url" in status || "token" in status, false, "GET never re-discloses the URL");

  const second = await (await inScope(() => profileRoute.POST(profileReq("POST", jwt), undefined))).json();
  assert.notEqual(second.token, a.token);
  assert.equal((await getFeed(`${a.token}.ics`)).status, 404, "the old URL is revoked");
  assert.equal((await getFeed(`${second.token}.ics`)).status, 200);

  const del = await inScope(() => profileRoute.DELETE(profileReq("DELETE", jwt), undefined));
  assert.equal(del.status, 200);
  assert.equal(me.calendarTokenHash, null);
  assert.equal((await getFeed(`${second.token}.ics`)).status, 404, "DELETE revokes");
});

test("POST for a request manager also returns the all-requests URL", async () => {
  const mgr = addUser({ permissions: Permission.MANAGE_REQUESTS });
  const jwt = await mintSession(mgr);
  const body = await (await inScope(() => profileRoute.POST(profileReq("POST", jwt), undefined))).json();
  assert.equal(body.allUrl, `${body.url}?scope=all`);
});

// ── 6. the cron warm ────────────────────────────────────────────────────────

test("warm: fetches only missing dates, then the seasons the feed will read", async () => {
  const me = addUser();
  const now = new Date();
  requests = [
    { requestedBy: me.id, tmdbId: 100, mediaType: "MOVIE", title: "Fresh", status: "APPROVED", createdAt: now },
    { requestedBy: me.id, tmdbId: 101, mediaType: "MOVIE", title: "Missing", status: "APPROVED", createdAt: now },
    { requestedBy: me.id, tmdbId: 102, mediaType: "MOVIE", title: "Declined", status: "DECLINED", createdAt: now },
  ];
  watchlist = [{ userId: me.id, tmdbId: 200, mediaType: "TV", title: "Airing", createdAt: now }];
  putCache("movie:100:release-info:v2", { primary: iso(5) });

  const r = await warmCalendarCache();
  const paths = fetchCalls.map((u) => u.pathname).sort();
  assert.deepEqual(paths, ["/3/movie/101", "/3/tv/200", "/3/tv/200/season/1"]);
  assert.equal(r.titles, 3, "declined requests are not warmed");
  assert.equal(r.fetched, 3);
  assert.ok(cache.has("movie:101:release-info:v2"));
  assert.ok(cache.has("tv:200:calendar:v1"));
  assert.ok(cache.has("tv:200:season:1"));

  // The feed now has the warmed dates, with no further fetch.
  fetchCalls.length = 0;
  const ics = (await buildCalendarFeed({ kind: "user", userId: me.id })).replace(/\r\n /g, "");
  assert.ok(ics.includes("SUMMARY:Airing S01E01 – Pilot"));
  assert.equal(fetchCalls.length, 0);
});

test("warm: an expired blob that proves a title is finished is not re-fetched", async () => {
  const me = addUser();
  const now = new Date();
  const past = new Date(Date.now() - DAY);
  requests = [
    { requestedBy: me.id, tmdbId: 300, mediaType: "MOVIE", title: "Old", status: "AVAILABLE", createdAt: now },
    { requestedBy: me.id, tmdbId: 301, mediaType: "TV", title: "Ended", status: "AVAILABLE", createdAt: now },
  ];
  putCache("movie:300:release-info:v2", { primary: "2001-01-01", digital: "2001-06-01", physical: "2001-07-01" }, past);
  putCache("tv:301:calendar:v1", { status: "Ended", lastAirDate: "2010-01-01", seasons: [], nextEpisode: null }, past);
  await warmCalendarCache();
  assert.equal(fetchCalls.length, 0);
});

test("warm: bounded by MAX_CALENDAR_WARM_FETCHES", async () => {
  const me = addUser();
  const now = new Date();
  requests = Array.from({ length: MAX_CALENDAR_WARM_FETCHES + 25 }, (_, i) => ({
    requestedBy: me.id, tmdbId: 10_000 + i, mediaType: "MOVIE" as const, title: `M${i}`, status: "APPROVED", createdAt: now,
  }));
  const r = await warmCalendarCache();
  assert.equal(fetchCalls.length, MAX_CALENDAR_WARM_FETCHES);
  assert.equal(r.fetched, MAX_CALENDAR_WARM_FETCHES);
});

test("warm: an aborted signal stops before any upstream call and RETURNS (no throw)", async () => {
  const me = addUser();
  requests = [{ requestedBy: me.id, tmdbId: 400, mediaType: "MOVIE", title: "X", status: "APPROVED", createdAt: new Date() }];
  const ac = new AbortController();
  ac.abort();
  const r = await warmCalendarCache({ signal: ac.signal });
  assert.equal(r.aborted, true);
  assert.equal(fetchCalls.length, 0);
});

test("warm: feature off ⇒ skipped without reading anything", async () => {
  settings.set("feature.integration.calendar", "false");
  invalidateFeatureFlagCache();
  const r = await warmCalendarCache();
  assert.equal(r.skipped, "disabled");
  assert.equal(reads.filter((x) => x !== "user.findUnique:id").length, 0);
  assert.equal(fetchCalls.length, 0);
});
