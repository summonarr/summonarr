// Route-level unit tests for GET /api/play-history/mine — the ONLY
// non-admin surface over PlayHistory. The entire point of the route is the
// scope: a signed-in user reads their OWN watch history and nothing else, so
// these tests pin the scoping chokepoint (src/lib/my-watch-history.ts) through
// the real withAuth-wrapped handler:
//
//   1. SCOPE: results come exclusively from the MediaServerUser rows linked to
//      the SESSION user — another user's rows never appear, and soft-deleted
//      (active:false) linked rows stay included (guardrail 28: history
//      surfaces don't filter on `active`). Linkage is the UNION of the
//      explicit userId FK and the caller's own provider identity
//      (User.plexUserId/jellyfinUserId ↔ MediaServerUser (source,
//      sourceUserId)) — a Jellyfin sign-in with no email never FK-links, but
//      their provider subject IS their media-server identity.
//   2. NO USER PIVOT: there is deliberately no userId parameter. Sending
//      ?userId=/&mediaServerUserId= pointing at another user changes nothing.
//   3. UNLINKED ⇒ EMPTY, DB-FREE: an account with no linked MediaServerUser
//      gets { linked:false, items:[] } and PlayHistory is never queried.
//   4. LEAN SELECT: the payload excludes the admin forensics surface
//      (ipAddress, codecs, network fields) even though the rows carry them.
//   5. Filters (mediaType, sanitized search) and the keyset cursor page within
//      the caller's scope; all-time stats ignore filters.
//
// Harness: the sessions-routes idiom — real signed session JWTs (bearer
// transport, which skips the UA-fingerprint binding per guardrail 6b) against
// in-memory authSession/user/mediaServerUser/playHistory prisma stubs. The
// playHistory stub honors `where`/`select`/`orderBy`/`take` via a mini matcher
// so filter + cursor behavior is exercised, not just recorded. No DB, no
// network.
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";

process.env.TOKEN_ENCRYPTION_KEY = "ab".repeat(32); // prisma.ts pulls in token-crypto
process.env.NEXTAUTH_SECRET = "watch-history-test-secret-0123456789abcdef"; // session JWT HMAC
process.env.AUTH_URL = "http://localhost:3000"; // insecure context → unprefixed cookie name
process.env.TRUST_PROXY = "true"; // silence rate-limit's module-load warning
(process.env as Record<string, string | undefined>).NODE_ENV = "test";

// No network, ever.
globalThis.fetch = (() => {
  throw new Error("unexpected network call from watch-history-mine tests");
}) as unknown as typeof fetch;

const warns: string[] = [];
const errors: string[] = [];
console.warn = (...args: unknown[]) => { warns.push(args.map(String).join(" ")); };
console.error = (...args: unknown[]) => { errors.push(args.map(String).join(" ")); };

// Dynamic imports so the env/global stubs above precede the module-graph load.
const { NextRequest } = await import("next/server");
const { prisma } = await import("../src/lib/prisma.ts");
const { shadowPrismaModel } = await import("./_helpers.mts");
const { signSessionJwt } = await import("../src/lib/session-jwt.ts");

// ── recording op log ─────────────────────────────────────────────────────────
type Op = { op: string; args?: unknown };
const ops: Op[] = [];
const rec = (op: string, args?: unknown) => { ops.push({ op, args }); };
function opsOf(name: string): Op[] {
  return ops.filter((o) => o.op === name);
}

// ── in-memory DB state ────────────────────────────────────────────────────────
type DbUser = {
  role: string;
  permissions: bigint;
  mediaServer: string | null;
  sessionsRevokedAt: Date | null;
  passwordChangedAt: Date | null;
  deactivatedAt: Date | null;
  email: string | null;
  notificationEmail: string | null;
  passwordHash: string | null;
  plexUserId: string | null;
  jellyfinUserId: string | null;
};
type MsuRow = { id: string; userId: string | null; active: boolean; source: string; sourceUserId: string };
// Full-width history rows INCLUDING admin-only columns, so the select-trimming
// pin is real: the data is there and must not reach the response.
type HistoryRow = {
  id: string;
  source: string;
  startedAt: Date;
  stoppedAt: Date;
  duration: number;
  playDuration: number;
  watched: boolean;
  completed: boolean;
  mediaServerUserId: string;
  tmdbId: number | null;
  mediaType: "MOVIE" | "TV" | null;
  title: string;
  year: string | null;
  posterPath: string | null;
  seasonNumber: number | null;
  episodeNumber: number | null;
  episodeTitle: string | null;
  platform: string | null;
  player: string | null;
  device: string | null;
  playMethod: string | null;
  ipAddress: string;
  videoCodec: string;
  bitrate: number;
};

const usersById = new Map<string, DbUser>();
const authSessions = new Map<string, { sessionId: string; userId: string; expiresAt: Date }>();
const msuRows: MsuRow[] = [];
const historyRows: HistoryRow[] = [];

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

// Interprets the lib's identity-union query: { OR: [{ userId }, { source,
// sourceUserId }...] }. Each branch is a conjunction of scalar equalities.
shadowPrismaModel(prisma, "mediaServerUser", {
  findMany: async (args: { where: { OR: Record<string, string>[] }; select: unknown }) => {
    rec("mediaServerUser.findMany", args);
    return msuRows
      .filter((r) =>
        args.where.OR.some((branch) =>
          Object.entries(branch).every(
            ([key, value]) => (r as unknown as Record<string, unknown>)[key] === value,
          ),
        ),
      )
      .map((r) => ({ id: r.id }));
  },
});

// Minimal Prisma-where interpreter covering exactly the shapes the lib emits:
// AND arrays, OR arrays, `in` lists, scalar equality, `contains` (insensitive),
// and `lt` on startedAt/id (the keyset cursor).
type Where = Record<string, unknown>;
function matches(row: HistoryRow, where: Where): boolean {
  for (const [key, cond] of Object.entries(where)) {
    if (key === "AND") {
      if (!(cond as Where[]).every((w) => matches(row, w))) return false;
      continue;
    }
    if (key === "OR") {
      if (!(cond as Where[]).some((w) => matches(row, w))) return false;
      continue;
    }
    const value = (row as unknown as Record<string, unknown>)[key];
    if (cond !== null && typeof cond === "object" && !(cond instanceof Date)) {
      const c = cond as { in?: unknown[]; contains?: string; lt?: unknown };
      if ("in" in c) {
        if (!c.in!.includes(value)) return false;
        continue;
      }
      if ("contains" in c) {
        if (typeof value !== "string") return false;
        if (!value.toLowerCase().includes(String(c.contains).toLowerCase())) return false;
        continue;
      }
      if ("lt" in c) {
        if (value instanceof Date && c.lt instanceof Date) {
          if (!(value.getTime() < c.lt.getTime())) return false;
        } else if (!(String(value) < String(c.lt))) {
          return false;
        }
        continue;
      }
      throw new Error(`watch-history test matcher: unsupported condition on ${key}: ${JSON.stringify(cond)}`);
    }
    if (cond instanceof Date) {
      if (!(value instanceof Date) || value.getTime() !== cond.getTime()) return false;
      continue;
    }
    if (value !== cond) return false;
  }
  return true;
}

function sortDesc(a: HistoryRow, b: HistoryRow): number {
  const t = b.startedAt.getTime() - a.startedAt.getTime();
  if (t !== 0) return t;
  return a.id < b.id ? 1 : a.id > b.id ? -1 : 0;
}

function pick(row: HistoryRow, select: Record<string, true>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const key of Object.keys(select)) {
    out[key] = (row as unknown as Record<string, unknown>)[key];
  }
  return out;
}

shadowPrismaModel(prisma, "playHistory", {
  findMany: async (args: { where: Where; select: Record<string, true>; take: number }) => {
    rec("playHistory.findMany", args);
    return historyRows
      .filter((r) => matches(r, args.where))
      .sort(sortDesc)
      .slice(0, args.take)
      .map((r) => pick(r, args.select));
  },
  count: async (args: { where: Where }) => {
    rec("playHistory.count", args);
    return historyRows.filter((r) => matches(r, args.where)).length;
  },
  aggregate: async (args: { where: Where }) => {
    rec("playHistory.aggregate", args);
    const rows = historyRows.filter((r) => matches(r, args.where));
    return {
      _count: { _all: rows.length },
      _sum: { playDuration: rows.reduce((s, r) => s + r.playDuration, 0) || null },
    };
  },
});

// resolvePosterMap backing tables: one core row proves the tmdbId→poster
// mapping; everything else falls through to an empty TmdbCache.
shadowPrismaModel(prisma, "tmdbMediaCore", {
  findMany: async (args: { where: { tmdbId: { in: number[] } } }) => {
    rec("tmdbMediaCore.findMany", args);
    return args.where.tmdbId.in.includes(603)
      ? [{ tmdbId: 603, posterPath: "/matrix.jpg" }]
      : [];
  },
});
shadowPrismaModel(prisma, "tmdbCache", {
  findMany: async () => [],
});

// ── session + seed helpers ───────────────────────────────────────────────────
let seq = 0;
async function mintSession(
  identity: { plexUserId?: string; jellyfinUserId?: string } = {},
): Promise<{ userId: string; token: string }> {
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
    notificationEmail: null,
    passwordHash: null,
    plexUserId: identity.plexUserId ?? null,
    jellyfinUserId: identity.jellyfinUserId ?? null,
  });
  authSessions.set(sessionId, { sessionId, userId, expiresAt: new Date(Date.now() + 86_400_000) });
  const iat = Math.floor(Date.now() / 1000);
  const token = await signSessionJwt(
    { id: userId, role: "USER", permissions: "0", provider: "credentials", sessionId, expiresAt: iat + 86_400 },
    { expiresInSeconds: 7_200, iat },
  );
  return { userId, token };
}

function addMsu(
  id: string,
  userId: string | null,
  active = true,
  over: { source?: string; sourceUserId?: string } = {},
): void {
  msuRows.push({
    id,
    userId,
    active,
    source: over.source ?? "plex",
    sourceUserId: over.sourceUserId ?? `src-${id}`,
  });
}

let rowSeq = 0;
function addPlay(msuId: string, over: Partial<HistoryRow> = {}): HistoryRow {
  rowSeq++;
  const row: HistoryRow = {
    id: `play-${String(rowSeq).padStart(3, "0")}`,
    source: "plex",
    startedAt: new Date(Date.UTC(2026, 5, 1, 12, 0, rowSeq)),
    stoppedAt: new Date(Date.UTC(2026, 5, 1, 14, 0, rowSeq)),
    duration: 7200,
    playDuration: 6000,
    watched: true,
    completed: true,
    mediaServerUserId: msuId,
    tmdbId: null,
    mediaType: "MOVIE",
    title: `Title ${rowSeq}`,
    year: "2020",
    posterPath: null,
    seasonNumber: null,
    episodeNumber: null,
    episodeTitle: null,
    platform: "Apple TV",
    player: "Living Room",
    device: "tvOS",
    playMethod: "DirectPlay",
    ipAddress: "203.0.113.50",
    videoCodec: "hevc",
    bitrate: 12000,
    ...over,
  };
  historyRows.push(row);
  return row;
}

type Req = InstanceType<typeof NextRequest>;
function mineReq(token: string | null, query: Record<string, string> = {}): Req {
  const qs = new URLSearchParams(query).toString();
  return new NextRequest(`http://localhost:3000/api/play-history/mine${qs ? `?${qs}` : ""}`, {
    method: "GET",
    headers: {
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      "x-forwarded-for": "203.0.113.99",
    },
  });
}

// Route handler (imported AFTER every stub is in place).
const { GET: getMine } = await import("../src/app/api/play-history/mine/route.ts");

interface MineItem {
  id: string;
  title: string;
  posterUrl: string | null;
  [key: string]: unknown;
}
interface MineBody {
  linked: boolean;
  items: MineItem[];
  total: number;
  nextCursor: string | null;
  pageSize: number;
  stats: { plays: number; playSeconds: number };
}
async function fetchMine(token: string | null, query: Record<string, string> = {}): Promise<{ status: number; body: MineBody }> {
  const res = await getMine(mineReq(token, query), undefined);
  return { status: res.status, body: (await res.json()) as MineBody };
}

beforeEach(() => {
  ops.length = 0;
  warns.length = 0;
  errors.length = 0;
  msuRows.length = 0;
  historyRows.length = 0;
});

// ── tests ────────────────────────────────────────────────────────────────────

test("unauthenticated request is 401 and never touches PlayHistory", async () => {
  const res = await getMine(mineReq(null), undefined);
  assert.equal(res.status, 401);
  assert.equal(opsOf("playHistory.findMany").length, 0);
  assert.equal(opsOf("mediaServerUser.findMany").length, 0);
});

test("returns ONLY the caller's linked history — other users' rows never appear, inactive links included", async () => {
  const alice = await mintSession();
  const bob = await mintSession();
  addMsu("msu-a1", alice.userId, true);
  addMsu("msu-a2", alice.userId, false); // soft-deleted server user — history must survive (guardrail 28)
  addMsu("msu-b1", bob.userId, true);
  const a1 = addPlay("msu-a1", { tmdbId: 603, title: "The MATRIX", playDuration: 6000 });
  const a2 = addPlay("msu-a1", { mediaType: "TV", title: "Severance", seasonNumber: 1, episodeNumber: 2, episodeTitle: "Half Loop", playDuration: 3000 });
  const a3 = addPlay("msu-a2", { source: "jellyfin", title: "Old Watch", playDuration: 1500 });
  addPlay("msu-b1", { title: "Bob Secret Movie" });

  const { status, body } = await fetchMine(alice.token);
  assert.equal(status, 200);
  assert.equal(body.linked, true);
  assert.deepEqual(
    new Set(body.items.map((i) => i.id)),
    new Set([a1.id, a2.id, a3.id]),
  );
  assert.ok(!body.items.some((i) => i.title === "Bob Secret Movie"));
  assert.equal(body.total, 3);
  // All-time stats are scoped the same way.
  assert.equal(body.stats.plays, 3);
  assert.equal(body.stats.playSeconds, 6000 + 3000 + 1500);

  // Structural pin: linkage was resolved for the SESSION user (FK branch of
  // the identity union), and the history where-clause is the linked-id set
  // (not a caller-supplied value).
  const msuCall = opsOf("mediaServerUser.findMany")[0]!.args as { where: { OR: { userId?: string }[] } };
  assert.deepEqual(msuCall.where.OR, [{ userId: alice.userId }]);
  const phCall = opsOf("playHistory.findMany")[0]!.args as { where: { mediaServerUserId?: { in: string[] } } };
  assert.deepEqual(new Set(phCall.where.mediaServerUserId?.in), new Set(["msu-a1", "msu-a2"]));
});

test("userId-shaped query params are ignored — no parameter can widen the scope", async () => {
  const alice = await mintSession();
  const bob = await mintSession();
  addMsu("msu-a1", alice.userId);
  addMsu("msu-b1", bob.userId);
  const mine = addPlay("msu-a1", { title: "Mine" });
  addPlay("msu-b1", { title: "Bob Secret Movie" });

  const { status, body } = await fetchMine(alice.token, {
    userId: "msu-b1",
    mediaServerUserId: "msu-b1",
    user: bob.userId,
  });
  assert.equal(status, 200);
  assert.deepEqual(body.items.map((i) => i.id), [mine.id]);
  assert.ok(!body.items.some((i) => i.title === "Bob Secret Movie"));
});

test("unlinked account gets linked:false and PlayHistory is never queried", async () => {
  const carol = await mintSession();
  addPlay("msu-someone-else", { title: "Not Carol's" });

  const { status, body } = await fetchMine(carol.token);
  assert.equal(status, 200);
  assert.equal(body.linked, false);
  assert.deepEqual(body.items, []);
  assert.equal(body.total, 0);
  assert.deepEqual(body.stats, { plays: 0, playSeconds: 0 });
  assert.equal(opsOf("playHistory.findMany").length, 0);
  assert.equal(opsOf("playHistory.count").length, 0);
  assert.equal(opsOf("playHistory.aggregate").length, 0);
});

test("a Jellyfin sign-in sees history for its provider identity even with no FK link (no-email accounts)", async () => {
  // jf-alice signed in via Jellyfin: User.jellyfinUserId is bound, but the
  // MediaServerUser row was created by the poller with NO email → userId FK
  // never linked. The provider-identity branch of the union must still scope
  // her rows in — and never anyone else's.
  const jfAlice = await mintSession({ jellyfinUserId: "jf-uuid-alice" });
  await mintSession({ jellyfinUserId: "jf-uuid-bob" }); // bob exists; his identity must not bleed
  addMsu("msu-jf-alice", null, true, { source: "jellyfin", sourceUserId: "jf-uuid-alice" });
  addMsu("msu-jf-bob", null, true, { source: "jellyfin", sourceUserId: "jf-uuid-bob" });
  // Same sourceUserId string on the WRONG source must not match either.
  addMsu("msu-plex-decoy", null, true, { source: "plex", sourceUserId: "jf-uuid-alice" });
  const mine = addPlay("msu-jf-alice", { source: "jellyfin", title: "Jellyfin Watch" });
  addPlay("msu-jf-bob", { source: "jellyfin", title: "Bob Jellyfin Watch" });
  addPlay("msu-plex-decoy", { title: "Decoy Plex Watch" });

  const { status, body } = await fetchMine(jfAlice.token);
  assert.equal(status, 200);
  assert.equal(body.linked, true);
  assert.deepEqual(body.items.map((i) => i.id), [mine.id]);
});

test("a Plex sign-in unions its provider identity with FK-linked rows, deduplicated", async () => {
  const alice = await mintSession({ plexUserId: "11111" });
  // One row linked BOTH ways (FK + identity), one FK-only, one identity-only.
  addMsu("msu-both", alice.userId, true, { source: "plex", sourceUserId: "11111" });
  addMsu("msu-fk-only", alice.userId, true, { source: "jellyfin", sourceUserId: "jf-other" });
  const both = addPlay("msu-both", { title: "Both Paths" });
  const fkOnly = addPlay("msu-fk-only", { source: "jellyfin", title: "FK Only" });

  const { body } = await fetchMine(alice.token);
  assert.deepEqual(new Set(body.items.map((i) => i.id)), new Set([both.id, fkOnly.id]));
  assert.equal(body.total, 2);
  assert.equal(body.stats.plays, 2);
});

test("payload is the lean self-view: admin forensics columns never serialize; posters resolve by tmdbId", async () => {
  const alice = await mintSession();
  addMsu("msu-a1", alice.userId);
  addPlay("msu-a1", { tmdbId: 603, title: "The MATRIX", posterPath: "/matrix-row.jpg" });

  const { body } = await fetchMine(alice.token);
  const item = body.items[0]!;
  for (const leaked of ["ipAddress", "videoCodec", "bitrate", "mediaServerUserId", "sourceSessionId"]) {
    assert.ok(!(leaked in item), `expected ${leaked} to be excluded from the self view`);
  }
  assert.equal(item.title, "The MATRIX");
  assert.equal(item.posterUrl, "https://image.tmdb.org/t/p/w342/matrix.jpg");
  // The row's raw TMDB path rides along for native clients, which build their
  // own image URLs at smaller sizes than the web's w342 posterUrl.
  assert.equal(item.posterPath, "/matrix-row.jpg");
  assert.equal(typeof item.startedAt, "string"); // ISO-serialized for the client
});

test("mediaType filter narrows items but all-time stats ignore it", async () => {
  const alice = await mintSession();
  addMsu("msu-a1", alice.userId);
  addPlay("msu-a1", { mediaType: "MOVIE", title: "A Movie", playDuration: 100 });
  const tv = addPlay("msu-a1", { mediaType: "TV", title: "A Show", playDuration: 200 });

  const { body } = await fetchMine(alice.token, { mediaType: "TV" });
  assert.deepEqual(body.items.map((i) => i.id), [tv.id]);
  assert.equal(body.total, 1);
  assert.equal(body.stats.plays, 2);
  assert.equal(body.stats.playSeconds, 300);
});

test("search matches title/episode case-insensitively with LIKE metacharacters stripped", async () => {
  const alice = await mintSession();
  addMsu("msu-a1", alice.userId);
  const movie = addPlay("msu-a1", { title: "The MATRIX" });
  const ep = addPlay("msu-a1", { mediaType: "TV", title: "Severance", episodeTitle: "The Matrix Within" });
  addPlay("msu-a1", { title: "Unrelated" });

  // "ma%trix" — the `%` wildcard is stripped, leaving a literal "matrix" match.
  const { body } = await fetchMine(alice.token, { search: "ma%trix" });
  assert.deepEqual(
    new Set(body.items.map((i) => i.id)),
    new Set([movie.id, ep.id]),
  );
});

test("keyset cursor pages the caller's history without overlap (same-timestamp id tiebreak)", async () => {
  const alice = await mintSession();
  addMsu("msu-a1", alice.userId);
  const sameInstant = new Date(Date.UTC(2026, 5, 10, 20, 0, 0));
  for (let i = 0; i < 31; i++) {
    addPlay("msu-a1", { startedAt: sameInstant, stoppedAt: new Date(sameInstant.getTime() + 3_600_000) });
  }

  const first = await fetchMine(alice.token);
  assert.equal(first.body.items.length, 30);
  assert.equal(first.body.total, 31);
  assert.ok(first.body.nextCursor, "expected a cursor for the next page");

  const second = await fetchMine(alice.token, { cursor: first.body.nextCursor! });
  assert.equal(second.body.items.length, 1);
  assert.equal(second.body.nextCursor, null);

  const seen = new Set(first.body.items.map((i) => i.id));
  for (const item of second.body.items) {
    assert.ok(!seen.has(item.id), `row ${item.id} appeared on both pages`);
  }
  assert.equal(seen.size + second.body.items.length, 31);
});

test("a malformed cursor fails soft to the first page", async () => {
  const alice = await mintSession();
  addMsu("msu-a1", alice.userId);
  const row = addPlay("msu-a1");

  const { status, body } = await fetchMine(alice.token, { cursor: "not|a-real-cursor|at-all" });
  assert.equal(status, 200);
  assert.deepEqual(body.items.map((i) => i.id), [row.id]);
});
