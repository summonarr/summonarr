// Audit fix 2, R7 item 1: the Plex writer's dedupe (src/lib/plex-dedupe.ts)
// must hand the never-watched loader (src/lib/never-watched-data.ts) EVERY key
// a title answers to (guardrails 37c + 14d). A write-side "one owner per key"
// strip removed a conflated item's key from the other titles it claims, so a
// watch recorded on that key stopped crediting them — a false "never watched"
// on a list that feeds a delete. These tests run the writer's real output
// through the loader, over the in-memory prisma idiom of
// tests/audit-fix-nw-data.test.mts. No DB, no network.
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
  if ("hasSome" in c) return Array.isArray(v) && (c.hasSome as unknown[]).some((x) => (v as unknown[]).includes(x));
  if ("not" in c && c.not === null) return v !== null && v !== undefined;
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
let requests: Row[] = [];
let episodes: Array<{ source?: string; tmdbId: number; seasonNumber: number; episodeNumber: number; addedAt: Date | null }> = [];
const groupByWheres: Where[] = [];

const settings = new Map<string, string>([
  ["playHistoryEnabled", "true"],
  ["playHistoryPlexEnabled", "true"],
  ["playHistoryJellyfinEnabled", "true"],
]);

shadowPrismaModel(prisma, "plexLibraryItem", { findMany: async (args: { where?: Where }) => plexLib.filter((r) => matchWhere(r, args.where)) });
shadowPrismaModel(prisma, "jellyfinLibraryItem", { findMany: async (args: { where?: Where }) => jfLib.filter((r) => matchWhere(r, args.where)) });
shadowPrismaModel(prisma, "playHistory", {
  groupBy: async (args: Parameters<typeof groupBy>[1]) => {
    if (args.where) groupByWheres.push(args.where);
    return groupBy(plays, args);
  },
});
shadowPrismaModel(prisma, "activeSession", { findMany: async () => sessions });
shadowPrismaModel(prisma, "upstreamWatchEvidence", { findMany: async (args: { where?: Where }) => upstream.filter((r) => matchWhere(r, args.where)) });
shadowPrismaModel(prisma, "mediaRequest", { groupBy: async (args: Parameters<typeof groupBy>[1]) => groupBy(requests, args) });
shadowPrismaModel(prisma, "setting", {
  findMany: async (args: { where?: Where }) =>
    [...settings.entries()].map(([key, value]) => ({ key, value })).filter((r) => matchWhere(r, args.where)),
});
shadowPrismaClientMethod(prisma, "$queryRaw", async () => {
  const bySeason = new Map<string, { tmdbId: number; seasonNumber: number; eps: Set<number>; plex: Set<number>; jf: Set<number>; dates: Array<Date | null> }>();
  for (const e of episodes) {
    const k = `${e.tmdbId}:${e.seasonNumber}`;
    const g = bySeason.get(k) ?? { tmdbId: e.tmdbId, seasonNumber: e.seasonNumber, eps: new Set(), plex: new Set(), jf: new Set(), dates: [] };
    g.eps.add(e.episodeNumber);
    if (e.source === "plex") g.plex.add(e.episodeNumber);
    if (e.source === "jellyfin") g.jf.add(e.episodeNumber);
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
      plexEpisodes: g.plex.size,
      jellyfinEpisodes: g.jf.size,
    };
  });
});

const { loadLibraryWatchFacts } = await import("../src/lib/never-watched-data.ts");
const { deduplicatePlexRowsByRatingKey } = await import("../src/lib/plex-dedupe.ts");

const plex = (tmdbId: number, title: string, key: string, keys: string[]) => ({
  tmdbId, mediaType: "MOVIE" as const, serverInstance: "", title, year: "2020", addedAt: d("2025-03-01"),
  plexRatingKey: key, plexRatingKeys: keys,
});
const play = (over: Row): Row => ({
  source: "plex", serverInstance: "", tmdbId: null, mediaType: null, title: "x", seasonNumber: null,
  sourceItemId: null, sourceShowId: null, startedAt: d("2025-08-01"), mediaServerUserId: "msu-1",
  watched: false, completed: false, ...over,
});

beforeEach(() => {
  groupByWheres.length = 0;
  plexLib = [];
  jfLib = [];
  // A recorded play long before the titles arrived, so Plex history coverage
  // opens before them and the titles are judged at all.
  plays = [play({ tmdbId: 999999, mediaType: "MOVIE", startedAt: d("2025-01-01") })];
  sessions = [];
  upstream = [];
  requests = [];
  episodes = [];
});

type Facts = Awaited<ReturnType<typeof loadLibraryWatchFacts>>;
const states = (facts: Facts) => Object.fromEntries(facts.titles.map((t) => [t.tmdbId, t.verdict.state]));

/** The full-replace write: the writer's dedupe output becomes the stored library. */
async function writeLibrary(batch: ReturnType<typeof plex>[]) {
  const kept = await deduplicatePlexRowsByRatingKey(batch, "MOVIE", "", "sync");
  plexLib = kept.map((r) => ({ ...r }));
  return kept;
}

// A = the conflated 4K item R (claims tmdb 10 and 20); B = 20's clean copy S in
// another section, which carries R as a duplicate key (plexLibraryRatingKeys).
const conflatedPair = () => [plex(10, "Alpha One", "R", ["R"]), plex(20, "Bravo Two", "S", ["S", "R"])];

for (const order of ["AB", "BA"] as const) {
  const batch = () => (order === "AB" ? conflatedPair() : conflatedPair().reverse());

  test(`(${order}) an upstream record on the shared key still clears BOTH titles after the writer runs`, async () => {
    const kept = await writeLibrary(batch());
    assert.deepEqual(
      Object.fromEntries(kept.map((r) => [r.tmdbId, r.plexRatingKeys])),
      { 10: ["R"], 20: ["S", "R"] },
      "the writer keeps R on B's array",
    );
    upstream.push({ source: "plex", serverInstance: "", itemKey: "R", seasonNumber: -1, mediaType: "MOVIE", playCount: 3, lastPlayedAt: d("2025-06-01") });
    const s = states(await loadLibraryWatchFacts(null, { now: NOW, seasons: true }));
    assert.equal(s[10], "watched");
    assert.equal(s[20], "watched", "B was watched through its 4K copy R — never 'never watched'");
  });

  test(`(${order}) a play of the shared key stored under the conflated item's tmdb id credits B too`, async () => {
    await writeLibrary(batch());
    plays.push(play({ tmdbId: 10, mediaType: "MOVIE", sourceItemId: "R", title: "Alpha One" }));
    const facts = await loadLibraryWatchFacts(null, { now: NOW, seasons: true });
    const b = facts.titles.find((t) => t.tmdbId === 20)!;
    assert.equal(b.verdict.state, "watched");
    assert.equal(b.evidence.plays, 1);
  });
}

test("with a canonical 37b conflation too, the dropped candidate goes but the key stays on the clean copy's array", async () => {
  // R claims 10, 20 and 30 (canonically on 10 and 30 in this batch); 20's clean
  // copy S carries R. 37b keeps 10 for R and drops 30; B keeps [S, R].
  const kept = await writeLibrary([plex(30, "Charlie", "R", ["R"]), ...conflatedPair()]);
  assert.deepEqual(kept.map((r) => r.tmdbId).sort((a, b) => a - b), [10, 20]);
  sessions.push({ source: "plex", serverInstance: "", tmdbId: 10, mediaType: "MOVIE", title: "Alpha One", seasonNumber: null, sourceItemId: "R", sourceShowId: null, lastSeenAt: d("2026-09-30") });
  const facts = await loadLibraryWatchFacts(null, { now: NOW, seasons: true });
  const b = facts.titles.find((t) => t.tmdbId === 20)!;
  assert.equal(b.playingNow, true, "a session of R is playing B's 4K copy");
});
