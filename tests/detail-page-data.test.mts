// Unit tests for loadDetailPageState (src/lib/detail-page-data.ts) — the one
// loader behind the movie and TV detail pages. It folds what used to be two
// request reads, two queue reads and four flag reads into fewer, named reads,
// so these pin that each piece of page state still comes out of the right
// rows: the main button vs the hero badge vs the 4K button, the 4K gate on
// queue/availability state, the visibility-scoped and narrow library reads,
// the page flags by name, the shared request token, and the logged arr-links
// fallback. In-memory prisma stubs over the real helpers; no DB, no network.
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";

process.env.TOKEN_ENCRYPTION_KEY = "ab".repeat(32); // prisma.ts pulls in token-crypto
process.env.NEXTAUTH_SECRET = "detail-page-data-secret-0123456789abcdef";
process.env.TRUST_PROXY = "true";

globalThis.fetch = (() => {
  throw new Error("unexpected network call from detail-page-data tests");
}) as unknown as typeof fetch;

const { prisma } = await import("../src/lib/prisma.ts");
const { shadowPrismaModel } = await import("./_helpers.mts");
const { loadDetailPageState, allNamed, emptyOnFailure } = await import("../src/lib/detail-page-data.ts");
// The 4K settings are held for a few seconds (four-k-visibility.ts); every
// settings change here must be read fresh.
const { invalidateShow4kVisibilityCache } = await import("../src/lib/four-k-visibility.ts");
const { invalidateFeatureFlagCache } = await import("../src/lib/features.ts");
const { invalidateBlacklistCache } = await import("../src/lib/blacklist.ts");
const { Permission, PRESETS } = await import("../src/lib/permissions.ts");
const { verifyRequestToken } = await import("../src/lib/request-token.ts");
type Session = import("../src/lib/api-auth.ts").SummonarrSession;

// ── fixtures ────────────────────────────────────────────────────────────────
type Where = Record<string, unknown>;
let settings: Record<string, string> = {};
let requests: Array<{ tmdbId: number; mediaType: string; requestedBy: string; arrInstance: string; status: string }> = [];
let plexRows: Array<{ tmdbId: number; mediaType: string; serverInstance: string }> = [];
let jellyfinRows: Array<{ tmdbId: number; mediaType: string; serverInstance: string; communityRating: number | null }> = [];
let wanted: Array<{ service: "radarr" | "sonarr"; tmdbId: number; arrInstance: string }> = [];
let available: Array<{ service: "radarr" | "sonarr"; tmdbId: number; arrInstance: string }> = [];
let failArrLinks = false;
let libraryCalls: Array<{ model: string; args: { where: Where; select?: Record<string, boolean> } }> = [];
let warns: string[] = [];

beforeEach(() => {
  invalidateShow4kVisibilityCache();
  settings = {};
  requests = [];
  plexRows = [];
  jellyfinRows = [];
  wanted = [];
  available = [];
  failArrLinks = false;
  libraryCalls = [];
  warns = [];
  invalidateFeatureFlagCache();
  invalidateBlacklistCache();
});
console.warn = (...args: unknown[]) => {
  warns.push(args.map(String).join(" "));
};

const project = <T extends Record<string, unknown>>(row: T, select?: Record<string, boolean>) =>
  select ? Object.fromEntries(Object.keys(select).map((k) => [k, row[k]])) : row;

// `{ in: [...] }`, `{ not: x }` or a plain value, as the reads under test use them.
function matches(value: unknown, cond: unknown): boolean {
  if (cond === undefined) return true;
  if (cond && typeof cond === "object") {
    const c = cond as { in?: unknown[]; not?: unknown };
    if (c.in) return c.in.includes(value);
    if ("not" in c) return value !== c.not;
  }
  return value === cond;
}
const whereMatches = (row: Record<string, unknown>, where: Where) =>
  Object.entries(where).every(([k, v]) => matches(row[k], v));

shadowPrismaModel(prisma, "setting", {
  findUnique: async ({ where }: { where: { key: string } }) =>
    where.key in settings ? { key: where.key, value: settings[where.key] } : null,
  findMany: async ({ where }: { where: { key: { in: string[] } } }) =>
    where.key.in.filter((k) => k in settings).map((k) => ({ key: k, value: settings[k] })),
});
shadowPrismaModel(prisma, "blacklistItem", { findMany: async () => [] });
shadowPrismaModel(prisma, "user", { findUnique: async () => ({ role: "USER", permissions: null, mediaServerGrants: null, instanceGrants: null }) });
shadowPrismaModel(prisma, "mediaRequest", {
  findMany: async ({ where, select }: { where: Where; select?: Record<string, boolean> }) =>
    requests.filter((r) => whereMatches(r, where)).map((r) => project(r, select)),
});
shadowPrismaModel(prisma, "deletionVote", { findFirst: async () => null });
shadowPrismaModel(prisma, "watchlistItem", { findUnique: async () => null });
shadowPrismaModel(prisma, "hiddenItem", { findUnique: async () => ({ id: "h1" }) });
for (const [model, rows] of [["plexLibraryItem", () => plexRows], ["jellyfinLibraryItem", () => jellyfinRows]] as const) {
  shadowPrismaModel(prisma, model, {
    findFirst: async (args: { where: Where; select?: Record<string, boolean> }) => {
      libraryCalls.push({ model, args });
      const row = (rows() as Array<Record<string, unknown>>).find((r) => whereMatches(r, args.where));
      return row ? project(row, args.select) : null;
    },
  });
}
for (const service of ["radarr", "sonarr"] as const) {
  const arrRows = (list: typeof wanted, where: Where) =>
    list.filter((r) => r.service === service && r.tmdbId === where.tmdbId && matches(r.arrInstance, where.arrInstance));
  shadowPrismaModel(prisma, `${service}WantedItem`, {
    findMany: async ({ where, select }: { where: Where; select?: Record<string, boolean> }) => {
      // arrInstancesForTitle reads every slug (no arrInstance filter).
      if (failArrLinks && where.arrInstance === undefined) throw new Error("wanted cache unreadable");
      return arrRows(wanted, where).map((r) => project(r, select));
    },
  });
  shadowPrismaModel(prisma, `${service}AvailableItem`, {
    findUnique: async ({ where }: { where: { tmdbId_arrInstance: { tmdbId: number; arrInstance: string } } }) =>
      arrRows(available, where.tmdbId_arrInstance)[0] ?? null,
    findMany: async ({ where, select }: { where: Where; select?: Record<string, boolean> }) =>
      arrRows(available, where).map((r) => project(r, select)),
  });
}

const viewer = (permissions: bigint, role = "USER"): Session => ({
  user: { id: "u_1", role, permissions, mediaServer: null, provider: "credentials" },
  sessionId: "sess_1",
});
const USER = viewer(PRESETS.USER);
const ADMIN = viewer(Permission.ADMIN, "ADMIN");
const MOVIE = { id: 550, genreList: [], originalLanguage: "en", originCountryCodes: ["US"] };
const request = (arrInstance: string, status = "PENDING") =>
  ({ tmdbId: 550, mediaType: "MOVIE", requestedBy: "u_1", arrInstance, status });

// ── the merged request read ─────────────────────────────────────────────────
test("a 4K request lights the 4K button only — not the main button or the hero's Requested badge", async () => {
  requests = [request("4k")];
  const state = await loadDetailPageState(USER, MOVIE, "MOVIE");
  assert.equal(state.requested4k, true);
  assert.equal(state.requested, false);
  assert.equal(state.requestedAny, false);
});

test("a default-instance request lights the main button and the badge, not the 4K button", async () => {
  requests = [request("")];
  const state = await loadDetailPageState(USER, MOVIE, "MOVIE");
  assert.equal(state.requested, true);
  assert.equal(state.requestedAny, true);
  assert.equal(state.requested4k, false);
});

test("a DECLINED request counts for nothing, and another viewer's request is not this viewer's", async () => {
  requests = [request("", "DECLINED"), request("4k", "DECLINED"), { ...request(""), requestedBy: "u_2" }];
  const state = await loadDetailPageState(USER, MOVIE, "MOVIE");
  assert.deepEqual([state.requested, state.requestedAny, state.requested4k], [false, false, false]);
});

// ── the 4K gate ─────────────────────────────────────────────────────────────
test("4K queue and availability are withheld until a 4K instance is configured and the viewer may request 4K", async () => {
  wanted = [{ service: "radarr", tmdbId: 550, arrInstance: "" }, { service: "radarr", tmdbId: 550, arrInstance: "4k" }];
  available = [{ service: "radarr", tmdbId: 550, arrInstance: "4k" }];
  const hidden = await loadDetailPageState(USER, MOVIE, "MOVIE");
  assert.equal(hidden.arrPending, true, "the default queue row is read from the same query");
  assert.deepEqual([hidden.show4k, hidden.arr4kPending, hidden.arr4kAvailable], [false, false, false]);

  settings = { radarr4kUrl: "http://radarr4k:7878", radarr4kApiKey: "key", request4kAll: "true" };
  invalidateShow4kVisibilityCache();
  const shown = await loadDetailPageState(USER, MOVIE, "MOVIE");
  assert.deepEqual([shown.show4k, shown.arr4kPending, shown.arr4kAvailable], [true, true, true]);
  assert.equal(shown.arrPending, true);

  // A Sonarr 4K instance says nothing about a movie.
  settings = { sonarr4kUrl: "http://sonarr4k:8989", sonarr4kApiKey: "key", request4kAll: "true" };
  invalidateShow4kVisibilityCache();
  assert.equal((await loadDetailPageState(USER, MOVIE, "MOVIE")).show4k, false);
});

test("a TV title reads Sonarr's queue, not Radarr's", async () => {
  wanted = [{ service: "radarr", tmdbId: 550, arrInstance: "" }];
  assert.equal((await loadDetailPageState(USER, MOVIE, "TV")).arrPending, false);
  wanted = [{ service: "sonarr", tmdbId: 550, arrInstance: "" }];
  assert.equal((await loadDetailPageState(USER, MOVIE, "TV")).arrPending, true);
});

// ── library reads ───────────────────────────────────────────────────────────
test("the library reads are scoped to the visible servers and select no on-disk path", async () => {
  plexRows = [{ tmdbId: 550, mediaType: "MOVIE", serverInstance: "" }];
  jellyfinRows = [{ tmdbId: 550, mediaType: "MOVIE", serverInstance: "", communityRating: 7.25 }];
  const state = await loadDetailPageState(USER, MOVIE, "MOVIE");
  assert.equal(state.plexAvailable, true);
  assert.equal(state.jellyfinAvailable, true);
  assert.equal(state.jellyfinCommunityRating, 7.25);
  const plex = libraryCalls.find((c) => c.model === "plexLibraryItem");
  const jellyfin = libraryCalls.find((c) => c.model === "jellyfinLibraryItem");
  assert.ok(plex && jellyfin);
  assert.deepEqual(plex.args.where.serverInstance, { in: [""] });
  assert.deepEqual(jellyfin.args.where.serverInstance, { in: [""] });
  assert.deepEqual(plex.args.select, { tmdbId: true });
  assert.deepEqual(jellyfin.args.select, { communityRating: true });
});

// ── flags, token, watchlist/hidden ─────────────────────────────────────────
test("each page flag is read by its own name", async () => {
  settings = { "feature.page.votes": "false", "feature.page.issues": "true" };
  const a = await loadDetailPageState(USER, MOVIE, "MOVIE");
  assert.deepEqual([a.votesEnabled, a.issuesEnabled], [false, true]);
  invalidateFeatureFlagCache();
  settings = { "feature.page.votes": "true", "feature.page.issues": "false" };
  const b = await loadDetailPageState(USER, MOVIE, "MOVIE");
  assert.deepEqual([b.votesEnabled, b.issuesEnabled], [true, false]);
  // The integration flags reach the badge visibility.
  invalidateFeatureFlagCache();
  settings = { "feature.integration.plex": "false" };
  const c = await loadDetailPageState(ADMIN, MOVIE, "MOVIE");
  assert.deepEqual([c.showPlex, c.showJellyfin], [false, true]);
});

test("one request token, valid for this title and viewer only", async () => {
  const state = await loadDetailPageState(USER, MOVIE, "MOVIE");
  assert.equal(verifyRequestToken(state.requestToken, 550, "MOVIE", "u_1"), true);
  assert.equal(verifyRequestToken(state.requestToken, 550, "TV", "u_1"), false);
  assert.equal(verifyRequestToken(state.requestToken, 550, "MOVIE", "u_2"), false);
  const tv = await loadDetailPageState(USER, MOVIE, "TV");
  assert.equal(verifyRequestToken(tv.requestToken, 550, "TV", "u_1"), true);
  assert.deepEqual([state.onWatchlist, state.onHidden], [false, true]);
});

// ── admin extras ────────────────────────────────────────────────────────────
test("a failed arr-links read logs one warning under the page's scope and renders without the links", async () => {
  failArrLinks = true;
  settings = { "feature.admin.neverWatched": "false" }; // the chip's own read is not under test
  const movie = await loadDetailPageState(ADMIN, MOVIE, "MOVIE");
  assert.deepEqual(movie.arrLinks, []);
  assert.equal(warns.length, 1, JSON.stringify(warns));
  assert.match(warns[0], /^\[movie-page\] arr-links read failed for 550: wanted cache unreadable$/);

  warns = [];
  const tv = await loadDetailPageState(ADMIN, MOVIE, "TV");
  assert.deepEqual(tv.arrLinks, []);
  assert.equal(warns.length, 1);
  assert.match(warns[0], /^\[tv-page\] arr-links read failed for 550:/);
});

test("arr links are an admin extra: a viewer without ADMIN never reads them", async () => {
  failArrLinks = true; // would warn if read
  const state = await loadDetailPageState(USER, MOVIE, "MOVIE");
  assert.deepEqual(state.arrLinks, []);
  assert.equal(state.neverWatched, null);
  assert.deepEqual(warns, []);
});

// ── helpers ─────────────────────────────────────────────────────────────────
test("allNamed hands back each result under its own name", async () => {
  const out = await allNamed({ a: Promise.resolve(1), b: Promise.resolve("two"), c: Promise.resolve(false) });
  assert.deepEqual(out, { a: 1, b: "two", c: false });
  await assert.rejects(allNamed({ ok: Promise.resolve(1), bad: Promise.reject(new Error("boom")) }), /boom/);
});

test("emptyOnFailure logs the scope, source and id once and degrades to an empty list", async () => {
  const out = await Promise.reject(new Error("TMDB 503")).catch(emptyOnFailure("movie-page", "credits", 550));
  assert.deepEqual(out, []);
  assert.deepEqual(warns, ["[movie-page] credits read failed for 550: TMDB 503"]);
});
