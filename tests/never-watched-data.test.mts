// Data-layer tests for the never-watched loader (src/lib/never-watched-data.ts,
// guardrail 14d) over an in-memory prisma that honours the `where`/`groupBy`
// shapes the loader uses. No DB, no network.
//
// What these pin — each a way a watched title could be called "never watched",
// which on a page that feeds a delete is the failure that matters:
//   1. A play with NO tmdb id still clears its title through the movie's own item
//      key — including a copy in another section (plexRatingKeys, 37c) and a
//      Jellyfin duplicate (jellyfinItemIds, 37).
//   2. A play stored under ANOTHER tmdb id (a 37b conflation loser, a rematch done
//      in Plex) clears the title by key — and a play whose tmdb id already
//      matched is never counted twice.
//   3. An episode watched before its show reached the library cache (tmdb id null,
//      sourceShowId set) clears the show AND its season.
//   4. A media server's own watch record clears a title, by movie key or by show
//      key + season.
//   5. A session playing right now clears it.
//   6. An unattributed play whose title merely matches is "possibly watched";
//      one that matches nothing is counted as unplaced.
//   7. Evidence is never filtered by user, status, the watched flag, source or
//      server (structural).
//   8. NARROWED-READ PARITY: re-judging one title (what the delete route does)
//      reaches the same verdict as the full report. A tmdb-id-only narrowed read
//      used to miss 1–4 entirely.
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { shadowPrismaClientMethod, shadowPrismaModel } from "./_helpers.mts";

process.env.TOKEN_ENCRYPTION_KEY = "ab".repeat(32);
console.warn = () => {};

const { prisma } = await import("../src/lib/prisma.ts");

// ── a tiny where/groupBy evaluator ──────────────────────────────────────────
type Row = Record<string, unknown>;
type Where = Record<string, unknown>;

function matchField(v: unknown, cond: unknown): boolean {
  if (cond === null || typeof cond !== "object" || cond instanceof Date) return v === cond;
  const c = cond as Record<string, unknown>;
  if ("in" in c) return (c.in as unknown[]).includes(v);
  if ("not" in c && c.not === null) return v !== null && v !== undefined;
  if ("equals" in c) {
    return c.mode === "insensitive"
      ? String(v ?? "").toLowerCase() === String(c.equals).toLowerCase()
      : v === c.equals;
  }
  if ("startsWith" in c) return String(v).startsWith(String(c.startsWith));
  if ("contains" in c) {
    return c.mode === "insensitive"
      ? String(v ?? "").toLowerCase().includes(String(c.contains).toLowerCase())
      : String(v ?? "").includes(String(c.contains));
  }
  throw new Error(`unsupported condition ${JSON.stringify(cond)}`);
}

function matchWhere(row: Row, where: Where | undefined): boolean {
  if (!where) return true;
  for (const [k, cond] of Object.entries(where)) {
    if (k === "OR") {
      if (!(cond as Where[]).some((w) => matchWhere(row, w))) return false;
      continue;
    }
    if (!matchField(row[k], cond)) return false;
  }
  return true;
}

function groupBy(rows: Row[], args: { by: string[]; where?: Where; _count?: unknown; _max?: Record<string, true>; _min?: Record<string, true> }) {
  const groups = new Map<string, Row[]>();
  for (const r of rows.filter((x) => matchWhere(x, args.where))) {
    const key = JSON.stringify(args.by.map((f) => r[f] ?? null));
    const list = groups.get(key);
    if (list) list.push(r);
    else groups.set(key, [r]);
  }
  return [...groups.values()].map((list) => {
    const out: Row = {};
    for (const f of args.by) out[f] = list[0][f] ?? null;
    if (args._count) out._count = { _all: list.length };
    const agg = (field: string, pick: (a: Date, b: Date) => Date) =>
      list.map((r) => r[field] as Date | null).filter((d): d is Date => d instanceof Date).reduce<Date | null>((a, d) => (a ? pick(a, d) : d), null);
    if (args._max) out._max = Object.fromEntries(Object.keys(args._max).map((f) => [f, agg(f, (a, b) => (b > a ? b : a))]));
    if (args._min) out._min = Object.fromEntries(Object.keys(args._min).map((f) => [f, agg(f, (a, b) => (b < a ? b : a))]));
    return out;
  });
}

// ── state ───────────────────────────────────────────────────────────────────
const d = (iso: string) => new Date(`${iso}T00:00:00.000Z`);
const NOW = d("2026-10-01");

let plexLib: Row[] = [];
let jfLib: Row[] = [];
let plays: Row[] = [];
let sessions: Row[] = [];
let upstream: Row[] = [];
let episodes: Array<{ tmdbId: number; seasonNumber: number; episodeNumber: number; addedAt: Date | null }> = [];
const groupByWheres: Where[] = [];

const settings = new Map<string, string>([
  ["playHistoryEnabled", "true"],
  ["playHistoryPlexEnabled", "true"],
  ["playHistoryJellyfinEnabled", "true"],
]);

const findByIds = (rows: Row[]) => async (args: { where?: Where }) => rows.filter((r) => matchWhere(r, args.where));
shadowPrismaModel(prisma, "plexLibraryItem", { findMany: findByIds(plexLib) });
shadowPrismaModel(prisma, "jellyfinLibraryItem", { findMany: async (args: { where?: Where }) => jfLib.filter((r) => matchWhere(r, args.where)) });
// Re-bind after the arrays are reassigned in beforeEach.
shadowPrismaModel(prisma, "plexLibraryItem", { findMany: async (args: { where?: Where }) => plexLib.filter((r) => matchWhere(r, args.where)) });
shadowPrismaModel(prisma, "playHistory", {
  groupBy: async (args: Parameters<typeof groupBy>[1]) => {
    if (args.where) groupByWheres.push(args.where);
    return groupBy(plays, args);
  },
});
shadowPrismaModel(prisma, "activeSession", { findMany: async () => sessions });
shadowPrismaModel(prisma, "upstreamWatchEvidence", { findMany: async (args: { where?: Where }) => upstream.filter((r) => matchWhere(r, args.where)) });
shadowPrismaModel(prisma, "mediaRequest", { groupBy: async () => [] });
shadowPrismaModel(prisma, "setting", {
  findMany: async (args: { where?: Where }) =>
    [...settings.entries()].map(([key, value]) => ({ key, value })).filter((r) => matchWhere(r, args.where)),
});
shadowPrismaClientMethod(prisma, "$queryRaw", async () => {
  const bySeason = new Map<string, { tmdbId: number; seasonNumber: number; eps: Set<number>; dates: Array<Date | null> }>();
  for (const e of episodes) {
    const k = `${e.tmdbId}:${e.seasonNumber}`;
    const g = bySeason.get(k) ?? { tmdbId: e.tmdbId, seasonNumber: e.seasonNumber, eps: new Set(), dates: [] };
    g.eps.add(e.episodeNumber);
    g.dates.push(e.addedAt);
    bySeason.set(k, g);
  }
  return [...bySeason.values()].map((g) => {
    const dated = g.dates.filter((x): x is Date => x !== null);
    return {
      tmdbId: g.tmdbId,
      seasonNumber: g.seasonNumber,
      episodes: g.eps.size,
      firstAddedAt: dated.length ? new Date(Math.min(...dated.map((x) => x.getTime()))) : null,
      lastAddedAt: dated.length ? new Date(Math.max(...dated.map((x) => x.getTime()))) : null,
      undated: g.dates.length - dated.length,
    };
  });
});

const { loadLibraryWatchFacts } = await import("../src/lib/never-watched-data.ts");

// ── fixtures ────────────────────────────────────────────────────────────────
const plex = (tmdbId: number, mediaType: "MOVIE" | "TV", title: string, keys: { key: string; keys?: string[] }, instance = "") => ({
  tmdbId, mediaType, serverInstance: instance, title, year: "2020", addedAt: d("2025-03-01"),
  plexRatingKey: keys.key, plexRatingKeys: keys.keys ?? [keys.key],
});
const play = (over: Row): Row => ({
  source: "plex", serverInstance: "", tmdbId: null, mediaType: null, title: "x", seasonNumber: null,
  sourceItemId: null, sourceShowId: null, startedAt: d("2025-08-01"), mediaServerUserId: "msu-deactivated",
  watched: false, completed: false, ...over,
});

beforeEach(() => {
  groupByWheres.length = 0;
  plexLib = [
    plex(100, "MOVIE", "Alpha", { key: "rk100", keys: ["rk100", "rk100-4k"] }), // two sections (37c)
    plex(200, "MOVIE", "Bravo", { key: "rk200" }),
    plex(300, "MOVIE", "Charlie", { key: "rk300" }),
    plex(400, "MOVIE", "Delta", { key: "rk400" }),
    plex(500, "MOVIE", "Echo", { key: "rk500" }),
    plex(600, "TV", "Foxtrot", { key: "rk600" }),
    plex(700, "MOVIE", "Golf", { key: "rk700" }),
    plex(800, "MOVIE", "Hotel", { key: "rk800" }),
    plex(900, "MOVIE", "India", { key: "rk900" }),
    plex(610, "TV", "Juliet", { key: "rk610" }),
  ];
  jfLib = [
    {
      tmdbId: 300, mediaType: "MOVIE", serverInstance: "", title: "Charlie", year: "2020", addedAt: d("2025-03-01"),
      jellyfinItemId: "jf-300", jellyfinItemIds: ["jf-300", "jf-300-dup"],
    },
  ];
  plays = [
    // Establishes coverage: plex since 2025-01-01, jellyfin since 2025-02-01.
    play({ tmdbId: 999999, mediaType: "MOVIE", startedAt: d("2025-01-01") }),
    play({ source: "jellyfin", tmdbId: 999998, mediaType: "MOVIE", startedAt: d("2025-02-01") }),
    // 1. no tmdb id; the 4K section copy's key.
    play({ sourceItemId: "rk100-4k", title: "Alpha" }),
    // 1. Jellyfin duplicate copy's id.
    play({ source: "jellyfin", sourceItemId: "jf-300-dup", title: "Charlie" }),
    // 2. stored under another tmdb id, the title's own key.
    play({ tmdbId: 4040, mediaType: "MOVIE", sourceItemId: "rk400", title: "Delta (alt)" }),
    // 2b. a normal attributed play — must count ONCE although its key matches too.
    play({ tmdbId: 200, mediaType: "MOVIE", sourceItemId: "rk200", title: "Bravo", watched: true }),
    // 3. episode before the show was cached: tmdb null, show key set, season 1.
    play({ sourceItemId: "ep-601", sourceShowId: "rk600", seasonNumber: 1, title: "Foxtrot" }),
    // An ordinary attributed episode play: Juliet season 2.
    play({ tmdbId: 610, mediaType: "TV", sourceItemId: "ep-612", seasonNumber: 2, title: "Juliet" }),
    // 6. unattributed, no key match, same title as Golf → possibly watched.
    play({ sourceItemId: "unknown-key", title: "  golf " }),
    // 6. unattributed, matches nothing at all → unplaced.
    play({ sourceItemId: "nowhere", title: "Not In The Library" }),
  ];
  sessions = [
    // 5. playing now, matched by item key only.
    { source: "plex", serverInstance: "", tmdbId: null, mediaType: "MOVIE", title: "Hotel", seasonNumber: null, sourceItemId: "rk800", sourceShowId: null, lastSeenAt: d("2026-09-30") },
  ];
  upstream = [
    // 4. Plex's own record of India.
    { source: "plex", serverInstance: "", itemKey: "rk900", seasonNumber: -1, mediaType: "MOVIE", playCount: 2, lastPlayedAt: d("2023-05-01") },
  ];
  episodes = [
    { tmdbId: 600, seasonNumber: 1, episodeNumber: 1, addedAt: d("2025-03-01") },
    { tmdbId: 600, seasonNumber: 2, episodeNumber: 1, addedAt: d("2025-04-01") },
    { tmdbId: 600, seasonNumber: 2, episodeNumber: 2, addedAt: d("2025-05-01") },
    { tmdbId: 600, seasonNumber: 3, episodeNumber: 1, addedAt: null }, // undated → unobservable
    { tmdbId: 610, seasonNumber: 1, episodeNumber: 1, addedAt: d("2025-03-01") },
    { tmdbId: 610, seasonNumber: 2, episodeNumber: 1, addedAt: d("2025-03-01") },
  ];
});

const byId = (facts: Awaited<ReturnType<typeof loadLibraryWatchFacts>>) => new Map(facts.titles.map((t) => [t.tmdbId, t]));

test("1. a play with no tmdb id clears its title through ANY copy's key — Plex sections (37c) and Jellyfin duplicates (37)", async () => {
  const t = byId(await loadLibraryWatchFacts(null, { now: NOW }));
  assert.equal(t.get(100)!.verdict.state, "watched", "the 4K section copy's ratingKey");
  assert.equal(t.get(300)!.verdict.state, "watched", "the Jellyfin duplicate's item id");
});

test("2. a play stored under another tmdb id clears the title by key; an attributed play is never counted twice", async () => {
  const t = byId(await loadLibraryWatchFacts(null, { now: NOW }));
  assert.equal(t.get(400)!.verdict.state, "watched");
  assert.equal(t.get(200)!.evidence.plays, 1, "the tmdb-id group and the key group are the same play");
});

test("3. an episode recorded before its show was cached clears the show AND that season — not the others", async () => {
  const t = byId(await loadLibraryWatchFacts(null, { now: NOW, seasons: true }));
  const show = t.get(600)!;
  assert.equal(show.verdict.state, "watched");
  const seasons = new Map((show.seasons ?? []).map((s) => [s.seasonNumber, s]));
  assert.equal(seasons.get(1)!.state, "watched");
  assert.equal(seasons.get(2)!.state, "neverWatched");
  assert.equal(seasons.get(2)!.windowStart?.toISOString(), d("2025-04-01").toISOString(), "the season's first episode");
  assert.equal(seasons.get(3)!.state, "unobservable", "an undated episode makes the season's arrival unknowable");
});

test("an attributed episode play clears exactly its own season", async () => {
  const show = byId(await loadLibraryWatchFacts(null, { now: NOW, seasons: true })).get(610)!;
  assert.equal(show.verdict.state, "watched");
  assert.deepEqual((show.seasons ?? []).map((s) => [s.seasonNumber, s.state]), [[1, "neverWatched"], [2, "watched"]]);
});

test("4 + 5. the media server's own record and a session playing now each clear a title", async () => {
  const t = byId(await loadLibraryWatchFacts(null, { now: NOW }));
  assert.equal(t.get(900)!.verdict.state, "watched", "upstream record by movie key");
  assert.equal(t.get(800)!.verdict.state, "watched", "playing now, matched by item key");
  assert.equal(t.get(800)!.playingNow, true);
});

test("6. a title-only match is 'possibly watched'; a play matching nothing is counted, not dropped", async () => {
  const facts = await loadLibraryWatchFacts(null, { now: NOW });
  const t = byId(facts);
  assert.equal(t.get(700)!.verdict.state, "possiblyWatched");
  assert.deepEqual(t.get(700)!.evidence.softServers, ["plex"]);
  assert.equal(facts.unplacedPlays, 1);
  assert.equal(t.get(500)!.verdict.state, "neverWatched", "Echo: nothing at all — the one true positive");
});

test("upstream TV evidence by show key + season clears exactly that season", async () => {
  upstream.push({ source: "plex", serverInstance: "", itemKey: "rk600", seasonNumber: 2, mediaType: "TV", playCount: 1, lastPlayedAt: null });
  const show = byId(await loadLibraryWatchFacts(null, { now: NOW, seasons: true })).get(600)!;
  const seasons = new Map((show.seasons ?? []).map((s) => [s.seasonNumber, s]));
  assert.equal(seasons.get(2)!.state, "watched");
  assert.equal(show.evidence.undated, true, "an undated upstream record blocks the idle rule");
});

test("7. evidence reads are never filtered by user, status, the watched flag, source or server (structural)", async () => {
  await loadLibraryWatchFacts(null, { now: NOW, seasons: true });
  const forbidden = ["mediaServerUserId", "mediaServerUser", "watched", "completed", "source", "serverInstance"];
  for (const w of groupByWheres) {
    for (const k of forbidden) assert.ok(!(k in w), `a play-evidence read filtered on ${k}: ${JSON.stringify(w)}`);
  }
});

test("8. narrowed-read parity: re-judging one title reaches the full report's verdict, evidence and seasons", async () => {
  const full = byId(await loadLibraryWatchFacts(null, { now: NOW, seasons: true }));
  for (const [tmdbId, t] of full) {
    const one = await loadLibraryWatchFacts(null, { now: NOW, seasons: true, only: [{ tmdbId, mediaType: t.mediaType }] });
    assert.equal(one.titles.length, 1, `${tmdbId}`);
    assert.equal(one.titles[0].verdict.state, t.verdict.state, `verdict for ${t.title}`);
    assert.equal(one.titles[0].evidence.plays, t.evidence.plays, `plays for ${t.title}`);
    assert.equal(one.titles[0].evidence.softPlays, t.evidence.softPlays, `soft plays for ${t.title}`);
    assert.deepEqual(
      (one.titles[0].seasons ?? []).map((s) => [s.seasonNumber, s.state]),
      (t.seasons ?? []).map((s) => [s.seasonNumber, s.state]),
      `seasons for ${t.title}`,
    );
  }
});

test("a holder on an untracked source is unobservable, naming the server", async () => {
  jfLib.push({ tmdbId: 500, mediaType: "MOVIE", serverInstance: "remote", title: "Echo", year: "2020", addedAt: d("2025-03-01"), jellyfinItemId: "jf-500", jellyfinItemIds: [] });
  const echo = byId(await loadLibraryWatchFacts(null, { now: NOW })).get(500)!;
  assert.equal(echo.verdict.state, "unobservable");
  assert.equal(echo.verdict.reason, "noHistory", "jellyfin:remote has recorded nothing");
  assert.deepEqual(echo.verdict.reasonServers, ["jellyfin:remote"]);
});
