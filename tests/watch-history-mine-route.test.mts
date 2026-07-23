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
//   5. CONSOLIDATION: repeat plays of the same movie/episode collapse into one
//      entry (latest play + playCount/totalPlaySeconds, group-wide watched),
//      keyed by tmdb identity → sourceItemId → per-row; distinct unmatched
//      titles never merge just because their ids are null.
//   6. Filters (mediaType, ILIKE-escaped literal search) and the keyset cursor
//      page within the caller's scope; all-time stats ignore both filters AND
//      consolidation (raw play counts).
//
// Harness: the sessions-routes idiom — real signed session JWTs (bearer
// transport, which skips the UA-fingerprint binding per guardrail 6b) against
// in-memory prisma stubs. The lib's grouped page/count queries are raw SQL
// ($queryRawUnsafe), so the stub is a JS MIRROR of the query contract: it
// parses the bind positions out of the SQL shape (IN list, CAST, ILIKE,
// cursor, LIMIT) and evaluates scoping/filtering/grouping over the in-memory
// rows. That keeps these tests behavioral for the wire contract; the SQL
// itself is proven against a real Postgres in live verification, not here.
// No DB, no network.
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
const { shadowPrismaModel, shadowPrismaClientMethod } = await import("./_helpers.mts");
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
  sourceItemId: string | null;
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

// Structured-where matcher for the Prisma queries the lib issues (the list
// path's stats aggregate + the entry-detail findFirst/findMany/aggregate):
// AND arrays, `in` lists, and scalar/null equality — Prisma translates a null
// equality to IS NULL, which plain `===` mirrors here.
type PWhere = Record<string, unknown>;
function rowMatches(row: HistoryRow, where: PWhere): boolean {
  for (const [key, cond] of Object.entries(where)) {
    if (key === "AND") {
      if (!(cond as PWhere[]).every((w) => rowMatches(row, w))) return false;
      continue;
    }
    const value = (row as unknown as Record<string, unknown>)[key];
    if (cond !== null && typeof cond === "object" && !(cond instanceof Date)) {
      const c = cond as { in?: unknown[] };
      if ("in" in c) {
        if (!c.in!.includes(value)) return false;
        continue;
      }
      throw new Error(`watch-history test matcher: unsupported condition on ${key}: ${JSON.stringify(cond)}`);
    }
    if (value !== cond) return false;
  }
  return true;
}

function pickSelect(row: HistoryRow, select: Record<string, true>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const key of Object.keys(select)) {
    out[key] = (row as unknown as Record<string, unknown>)[key];
  }
  return out;
}

// The list path's grouped page/count ride $queryRawUnsafe (mirrored below);
// these delegate methods serve the stats aggregate + the entry-detail queries.
// count is deliberately NOT stubbed — a regression to Prisma count throws
// loudly instead of hanging on a real DB.
shadowPrismaModel(prisma, "playHistory", {
  findFirst: async (args: { where: PWhere; select: Record<string, true> }) => {
    rec("playHistory.findFirst", args);
    const row = historyRows.find((r) => rowMatches(r, args.where));
    return row ? pickSelect(row, args.select) : null;
  },
  findMany: async (args: { where: PWhere; select: Record<string, true>; take: number }) => {
    rec("playHistory.findMany", args);
    return historyRows
      .filter((r) => rowMatches(r, args.where))
      .sort(repSortDesc)
      .slice(0, args.take)
      .map((r) => pickSelect(r, args.select));
  },
  aggregate: async (args: { where: PWhere }) => {
    rec("playHistory.aggregate", args);
    const rows = historyRows.filter((r) => rowMatches(r, args.where));
    const times = rows.map((r) => r.startedAt.getTime());
    return {
      _count: { _all: rows.length },
      _sum: { playDuration: rows.reduce((s, r) => s + r.playDuration, 0) || null },
      _min: { startedAt: times.length ? new Date(Math.min(...times)) : null },
      _max: { startedAt: times.length ? new Date(Math.max(...times)) : null },
    };
  },
});

// ── raw-SQL mirror ───────────────────────────────────────────────────────────
// Evaluates the grouped page/count queries over the in-memory rows by parsing
// bind positions out of the SQL shape the lib emits. Mirrors the identity
// ladder exactly; divergence between this mirror and the real SQL is what the
// live-Postgres verification exists to catch.

function groupKey(r: HistoryRow): string {
  if (r.tmdbId != null) {
    return `tmdb:${r.tmdbId}:${r.mediaType ?? ""}:${r.seasonNumber ?? -1}:${r.episodeNumber ?? -1}`;
  }
  if (r.sourceItemId != null) return `item:${r.source}:${r.sourceItemId}`;
  return `row:${r.id}`;
}

function repSortDesc(a: { startedAt: Date; id: string }, b: { startedAt: Date; id: string }): number {
  const t = b.startedAt.getTime() - a.startedAt.getTime();
  if (t !== 0) return t;
  return a.id < b.id ? 1 : a.id > b.id ? -1 : 0;
}

// The page query's SELECT list — the lean self-view columns.
function lean(r: HistoryRow) {
  return {
    id: r.id, source: r.source, startedAt: r.startedAt, stoppedAt: r.stoppedAt,
    duration: r.duration, playDuration: r.playDuration, tmdbId: r.tmdbId,
    mediaType: r.mediaType, title: r.title, year: r.year, posterPath: r.posterPath,
    seasonNumber: r.seasonNumber, episodeNumber: r.episodeNumber,
    episodeTitle: r.episodeTitle, platform: r.platform, player: r.player,
    device: r.device, playMethod: r.playMethod,
  };
}

function filteredRows(sql: string, binds: unknown[]): HistoryRow[] {
  const inMatch = sql.match(/"mediaServerUserId" IN \(([^)]*)\)/);
  assert.ok(inMatch, "page/count SQL must scope by mediaServerUserId IN (…)");
  const idCount = (inMatch![1]!.match(/\$\d+/g) ?? []).length;
  const msuIds = binds.slice(0, idCount) as string[];
  let rows = historyRows.filter((r) => msuIds.includes(r.mediaServerUserId));

  const castMatch = sql.match(/"mediaType" = CAST\(\$(\d+) AS "MediaType"\)/);
  if (castMatch) {
    const want = binds[Number(castMatch[1]) - 1];
    rows = rows.filter((r) => r.mediaType === want);
  }
  const ilikeMatch = sql.match(/ILIKE \$(\d+) ESCAPE/);
  if (ilikeMatch) {
    const pattern = binds[Number(ilikeMatch[1]) - 1] as string; // "%<escaped>%"
    const needle = pattern.slice(1, -1).replace(/\\([\\%_])/g, "$1").toLowerCase();
    rows = rows.filter(
      (r) =>
        r.title.toLowerCase().includes(needle) ||
        (r.episodeTitle ?? "").toLowerCase().includes(needle),
    );
  }
  return rows;
}

function groupedReps(rows: HistoryRow[]) {
  const groups = new Map<string, HistoryRow[]>();
  for (const r of rows) {
    const k = groupKey(r);
    const bucket = groups.get(k);
    if (bucket) bucket.push(r);
    else groups.set(k, [r]);
  }
  return [...groups.values()].map((g) => {
    const rep = [...g].sort(repSortDesc)[0]!;
    return {
      ...lean(rep),
      play_count: g.length,
      total_play_duration: g.reduce((s, r) => s + r.playDuration, 0),
      group_watched: g.some((r) => r.watched),
      group_completed: g.some((r) => r.completed),
    };
  });
}

shadowPrismaClientMethod(prisma, "$queryRawUnsafe", async (sql: string, ...binds: unknown[]) => {
  rec("$queryRawUnsafe", { sql, binds });
  if (sql.includes("COUNT(DISTINCT")) {
    const keys = new Set(filteredRows(sql, binds).map(groupKey));
    return [{ total: keys.size }];
  }
  let reps = groupedReps(filteredRows(sql, binds));
  const cursorMatch = sql.match(/"startedAt" < \$(\d+)/);
  if (cursorMatch) {
    const at = binds[Number(cursorMatch[1]) - 1] as Date;
    const cid = binds[Number(cursorMatch[1])] as string;
    reps = reps.filter(
      (r) =>
        r.startedAt.getTime() < at.getTime() ||
        (r.startedAt.getTime() === at.getTime() && r.id < cid),
    );
  }
  const limitMatch = sql.match(/LIMIT \$(\d+)/);
  assert.ok(limitMatch, "page SQL must carry a bound LIMIT");
  const limit = binds[Number(limitMatch![1]) - 1] as number;
  return reps.sort(repSortDesc).slice(0, limit);
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
    sourceItemId: null,
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

// Route handlers (imported AFTER every stub is in place).
const { GET: getMine } = await import("../src/app/api/play-history/mine/route.ts");
const { GET: getMineEntry } = await import("../src/app/api/play-history/mine/[id]/route.ts");

interface MineItem {
  id: string;
  title: string;
  posterUrl: string | null;
  playCount: number;
  totalPlaySeconds: number;
  watched: boolean;
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

interface EntryBody {
  item: MineItem;
  plays: { id: string; playDuration: number; [key: string]: unknown }[];
  firstStartedAt: string;
  lastStartedAt: string;
}
async function fetchEntry(token: string | null, id: string): Promise<{ status: number; body: EntryBody }> {
  const req = new NextRequest(`http://localhost:3000/api/play-history/mine/${id}`, {
    method: "GET",
    headers: {
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      "x-forwarded-for": "203.0.113.99",
    },
  });
  const res = await getMineEntry(req, { params: Promise.resolve({ id }) });
  return { status: res.status, body: (await res.json()) as EntryBody };
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
  assert.equal(opsOf("$queryRawUnsafe").length, 0);
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

  // Structural pins: linkage was resolved for the SESSION user (FK branch of
  // the identity union), and the raw page query's scope binds are exactly the
  // linked-id set (not a caller-supplied value).
  const msuCall = opsOf("mediaServerUser.findMany")[0]!.args as { where: { OR: { userId?: string }[] } };
  assert.deepEqual(msuCall.where.OR, [{ userId: alice.userId }]);
  const raw = opsOf("$queryRawUnsafe")[0]!.args as { binds: unknown[] };
  assert.deepEqual(new Set(raw.binds.slice(0, 2)), new Set(["msu-a1", "msu-a2"]));
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
  // The scope bind is still alice's linked id — nothing from the query string.
  const raw = opsOf("$queryRawUnsafe")[0]!.args as { binds: unknown[] };
  assert.equal(raw.binds[0], "msu-a1");
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
  assert.equal(opsOf("$queryRawUnsafe").length, 0);
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
  for (const leaked of ["ipAddress", "videoCodec", "bitrate", "mediaServerUserId", "sourceSessionId", "sourceItemId"]) {
    assert.ok(!(leaked in item), `expected ${leaked} to be excluded from the self view`);
  }
  assert.equal(item.title, "The MATRIX");
  assert.equal(item.posterUrl, "https://image.tmdb.org/t/p/w342/matrix.jpg");
  // The row's raw TMDB path rides along for native clients, which build their
  // own image URLs at smaller sizes than the web's w342 posterUrl.
  assert.equal(item.posterPath, "/matrix-row.jpg");
  assert.equal(typeof item.startedAt, "string"); // ISO-serialized for the client
  // The page SQL itself must never select the forensics columns.
  const sql = (opsOf("$queryRawUnsafe")[0]!.args as { sql: string }).sql;
  for (const col of ["ipAddress", "videoCodec", "bitrate", "location", "bandwidth"]) {
    assert.ok(!sql.includes(`"${col}"`), `page SQL must not select ${col}`);
  }
});

test("repeat plays of the same episode/movie consolidate into one entry with aggregates", async () => {
  const alice = await mintSession();
  addMsu("msu-a1", alice.userId);
  // Same episode three times (two partial, one watched) — latest is play 3.
  addPlay("msu-a1", { tmdbId: 95396, mediaType: "TV", title: "Severance", seasonNumber: 1, episodeNumber: 2, episodeTitle: "Half Loop", playDuration: 1000, watched: false, completed: false });
  addPlay("msu-a1", { tmdbId: 95396, mediaType: "TV", title: "Severance", seasonNumber: 1, episodeNumber: 2, episodeTitle: "Half Loop", playDuration: 2000, watched: true, completed: true });
  const epLatest = addPlay("msu-a1", { tmdbId: 95396, mediaType: "TV", title: "Severance", seasonNumber: 1, episodeNumber: 2, episodeTitle: "Half Loop", playDuration: 500, watched: false, completed: false, platform: "iOS" });
  // A DIFFERENT episode of the same show must stay its own entry.
  const otherEp = addPlay("msu-a1", { tmdbId: 95396, mediaType: "TV", title: "Severance", seasonNumber: 1, episodeNumber: 3, playDuration: 3000 });
  // Same movie twice.
  addPlay("msu-a1", { tmdbId: 603, title: "The Matrix", playDuration: 4000 });
  const movieLatest = addPlay("msu-a1", { tmdbId: 603, title: "The Matrix", playDuration: 4500 });

  const { body } = await fetchMine(alice.token);
  assert.equal(body.items.length, 3);
  assert.equal(body.total, 3);

  const ep = body.items.find((i) => i.id === epLatest.id)!;
  assert.ok(ep, "episode entry must be represented by its LATEST play");
  assert.equal(ep.playCount, 3);
  assert.equal(ep.totalPlaySeconds, 1000 + 2000 + 500);
  // Group-wide watched: one qualifying play marks the consolidated entry.
  assert.equal(ep.watched, true);

  const movie = body.items.find((i) => i.id === movieLatest.id)!;
  assert.equal(movie.playCount, 2);
  assert.equal(movie.totalPlaySeconds, 8500);

  const single = body.items.find((i) => i.id === otherEp.id)!;
  assert.equal(single.playCount, 1);

  // Consolidation never inflates the all-time totals: stats stay RAW plays.
  assert.equal(body.stats.plays, 6);
});

test("unmatched rows consolidate by library item, and distinct unmatched titles never merge", async () => {
  const alice = await mintSession();
  addMsu("msu-a1", alice.userId);
  // No tmdbId, same source item → one entry.
  addPlay("msu-a1", { title: "Home Video", sourceItemId: "plex-item-9", playDuration: 100 });
  const itemLatest = addPlay("msu-a1", { title: "Home Video", sourceItemId: "plex-item-9", playDuration: 200 });
  // No tmdbId, no sourceItemId — two different titles must stay two entries.
  const loose1 = addPlay("msu-a1", { title: "Loose Row A" });
  const loose2 = addPlay("msu-a1", { title: "Loose Row B" });

  const { body } = await fetchMine(alice.token);
  assert.equal(body.items.length, 3);
  const item = body.items.find((i) => i.id === itemLatest.id)!;
  assert.equal(item.playCount, 2);
  assert.equal(item.totalPlaySeconds, 300);
  assert.ok(body.items.some((i) => i.id === loose1.id));
  assert.ok(body.items.some((i) => i.id === loose2.id));
});

test("mediaType filter narrows entries but all-time stats ignore it", async () => {
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

test("search matches title/episode case-insensitively; LIKE metacharacters are LITERAL, not wildcards", async () => {
  const alice = await mintSession();
  addMsu("msu-a1", alice.userId);
  const movie = addPlay("msu-a1", { title: "The MATRIX" });
  const ep = addPlay("msu-a1", { mediaType: "TV", title: "Severance", episodeTitle: "The Matrix Within" });
  const literal = addPlay("msu-a1", { title: "100% Wolf" });
  addPlay("msu-a1", { title: "Unrelated" });

  const plain = await fetchMine(alice.token, { search: "matrix" });
  assert.deepEqual(
    new Set(plain.body.items.map((i) => i.id)),
    new Set([movie.id, ep.id]),
  );

  // "ma%trix" carries a LITERAL percent — escaped, so it matches nothing
  // (rather than acting as a wildcard bridging "ma…trix").
  const wildcard = await fetchMine(alice.token, { search: "ma%trix" });
  assert.deepEqual(wildcard.body.items, []);
  // …and a literal % still finds titles that actually contain one.
  const percent = await fetchMine(alice.token, { search: "100%" });
  assert.deepEqual(percent.body.items.map((i) => i.id), [literal.id]);
  // The bind itself must be the escaped pattern, ready for ESCAPE '\'.
  const lastRaw = opsOf("$queryRawUnsafe").at(-2)!.args as { binds: unknown[] };
  assert.ok(lastRaw.binds.includes("%100\\%%"), "search bind must be ILIKE-escaped");
});

test("keyset cursor pages the caller's entries without overlap (same-timestamp id tiebreak)", async () => {
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

// ── entry detail (GET /api/play-history/mine/[id]) ───────────────────────────

test("entry detail expands the whole group from ANY play id; foreign rows 404 like missing ones", async () => {
  const alice = await mintSession();
  const bob = await mintSession();
  addMsu("msu-a1", alice.userId);
  addMsu("msu-b1", bob.userId);
  const p1 = addPlay("msu-a1", { tmdbId: 95396, mediaType: "TV", title: "Severance", seasonNumber: 1, episodeNumber: 2, playDuration: 1000, watched: false, completed: false, platform: "tvOS" });
  const p2 = addPlay("msu-a1", { tmdbId: 95396, mediaType: "TV", title: "Severance", seasonNumber: 1, episodeNumber: 2, playDuration: 2000, watched: true, completed: true, platform: "iOS" });
  const p3 = addPlay("msu-a1", { tmdbId: 95396, mediaType: "TV", title: "Severance", seasonNumber: 1, episodeNumber: 2, playDuration: 500, watched: false, completed: false, platform: "Chrome" });
  // Neighbours that must NOT leak into the group: a different episode, and
  // BOB's play of the very same episode.
  addPlay("msu-a1", { tmdbId: 95396, mediaType: "TV", title: "Severance", seasonNumber: 1, episodeNumber: 3 });
  addPlay("msu-b1", { tmdbId: 95396, mediaType: "TV", title: "Severance", seasonNumber: 1, episodeNumber: 2 });

  // Anchor by an OLDER play's id — the contract is "any play id in the entry".
  const { status, body } = await fetchEntry(alice.token, p1.id);
  assert.equal(status, 200);
  assert.deepEqual(body.plays.map((p) => p.id), [p3.id, p2.id, p1.id]); // newest first
  assert.equal(body.item.id, p3.id); // representative = latest play
  assert.equal(body.item.playCount, 3);
  assert.equal(body.item.totalPlaySeconds, 3500);
  assert.equal(body.item.watched, true); // group-wide bool
  assert.equal(body.firstStartedAt, p1.startedAt.toISOString());
  assert.equal(body.lastStartedAt, p3.startedAt.toISOString());
  // Per-play payload stays lean.
  for (const leaked of ["ipAddress", "videoCodec", "bitrate", "mediaServerUserId"]) {
    assert.ok(!(leaked in body.plays[0]!), `expected ${leaked} to be excluded from plays`);
  }

  // Bob probing alice's row id gets a 404 indistinguishable from a bad id.
  const foreign = await fetchEntry(bob.token, p1.id);
  assert.equal(foreign.status, 404);
  const missing = await fetchEntry(alice.token, "no-such-row");
  assert.equal(missing.status, 404);
  // Unauthenticated is 401 before any lookup.
  const unauth = await fetchEntry(null, p1.id);
  assert.equal(unauth.status, 401);
});

test("entry detail groups unmatched rows by library item, and a bare row stands alone", async () => {
  const alice = await mintSession();
  addMsu("msu-a1", alice.userId);
  const i1 = addPlay("msu-a1", { title: "Home Video", sourceItemId: "jf-item-9", playDuration: 100 });
  const i2 = addPlay("msu-a1", { title: "Home Video", sourceItemId: "jf-item-9", playDuration: 200 });
  const loose = addPlay("msu-a1", { title: "Loose Row" });

  const grouped = await fetchEntry(alice.token, i1.id);
  assert.equal(grouped.status, 200);
  assert.deepEqual(new Set(grouped.body.plays.map((p) => p.id)), new Set([i1.id, i2.id]));
  assert.equal(grouped.body.item.playCount, 2);
  assert.equal(grouped.body.item.totalPlaySeconds, 300);

  const single = await fetchEntry(alice.token, loose.id);
  assert.equal(single.status, 200);
  assert.deepEqual(single.body.plays.map((p) => p.id), [loose.id]);
  assert.equal(single.body.item.playCount, 1);
});
