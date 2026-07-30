// Unit tests for the three functions in src/lib/my-watch-history.ts that
// tests/watch-history-mine-route.test.mts does NOT reach — it exercises
// getMyWatchHistory through GET /api/play-history/mine, leaving the entry
// detail, the personal stats bundle and Wrapped uncovered — plus the shared
// scope resolver itself, tested directly rather than through a route.
//
// What matters here is that all four functions share ONE chokepoint,
// resolveLinkedMediaServerUserIds: it decides whose PlayHistory a caller can
// read, and every one of them is a self-service surface with deliberately NO
// userId parameter. So the tests below pin, per function:
//
//   1. SCOPE. The linked set is the UNION of the explicit MediaServerUser.userId
//      FK and the caller's OWN provider subject (User.plexUserId /
//      jellyfinUserId ↔ MediaServerUser (source, sourceUserId)) — guardrail 34's
//      "subject first, email second" applied to the read side. A local-credentials
//      or OIDC account has no provider subject at all, so the FK is its ONLY
//      route to its own history; a Jellyfin account often has no email, so the
//      subject is ITS only route. Dropping either branch silently empties one
//      whole class of account's history page.
//   2. UNLINKED ⇒ EMPTY, AND CHEAP. Zero linked ids must short-circuit BEFORE any
//      PlayHistory query — an unscoped read here is the whole-table leak this
//      module exists to prevent, so the op log asserts the query never happens.
//   3. FOREIGN ROWS ARE INDISTINGUISHABLE FROM MISSING ONES. getMyWatchHistoryEntry
//      takes a client-supplied row id; another user's id must return null (→404),
//      not that row, and not a distinguishable error.
//   4. GROUP-WIDE FLAGS OVER A CAPPED LIST. `plays` is capped at
//      MY_ENTRY_PLAYS_CAP but playCount/totalPlaySeconds/watched/completed
//      describe the WHOLE group — computed by aggregate + existence probes, not
//      by folding the capped array (the in-code comment names this exact bug).
//   5. THE IDENTITY LADDER matches the list query's: tmdb identity (with
//      season/episode, since every episode of a show shares the show's tmdbId),
//      else source+sourceItemId, else the row alone — and the group is ALWAYS
//      re-scoped to the linked ids, so a shared library item can't pull in
//      another user's plays.
//   6. getMyWrapped honors ?year= only when that year actually has data.
//
// Harness: in-memory prisma stubs over the real module graph (the
// tests/jellyfin-config.test.mts idiom via tests/_helpers.mts), with an op log so
// "never queried" is assertable rather than assumed. play-history's stats/Wrapped
// aggregates are raw SQL, so $queryRawUnsafe is stubbed as a dispatcher keyed on
// the query shape. No DB, no network.
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";

process.env.TOKEN_ENCRYPTION_KEY = "ab".repeat(32); // prisma.ts pulls in token-crypto
process.env.NEXTAUTH_SECRET = "my-watch-history-test-secret-0123456789ab";
process.env.AUTH_URL = "http://localhost:3000";
process.env.TRUST_PROXY = "true";
(process.env as Record<string, string | undefined>).NODE_ENV = "test";

globalThis.fetch = (() => {
  throw new Error("unexpected network call from my-watch-history tests");
}) as unknown as typeof fetch;

console.warn = () => {};
console.error = () => {};

const { prisma } = await import("../src/lib/prisma.ts");
const { shadowPrismaModel, shadowPrismaClientMethod } = await import("./_helpers.mts");
const {
  resolveLinkedMediaServerUserIds,
  getMyWatchHistoryEntry,
  getMyPlayStats,
  getMyWrapped,
  MY_ENTRY_PLAYS_CAP,
} = await import("../src/lib/my-watch-history.ts");

// ── op log ───────────────────────────────────────────────────────────────────
type Op = { op: string; args?: unknown };
let ops: Op[] = [];
const rec = (op: string, args?: unknown) => { ops.push({ op, args }); };
const opsOf = (name: string) => ops.filter((o) => o.op === name);

// ── in-memory state ──────────────────────────────────────────────────────────
type DbUser = { id: string; plexUserId: string | null; jellyfinUserId: string | null };
type DbMsu = { id: string; source: string; sourceUserId: string; userId: string | null; active: boolean };
type DbPlay = {
  id: string;
  mediaServerUserId: string;
  source: string;
  startedAt: Date;
  stoppedAt: Date;
  duration: number;
  playDuration: number;
  watched: boolean;
  completed: boolean;
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
};

let users: DbUser[] = [];
let serverUsers: DbMsu[] = [];
let plays: DbPlay[] = [];
let years: number[] = [];

function play(over: Partial<DbPlay> & { id: string; mediaServerUserId: string }): DbPlay {
  return {
    source: "plex",
    startedAt: new Date("2026-01-01T00:00:00.000Z"),
    stoppedAt: new Date("2026-01-01T01:00:00.000Z"),
    duration: 3600,
    playDuration: 3600,
    watched: true,
    completed: true,
    tmdbId: null,
    mediaType: null,
    title: "Untitled",
    year: null,
    posterPath: null,
    seasonNumber: null,
    episodeNumber: null,
    episodeTitle: null,
    sourceItemId: null,
    platform: null,
    player: null,
    device: null,
    playMethod: null,
    ...over,
  };
}

// ── where-matcher covering the shapes my-watch-history actually builds ───────
// Deliberately narrow: `id`, `mediaServerUserId: {in}`, `tmdbId` (incl. null),
// `mediaType`/`seasonNumber`/`episodeNumber` (null-significant equality),
// `source`, `sourceItemId`, `watched`/`completed`, and AND-composition. An
// unrecognized key throws so a query-shape change surfaces as a loud failure
// instead of a silently-passing match-everything stub.
function matches(row: DbPlay, where: Record<string, unknown> | undefined): boolean {
  if (!where) return true;
  for (const [k, v] of Object.entries(where)) {
    if (k === "AND") {
      const list = (Array.isArray(v) ? v : [v]) as Record<string, unknown>[];
      if (!list.every((w) => matches(row, w))) return false;
      continue;
    }
    if (k === "mediaServerUserId") {
      const ids = (v as { in?: string[] }).in;
      assert.ok(Array.isArray(ids), "mediaServerUserId must be scoped with { in: [...] }");
      if (!ids.includes(row.mediaServerUserId)) return false;
      continue;
    }
    if (
      k === "id" || k === "tmdbId" || k === "mediaType" || k === "seasonNumber" ||
      k === "episodeNumber" || k === "source" || k === "sourceItemId" ||
      k === "watched" || k === "completed"
    ) {
      if ((row as unknown as Record<string, unknown>)[k] !== v) return false;
      continue;
    }
    throw new Error(`unhandled PlayHistory where key in stub: ${k}`);
  }
  return true;
}

function sortDesc(rows: DbPlay[]): DbPlay[] {
  return [...rows].sort(
    (a, b) => b.startedAt.getTime() - a.startedAt.getTime() || (a.id < b.id ? 1 : a.id > b.id ? -1 : 0),
  );
}

shadowPrismaModel(prisma, "user", {
  findUnique: async ({ where }: { where: { id: string } }) => {
    rec("user.findUnique", where);
    return users.find((u) => u.id === where.id) ?? null;
  },
});

shadowPrismaModel(prisma, "mediaServerUser", {
  findMany: async ({ where }: { where: { OR: Record<string, unknown>[] } }) => {
    rec("mediaServerUser.findMany", where);
    const or = where.OR;
    return serverUsers
      .filter((m) =>
        or.some((clause) => {
          if ("userId" in clause) return m.userId === clause.userId;
          return m.source === clause.source && m.sourceUserId === clause.sourceUserId;
        }),
      )
      .map((m) => ({ id: m.id }));
  },
});

shadowPrismaModel(prisma, "playHistory", {
  count: async ({ where }: { where?: Record<string, unknown> } = {}) => {
    rec("playHistory.count", where);
    return plays.filter((p) => matches(p, where)).length;
  },
  findFirst: async ({ where }: { where: Record<string, unknown> }) => {
    rec("playHistory.findFirst", where);
    return sortDesc(plays.filter((p) => matches(p, where)))[0] ?? null;
  },
  findMany: async ({ where, take }: { where: Record<string, unknown>; take?: number }) => {
    rec("playHistory.findMany", where);
    const rows = sortDesc(plays.filter((p) => matches(p, where)));
    return take != null ? rows.slice(0, take) : rows;
  },
  aggregate: async ({ where }: { where: Record<string, unknown> }) => {
    rec("playHistory.aggregate", where);
    const rows = plays.filter((p) => matches(p, where));
    const times = rows.map((r) => r.startedAt.getTime());
    return {
      _count: { _all: rows.length },
      _sum: { playDuration: rows.reduce((n, r) => n + r.playDuration, 0) },
      _min: { startedAt: times.length ? new Date(Math.min(...times)) : null },
      _max: { startedAt: times.length ? new Date(Math.max(...times)) : null },
    };
  },
});

// poster-cache reads these two; an empty result means posterUrl stays null,
// which is all these tests assert about it.
shadowPrismaModel(prisma, "tmdbMediaCore", {
  findMany: async () => { rec("tmdbMediaCore.findMany"); return []; },
});
shadowPrismaModel(prisma, "tmdbCache", {
  findMany: async () => { rec("tmdbCache.findMany"); return []; },
});

// play-history's stats/Wrapped aggregates are all raw SQL. Dispatch on the query
// shape: the years probe is the only one these tests need real data from, and
// every other aggregate is null-safe over an empty result set.
shadowPrismaClientMethod(prisma, "$queryRawUnsafe", async (sql: string) => {
  rec("$queryRawUnsafe", sql.slice(0, 60).replace(/\s+/g, " ").trim());
  if (/EXTRACT\(YEAR FROM "startedAt"\)/.test(sql)) return years.map((y) => ({ y }));
  return [];
});
shadowPrismaClientMethod(prisma, "$queryRaw", async () => { rec("$queryRaw"); return []; });
shadowPrismaModel(prisma, "activeSession", {
  findMany: async () => { rec("activeSession.findMany"); return []; },
});

beforeEach(() => {
  ops = [];
  users = [
    { id: "u-local", plexUserId: null, jellyfinUserId: null },
    { id: "u-plex", plexUserId: "plex-777", jellyfinUserId: null },
    { id: "u-jf", plexUserId: null, jellyfinUserId: "jf-888" },
    { id: "u-both", plexUserId: "plex-999", jellyfinUserId: "jf-999" },
  ];
  serverUsers = [
    { id: "msu-fk", source: "plex", sourceUserId: "plex-111", userId: "u-local", active: true },
    { id: "msu-plex-subject", source: "plex", sourceUserId: "plex-777", userId: null, active: true },
    { id: "msu-jf-subject", source: "jellyfin", sourceUserId: "jf-888", userId: null, active: true },
    { id: "msu-stranger", source: "plex", sourceUserId: "plex-666", userId: "u-stranger", active: true },
  ];
  plays = [];
  years = [];
});

// ── resolveLinkedMediaServerUserIds — the shared chokepoint ──────────────────

test("the explicit MediaServerUser.userId FK links an account with no provider subject", async () => {
  // A local-credentials / OIDC account has no plexUserId or jellyfinUserId at
  // all, so the FK is its ONLY route to its own history (guardrail 34).
  assert.deepEqual(await resolveLinkedMediaServerUserIds("u-local"), ["msu-fk"]);
});

test("a Plex account links through its provider subject even with no FK row", async () => {
  assert.deepEqual(await resolveLinkedMediaServerUserIds("u-plex"), ["msu-plex-subject"]);
});

test("a Jellyfin account links through its provider subject — the email branch would never match", async () => {
  // Jellyfin accounts frequently have no email, and a Jellyfin-provisioned row
  // carries a synthetic @jellyfin.local address no media server ever reports.
  assert.deepEqual(await resolveLinkedMediaServerUserIds("u-jf"), ["msu-jf-subject"]);
});

test("the FK and provider-subject branches are UNIONed, not either/or", async () => {
  serverUsers.push({ id: "msu-extra", source: "jellyfin", sourceUserId: "jf-x", userId: "u-plex", active: true });
  const ids = await resolveLinkedMediaServerUserIds("u-plex");
  assert.deepEqual([...ids].sort(), ["msu-extra", "msu-plex-subject"]);
});

test("an account with both subjects picks up its Plex AND Jellyfin identities", async () => {
  serverUsers.push(
    { id: "msu-b-plex", source: "plex", sourceUserId: "plex-999", userId: null, active: true },
    { id: "msu-b-jf", source: "jellyfin", sourceUserId: "jf-999", userId: null, active: true },
  );
  const ids = await resolveLinkedMediaServerUserIds("u-both");
  assert.deepEqual([...ids].sort(), ["msu-b-jf", "msu-b-plex"]);
});

test("the subject match is source-scoped — a Jellyfin id equal to a Plex id never cross-links", async () => {
  // sourceUserId is only unique WITHIN a source; the OR clauses pair
  // source+sourceUserId for exactly this reason.
  serverUsers.push({ id: "msu-collide", source: "jellyfin", sourceUserId: "plex-777", userId: null, active: true });
  assert.deepEqual(await resolveLinkedMediaServerUserIds("u-plex"), ["msu-plex-subject"]);
});

test("another account's rows are never in the linked set", async () => {
  const ids = await resolveLinkedMediaServerUserIds("u-local");
  assert.ok(!ids.includes("msu-stranger"));
});

test("a soft-deleted (active:false) server user stays linked — history outlives removal", async () => {
  // Guardrail 28: history/stats surfaces deliberately do NOT filter on `active`.
  serverUsers[0].active = false;
  assert.deepEqual(await resolveLinkedMediaServerUserIds("u-local"), ["msu-fk"]);
  const where = opsOf("mediaServerUser.findMany")[0].args as Record<string, unknown>;
  assert.ok(!("active" in where), "the linked-set query must not filter on active");
});

test("an account with nothing linked resolves to an empty set", async () => {
  serverUsers = [];
  assert.deepEqual(await resolveLinkedMediaServerUserIds("u-local"), []);
});

test("a missing user row degrades to the FK branch alone rather than throwing", async () => {
  users = [];
  assert.deepEqual(await resolveLinkedMediaServerUserIds("u-local"), ["msu-fk"]);
});

test("only the caller's own id is ever used to build the OR clause", async () => {
  await resolveLinkedMediaServerUserIds("u-plex");
  const where = opsOf("mediaServerUser.findMany")[0].args as { OR: Record<string, unknown>[] };
  const fk = where.OR.find((c) => "userId" in c);
  assert.deepEqual(fk, { userId: "u-plex" });
  assert.equal(where.OR.length, 2); // FK + the one provider subject this user has
});

// ── getMyWatchHistoryEntry — scope ───────────────────────────────────────────

test("an unlinked account returns null and NEVER queries PlayHistory", async () => {
  serverUsers = [];
  assert.equal(await getMyWatchHistoryEntry("u-local", "p1"), null);
  assert.equal(opsOf("playHistory.findFirst").length, 0);
  assert.equal(opsOf("playHistory.findMany").length, 0);
  assert.equal(opsOf("playHistory.aggregate").length, 0);
});

test("another user's row id returns null — foreign ids are indistinguishable from missing ones", async () => {
  plays = [play({ id: "p-theirs", mediaServerUserId: "msu-stranger", title: "Theirs" })];
  assert.equal(await getMyWatchHistoryEntry("u-local", "p-theirs"), null);
});

test("a row id that doesn't exist at all also returns null", async () => {
  plays = [play({ id: "p-mine", mediaServerUserId: "msu-fk" })];
  assert.equal(await getMyWatchHistoryEntry("u-local", "no-such-row"), null);
});

test("the anchor lookup is scoped to the linked ids, not just the row id", async () => {
  plays = [play({ id: "p-theirs", mediaServerUserId: "msu-stranger" })];
  await getMyWatchHistoryEntry("u-local", "p-theirs");
  const where = opsOf("playHistory.findFirst")[0].args as Record<string, unknown>;
  assert.deepEqual(where.mediaServerUserId, { in: ["msu-fk"] });
  assert.equal(where.id, "p-theirs");
});

test("every group query re-applies the linked-id scope alongside the identity clause", async () => {
  plays = [play({ id: "p1", mediaServerUserId: "msu-fk", tmdbId: 42, mediaType: "MOVIE" })];
  await getMyWatchHistoryEntry("u-local", "p1");
  for (const op of [...opsOf("playHistory.findMany"), ...opsOf("playHistory.aggregate")]) {
    const where = op.args as { AND?: unknown[] };
    assert.ok(Array.isArray(where.AND), "group queries must be AND-composed");
    const scoped = JSON.stringify(where.AND).includes('"mediaServerUserId"');
    assert.ok(scoped, `group query missing the linked-id scope: ${JSON.stringify(where)}`);
  }
});

test("a shared library item does not pull another user's plays into the group", async () => {
  plays = [
    play({ id: "p-mine", mediaServerUserId: "msu-fk", tmdbId: 7, mediaType: "MOVIE", title: "Shared" }),
    play({ id: "p-theirs", mediaServerUserId: "msu-stranger", tmdbId: 7, mediaType: "MOVIE", title: "Shared" }),
  ];
  const detail = await getMyWatchHistoryEntry("u-local", "p-mine");
  assert.ok(detail);
  assert.equal(detail.item.playCount, 1);
  assert.deepEqual(detail.plays.map((p) => p.id), ["p-mine"]);
});

// ── getMyWatchHistoryEntry — the identity ladder ─────────────────────────────

test("tmdb identity groups repeat plays of the same movie across devices and sources", async () => {
  plays = [
    play({ id: "a", mediaServerUserId: "msu-fk", tmdbId: 10, mediaType: "MOVIE", device: "TV", startedAt: new Date("2026-01-01T00:00:00Z") }),
    play({ id: "b", mediaServerUserId: "msu-fk", tmdbId: 10, mediaType: "MOVIE", source: "jellyfin", device: "Phone", startedAt: new Date("2026-02-01T00:00:00Z") }),
  ];
  const detail = await getMyWatchHistoryEntry("u-local", "a");
  assert.ok(detail);
  assert.equal(detail.item.playCount, 2);
  // The representative is the LATEST play, whichever id the caller passed in.
  assert.equal(detail.item.id, "b");
  assert.equal(detail.item.device, "Phone");
});

test("TV grouping includes season and episode — episodes of one show never merge", async () => {
  // Every episode of a show shares the show's tmdbId, so tmdbId alone would
  // collapse a whole series into a single entry.
  plays = [
    play({ id: "s1e1", mediaServerUserId: "msu-fk", tmdbId: 55, mediaType: "TV", seasonNumber: 1, episodeNumber: 1 }),
    play({ id: "s1e2", mediaServerUserId: "msu-fk", tmdbId: 55, mediaType: "TV", seasonNumber: 1, episodeNumber: 2 }),
  ];
  const detail = await getMyWatchHistoryEntry("u-local", "s1e1");
  assert.ok(detail);
  assert.equal(detail.item.playCount, 1);
  assert.deepEqual(detail.plays.map((p) => p.id), ["s1e1"]);
});

test("the same episode watched twice collapses into one entry", async () => {
  plays = [
    play({ id: "e-old", mediaServerUserId: "msu-fk", tmdbId: 55, mediaType: "TV", seasonNumber: 2, episodeNumber: 3, startedAt: new Date("2026-01-01T00:00:00Z") }),
    play({ id: "e-new", mediaServerUserId: "msu-fk", tmdbId: 55, mediaType: "TV", seasonNumber: 2, episodeNumber: 3, startedAt: new Date("2026-03-01T00:00:00Z") }),
  ];
  const detail = await getMyWatchHistoryEntry("u-local", "e-old");
  assert.ok(detail);
  assert.equal(detail.item.playCount, 2);
  assert.equal(detail.item.id, "e-new");
});

test("an unmatched row falls back to source + sourceItemId", async () => {
  plays = [
    play({ id: "i1", mediaServerUserId: "msu-fk", sourceItemId: "item-9", title: "Home Video", startedAt: new Date("2026-01-01T00:00:00Z") }),
    play({ id: "i2", mediaServerUserId: "msu-fk", sourceItemId: "item-9", title: "Home Video", startedAt: new Date("2026-01-05T00:00:00Z") }),
  ];
  const detail = await getMyWatchHistoryEntry("u-local", "i1");
  assert.ok(detail);
  assert.equal(detail.item.playCount, 2);
  assert.equal(detail.item.id, "i2");
});

test("the sourceItemId branch is source-scoped and excludes tmdb-matched rows", async () => {
  plays = [play({ id: "i1", mediaServerUserId: "msu-fk", sourceItemId: "item-9" })];
  await getMyWatchHistoryEntry("u-local", "i1");
  const where = opsOf("playHistory.findMany")[0].args as { AND: Record<string, unknown>[] };
  const clause = where.AND.find((c) => "sourceItemId" in c)!;
  assert.equal(clause.source, "plex");
  assert.equal(clause.sourceItemId, "item-9");
  // tmdbId:null keeps a later-matched row from being swept into the unmatched group.
  assert.equal(clause.tmdbId, null);
});

test("two unmatched titles with null ids NEVER collapse into one entry", async () => {
  // The last rung of the ladder is the row itself, precisely so distinct
  // unmatched titles aren't merged just because their identifiers are null.
  plays = [
    play({ id: "n1", mediaServerUserId: "msu-fk", title: "Alpha" }),
    play({ id: "n2", mediaServerUserId: "msu-fk", title: "Beta" }),
  ];
  const detail = await getMyWatchHistoryEntry("u-local", "n1");
  assert.ok(detail);
  assert.equal(detail.item.playCount, 1);
  assert.equal(detail.item.title, "Alpha");
  const where = opsOf("playHistory.findMany")[0].args as { AND: Record<string, unknown>[] };
  assert.ok(where.AND.some((c) => c.id === "n1"), "the last rung must key on the row id");
});

test("a movie and a TV title sharing a tmdbId stay separate entries", async () => {
  // TMDB namespaces movie and TV ids separately, so the same number is two works.
  plays = [
    play({ id: "m", mediaServerUserId: "msu-fk", tmdbId: 88, mediaType: "MOVIE", title: "Film" }),
    play({ id: "t", mediaServerUserId: "msu-fk", tmdbId: 88, mediaType: "TV", title: "Series", seasonNumber: 1, episodeNumber: 1 }),
  ];
  const detail = await getMyWatchHistoryEntry("u-local", "m");
  assert.ok(detail);
  assert.equal(detail.item.playCount, 1);
  assert.equal(detail.item.title, "Film");
});

// ── getMyWatchHistoryEntry — group-wide flags over a capped list ─────────────

test("playCount and totalPlaySeconds describe the whole group, not the capped page", async () => {
  const n = MY_ENTRY_PLAYS_CAP + 25;
  plays = Array.from({ length: n }, (_, i) =>
    play({
      id: `c${String(i).padStart(4, "0")}`,
      mediaServerUserId: "msu-fk",
      tmdbId: 1234,
      mediaType: "MOVIE",
      playDuration: 10,
      startedAt: new Date(Date.UTC(2026, 0, 1, 0, i)),
    }),
  );
  const detail = await getMyWatchHistoryEntry("u-local", "c0000");
  assert.ok(detail);
  assert.equal(detail.plays.length, MY_ENTRY_PLAYS_CAP);
  assert.equal(detail.item.playCount, n);
  assert.equal(detail.item.totalPlaySeconds, n * 10);
});

test("a qualifying play outside the newest 100 still marks the entry watched", async () => {
  // The exact bug the in-code comment names: folding `playRows` (capped) instead
  // of probing the group would render this entry as unwatched while the list
  // view's bool_or shows it watched.
  const n = MY_ENTRY_PLAYS_CAP + 5;
  plays = Array.from({ length: n }, (_, i) =>
    play({
      id: `w${String(i).padStart(4, "0")}`,
      mediaServerUserId: "msu-fk",
      tmdbId: 4321,
      mediaType: "MOVIE",
      watched: false,
      completed: false,
      startedAt: new Date(Date.UTC(2026, 0, 1, 0, i)),
    }),
  );
  // The OLDEST play (sorts last, outside the newest-100 window) is the only
  // watched+completed one.
  plays[0].watched = true;
  plays[0].completed = true;

  const detail = await getMyWatchHistoryEntry("u-local", "w0000");
  assert.ok(detail);
  assert.ok(!detail.plays.some((p) => p.watched), "the capped page holds no watched play");
  assert.equal(detail.item.watched, true);
  assert.equal(detail.item.completed, true);
});

test("watched and completed are probed independently", async () => {
  plays = [
    play({ id: "x1", mediaServerUserId: "msu-fk", tmdbId: 5, mediaType: "MOVIE", watched: true, completed: false }),
    play({ id: "x2", mediaServerUserId: "msu-fk", tmdbId: 5, mediaType: "MOVIE", watched: false, completed: false, startedAt: new Date("2026-05-01T00:00:00Z") }),
  ];
  const detail = await getMyWatchHistoryEntry("u-local", "x1");
  assert.ok(detail);
  assert.equal(detail.item.watched, true);
  assert.equal(detail.item.completed, false);
});

test("a group with no watched or completed play reports both false", async () => {
  plays = [play({ id: "u1", mediaServerUserId: "msu-fk", tmdbId: 6, mediaType: "MOVIE", watched: false, completed: false })];
  const detail = await getMyWatchHistoryEntry("u-local", "u1");
  assert.ok(detail);
  assert.equal(detail.item.watched, false);
  assert.equal(detail.item.completed, false);
});

test("the plays list is newest-first and capped at MY_ENTRY_PLAYS_CAP", async () => {
  plays = Array.from({ length: 5 }, (_, i) =>
    play({
      id: `o${i}`,
      mediaServerUserId: "msu-fk",
      tmdbId: 99,
      mediaType: "MOVIE",
      startedAt: new Date(Date.UTC(2026, 0, 1 + i)),
    }),
  );
  const detail = await getMyWatchHistoryEntry("u-local", "o0");
  assert.ok(detail);
  assert.deepEqual(detail.plays.map((p) => p.id), ["o4", "o3", "o2", "o1", "o0"]);
  assert.equal(MY_ENTRY_PLAYS_CAP, 100);
});

test("firstStartedAt / lastStartedAt span the whole group, not the capped page", async () => {
  plays = [
    play({ id: "f1", mediaServerUserId: "msu-fk", tmdbId: 77, mediaType: "MOVIE", startedAt: new Date("2024-06-01T00:00:00Z") }),
    play({ id: "f2", mediaServerUserId: "msu-fk", tmdbId: 77, mediaType: "MOVIE", startedAt: new Date("2026-06-01T00:00:00Z") }),
  ];
  const detail = await getMyWatchHistoryEntry("u-local", "f1");
  assert.ok(detail);
  assert.equal(detail.firstStartedAt, "2024-06-01T00:00:00.000Z");
  assert.equal(detail.lastStartedAt, "2026-06-01T00:00:00.000Z");
});

// ── getMyWatchHistoryEntry — the lean serialization contract ─────────────────

test("the entry payload carries no admin forensics fields", async () => {
  // The admin surface keeps ipAddress/codecs/bitrate; the self-service one must
  // not leak them even though the rows carry them.
  plays = [play({ id: "l1", mediaServerUserId: "msu-fk", tmdbId: 3, mediaType: "MOVIE" })];
  const detail = await getMyWatchHistoryEntry("u-local", "l1");
  assert.ok(detail);
  const blob = JSON.stringify(detail);
  for (const field of ["ipAddress", "videoCodec", "audioCodec", "bitrate", "mediaServerUserId"]) {
    assert.ok(!blob.includes(field), `${field} must not reach the self-service payload`);
  }
});

test("sourceItemId is group-key input only and never serializes", async () => {
  plays = [play({ id: "s1", mediaServerUserId: "msu-fk", sourceItemId: "secret-item-id" })];
  const detail = await getMyWatchHistoryEntry("u-local", "s1");
  assert.ok(detail);
  assert.ok(!JSON.stringify(detail).includes("secret-item-id"));
});

test("timestamps serialize as ISO strings, not Date objects", async () => {
  plays = [play({ id: "t1", mediaServerUserId: "msu-fk", tmdbId: 4, mediaType: "MOVIE" })];
  const detail = await getMyWatchHistoryEntry("u-local", "t1");
  assert.ok(detail);
  assert.equal(typeof detail.item.startedAt, "string");
  assert.equal(typeof detail.item.stoppedAt, "string");
  assert.equal(typeof detail.plays[0].startedAt, "string");
  assert.equal(detail.item.startedAt, "2026-01-01T00:00:00.000Z");
});

test("identity fields come from the anchor while playback fields come from the newest play", async () => {
  plays = [
    play({ id: "id-old", mediaServerUserId: "msu-fk", tmdbId: 12, mediaType: "MOVIE", title: "Canonical", year: "1999", device: "Old TV", startedAt: new Date("2026-01-01T00:00:00Z") }),
    play({ id: "id-new", mediaServerUserId: "msu-fk", tmdbId: 12, mediaType: "MOVIE", title: "Canonical", year: "1999", device: "New Phone", startedAt: new Date("2026-02-01T00:00:00Z") }),
  ];
  const detail = await getMyWatchHistoryEntry("u-local", "id-old");
  assert.ok(detail);
  assert.equal(detail.item.title, "Canonical");
  assert.equal(detail.item.year, "1999");
  assert.equal(detail.item.device, "New Phone");
});

test("a row with no tmdbId resolves no poster and skips the poster lookup entirely", async () => {
  plays = [play({ id: "np", mediaServerUserId: "msu-fk", tmdbId: null })];
  const detail = await getMyWatchHistoryEntry("u-local", "np");
  assert.ok(detail);
  assert.equal(detail.item.posterUrl, null);
  assert.equal(opsOf("tmdbMediaCore.findMany").length, 0);
});

// ── getMyPlayStats ───────────────────────────────────────────────────────────

test("an unlinked account gets linked:false and never runs a stats aggregate", async () => {
  serverUsers = [];
  const res = await getMyPlayStats("u-local");
  assert.deepEqual(res, { linked: false, stats: null });
  assert.equal(opsOf("$queryRawUnsafe").length, 0);
});

test("a linked account gets linked:true and a stats bundle", async () => {
  const res = await getMyPlayStats("u-local");
  assert.equal(res.linked, true);
  assert.ok(res.stats);
});

test("the stats bundle is computed over the caller's linked ids", async () => {
  await getMyPlayStats("u-plex");
  assert.equal(opsOf("mediaServerUser.findMany").length, 1);
  assert.ok(opsOf("$queryRawUnsafe").length > 0);
});

test("getMyPlayStats exposes no userId parameter — scope can't be widened by an argument", () => {
  assert.equal(getMyPlayStats.length, 1);
});

// ── getMyWrapped ─────────────────────────────────────────────────────────────

test("an unlinked account gets linked:false with no years and no data", async () => {
  serverUsers = [];
  assert.deepEqual(await getMyWrapped("u-local"), { linked: false, years: [], year: null, data: null });
});

test("a linked account with no watched plays is linked but has no year", async () => {
  years = [];
  const res = await getMyWrapped("u-local");
  assert.equal(res.linked, true);
  assert.deepEqual(res.years, []);
  assert.equal(res.year, null);
  assert.equal(res.data, null);
});

test("with no requested year the most recent year on record is used", async () => {
  years = [2026, 2025, 2024];
  const res = await getMyWrapped("u-local");
  assert.equal(res.year, 2026);
  assert.deepEqual(res.years, [2026, 2025, 2024]);
  assert.ok(res.data);
});

test("a requested year that has data is honored", async () => {
  years = [2026, 2025, 2024];
  assert.equal((await getMyWrapped("u-local", 2024)).year, 2024);
});

test("a hand-typed year with no data falls back to the most recent one", async () => {
  // `?year=1999` must not scope Wrapped to an empty year.
  years = [2026, 2025];
  assert.equal((await getMyWrapped("u-local", 1999)).year, 2026);
});

test("a year in the future with no data also falls back", async () => {
  years = [2026];
  assert.equal((await getMyWrapped("u-local", 2099)).year, 2026);
});

test("a non-integer-ish requested year is rejected by the membership check", async () => {
  years = [2026];
  assert.equal((await getMyWrapped("u-local", NaN)).year, 2026);
  assert.equal((await getMyWrapped("u-local", 0)).year, 2026);
});

test("the returned years list is exactly what the year probe reported", async () => {
  years = [2026, 2023, 2019];
  assert.deepEqual((await getMyWrapped("u-local")).years, [2026, 2023, 2019]);
});

test("Wrapped runs its aggregates only after a year is settled", async () => {
  years = [];
  await getMyWrapped("u-local");
  // Only the year probe itself ran — no year means no bundle to build.
  const sqls = opsOf("$queryRawUnsafe").map((o) => o.args as string);
  assert.equal(sqls.length, 1);
  assert.ok(sqls[0].includes("EXTRACT(YEAR"));
});

test("Wrapped's aggregates fan out once a year is settled", async () => {
  years = [2026];
  await getMyWrapped("u-local");
  assert.ok(opsOf("$queryRawUnsafe").length > 1);
});
