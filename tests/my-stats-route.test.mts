// Route-level unit tests for GET /api/play-history/mine/stats — the iOS
// "My Stats" screen's only data source.
//
// The pin here is the POSTER SOURCE for topMedia. `PlayHistory.posterPath` is a
// snapshot taken at finalize time from the title's `movie:/tv:<id>:details`
// TmdbCache row, so it is null for anything nobody had opened in the app before
// they watched it — which is most of a library. Shipping that column raw left
// every "Most watched" row on the phone rendering a placeholder while the web
// /my-stats page (which resolves live through TmdbMediaCore/TmdbCache) showed
// real art. So: the LIVE lookup wins, the stored snapshot is only the fallback,
// and the field stays a raw TMDB path — the client picks its own image size,
// and already-shipped builds are fixed without an app update.
//
// Harness: the watch-history-mine-route idiom — a real signed session JWT over
// the bearer transport (skips UA-fingerprint binding, guardrail 6b) against
// in-memory prisma stubs. getPlayStatsForServerUsers fires a dozen aggregate
// queries; only the topMedia one matters here, so the $queryRawUnsafe stub
// answers that shape and returns [] for the rest (every consumer maps over an
// empty array). No DB, no network.
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";

process.env.TOKEN_ENCRYPTION_KEY = "ab".repeat(32); // prisma.ts pulls in token-crypto
process.env.NEXTAUTH_SECRET = "my-stats-test-secret-0123456789abcdefghij"; // session JWT HMAC
process.env.AUTH_URL = "http://localhost:3000"; // insecure context → unprefixed cookie name
process.env.TRUST_PROXY = "true"; // silence rate-limit's module-load warning
(process.env as Record<string, string | undefined>).NODE_ENV = "test";

// No network, ever.
globalThis.fetch = (() => {
  throw new Error("unexpected network call from my-stats route tests");
}) as unknown as typeof fetch;

console.warn = () => {};
console.error = () => {};

// Dynamic imports so the env/global stubs above precede the module-graph load.
const { NextRequest } = await import("next/server");
const { prisma } = await import("../src/lib/prisma.ts");
const { shadowPrismaModel, shadowPrismaClientMethod } = await import("./_helpers.mts");
const { signSessionJwt } = await import("../src/lib/session-jwt.ts");

// ── in-memory DB state ───────────────────────────────────────────────────────
type TopMediaRow = {
  title: string;
  tmdbId: number | null;
  mediaType: string | null;
  posterPath: string | null; // the PlayHistory snapshot, MAX()'d per group
  count: bigint;
};

const usersById = new Map<string, Record<string, unknown>>();
const authSessions = new Map<string, { sessionId: string; userId: string; expiresAt: Date }>();
const msuRows: { id: string; userId: string | null; source: string; sourceUserId: string }[] = [];
let topMediaRows: TopMediaRow[] = [];
let coreRows: { tmdbId: number; mediaType?: string; posterPath: string | null }[] = [];
let cacheRows: { key: string; data: string }[] = [];
let coreQueries = 0;
let cacheQueries = 0;

shadowPrismaModel(prisma, "authSession", {
  findUnique: async (args: { where: { sessionId: string } }) =>
    authSessions.get(args.where.sessionId) ?? null,
  update: async () => ({}), // lastSeenAt fire-and-forget touch
});

shadowPrismaModel(prisma, "user", {
  findUnique: async (args: { where: { id: string } }) => {
    const u = usersById.get(args.where.id);
    return u ? { ...u } : null;
  },
  update: async () => ({}),
});

// The identity union: { OR: [{ userId }, { source, sourceUserId }, …] }.
shadowPrismaModel(prisma, "mediaServerUser", {
  findMany: async (args: { where: { OR: Record<string, string>[] } }) =>
    msuRows
      .filter((r) =>
        args.where.OR.some((branch) =>
          Object.entries(branch).every(
            ([key, value]) => (r as unknown as Record<string, unknown>)[key] === value,
          ),
        ),
      )
      .map((r) => ({ id: r.id })),
});

shadowPrismaModel(prisma, "playHistory", {
  count: async () => topMediaRows.reduce((s, r) => s + Number(r.count), 0),
  findMany: async () => [], // recentPlays — only lastActiveIso reads it
});

// Only the topMedia aggregate is modelled; the other eleven queries in the
// bundle return [] and their consumers map over nothing.
shadowPrismaClientMethod(prisma, "$queryRawUnsafe", async (sql: string) => {
  if (sql.includes(`MAX("posterPath")`) && sql.includes(`GROUP BY "tmdbId"`)) {
    return topMediaRows;
  }
  return [];
});

shadowPrismaModel(prisma, "tmdbMediaCore", {
  findMany: async (args: { where: { tmdbId: { in: number[] } } }) => {
    coreQueries++;
    return coreRows.filter((r) => args.where.tmdbId.in.includes(r.tmdbId));
  },
});

shadowPrismaModel(prisma, "tmdbCache", {
  findMany: async (args: { where: { key: { in: string[] } } }) => {
    cacheQueries++;
    return cacheRows.filter((r) => args.where.key.in.includes(r.key));
  },
});

// Route handler (imported AFTER every stub is in place).
const { GET: getMyStats } = await import("../src/app/api/play-history/mine/stats/route.ts");

// ── fixtures ─────────────────────────────────────────────────────────────────
let seq = 0;
async function signedInUser(): Promise<string> {
  seq++;
  const userId = `user-${seq}`;
  const sessionId = `sess-${seq}`;
  usersById.set(userId, {
    role: "USER",
    permissions: 0n,
    mediaServer: null,
    sessionsRevokedAt: null,
    passwordChangedAt: null,
    deactivatedAt: null,
    email: `user-${seq}@example.com`,
    plexUserId: null,
    jellyfinUserId: null,
  });
  authSessions.set(sessionId, { sessionId, userId, expiresAt: new Date(Date.now() + 86_400_000) });
  const iat = Math.floor(Date.now() / 1000);
  const token = await signSessionJwt(
    { id: userId, role: "USER", permissions: "0", provider: "credentials", sessionId, expiresAt: iat + 86_400 },
    { expiresInSeconds: 7_200, iat },
  );
  return token;
}

function topMedia(over: Partial<TopMediaRow> = {}): TopMediaRow {
  return {
    title: "Some Title",
    tmdbId: 550,
    mediaType: "MOVIE",
    posterPath: null,
    count: 3n,
    ...over,
  };
}

type StatsBody = {
  linked: boolean;
  stats: { topMedia: { title: string; tmdbId: number | null; posterPath: string | null }[] } | null;
};

async function fetchStats(token: string): Promise<StatsBody> {
  const req = new NextRequest("http://localhost:3000/api/play-history/mine/stats", {
    method: "GET",
    headers: { authorization: `Bearer ${token}`, "x-forwarded-for": "203.0.113.99" },
  });
  const res = await getMyStats(req, { params: Promise.resolve({}) });
  assert.equal(res.status, 200);
  return (await res.json()) as StatsBody;
}

beforeEach(() => {
  msuRows.length = 0;
  topMediaRows = [];
  coreRows = [];
  cacheRows = [];
  coreQueries = 0;
  cacheQueries = 0;
});

// ── tests ────────────────────────────────────────────────────────────────────
test("a null PlayHistory snapshot still ships art from the live TmdbMediaCore row", async () => {
  const token = await signedInUser();
  msuRows.push({ id: "msu-1", userId: "user-1", source: "plex", sourceUserId: "p-1" });
  topMediaRows = [
    topMedia({ tmdbId: 550, title: "Fight Club", posterPath: null }),
    topMedia({ tmdbId: 1399, title: "Thrones", mediaType: "TV", posterPath: null }),
  ];
  coreRows = [
    { tmdbId: 550, posterPath: "/fight-club.jpg" },
    { tmdbId: 1399, mediaType: "TV", posterPath: "/thrones.jpg" },
  ];

  const body = await fetchStats(token);
  assert.equal(body.linked, true);
  // Raw TMDB paths, NOT w342 URLs — the client builds its own image URL.
  assert.deepEqual(
    body.stats!.topMedia.map((m) => m.posterPath),
    ["/fight-club.jpg", "/thrones.jpg"],
  );
});

test("the live path also wins over a STALE snapshot, and the TmdbCache blob backs up the core miss", async () => {
  const token = await signedInUser();
  msuRows.push({ id: "msu-2", userId: "user-2", source: "plex", sourceUserId: "p-2" });
  topMediaRows = [
    topMedia({ tmdbId: 550, posterPath: "/stale-snapshot.jpg" }),
    topMedia({ tmdbId: 603, posterPath: null }),
  ];
  coreRows = [{ tmdbId: 550, posterPath: "/current.jpg" }];
  cacheRows = [{ key: "movie:603:details", data: JSON.stringify({ posterPath: "/matrix.jpg" }) }];

  const body = await fetchStats(token);
  assert.deepEqual(
    body.stats!.topMedia.map((m) => m.posterPath),
    ["/current.jpg", "/matrix.jpg"],
  );
});

test("the stored snapshot is the fallback, and a row with neither source stays null", async () => {
  const token = await signedInUser();
  msuRows.push({ id: "msu-3", userId: "user-3", source: "plex", sourceUserId: "p-3" });
  topMediaRows = [
    topMedia({ tmdbId: 9999, posterPath: "/snapshot-only.jpg" }), // uncached tmdbId
    topMedia({ tmdbId: null, title: "Unmatched", posterPath: "/unmapped-snapshot.jpg" }),
    topMedia({ tmdbId: 4242, title: "No art anywhere", posterPath: null }),
  ];

  const body = await fetchStats(token);
  assert.deepEqual(
    body.stats!.topMedia.map((m) => m.posterPath),
    ["/snapshot-only.jpg", "/unmapped-snapshot.jpg", null],
  );
});

test("no top media ⇒ no poster lookup at all; an unlinked account is stats-free", async () => {
  const linked = await signedInUser();
  msuRows.push({ id: "msu-4", userId: "user-4", source: "plex", sourceUserId: "p-4" });
  const empty = await fetchStats(linked);
  assert.deepEqual(empty.stats!.topMedia, []);
  assert.equal(coreQueries, 0); // resolvePosterPathMap short-circuits on zero ids
  assert.equal(cacheQueries, 0);

  // A user with no MediaServerUser row never reaches the stats bundle.
  const unlinked = await signedInUser();
  const body = await fetchStats(unlinked);
  assert.equal(body.linked, false);
  assert.equal(body.stats, null);
  assert.equal(coreQueries, 0);
});
