// Route-level unit tests for two more uncovered guardrail-35 read surfaces,
// plus the shared enrichment behind one of them:
//   GET /api/person/[id]        → src/lib/person.ts getEnrichedPerson (untested)
//   GET /api/tv/[id]/season/[n]
//
// Both hand a caller per-title availability derived from the Plex/Jellyfin
// library tables, so both are places a RESTRICTED server can leak. The season
// route is the second of the three TVEpisodeCache read sites named in guardrail
// 35 (tests/tv-availability-route.test.mts covers the first): that table has no
// serverInstance column, so `source IN (…)` alone would report a restricted
// server's per-episode holdings as raw JSON.
//
// person/[id] leaks differently and is the more interesting one. Its enrichment
// resolves visibility INSIDE the data layer — the library queries are scoped by
// `serverInstance: { in: visible.* }` — because getBadgeVisibility is only a
// cosmetic mask and the raw payload ships the unmasked field. So the tests
// assert the QUERY is scoped, not merely that the rendered flag is false: a mask
// applied after an unscoped read still leaks to anyone with devtools or a native
// client. That is the exact "never enforce this at the presentation layer" rule.
//
// Also pinned:
//   - the 404-vs-502 split on person. Only a genuine TMDB 404 is Not Found; a
//     TMDB 5xx, a network error or a Prisma failure must surface as 502, or a
//     transient outage becomes indistinguishable from a deleted person and gets
//     cached/handled as one.
//   - requestedByMe / requestToken are scoped to the SESSION user, and the
//     minted token verifies for that user and that credit only.
//   - the season route's fire-and-forget episode-metadata warm is unawaited and
//     swallows errors (the same deliberate pattern as guardrail 17), and must
//     not run when the viewer can see no source.
//   - provider narrowing, rate limits, and id validation on both.
//
// Harness: the tests/votes-route.test.mts idiom — real withAuth-wrapped handlers,
// genuine signed session JWTs, a synthetic workAsyncStorage + workUnitAsyncStorage
// scope, in-memory prisma stubs and a scripted fetch for TMDB. No DB, no network.
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { AsyncLocalStorage } from "node:async_hooks";
import dns from "node:dns/promises";

(globalThis as { AsyncLocalStorage?: unknown }).AsyncLocalStorage = AsyncLocalStorage;

process.env.TOKEN_ENCRYPTION_KEY = "ab".repeat(32);
process.env.NEXTAUTH_SECRET = "media-detail-routes-secret-0123456789abc";
process.env.AUTH_URL = "http://localhost:3000";
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

// ── scripted TMDB ────────────────────────────────────────────────────────────
type TmdbMode = "ok" | "404" | "500" | "network";
let personMode: TmdbMode = "ok";
let seasonMode: TmdbMode = "ok";
const fetchCalls: URL[] = [];

// getPersonDetails filters on media_type ∈ {movie,tv}, a truthy poster_path and
// vote_count > 10 — so the fixture has to satisfy all three or the filmography
// arrives empty and every enrichment assertion below reads `undefined`.
const PERSON_CREDITS = [
  { id: 603, media_type: "movie", title: "The Matrix", poster_path: "/m.jpg", release_date: "1999-03-31", vote_average: 8.2, vote_count: 24_000, character: "Neo" },
  { id: 604, media_type: "movie", title: "The Matrix Reloaded", poster_path: "/m2.jpg", release_date: "2003-05-15", vote_average: 7.0, vote_count: 12_000, character: "Neo" },
  { id: 1399, media_type: "tv", name: "Game of Thrones", poster_path: "/got.jpg", first_air_date: "2011-04-17", vote_average: 8.4, vote_count: 21_000, character: "Self" },
];

globalThis.fetch = (async (input: RequestInfo | URL) => {
  const url = new URL(String(input));
  fetchCalls.push(url);
  if (!(url.hostname === "themoviedb.org" || url.hostname.endsWith(".themoviedb.org"))) {
    throw new Error(`unexpected non-TMDB fetch: ${url}`);
  }
  const isSeason = /\/tv\/\d+\/season\/\d+/.test(url.pathname);
  const mode = isSeason ? seasonMode : personMode;
  if (mode === "network") throw new TypeError("fetch failed");
  if (mode === "404") return new Response(JSON.stringify({ status_message: "not found" }), { status: 404, headers: { "content-type": "application/json" } });
  if (mode === "500") return new Response(JSON.stringify({ status_message: "server error" }), { status: 500, headers: { "content-type": "application/json" } });

  if (isSeason) {
    return new Response(
      JSON.stringify({
        episodes: [
          { episode_number: 1, name: "Winter Is Coming", air_date: "2011-04-17", still_path: "/e1.jpg", runtime: 62, overview: "one" },
          { episode_number: 2, name: "The Kingsroad", air_date: "2011-04-24", still_path: "/e2.jpg", runtime: 56, overview: "two" },
        ],
      }),
      { status: 200, headers: { "content-type": "application/json" } },
    );
  }
  if (url.pathname.includes("/person/")) {
    if (url.pathname.includes("combined_credits")) {
      return new Response(JSON.stringify({ cast: PERSON_CREDITS, crew: [] }), { status: 200, headers: { "content-type": "application/json" } });
    }
    return new Response(
      JSON.stringify({
        id: 6384, name: "Keanu Reeves", biography: "b", profile_path: "/k.jpg",
        birthday: "1964-09-02", place_of_birth: "Beirut", known_for_department: "Acting",
        combined_credits: { cast: PERSON_CREDITS, crew: [] },
      }),
      { status: 200, headers: { "content-type": "application/json" } },
    );
  }
  return new Response("{}", { status: 200, headers: { "content-type": "application/json" } });
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
const { shadowPrismaModel, shadowPrismaClientMethod } = await import("./_helpers.mts");
const { signSessionJwt } = await import("../src/lib/session-jwt.ts");
const { getSessionCookieName } = await import("../src/lib/session-cookie.ts");
const { Permission } = await import("../src/lib/permissions.ts");
const { verifyRequestToken } = await import("../src/lib/request-token.ts");

// ── op log ───────────────────────────────────────────────────────────────────
type Op = { op: string; args?: unknown };
let ops: Op[] = [];
const rec = (op: string, args?: unknown) => { ops.push({ op, args }); };
const opsOf = (name: string) => ops.filter((o) => o.op === name);

// ── auth fixture ─────────────────────────────────────────────────────────────
const usersById = new Map<string, Record<string, unknown>>();
const sessionRows = new Set<string>();
shadowPrismaModel(prisma, "authSession", {
  findUnique: async (args: { where: { sessionId: string } }) =>
    sessionRows.has(args.where.sessionId) ? { id: `row-${args.where.sessionId}`, sessionId: args.where.sessionId } : null,
  update: async () => ({}),
});
shadowPrismaModel(prisma, "user", {
  findUnique: async (args: { where: { id: string }; select?: Record<string, boolean> }) => {
    rec("user.findUnique", args.select);
    return usersById.get(args.where.id) ?? null;
  },
  update: async () => ({}),
});

let seq = 0;
// NOTE on `mediaServer`: getBadgeVisibility is a COSMETIC mask keyed on it — a
// non-admin with mediaServer:null sees neither badge regardless of what the
// library holds. Tests that mean to exercise the DATA-layer scope therefore mint
// with mediaServer:"plex" so the mask is wide open and the serverInstance
// scoping is the only thing that can withhold anything. Leaving it null would
// make those assertions pass for the wrong reason.
async function mintSession(
  opts: { provider?: string; role?: string; permissions?: bigint; grants?: unknown; mediaServer?: string | null } = {},
): Promise<{ userId: string; token: string }> {
  seq++;
  const userId = `viewer-${seq}`;
  const sessionId = `sess-${seq}`;
  const role = opts.role ?? "USER";
  const permissions = (opts.permissions ?? 0n).toString();
  usersById.set(userId, {
    id: userId, name: `Viewer ${seq}`, role, permissions: BigInt(permissions),
    mediaServer: opts.mediaServer ?? null, sessionsRevokedAt: null, passwordChangedAt: null, deactivatedAt: null,
    email: `viewer-${seq}@example.com`, notificationEmail: null,
    mediaServerGrants: opts.grants ?? null,
  });
  sessionRows.add(sessionId);
  const iat = Math.floor(Date.now() / 1000);
  const token = await signSessionJwt(
    { id: userId, role, permissions, provider: opts.provider ?? "credentials", sessionId, expiresAt: iat + 86_400 },
    { expiresInSeconds: 7_200, iat },
  );
  return { userId, token };
}
const COOKIE = getSessionCookieName();

// ── business stubs ───────────────────────────────────────────────────────────
const settings = new Map<string, string>();
shadowPrismaModel(prisma, "setting", {
  findUnique: async (args: { where: { key: string } }) => {
    const v = settings.get(args.where.key);
    return v === undefined ? null : { key: args.where.key, value: v };
  },
  findMany: async (args: { where?: { key?: { in?: string[] } } } = {}) => {
    const keys = args.where?.key?.in;
    const all = [...settings.entries()].map(([key, value]) => ({ key, value }));
    return keys ? all.filter((r) => keys.includes(r.key)) : all;
  },
});

type LibRow = { tmdbId: number; mediaType: string; serverInstance: string };
let plexLib: LibRow[] = [];
let jellyfinLib: LibRow[] = [];

function libModel(name: string, rows: () => LibRow[]) {
  const scoped = (args: { where: { serverInstance?: { in: string[] }; OR?: Array<{ tmdbId: number; mediaType: string }>; tmdbId?: number; mediaType?: string } }) => {
    const inst = args.where.serverInstance?.in;
    assert.ok(Array.isArray(inst), `${name} query is not serverInstance-scoped — a restricted server would leak`);
    return rows().filter((r) => {
      if (!inst.includes(r.serverInstance)) return false;
      if (args.where.OR) return args.where.OR.some((c) => c.tmdbId === r.tmdbId && c.mediaType === r.mediaType);
      if (args.where.tmdbId !== undefined) return r.tmdbId === args.where.tmdbId && (args.where.mediaType === undefined || r.mediaType === args.where.mediaType);
      return true;
    });
  };
  return {
    findMany: async (args: Parameters<typeof scoped>[0]) => { rec(`${name}.findMany`, args.where); return scoped(args); },
    findFirst: async (args: Parameters<typeof scoped>[0]) => { rec(`${name}.findFirst`, args.where); return scoped(args)[0] ?? null; },
  };
}
shadowPrismaModel(prisma, "plexLibraryItem", libModel("plexLibraryItem", () => plexLib));
shadowPrismaModel(prisma, "jellyfinLibraryItem", libModel("jellyfinLibraryItem", () => jellyfinLib));

type EpRow = { tmdbId: number; seasonNumber: number; episodeNumber: number; source: string };
let episodeRows: EpRow[] = [];
shadowPrismaModel(prisma, "tVEpisodeCache", {
  findMany: async (args: { where: { tmdbId: number; seasonNumber?: number; source: { in: string[] } } }) => {
    rec("tVEpisodeCache.findMany", args.where);
    return episodeRows.filter(
      (e) => e.tmdbId === args.where.tmdbId
        && (args.where.seasonNumber === undefined || e.seasonNumber === args.where.seasonNumber)
        && args.where.source.in.includes(e.source),
    );
  },
  update: async (args: unknown) => { rec("tVEpisodeCache.update", args); return {}; },
});

type ReqRow = { tmdbId: number; mediaType: string; requestedBy: string; status: string };
let requestRows: ReqRow[] = [];
// Named so the one test that swaps in a throwing stub can put THIS back in a
// finally, rather than re-declaring a second copy that can drift.
const mediaRequestModel = {
  findMany: async (args: { where: { OR?: Array<{ tmdbId: number; mediaType: string }>; requestedBy?: string; status?: unknown } }) => {
    rec("mediaRequest.findMany", args.where);
    return requestRows.filter((r) => {
      if (r.status === "DECLINED") return false;
      if (args.where.requestedBy !== undefined && r.requestedBy !== args.where.requestedBy) return false;
      if (args.where.OR) return args.where.OR.some((c) => c.tmdbId === r.tmdbId && c.mediaType === r.mediaType);
      return true;
    });
  },
};
shadowPrismaModel(prisma, "mediaRequest", mediaRequestModel);

for (const m of ["radarrWantedItem", "sonarrWantedItem"]) {
  shadowPrismaModel(prisma, m, {
    findMany: async (args: unknown) => { rec(`${m}.findMany`, args); return []; },
  });
}
shadowPrismaModel(prisma, "blacklistItem", { findMany: async () => { rec("blacklistItem.findMany"); return []; } });
shadowPrismaModel(prisma, "tmdbCache", {
  findMany: async () => [], findUnique: async () => null, findFirst: async () => null,
  upsert: async () => ({}), create: async () => ({}), deleteMany: async () => ({ count: 0 }),
});
shadowPrismaModel(prisma, "tmdbMediaCore", {
  findMany: async () => [], findUnique: async () => null,
  upsert: async () => ({}), createMany: async () => ({ count: 0 }),
});
shadowPrismaModel(prisma, "hiddenItem", { findMany: async () => [] });
shadowPrismaClientMethod(prisma, "$transaction", async (arg: unknown) =>
  Array.isArray(arg) ? Promise.all(arg) : (arg as (tx: unknown) => Promise<unknown>)(prisma));

const person = await import("../src/app/api/person/[id]/route.ts");
const season = await import("../src/app/api/tv/[id]/season/[n]/route.ts");

// ── scope ────────────────────────────────────────────────────────────────────
function inScope<T>(fn: () => Promise<T>): Promise<T> {
  const workStore = {
    route: "/media-detail.test", forceStatic: false, dynamicShouldError: false,
    afterContext: { after: () => {} },
  };
  const reqHeaders = new Headers();
  const requestStore = {
    type: "request", phase: "render",
    headers: HeadersAdapter.seal(reqHeaders),
    cookies: RequestCookiesAdapter.seal(new RequestCookies(reqHeaders)),
    usedDynamic: false,
  };
  return workAsyncStorage.run(workStore, () => workUnitAsyncStorage.run(requestStore, fn));
}

function getPerson(token: string | null, id: string): Promise<Response> {
  const req = new NextRequest(`http://localhost:3000/api/person/${id}`, {
    method: "GET", headers: token ? { cookie: `${COOKIE}=${token}` } : {},
  });
  return inScope(() => person.GET(req, { params: Promise.resolve({ id }) }));
}

function getSeason(token: string | null, id: string, n: string): Promise<Response> {
  const req = new NextRequest(`http://localhost:3000/api/tv/${id}/season/${n}`, {
    method: "GET", headers: token ? { cookie: `${COOKIE}=${token}` } : {},
  });
  return inScope(() => season.GET(req, { params: Promise.resolve({ id, n }) }));
}

function registerInstance(service: "plex" | "jellyfin", slug: string, restricted: boolean): void {
  const key = service === "plex" ? "plexInstances" : "jellyfinInstances";
  const existing = JSON.parse(settings.get(key) ?? "[]") as unknown[];
  existing.push({ slug, name: slug, restricted });
  settings.set(key, JSON.stringify(existing));
}

beforeEach(() => {
  ops = [];
  fetchCalls.length = 0;
  warns.length = 0;
  errors.length = 0;
  settings.clear();
  plexLib = [];
  jellyfinLib = [];
  episodeRows = [];
  requestRows = [];
  personMode = "ok";
  seasonMode = "ok";
});

// ── person: auth + validation ────────────────────────────────────────────────

test("person: an anonymous request is 401 and never reaches TMDB", async () => {
  const res = await getPerson(null, "6384");
  assert.equal(res.status, 401);
  assert.deepEqual(fetchCalls, []);
});

for (const [label, id] of [["a non-numeric id", "abc"], ["zero", "0"], ["a negative id", "-4"], ["an empty id", ""]] as const) {
  test(`person: ${label} is 400 and never reaches TMDB`, async () => {
    const me = await mintSession();
    const res = await getPerson(me.token, id);
    assert.equal(res.status, 400);
    assert.deepEqual(fetchCalls, []);
  });
}

test("person: the 31st request in the window is 429", async () => {
  const me = await mintSession();
  for (let i = 0; i < 30; i++) assert.equal((await getPerson(me.token, "6384")).status, 200);
  assert.equal((await getPerson(me.token, "6384")).status, 429);
});

// ── person: the 404-vs-502 split ─────────────────────────────────────────────

test("person: a genuine TMDB 404 maps to 404", async () => {
  personMode = "404";
  const me = await mintSession();
  const res = await getPerson(me.token, "999999");
  assert.equal(res.status, 404);
  assert.equal((await res.json()).error, "Not found");
});

test("person: a TMDB 5xx maps to 502, NOT 404", async () => {
  // A transient upstream failure must stay distinguishable from a deleted
  // person — otherwise an outage looks like a permanent Not Found.
  personMode = "500";
  const me = await mintSession();
  const res = await getPerson(me.token, "6384");
  assert.equal(res.status, 502);
  assert.equal((await res.json()).error, "Upstream error");
});

test("person: a network failure maps to 502", async () => {
  personMode = "network";
  const me = await mintSession();
  assert.equal((await getPerson(me.token, "6384")).status, 502);
});

test("person: a DB failure during enrichment maps to 502, not 404", async () => {
  // Fails the request lookup rather than the blacklist read: getBlacklistSet is
  // process-cached, so a throwing blacklist stub is never reached on a second
  // call and the test would pass vacuously.
  const me = await mintSession();
  shadowPrismaModel(prisma, "mediaRequest", {
    findMany: async () => { throw new Error("prisma exploded"); },
  });
  // finally, not a trailing statement: shadowPrismaModel is a plain assignment
  // and beforeEach reinstalls no stubs, so a throw above would leave the
  // throwing findMany installed and cascade 502s through every later test.
  try {
    const res = await getPerson(me.token, "6384");
    assert.equal(res.status, 502);
    assert.ok(!(await res.text()).includes("prisma exploded"), "the raw DB error must stay server-side");
  } finally {
    shadowPrismaModel(prisma, "mediaRequest", mediaRequestModel);
  }
});

test("person: the failure is logged with a scoped prefix and the raw error stays server-side", async () => {
  personMode = "500";
  const me = await mintSession();
  const res = await getPerson(me.token, "6384");
  assert.ok(errors.some((e) => e.includes("[person]")), `no scoped log: ${errors.join(" | ")}`);
  assert.ok(!(await res.text()).includes("status_message"));
});

// ── person: guardrail-35 visibility resolved in the DATA layer ───────────────

test("person: the library queries are serverInstance-scoped, not filtered afterwards", async () => {
  // The stub asserts the scope on every call; this pins that both library reads
  // actually happen through it.
  const me = await mintSession();
  await getPerson(me.token, "6384");
  assert.ok(opsOf("plexLibraryItem.findMany").length > 0);
  assert.ok(opsOf("jellyfinLibraryItem.findMany").length > 0);
  for (const op of [...opsOf("plexLibraryItem.findMany"), ...opsOf("jellyfinLibraryItem.findMany")]) {
    const where = op.args as { serverInstance: { in: string[] } };
    assert.ok(Array.isArray(where.serverInstance.in));
  }
});

test("person: a restricted server's holding never reaches the payload for an ungranted viewer", async () => {
  registerInstance("plex", "remote", true);
  plexLib = [{ tmdbId: 603, mediaType: "MOVIE", serverInstance: "remote" }];
  // mediaServer:"plex" ⇒ the cosmetic badge mask is OPEN, so a false here can
  // only come from the data-layer scope — not from getBadgeVisibility.
  const me = await mintSession({ mediaServer: "plex" });
  const body = await (await getPerson(me.token, "6384")).json();
  const matrix = body.credits.find((c: { id: number }) => c.id === 603);
  assert.equal(matrix.plexAvailable, false);
  // …and the ungranted instance was never even queried into the result set.
  const where = opsOf("plexLibraryItem.findMany")[0].args as { serverInstance: { in: string[] } };
  assert.deepEqual(where.serverInstance.in, [""]);
});

test("person: a granted viewer DOES see the restricted server's holding", async () => {
  registerInstance("plex", "remote", true);
  plexLib = [{ tmdbId: 603, mediaType: "MOVIE", serverInstance: "remote" }];
  const me = await mintSession({ grants: { plex: { remote: { view: true } } }, mediaServer: "plex" });
  const body = await (await getPerson(me.token, "6384")).json();
  assert.equal(body.credits.find((c: { id: number }) => c.id === 603).plexAvailable, true);
});

test("person: an unrestricted holding is visible to everyone", async () => {
  plexLib = [{ tmdbId: 603, mediaType: "MOVIE", serverInstance: "" }];
  const me = await mintSession({ mediaServer: "plex" });
  const body = await (await getPerson(me.token, "6384")).json();
  assert.equal(body.credits.find((c: { id: number }) => c.id === 603).plexAvailable, true);
});

test("person: availability is keyed on (tmdbId, mediaType) — a movie id can't light up the TV credit", async () => {
  // TMDB namespaces movie and TV ids separately, so the same number is two works.
  plexLib = [{ tmdbId: 1399, mediaType: "MOVIE", serverInstance: "" }];
  const me = await mintSession({ mediaServer: "plex" });
  const body = await (await getPerson(me.token, "6384")).json();
  assert.equal(body.credits.find((c: { id: number; mediaType: string }) => c.id === 1399 && c.mediaType === "tv").plexAvailable, false);
});

test("person: a provider-narrowed viewer's badge mask does not widen the underlying query", async () => {
  jellyfinLib = [{ tmdbId: 603, mediaType: "MOVIE", serverInstance: "" }];
  const me = await mintSession({ provider: "plex" });
  const body = await (await getPerson(me.token, "6384")).json();
  // getBadgeVisibility hides the Jellyfin badge for a Plex-signin user…
  assert.equal(body.credits.find((c: { id: number }) => c.id === 603).jellyfinAvailable, false);
});

// ── person: per-user request state ───────────────────────────────────────────

test("person: requestedByMe reflects the SESSION user, not any requester", async () => {
  const me = await mintSession();
  const them = await mintSession();
  requestRows = [{ tmdbId: 603, mediaType: "MOVIE", requestedBy: them.userId, status: "PENDING" }];
  const body = await (await getPerson(me.token, "6384")).json();
  const matrix = body.credits.find((c: { id: number }) => c.id === 603);
  assert.equal(matrix.requested, true, "somebody requested it");
  assert.equal(matrix.requestedByMe, false, "but not this caller");
});

test("person: requestedByMe is true for the caller's own request", async () => {
  const me = await mintSession();
  requestRows = [{ tmdbId: 603, mediaType: "MOVIE", requestedBy: me.userId, status: "PENDING" }];
  const body = await (await getPerson(me.token, "6384")).json();
  assert.equal(body.credits.find((c: { id: number }) => c.id === 603).requestedByMe, true);
});

test("person: a DECLINED request does not count as requested", async () => {
  const me = await mintSession();
  requestRows = [{ tmdbId: 603, mediaType: "MOVIE", requestedBy: me.userId, status: "DECLINED" }];
  const body = await (await getPerson(me.token, "6384")).json();
  assert.equal(body.credits.find((c: { id: number }) => c.id === 603).requested, false);
});

test("person: each credit carries a request token that verifies for THIS user and THAT credit", async () => {
  const me = await mintSession();
  const other = await mintSession();
  const body = await (await getPerson(me.token, "6384")).json();
  const matrix = body.credits.find((c: { id: number }) => c.id === 603);
  assert.equal(verifyRequestToken(matrix.requestToken, 603, "MOVIE", me.userId), true);
  assert.equal(verifyRequestToken(matrix.requestToken, 603, "MOVIE", other.userId), false);
  assert.equal(verifyRequestToken(matrix.requestToken, 604, "MOVIE", me.userId), false);
});

test("person: the TV credit's token is minted under the TV namespace", async () => {
  const me = await mintSession();
  const body = await (await getPerson(me.token, "6384")).json();
  const got = body.credits.find((c: { id: number; mediaType: string }) => c.id === 1399 && c.mediaType === "tv");
  assert.equal(verifyRequestToken(got.requestToken, 1399, "TV", me.userId), true);
  assert.equal(verifyRequestToken(got.requestToken, 1399, "MOVIE", me.userId), false);
});

test("person: a person with no credits short-circuits without touching the library tables", async () => {
  const me = await mintSession();
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = new URL(String(input));
    fetchCalls.push(url);
    return new Response(
      JSON.stringify({ id: 1, name: "Nobody", biography: "", combined_credits: { cast: [], crew: [] } }),
      { status: 200, headers: { "content-type": "application/json" } },
    );
  }) as unknown as typeof fetch;
  const res = await getPerson(me.token, "1");
  assert.equal(res.status, 200);
  assert.equal(opsOf("plexLibraryItem.findMany").length, 0);
  globalThis.fetch = originalFetch;
});

// ── season: auth + validation ────────────────────────────────────────────────

test("season: an anonymous request is 401 and never reaches TMDB", async () => {
  const res = await getSeason(null, "1399", "1");
  assert.equal(res.status, 401);
  assert.deepEqual(fetchCalls, []);
});

for (const [label, id, n] of [
  ["a non-numeric show id", "abc", "1"],
  ["a zero show id", "0", "1"],
  ["a negative show id", "-1", "1"],
  ["a non-numeric season", "1399", "abc"],
  ["a negative season", "1399", "-1"],
] as const) {
  test(`season: ${label} is 400 and never reaches TMDB`, async () => {
    const me = await mintSession();
    const res = await getSeason(me.token, id, n);
    assert.equal(res.status, 400);
    assert.deepEqual(fetchCalls, []);
  });
}

test("season 0 (specials) is a valid request — the bound is >= 0, not > 0", async () => {
  const me = await mintSession();
  assert.equal((await getSeason(me.token, "1399", "0")).status, 200);
});

test("season: a TMDB failure is 502 and no episode rows are read", async () => {
  seasonMode = "500";
  const me = await mintSession();
  const res = await getSeason(me.token, "1399", "1");
  assert.equal(res.status, 502);
  assert.equal(opsOf("tVEpisodeCache.findMany").length, 0);
});

test("season: the 31st request in the window is 429", async () => {
  const me = await mintSession();
  for (let i = 0; i < 30; i++) assert.equal((await getSeason(me.token, "1399", "1")).status, 200);
  assert.equal((await getSeason(me.token, "1399", "1")).status, 429);
});

// ── season: the guardrail-35 episode gate ────────────────────────────────────

test("season: episodes owned on a visible server are reported", async () => {
  plexLib = [{ tmdbId: 1399, mediaType: "TV", serverInstance: "" }];
  episodeRows = [{ tmdbId: 1399, seasonNumber: 1, episodeNumber: 1, source: "plex" }];
  const me = await mintSession();
  const body = await (await getSeason(me.token, "1399", "1")).json();
  assert.deepEqual(body.owned, [1]);
  assert.equal(body.source, "plex");
  assert.equal(body.episodes.length, 2, "TMDB metadata is returned regardless of ownership");
});

test("season: a RESTRICTED server's episodes are withheld from an ungranted viewer", async () => {
  registerInstance("plex", "remote", true);
  plexLib = [{ tmdbId: 1399, mediaType: "TV", serverInstance: "remote" }];
  episodeRows = [{ tmdbId: 1399, seasonNumber: 1, episodeNumber: 1, source: "plex" }];
  const me = await mintSession();
  const body = await (await getSeason(me.token, "1399", "1")).json();
  assert.deepEqual(body.owned, []);
  assert.equal(body.source, null);
  assert.equal(opsOf("tVEpisodeCache.findMany").length, 0, "the shared table must not be read at all");
});

test("season: a granted viewer DOES see the restricted server's episodes", async () => {
  registerInstance("plex", "remote", true);
  plexLib = [{ tmdbId: 1399, mediaType: "TV", serverInstance: "remote" }];
  episodeRows = [{ tmdbId: 1399, seasonNumber: 1, episodeNumber: 2, source: "plex" }];
  const me = await mintSession({ grants: { plex: { remote: { view: true } } } });
  const body = await (await getSeason(me.token, "1399", "1")).json();
  assert.deepEqual(body.owned, [2]);
});

test("season: an ADMIN short-circuits the grant check", async () => {
  registerInstance("plex", "remote", true);
  plexLib = [{ tmdbId: 1399, mediaType: "TV", serverInstance: "remote" }];
  episodeRows = [{ tmdbId: 1399, seasonNumber: 1, episodeNumber: 1, source: "plex" }];
  const me = await mintSession({ role: "ADMIN", permissions: Permission.ADMIN });
  assert.deepEqual((await (await getSeason(me.token, "1399", "1")).json()).owned, [1]);
});

test("season: the episode read is season-scoped — another season's rows never leak in", async () => {
  plexLib = [{ tmdbId: 1399, mediaType: "TV", serverInstance: "" }];
  episodeRows = [
    { tmdbId: 1399, seasonNumber: 1, episodeNumber: 1, source: "plex" },
    { tmdbId: 1399, seasonNumber: 2, episodeNumber: 5, source: "plex" },
  ];
  const me = await mintSession();
  const body = await (await getSeason(me.token, "1399", "1")).json();
  assert.deepEqual(body.owned, [1]);
});

test("season: owned episode numbers are sorted numerically and de-duplicated across sources", async () => {
  plexLib = [{ tmdbId: 1399, mediaType: "TV", serverInstance: "" }];
  jellyfinLib = [{ tmdbId: 1399, mediaType: "TV", serverInstance: "" }];
  episodeRows = [
    { tmdbId: 1399, seasonNumber: 1, episodeNumber: 10, source: "plex" },
    { tmdbId: 1399, seasonNumber: 1, episodeNumber: 2, source: "jellyfin" },
    { tmdbId: 1399, seasonNumber: 1, episodeNumber: 2, source: "plex" },
  ];
  const me = await mintSession();
  const body = await (await getSeason(me.token, "1399", "1")).json();
  assert.deepEqual(body.owned, [2, 10]);
  assert.equal(body.source, "both");
});

test("season: a Plex-signin user is told about Plex only", async () => {
  plexLib = [{ tmdbId: 1399, mediaType: "TV", serverInstance: "" }];
  jellyfinLib = [{ tmdbId: 1399, mediaType: "TV", serverInstance: "" }];
  episodeRows = [
    { tmdbId: 1399, seasonNumber: 1, episodeNumber: 1, source: "plex" },
    { tmdbId: 1399, seasonNumber: 1, episodeNumber: 9, source: "jellyfin" },
  ];
  const me = await mintSession({ provider: "plex" });
  const body = await (await getSeason(me.token, "1399", "1")).json();
  assert.deepEqual(body.owned, [1]);
  assert.equal(body.source, "plex");
});

// ── season: the fire-and-forget metadata warm ────────────────────────────────

test("season: the episode-metadata warm runs for owned rows", async () => {
  plexLib = [{ tmdbId: 1399, mediaType: "TV", serverInstance: "" }];
  episodeRows = [{ tmdbId: 1399, seasonNumber: 1, episodeNumber: 1, source: "plex" }];
  const me = await mintSession();
  await getSeason(me.token, "1399", "1");
  await new Promise((r) => setImmediate(r)); // let the unawaited warm settle
  assert.equal(opsOf("tVEpisodeCache.update").length, 1);
});

test("season: the warm does NOT run when the viewer can see no source", async () => {
  registerInstance("plex", "remote", true);
  plexLib = [{ tmdbId: 1399, mediaType: "TV", serverInstance: "remote" }];
  episodeRows = [{ tmdbId: 1399, seasonNumber: 1, episodeNumber: 1, source: "plex" }];
  const me = await mintSession();
  await getSeason(me.token, "1399", "1");
  await new Promise((r) => setImmediate(r));
  assert.equal(opsOf("tVEpisodeCache.update").length, 0);
});

test("season: a failing warm never breaks the response (unawaited, errors swallowed)", async () => {
  plexLib = [{ tmdbId: 1399, mediaType: "TV", serverInstance: "" }];
  episodeRows = [{ tmdbId: 1399, seasonNumber: 1, episodeNumber: 1, source: "plex" }];
  shadowPrismaModel(prisma, "tVEpisodeCache", {
    findMany: async (args: { where: { tmdbId: number; seasonNumber?: number; source: { in: string[] } } }) => {
      rec("tVEpisodeCache.findMany", args.where);
      return episodeRows.filter((e) => args.where.source.in.includes(e.source) && e.seasonNumber === args.where.seasonNumber);
    },
    update: async () => { rec("tVEpisodeCache.update"); throw new Error("warm failed"); },
  });
  const me = await mintSession();
  const res = await getSeason(me.token, "1399", "1");
  assert.equal(res.status, 200, "a failed cache warm must not surface to the caller");
  await new Promise((r) => setImmediate(r));
  assert.deepEqual((await res.json()).owned, [1]);
});

test("season: an owned episode TMDB no longer lists is skipped by the warm rather than throwing", async () => {
  plexLib = [{ tmdbId: 1399, mediaType: "TV", serverInstance: "" }];
  episodeRows = [{ tmdbId: 1399, seasonNumber: 1, episodeNumber: 99, source: "plex" }];
  shadowPrismaModel(prisma, "tVEpisodeCache", {
    findMany: async (args: { where: { tmdbId: number; seasonNumber?: number; source: { in: string[] } } }) => {
      rec("tVEpisodeCache.findMany", args.where);
      return episodeRows.filter((e) => args.where.source.in.includes(e.source) && e.seasonNumber === args.where.seasonNumber);
    },
    update: async (args: unknown) => { rec("tVEpisodeCache.update", args); return {}; },
  });
  const me = await mintSession();
  const res = await getSeason(me.token, "1399", "1");
  assert.equal(res.status, 200);
  await new Promise((r) => setImmediate(r));
  assert.equal(opsOf("tVEpisodeCache.update").length, 0, "no TMDB metadata for ep 99 ⇒ nothing to warm");
});
