// The media servers' own watch records for "For You" (guardrail 40c):
// src/lib/server-watch-history.ts (pure counting rules) and
// src/lib/server-watch-history-data.ts (the import run). Pinned here:
//
//   1. Plex: the owner's plays (local account "1") belong to the owner's plex.tv
//      id; other accounts' plays never land on the wrong identity; a play AT the
//      read point is not counted again; an undated play counts only on a full read.
//   2. Jellyfin: a full read counts PlayCount (the lifetime tally), an
//      incremental read counts ONE play per item played since — never the
//      lifetime count again.
//   3. The run is incremental and idempotent: a second run over the same history
//      counts nothing twice, even when the server ignores the viewedAt filter.
//   4. An identity's rows and its read point commit TOGETHER: a failed write
//      leaves both, and the next run counts those plays exactly once.
//   5. Owner unknown (plex.tv down) ⇒ the owner's read point HOLDS.
//   6. An aborted walk writes nothing.
//   7. Favorites are read only for an identity linked to an account, and set
//      the flag on exactly the favorited titles.
//   8. Nothing here ever writes PlayHistory (guardrail 19).
//
// Harness: in-memory prisma stubs, a staged-commit $transaction, a scripted
// globalThis.fetch (RFC1918 IP literals for the servers; plex.tv behind a DNS
// stub). No DB, no network.
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import dns from "node:dns/promises";

process.env.TOKEN_ENCRYPTION_KEY = "ab".repeat(32);
process.env.NEXTAUTH_SECRET = "server-history-test-secret-0123456789abcdef";
process.env.AUTH_URL = "http://localhost:3000";

const fakeLookup = async () => [{ address: "93.184.216.34", family: 4 }];
(dns as { lookup: unknown }).lookup = fakeLookup;
if ((dns as { lookup: unknown }).lookup !== fakeLookup) throw new Error("could not stub dns.lookup");

const errors: string[] = [];
const warns: string[] = [];
console.error = (...args: unknown[]) => { errors.push(args.map(String).join(" ")); };
console.warn = (...args: unknown[]) => { warns.push(args.map(String).join(" ")); };

// ── scripted upstreams ───────────────────────────────────────────────────────
const PLEX = "http://10.81.0.1:32400";
const JF = "http://10.82.0.1:8096";
type Call = { origin: string; path: string; params: URLSearchParams };
let calls: Call[] = [];
let respond: (url: URL) => Response | Promise<Response> = (url) => {
  throw new Error(`unexpected fetch ${url}`);
};
globalThis.fetch = (async (input: RequestInfo | URL) => {
  const url = new URL(String(input));
  calls.push({ origin: url.origin, path: url.pathname, params: url.searchParams });
  return respond(url);
}) as typeof fetch;
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

const { prisma } = await import("../src/lib/prisma.ts");
const { shadowPrismaModel, shadowPrismaClientMethod } = await import("./_helpers.mts");
const { resetLogDedup } = await import("../src/lib/log-dedup.ts");
const { invalidateFeatureFlagCache } = await import("../src/lib/features.ts");

// ── settings ─────────────────────────────────────────────────────────────────
const settings = new Map<string, string>();
shadowPrismaModel(prisma, "setting", {
  findUnique: async (args: { where: { key: string } }) => {
    const v = settings.get(args.where.key);
    return v === undefined ? null : { key: args.where.key, value: v };
  },
  findMany: async (args?: { where?: { key?: { in?: string[] } } }) => {
    const keys = args?.where?.key?.in;
    return [...settings.entries()].filter(([k]) => !keys || keys.includes(k)).map(([key, value]) => ({ key, value }));
  },
});

// ── identities ───────────────────────────────────────────────────────────────
type Identity = { id: string; source: string; serverInstance: string; sourceUserId: string; isServerAdmin: boolean; userId: string | null; active: boolean };
let identities: Identity[] = [];
type Cursor = { mediaServerUserId: string; readTo: Date | null; importedAt: Date | null };
let cursors: Cursor[] = [];
shadowPrismaModel(prisma, "mediaServerUser", {
  findMany: async (args: { where: { source: string; serverInstance: string; active: boolean; userId?: { not: null } } }) =>
    identities
      .filter((i) => i.source === args.where.source && i.serverInstance === args.where.serverInstance && i.active === args.where.active)
      // HONOUR the linked-only scope: a stub that ignored it would hand the run
      // unlinked identities and the co-watch-off pin below would test nothing.
      .filter((i) => args.where.userId === undefined || i.userId !== null)
      .map((i) => ({
        id: i.id,
        sourceUserId: i.sourceUserId,
        isServerAdmin: i.isServerAdmin,
        userId: i.userId,
        watchCursor: (() => {
          const c = cursors.find((x) => x.mediaServerUserId === i.id);
          return c ? { readTo: c.readTo } : null;
        })(),
      })),
});

// ── library ──────────────────────────────────────────────────────────────────
type PlexLib = { tmdbId: number; mediaType: "MOVIE" | "TV"; serverInstance: string; plexRatingKey: string | null; plexRatingKeys: string[]; title: string | null };
type JfLib = { tmdbId: number; mediaType: "MOVIE" | "TV"; serverInstance: string; jellyfinItemId: string | null; jellyfinItemIds: string[]; title: string | null };
let plexLib: PlexLib[] = [];
let jfLib: JfLib[] = [];
shadowPrismaModel(prisma, "plexLibraryItem", {
  findMany: async (args: { where: { serverInstance: string; OR: [{ plexRatingKey: { in: string[] } }, { plexRatingKeys: { hasSome: string[] } }] } }) => {
    const keys = new Set([...args.where.OR[0].plexRatingKey.in, ...args.where.OR[1].plexRatingKeys.hasSome]);
    return plexLib.filter((r) => r.serverInstance === args.where.serverInstance && ((r.plexRatingKey && keys.has(r.plexRatingKey)) || r.plexRatingKeys.some((k) => keys.has(k))));
  },
});
shadowPrismaModel(prisma, "jellyfinLibraryItem", {
  findMany: async (args: { where: { serverInstance: string; OR: [{ jellyfinItemId: { in: string[] } }, { jellyfinItemIds: { hasSome: string[] } }] } }) => {
    const ids = new Set([...args.where.OR[0].jellyfinItemId.in, ...args.where.OR[1].jellyfinItemIds.hasSome]);
    return jfLib
      .filter((r) => r.serverInstance === args.where.serverInstance && ((r.jellyfinItemId && ids.has(r.jellyfinItemId)) || r.jellyfinItemIds.some((k) => ids.has(k))))
      .sort((a, b) => a.tmdbId - b.tmdbId);
  },
});

// Guardrail 19: this job never writes a play.
const forbidden: string[] = [];
shadowPrismaModel(prisma, "playHistory", Object.fromEntries(
  ["create", "createMany", "update", "updateMany", "upsert", "delete", "deleteMany"].map((m) => [m, async () => {
    forbidden.push(`playHistory.${m}`);
    throw new Error("the server-history import must never write PlayHistory");
  }]),
));

// ── stored rows + a staged-commit transaction ────────────────────────────────
type Row = { mediaServerUserId: string; tmdbId: number; mediaType: "MOVIE" | "TV"; title: string; plays: number; lastWatchedAt: Date | null; favorite: boolean };
let rows: Row[] = [];
// Identity whose write fails (the createMany throws) — the transaction must roll
// back its rows AND its read point.
let failWriteFor: string | null = null;
shadowPrismaClientMethod(prisma, "$transaction", async (fn: unknown) => {
  if (typeof fn !== "function") throw new Error("only interactive transactions are expected");
  let stagedRows = rows.map((r) => ({ ...r }));
  const stagedCursors = cursors.map((c) => ({ ...c }));
  const tx = {
    serverWatchedTitle: {
      findMany: async (args: { where: { mediaServerUserId: string } }) =>
        stagedRows.filter((r) => r.mediaServerUserId === args.where.mediaServerUserId).map(({ mediaServerUserId: _m, ...r }) => r),
      deleteMany: async (args: { where: { mediaServerUserId: string } }) => {
        const before = stagedRows.length;
        stagedRows = stagedRows.filter((r) => r.mediaServerUserId !== args.where.mediaServerUserId);
        return { count: before - stagedRows.length };
      },
      createMany: async (args: { data: Row[] }) => {
        if (failWriteFor && args.data.some((r) => r.mediaServerUserId === failWriteFor)) throw new Error("simulated write failure");
        stagedRows.push(...args.data.map((r) => ({ ...r })));
        return { count: args.data.length };
      },
    },
    serverWatchCursor: {
      upsert: async (args: { where: { mediaServerUserId: string }; create: Cursor; update: Partial<Cursor> }) => {
        const c = stagedCursors.find((x) => x.mediaServerUserId === args.where.mediaServerUserId);
        if (c) Object.assign(c, args.update);
        else stagedCursors.push({ ...args.create });
        return {};
      },
    },
  };
  const out = await (fn as (t: unknown) => Promise<unknown>)(tx);
  rows = stagedRows; // commit only when the callback resolved
  cursors = stagedCursors;
  return out;
});

const pure = await import("../src/lib/server-watch-history.ts");
const { importServerWatchHistory } = await import("../src/lib/server-watch-history-data.ts");
const { parseJellyfinFavorite } = await import("../src/lib/jellyfin.ts");

// ── fixtures ─────────────────────────────────────────────────────────────────
const DAY = 86_400_000;
const ago = (days: number) => new Date(Date.now() - days * DAY);
const secs = (d: Date) => Math.floor(d.getTime() / 1000);
const OWNER_PLEX_TV_ID = "9001";

function configurePlex(): void {
  settings.set("plexServerUrl", PLEX);
  settings.set("plexAdminToken", "plex-admin-token");
}
function configureJellyfin(): void {
  settings.set("jellyfinUrl", JF);
  settings.set("jellyfinApiKey", "jf-key");
}

let plexHistory: unknown[] = [];
let plexTvUp = true;
let jfPlayed = new Map<string, unknown[]>();
let jfFavorites = new Map<string, unknown[]>();
function serve(url: URL): Response {
  if (url.hostname === "plex.tv") {
    return plexTvUp ? json({ id: Number(OWNER_PLEX_TV_ID), email: "owner@example.com", username: "owner" }) : new Response("down", { status: 503 });
  }
  if (url.origin === PLEX && url.pathname === "/status/sessions/history/all") {
    // Newest first, as the real server answers sort=viewedAt:desc — the
    // incremental walk stops at the first record older than its read point.
    const sorted = [...plexHistory].sort((a, b) => Number((b as { viewedAt: number }).viewedAt) - Number((a as { viewedAt: number }).viewedAt));
    return json({ MediaContainer: { Metadata: sorted, totalSize: sorted.length, size: sorted.length } });
  }
  if (url.origin === JF && url.pathname === "/Items") {
    const user = url.searchParams.get("userId")!;
    const items = url.searchParams.get("Filters") === "IsFavorite" ? jfFavorites.get(user) ?? [] : jfPlayed.get(user) ?? [];
    const start = Number(url.searchParams.get("StartIndex") ?? 0);
    return json({ Items: start === 0 ? items : [], TotalRecordCount: items.length });
  }
  throw new Error(`unexpected fetch ${url}`);
}

const plexRec = (o: Record<string, unknown>) => o;
const rowsOf = (id: string) => rows.filter((r) => r.mediaServerUserId === id).map((r) => [r.tmdbId, r.mediaType, r.plays, r.favorite]).sort();
const cursorOf = (id: string) => cursors.find((c) => c.mediaServerUserId === id)?.readTo ?? null;

beforeEach(() => {
  settings.clear();
  invalidateFeatureFlagCache();
  resetLogDedup();
  calls = [];
  errors.length = 0;
  warns.length = 0;
  forbidden.length = 0;
  identities = [];
  cursors = [];
  rows = [];
  failWriteFor = null;
  plexTvUp = true;
  plexHistory = [];
  jfPlayed = new Map();
  jfFavorites = new Map();
  plexLib = [
    { tmdbId: 100, mediaType: "MOVIE", serverInstance: "", plexRatingKey: "100", plexRatingKeys: [], title: "Movie 100" },
    // A show whose second copy's key (500) lives only in the array column (37c).
    { tmdbId: 450, mediaType: "TV", serverInstance: "", plexRatingKey: "450", plexRatingKeys: ["450", "500"], title: "Show 450" },
  ];
  jfLib = [
    { tmdbId: 700, mediaType: "MOVIE", serverInstance: "", jellyfinItemId: "jf-movie-700", jellyfinItemIds: [], title: "Movie 700" },
    { tmdbId: 800, mediaType: "TV", serverInstance: "", jellyfinItemId: "jf-series-800", jellyfinItemIds: [], title: "Show 800" },
    { tmdbId: 900, mediaType: "MOVIE", serverInstance: "", jellyfinItemId: "jf-movie-900", jellyfinItemIds: [], title: "Movie 900" },
  ];
  respond = serve;
});

// ═══ pure rules ══════════════════════════════════════════════════════════════

const titleFor = (k: string) =>
  k === "100" ? { tmdbId: 100, mediaType: "MOVIE" as const } : k === "500" ? { tmdbId: 450, mediaType: "TV" as const } : null;

test("foldPlexHistory: the owner's local '1' is the owner's plex.tv id; other accounts never land here", () => {
  const recs = [
    { kind: "movie" as const, itemKey: "100", showKey: null, viewedAt: ago(3), accountId: "1" },
    { kind: "movie" as const, itemKey: "100", showKey: null, viewedAt: ago(2), accountId: "1" },
    { kind: "movie" as const, itemKey: "100", showKey: null, viewedAt: ago(1), accountId: "77" },
    { kind: "episode" as const, itemKey: "501", showKey: "500", viewedAt: ago(4), accountId: "1" },
  ];
  const { deltas } = pure.foldPlexHistory(recs, OWNER_PLEX_TV_ID, OWNER_PLEX_TV_ID, null, titleFor);
  assert.deepEqual([...deltas.values()].map((d) => [d.tmdbId, d.mediaType, d.plays]).sort(), [[100, "MOVIE", 2], [450, "TV", 1]]);
  // Owner unknown: "1" can't be placed, so it is nobody's.
  assert.equal(pure.foldPlexHistory(recs, OWNER_PLEX_TV_ID, null, null, titleFor).deltas.size, 0);
  // A shared account is matched by its own plex.tv id.
  assert.deepEqual([...pure.foldPlexHistory(recs, "77", OWNER_PLEX_TV_ID, null, titleFor).deltas.values()].map((d) => d.plays), [1]);
});

test("foldPlexHistory: strictly AFTER the read point; undated plays count only on a full read; a mistyped key is unresolved", () => {
  const readTo = ago(2);
  const recs = [
    { kind: "movie" as const, itemKey: "100", showKey: null, viewedAt: readTo, accountId: "5" }, // AT the read point: counted before
    { kind: "movie" as const, itemKey: "100", showKey: null, viewedAt: ago(1), accountId: "5" },
    { kind: "movie" as const, itemKey: "100", showKey: null, viewedAt: null, accountId: "5" },
    // A movie record whose key resolves to a SHOW is not a play of that show.
    { kind: "movie" as const, itemKey: "500", showKey: null, viewedAt: ago(1), accountId: "5" },
  ];
  const inc = pure.foldPlexHistory(recs, "5", null, readTo, titleFor);
  assert.deepEqual([...inc.deltas.values()].map((d) => d.plays), [1]);
  assert.equal(inc.unresolved, 1);
  const full = pure.foldPlexHistory(recs, "5", null, null, titleFor);
  assert.deepEqual([...full.deltas.values()].map((d) => d.plays), [3], "the undated play and the boundary play both count on a full read");
});

test("foldJellyfinPlayed: a full read counts PlayCount; an incremental read counts ONE play per item since the read point", () => {
  const jfTitle = (id: string) => (id === "m" ? { tmdbId: 1, mediaType: "MOVIE" as const } : id === "s" ? { tmdbId: 2, mediaType: "TV" as const } : null);
  const items = [
    { kind: "movie" as const, itemKey: "m", showKey: null, lastPlayedAt: ago(1), playCount: 4 },
    { kind: "episode" as const, itemKey: "e1", showKey: "s", lastPlayedAt: ago(2), playCount: 2 },
    { kind: "episode" as const, itemKey: "e2", showKey: "s", lastPlayedAt: ago(10), playCount: 1 },
  ];
  const full = pure.foldJellyfinPlayed(items, null, jfTitle);
  assert.deepEqual([...full.deltas.values()].map((d) => [d.tmdbId, d.plays]).sort(), [[1, 4], [2, 3]]);
  const inc = pure.foldJellyfinPlayed(items, ago(5), jfTitle);
  assert.deepEqual([...inc.deltas.values()].map((d) => [d.tmdbId, d.plays]).sort(), [[1, 1], [2, 1]], "never the lifetime PlayCount again");
});

test("mergeServerWatchedRows: plays add, the later date wins, favorites set only when read, empty rows drop", () => {
  const t0 = ago(30);
  const existing = [
    { tmdbId: 1, mediaType: "MOVIE" as const, title: "One", plays: 2, lastWatchedAt: t0, favorite: true },
    { tmdbId: 2, mediaType: "MOVIE" as const, title: "Two", plays: 0, lastWatchedAt: null, favorite: true },
  ];
  const deltas = new Map([["1:MOVIE", { tmdbId: 1, mediaType: "MOVIE" as const, plays: 1, lastWatchedAt: ago(1) }]]);
  const name = () => "named";
  // Favorites not read this run: every stored flag stands.
  const kept = pure.mergeServerWatchedRows(existing, deltas, null, name);
  assert.deepEqual(kept.map((r) => [r.tmdbId, r.plays, r.favorite]), [[1, 3, true], [2, 0, true]]);
  assert.equal(kept[0].lastWatchedAt!.getTime(), ago(1).getTime());
  // Favorites read: 2 is no longer one, so its play-less row goes; 3 is new.
  const read = pure.mergeServerWatchedRows(existing, deltas, new Set(["3:TV"]), name);
  assert.deepEqual(read.map((r) => [r.tmdbId, r.mediaType, r.plays, r.favorite]).sort(), [[1, "MOVIE", 3, false], [3, "TV", 0, true]]);
  const point = ago(1);
  assert.equal(pure.nextReadTo(point, [ago(5), null])!.getTime(), point.getTime(), "a read point never moves backwards");
  assert.ok(pure.sameServerWatchedRows(kept, kept.map((r) => ({ ...r }))));
  assert.ok(!pure.sameServerWatchedRows(kept, read));
});

test("parseJellyfinFavorite: movies and series only; a row the server says is NOT a favorite is dropped", () => {
  assert.deepEqual(parseJellyfinFavorite({ Type: "Movie", Id: "a", UserData: { IsFavorite: true } }), { kind: "movie", itemId: "a" });
  assert.deepEqual(parseJellyfinFavorite({ Type: "Series", Id: "b" }), { kind: "series", itemId: "b" });
  assert.equal(parseJellyfinFavorite({ Type: "Episode", Id: "c" }), null);
  assert.equal(parseJellyfinFavorite({ Type: "Movie", Id: "d", UserData: { IsFavorite: false } }), null);
});

// ═══ the import run: Plex ════════════════════════════════════════════════════

function plexSetup(): void {
  configurePlex();
  identities = [
    { id: "msu-owner", source: "plex", serverInstance: "", sourceUserId: OWNER_PLEX_TV_ID, isServerAdmin: true, userId: "u-owner", active: true },
    { id: "msu-friend", source: "plex", serverInstance: "", sourceUserId: "2", isServerAdmin: false, userId: "u-friend", active: true },
  ];
  plexHistory = [
    plexRec({ type: "movie", ratingKey: "100", viewedAt: secs(ago(5)), accountID: 1 }),
    plexRec({ type: "movie", ratingKey: "100", viewedAt: secs(ago(9)), accountID: 1 }),
    plexRec({ type: "episode", ratingKey: "501", grandparentRatingKey: "500", parentIndex: 1, index: 1, viewedAt: secs(ago(3)), accountID: 2 }),
    // An account nobody here owns, and a title not in the library.
    plexRec({ type: "movie", ratingKey: "100", viewedAt: secs(ago(4)), accountID: 3 }),
    plexRec({ type: "movie", ratingKey: "4040", viewedAt: secs(ago(4)), accountID: 2 }),
  ];
}

test("plex first import: each identity gets ITS plays, the owner via local id 1, with its read point; no PlayHistory write", async () => {
  plexSetup();
  const result = await importServerWatchHistory();
  assert.equal(result.failedServers, 0);
  assert.deepEqual(rowsOf("msu-owner"), [[100, "MOVIE", 2, false]]);
  assert.deepEqual(rowsOf("msu-friend"), [[450, "TV", 1, false]]);
  assert.equal(result.unresolved, 1, "the title the library doesn't have");
  // Both read points sit at the newest record the walk saw.
  const newest = new Date(secs(ago(3)) * 1000);
  assert.equal(cursorOf("msu-owner")!.getTime(), newest.getTime());
  assert.equal(cursorOf("msu-friend")!.getTime(), newest.getTime());
  assert.equal(rows.find((r) => r.tmdbId === 450)!.title, "Show 450", "named from the library row");
  assert.deepEqual(forbidden, []);
});

test("plex re-run over the SAME history counts nothing twice — even when the server ignores the viewedAt filter", async () => {
  plexSetup();
  await importServerWatchHistory();
  calls = [];
  // The stub returns the whole history again (a server that ignores viewedAt>).
  await importServerWatchHistory();
  assert.deepEqual(rowsOf("msu-owner"), [[100, "MOVIE", 2, false]]);
  assert.deepEqual(rowsOf("msu-friend"), [[450, "TV", 1, false]]);
  const historyCall = calls.find((c) => c.path === "/status/sessions/history/all")!;
  assert.ok([...historyCall.params.keys()].some((k) => k.startsWith("viewedAt")), "the second walk asks only for what is new");

  // A new play is counted once.
  plexHistory = [...plexHistory, plexRec({ type: "movie", ratingKey: "100", viewedAt: secs(ago(1)), accountID: 1 })];
  await importServerWatchHistory();
  assert.deepEqual(rowsOf("msu-owner"), [[100, "MOVIE", 3, false]]);
});

test("plex: a failed write rolls back that identity's rows AND read point; the next run counts its plays exactly once", async () => {
  plexSetup();
  failWriteFor = "msu-friend";
  const result = await importServerWatchHistory();
  assert.equal(result.failedIdentities, 1);
  assert.deepEqual(rowsOf("msu-friend"), []);
  assert.equal(cursorOf("msu-friend"), null, "no read point moved past the plays that were not written");
  assert.deepEqual(rowsOf("msu-owner"), [[100, "MOVIE", 2, false]], "the other identity committed on its own");

  failWriteFor = null;
  await importServerWatchHistory();
  assert.deepEqual(rowsOf("msu-friend"), [[450, "TV", 1, false]]);
  assert.deepEqual(rowsOf("msu-owner"), [[100, "MOVIE", 2, false]], "the owner's plays are not counted again");
});

test("plex: owner unknown (plex.tv down) ⇒ the owner's read point HOLDS; the friend is still imported", async () => {
  plexSetup();
  plexTvUp = false;
  await importServerWatchHistory();
  assert.deepEqual(rowsOf("msu-owner"), []);
  assert.equal(cursorOf("msu-owner"), null);
  assert.deepEqual(rowsOf("msu-friend"), [[450, "TV", 1, false]]);

  plexTvUp = true;
  await importServerWatchHistory();
  assert.deepEqual(rowsOf("msu-owner"), [[100, "MOVIE", 2, false]], "the held plays arrive once plex.tv answers");
});

test("plex: a run aborted before it starts, or MID-WALK, writes nothing and moves no read point", async () => {
  plexSetup();
  const before = new AbortController();
  before.abort();
  assert.equal((await importServerWatchHistory({ signal: before.signal })).aborted, true);
  assert.deepEqual(rows, []);

  // Aborted while the history page is in flight: the walk returns what it read,
  // and none of it may be written (a partial walk would advance read points
  // past plays it never saw).
  const during = new AbortController();
  respond = (url) => {
    if (url.pathname === "/status/sessions/history/all") during.abort();
    return serve(url);
  };
  await importServerWatchHistory({ signal: during.signal });
  assert.deepEqual(rows, []);
  assert.deepEqual(cursors, []);
});

// ═══ the import run: Jellyfin ════════════════════════════════════════════════

const jfItem = (o: { type: "Movie" | "Episode"; id: string; series?: string; played: Date; count: number }) => ({
  Type: o.type,
  Id: o.id,
  ...(o.series ? { SeriesId: o.series, ParentIndexNumber: 1, IndexNumber: 1 } : {}),
  UserData: { Played: true, PlayCount: o.count, LastPlayedDate: o.played.toISOString() },
});

test("jellyfin: a full read counts PlayCount, the next read counts one per item since; favorites only for a LINKED identity", async () => {
  configureJellyfin();
  identities = [
    { id: "msu-jf", source: "jellyfin", serverInstance: "", sourceUserId: "jf-user", isServerAdmin: false, userId: "u1", active: true },
    { id: "msu-jf-unlinked", source: "jellyfin", serverInstance: "", sourceUserId: "jf-other", isServerAdmin: false, userId: null, active: true },
  ];
  jfPlayed.set("jf-user", [
    jfItem({ type: "Movie", id: "jf-movie-700", played: ago(2), count: 3 }),
    jfItem({ type: "Episode", id: "ep-1", series: "jf-series-800", played: ago(4), count: 1 }),
    jfItem({ type: "Episode", id: "ep-2", series: "jf-series-800", played: ago(6), count: 2 }),
  ]);
  jfPlayed.set("jf-other", [jfItem({ type: "Movie", id: "jf-movie-700", played: ago(3), count: 1 })]);
  jfFavorites.set("jf-user", [{ Type: "Movie", Id: "jf-movie-900", UserData: { IsFavorite: true } }, { Type: "Series", Id: "jf-series-800", UserData: { IsFavorite: true } }]);
  jfFavorites.set("jf-other", [{ Type: "Movie", Id: "jf-movie-900", UserData: { IsFavorite: true } }]);

  await importServerWatchHistory();
  assert.deepEqual(rowsOf("msu-jf"), [[700, "MOVIE", 3, false], [800, "TV", 3, true], [900, "MOVIE", 0, true]]);
  // Co-watch OFF (the default): a shelf is its own viewer's, so an identity
  // linked to no account is neither read nor stored.
  assert.deepEqual(rowsOf("msu-jf-unlinked"), []);
  assert.ok(!calls.some((c) => c.params.get("userId") === "jf-other"), "an unlinked identity costs no request at all");
  const favCall = calls.find((c) => c.params.get("Filters") === "IsFavorite")!;
  assert.equal(favCall.params.get("CollapseBoxSetItems"), "false", "guardrail 37d");

  // Next run: the movie was watched once more since; the server still reports
  // its LIFETIME PlayCount (4), which must not be added again.
  jfPlayed.set("jf-user", [
    jfItem({ type: "Movie", id: "jf-movie-700", played: ago(0.5), count: 4 }),
    ...jfPlayed.get("jf-user")!.slice(1),
  ]);
  jfFavorites.set("jf-user", [{ Type: "Series", Id: "jf-series-800", UserData: { IsFavorite: true } }]);
  await importServerWatchHistory();
  assert.deepEqual(rowsOf("msu-jf"), [[700, "MOVIE", 4, false], [800, "TV", 3, true]], "+1, not +4; the dropped favorite's play-less row is gone");
  assert.deepEqual(forbidden, []);

  // Co-watch ON: everyone's viewing feeds it, so the unlinked identity's
  // history is imported — but still no favorites (they only seed a shelf).
  settings.set("feature.behavior.forYouCoWatch", "true");
  invalidateFeatureFlagCache();
  calls = [];
  await importServerWatchHistory();
  assert.deepEqual(rowsOf("msu-jf-unlinked"), [[700, "MOVIE", 1, false]]);
  assert.ok(
    !calls.some((c) => c.params.get("userId") === "jf-other" && c.params.get("Filters") === "IsFavorite"),
    "an identity linked to no account costs no favorites read",
  );
});

test("plex: with co-watch OFF an unlinked account's plays are not stored, and it never forces a full walk", async () => {
  plexSetup();
  identities.push({ id: "msu-stranger", source: "plex", serverInstance: "", sourceUserId: "3", isServerAdmin: false, userId: null, active: true });
  await importServerWatchHistory();
  assert.deepEqual(rowsOf("msu-stranger"), []);
  assert.equal(cursorOf("msu-stranger"), null);
  calls = [];
  await importServerWatchHistory();
  const historyCall = calls.find((c) => c.path === "/status/sessions/history/all")!;
  assert.ok([...historyCall.params.keys()].some((k) => k.startsWith("viewedAt")), "the never-read stranger does not drag every run back to a full walk");
});
