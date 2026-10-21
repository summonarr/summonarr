// Audit fixes (wave B2) for the never-watched loader (src/lib/never-watched-data.ts,
// guardrail 14d), over the in-memory prisma harness of tests/audit-fix-nw-data.test.mts.
// No DB, no network.
//
// What these pin:
//   C119  Radarr/Sonarr's `added` (when the title entered the arr — often long
//         before any file) is never an arrival: the window opens at the media
//         server's own addedAt / the request's delivery, so a title downloaded
//         last month is not "never watched since March".
//   C130  an unattributed play on a server that does NOT hold the title (it
//         never identified the item, or its library isn't synced) is still soft
//         evidence for a same-named library title held elsewhere — and the
//         narrowed read reaches the same verdict.
//   C078  at most EVIDENCE_AGGREGATE_CONCURRENCY (2) of the whole-table
//         PlayHistory aggregates hold a pool connection at once.
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
// C078: the evidence aggregates' in-flight count (the cached per-server first
// play — by source,serverInstance — is not one of them). With `holdAggregates`
// each one stays open for a few ms, so overlapping ones are seen together.
let inFlight = 0;
let maxInFlight = 0;
let holdAggregates = false;
shadowPrismaModel(prisma, "playHistory", {
  groupBy: async (args: Parameters<typeof groupBy>[1]) => {
    if (args.where) groupByWheres.push(args.where);
    const evidence = args.by.join(",") !== "source,serverInstance";
    if (evidence) maxInFlight = Math.max(maxInFlight, ++inFlight);
    try {
      if (holdAggregates && evidence) await new Promise((r) => setTimeout(r, 5));
      return groupBy(plays, args);
    } finally {
      if (evidence) inFlight--;
    }
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

const { loadLibraryWatchFacts, EVIDENCE_AGGREGATE_CONCURRENCY } = await import("../src/lib/never-watched-data.ts");

type ArrIndex = NonNullable<Parameters<typeof loadLibraryWatchFacts>[0]>;

// ── fixtures ────────────────────────────────────────────────────────────────
const plex = (tmdbId: number, mediaType: "MOVIE" | "TV", title: string, keys: { key: string; keys?: string[] }, instance = "") => ({
  tmdbId, mediaType, serverInstance: instance, title, year: "2020", addedAt: d("2025-03-01"),
  plexRatingKey: keys.key, plexRatingKeys: keys.keys ?? [keys.key],
});
const jf = (tmdbId: number, mediaType: "MOVIE" | "TV", title: string, id: string, ids?: string[]) => ({
  tmdbId, mediaType, serverInstance: "", title, year: "2020", addedAt: d("2025-03-01"),
  jellyfinItemId: id, jellyfinItemIds: ids ?? [id],
});
const play = (over: Row): Row => ({
  source: "plex", serverInstance: "", tmdbId: null, mediaType: null, title: "x", seasonNumber: null,
  sourceItemId: null, sourceShowId: null, startedAt: d("2025-08-01"), mediaServerUserId: "msu-deactivated",
  watched: false, completed: false, ...over,
});
const session = (over: Row): Row => ({
  source: "plex", serverInstance: "", tmdbId: null, mediaType: "MOVIE", title: "zzz", seasonNumber: null,
  sourceItemId: null, sourceShowId: null, lastSeenAt: d("2026-09-30"), ...over,
});

// The original tests/never-watched-data.test.mts fixtures, so its parity loop
// runs here too over the extended harness.
beforeEach(() => {
  groupByWheres.length = 0;
  plexLib = [
    plex(100, "MOVIE", "Alpha", { key: "rk100", keys: ["rk100", "rk100-4k"] }),
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
  jfLib = [jf(300, "MOVIE", "Charlie", "jf-300", ["jf-300", "jf-300-dup"])];
  plays = [
    play({ tmdbId: 999999, mediaType: "MOVIE", startedAt: d("2025-01-01") }),
    play({ source: "jellyfin", tmdbId: 999998, mediaType: "MOVIE", startedAt: d("2025-02-01") }),
    play({ sourceItemId: "rk100-4k", title: "Alpha" }),
    play({ source: "jellyfin", sourceItemId: "jf-300-dup", title: "Charlie" }),
    play({ tmdbId: 4040, mediaType: "MOVIE", sourceItemId: "rk400", title: "Delta (alt)" }),
    play({ tmdbId: 200, mediaType: "MOVIE", sourceItemId: "rk200", title: "Bravo", watched: true }),
    play({ sourceItemId: "ep-601", sourceShowId: "rk600", seasonNumber: 1, title: "Foxtrot" }),
    play({ tmdbId: 610, mediaType: "TV", sourceItemId: "ep-612", seasonNumber: 2, title: "Juliet" }),
    play({ sourceItemId: "unknown-key", title: "  golf " }),
    play({ sourceItemId: "nowhere", title: "Not In The Library" }),
  ];
  sessions = [session({ title: "Hotel", sourceItemId: "rk800" })];
  upstream = [{ source: "plex", serverInstance: "", itemKey: "rk900", seasonNumber: -1, mediaType: "MOVIE", playCount: 2, lastPlayedAt: d("2023-05-01") }];
  episodes = [
    { tmdbId: 600, seasonNumber: 1, episodeNumber: 1, addedAt: d("2025-03-01") },
    { tmdbId: 600, seasonNumber: 2, episodeNumber: 1, addedAt: d("2025-04-01") },
    { tmdbId: 610, seasonNumber: 1, episodeNumber: 1, addedAt: d("2025-03-01") },
    { tmdbId: 610, seasonNumber: 2, episodeNumber: 1, addedAt: d("2025-03-01") },
  ];
  requests = [];
});

type Facts = Awaited<ReturnType<typeof loadLibraryWatchFacts>>;
const byId = (facts: Facts) => new Map(facts.titles.map((t) => [t.tmdbId, t]));
const full = async (arr: ArrIndex | null = null) => byId(await loadLibraryWatchFacts(arr, { now: NOW, seasons: true }));
const narrowed = async (ids: Array<[number, "MOVIE" | "TV"]>, arr: ArrIndex | null = null) =>
  byId(await loadLibraryWatchFacts(arr, { now: NOW, seasons: true, only: ids.map(([tmdbId, mediaType]) => ({ tmdbId, mediaType })) }));
const summary = (t: Facts["titles"][number] | undefined) => t && ({
  state: t.verdict.state, plays: t.evidence.plays, softPlays: t.evidence.softPlays, playingNow: t.playingNow,
  shelfStart: t.shelfStart?.toISOString() ?? null,
  seasons: (t.seasons ?? []).map((s) => [s.seasonNumber, s.state]),
});
async function assertParity(ids: number[], arr: ArrIndex | null = null) {
  const all = await full(arr);
  for (const id of ids) {
    const t = all.get(id)!;
    const one = (await narrowed([[id, t.mediaType]], arr)).get(id);
    assert.deepEqual(summary(one), summary(t), `narrowed read of ${t.title} (${id}) matches the full read`);
  }
}

const arrIndex = (entries: Array<{ tmdbId: number; mediaType: "MOVIE" | "TV"; instance: string; added: Date | null }>): ArrIndex => {
  const byKey = new Map<string, Array<Record<string, unknown>>>();
  for (const e of entries) {
    const k = `${e.mediaType}:${e.tmdbId}`; // cleanupKey
    byKey.set(k, [...(byKey.get(k) ?? []), {
      service: e.mediaType === "MOVIE" ? "radarr" : "sonarr", instance: e.instance, arrId: e.tmdbId, tmdbId: e.tmdbId,
      tvdbId: null, title: "t", sizeOnDisk: 1, airing: null, added: e.added,
    }]);
  }
  return { byKey, tvdbOnly: new Map(), errors: [] } as unknown as ArrIndex;
};

test("C119: a Radarr `added` months before the file is never the arrival — the window opens at the media server's addedAt", async () => {
  plexLib.push({ ...plex(1190, "MOVIE", "Sierra", { key: "rk1190" }), addedAt: d("2026-08-01") });
  requests.push({ tmdbId: 1190, mediaType: "MOVIE", status: "AVAILABLE", arrInstance: "", availableAt: d("2026-08-01"), cleanedUpAt: null });
  const arr = arrIndex([{ tmdbId: 1190, mediaType: "MOVIE", instance: "", added: d("2026-03-01") }]);
  const t = (await full(arr)).get(1190)!;
  assert.equal(t.shelfStart?.toISOString(), d("2026-08-01").toISOString());
  assert.equal(t.verdict.windowStart?.toISOString(), d("2026-08-01").toISOString());
  assert.equal(t.verdict.days, 61, "two months on the shelf, not seven");
  await assertParity([1190], arr);
});

test("C119: a Sonarr `added` is not an arrival either, with no request at all", async () => {
  plexLib.push({ ...plex(1191, "TV", "Tango", { key: "rk1191" }), addedAt: d("2026-09-01") });
  const arr = arrIndex([{ tmdbId: 1191, mediaType: "TV", instance: "", added: d("2025-06-01") }]);
  const t = (await full(arr)).get(1191)!;
  assert.equal(t.shelfStart?.toISOString(), d("2026-09-01").toISOString());
  assert.equal(t.verdict.state, "neverWatched");
  assert.equal(t.verdict.days, 30);
});

test("C130: an unattributed Jellyfin play of a title only Plex holds is SOFT evidence — never unplaced", async () => {
  plexLib.push(plex(1000, "MOVIE", "Kilo", { key: "rk1000" }));
  plays.push(play({ source: "jellyfin", sourceItemId: "jf-unidentified", title: "Kilo" }));
  const facts = await loadLibraryWatchFacts(null, { now: NOW, seasons: true });
  const t = byId(facts).get(1000)!;
  assert.equal(t.verdict.state, "possiblyWatched");
  assert.equal(t.evidence.softPlays, 1);
  assert.deepEqual(t.evidence.softServers, ["jellyfin"], "the play's own server is the one named");
  assert.equal(facts.unplacedPlays, 1, "only 'Not In The Library' stays unplaced");
  await assertParity([1000]);
});

test("C130: an episode from a server whose show library isn't synced is soft evidence for the show another server holds", async () => {
  plexLib.push(plex(1001, "TV", "Uniform", { key: "rk1001" }));
  plays.push(play({ source: "jellyfin", mediaType: "TV", sourceItemId: "jf-ep-x", sourceShowId: "jf-series-unsynced", seasonNumber: 2, title: "Uniform" }));
  const t = (await full()).get(1001)!;
  assert.equal(t.verdict.state, "possiblyWatched");
  assert.deepEqual(t.evidence.softServers, ["jellyfin"]);
  await assertParity([1001]);
});

test("C130: a tmdb-less live session on a non-holding server is soft evidence too", async () => {
  plexLib.push(plex(1000, "MOVIE", "Kilo", { key: "rk1000" }));
  sessions.push(session({ source: "jellyfin", sourceItemId: "jf-unknown", title: "Kilo" }));
  const t = (await full()).get(1000)!;
  assert.equal(t.evidence.softPlays, 1);
  assert.deepEqual(t.evidence.softServers, ["jellyfin"]);
  await assertParity([1000]);
});

test("C130: parity holds when the playing server ALSO holds a different same-named title — the match is per (play, title), never 'own server first'", async () => {
  plexLib.push(plex(1000, "MOVIE", "Kilo", { key: "rk1000" }));
  jfLib.push(jf(1002, "MOVIE", "Kilo", "jf-1002"));
  plays.push(play({ source: "jellyfin", sourceItemId: "jf-unidentified", title: "Kilo" }));
  const all = await full();
  assert.equal(all.get(1000)!.verdict.state, "possiblyWatched");
  assert.equal(all.get(1002)!.verdict.state, "possiblyWatched");
  await assertParity([1000, 1002]);
});

test("C078: at most two of the evidence read's PlayHistory aggregates run at once — and the read still answers", async () => {
  holdAggregates = true;
  maxInFlight = 0;
  try {
    const t = await full();
    assert.equal(EVIDENCE_AGGREGATE_CONCURRENCY, 2);
    assert.equal(maxInFlight, 2, "five aggregates, two at a time");
    assert.equal(t.get(200)!.verdict.state, "watched", "every aggregate was still read");
    assert.equal(t.get(600)!.verdict.state, "watched");
    await assertParity([100, 300, 700]);
  } finally {
    holdAggregates = false;
  }
});
