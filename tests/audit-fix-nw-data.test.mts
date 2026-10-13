// Audit fixes for the never-watched loader (src/lib/never-watched-data.ts,
// guardrail 14d) and the report's "eligible" (src/lib/never-watched-report.ts),
// over the same in-memory prisma idiom as tests/never-watched-data.test.mts —
// extended with `hasSome` (the narrowed read's foreign-key lookup), per-instance
// / per-stamp request groups, and per-source episode counts. No DB, no network.
//
// What these pin:
//   C125  the narrowed read's title filter carries EVERY holder's own title.
//   C126  past NARROW_TITLE_FILTER_MAX titles the unattributed read is the full
//         read's own (no OR of ILIKEs), and still reaches parity.
//   C129  an unattributed play / live session keeps its STORED media type.
//   #1/#4 a key on two titles credits both (plays, upstream, sessions), in
//         either library row order; a session credits its tmdb title AND its
//         key's title, once each.
//   #2    the narrowed read places a tmdb-less play keyed to an UNCHOSEN title
//         there, never as soft evidence for a same-named chosen one.
//   #3    a stamped or re-added-since request's availableAt is not an arrival.
//   C134  a show the two servers number differently gets other seasons' plays
//         as soft evidence; a partial copy does not.
//   C123  the report never calls a title eligible while its service is unreadable.
//   And the original never-watched-data fixtures still reach full/narrowed parity.
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
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

const { loadLibraryWatchFacts, NARROW_TITLE_FILTER_MAX } = await import("../src/lib/never-watched-data.ts");
const { arrServiceReadable } = await import("../src/lib/never-watched-report.ts");
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
const unattributedWhere = () => groupByWheres.find((w) => w.tmdbId === null);

test("the original fixtures reach full/narrowed parity over the extended harness", async () => {
  await assertParity([...(await full()).keys()]);
});

test("C125: the narrowed title filter carries every holder's own title — 'The Office (US)' on Plex, 'The Office' on Jellyfin", async () => {
  plexLib.push(plex(650, "TV", "The Office (US)", { key: "rk650" }));
  jfLib.push(jf(650, "TV", "The Office", "jf-650"));
  plays.push(play({ source: "jellyfin", mediaType: "TV", sourceItemId: "jf-ep", sourceShowId: "jf-gone", seasonNumber: 1, title: "The Office" }));
  const t = (await full()).get(650)!;
  assert.equal(t.verdict.state, "possiblyWatched");
  assert.equal(t.evidence.softPlays, 1);
  assert.deepEqual(t.evidence.softServers, ["jellyfin"]);
  await assertParity([650]);
});

test("C126: past NARROW_TITLE_FILTER_MAX titles the unattributed read is unfiltered — and still reaches parity; one title keeps its filter", async () => {
  const many: Array<[number, "MOVIE" | "TV"]> = [];
  for (let i = 0; i <= NARROW_TITLE_FILTER_MAX; i++) {
    plexLib.push(plex(10_000 + i, "MOVIE", `Bulk ${i}`, { key: `rk-bulk-${i}` }));
    many.push([10_000 + i, "MOVIE"]);
  }
  plays.push(play({ sourceItemId: "bulk-unknown", title: "Bulk 7" }));
  many.push([700, "MOVIE"]);
  const fullRead = await full();
  groupByWheres.length = 0;
  const wide = await narrowed(many);
  const where = unattributedWhere();
  assert.ok(where, "the unattributed read ran");
  assert.ok(!("OR" in where), `no ILIKE list past the bound: ${JSON.stringify(where).slice(0, 120)}`);
  for (const [id] of many) assert.deepEqual(summary(wide.get(id)), summary(fullRead.get(id)), `parity for ${id}`);
  assert.equal(wide.get(10_007)!.verdict.state, "possiblyWatched");
  groupByWheres.length = 0;
  await narrowed([[700, "MOVIE"]]);
  assert.ok(unattributedWhere() && "OR" in unattributedWhere()!, "a one-title read keeps its title filter");
});

test("C129: an unattributed episode with no season keeps its stored TV type — soft on the show, never on a same-named film", async () => {
  plexLib.push(plex(620, "TV", "Lima", { key: "rk620" }), plex(621, "MOVIE", "Lima", { key: "rk621" }));
  plays.push(play({ mediaType: "TV", title: "Lima", sourceItemId: "ep-lima", sourceShowId: "rk-lima-old", seasonNumber: null }));
  const t = await full();
  assert.equal(t.get(620)!.verdict.state, "possiblyWatched");
  assert.deepEqual(t.get(620)!.evidence.softServers, ["plex"]);
  assert.equal(t.get(621)!.verdict.state, "neverWatched", "the film was never played");
  assert.equal(t.get(621)!.evidence.softPlays, 0);
  await assertParity([620, 621]);
});

test("C129: a tmdb-less live session with no season keeps its stored TV type too", async () => {
  plexLib.push(plex(620, "TV", "Lima", { key: "rk620" }), plex(621, "MOVIE", "Lima", { key: "rk621" }));
  sessions.push(session({ mediaType: "TV", title: "Lima", sourceItemId: "ep-lima", sourceShowId: "rk-lima-old", seasonNumber: null }));
  const t = await full();
  assert.equal(t.get(620)!.evidence.softPlays, 1);
  assert.equal(t.get(621)!.evidence.softPlays, 0);
});

// A = conflated item R (claims tmdb 10 and 20); B = clean item S claiming 20,
// which also carries R as a duplicate key (37b/37c).
const rowA = () => plex(10, "MOVIE", "Alpha One", { key: "R", keys: ["R"] });
const rowB = () => plex(20, "MOVIE", "Bravo Two", { key: "S", keys: ["S", "R"] });
for (const order of ["AB", "BA"] as const) {
  const lib = () => (order === "AB" ? [rowA(), rowB()] : [rowB(), rowA()]);

  test(`#1 (${order}): an upstream record on a shared key clears BOTH titles`, async () => {
    plexLib.push(...lib());
    upstream.push({ source: "plex", serverInstance: "", itemKey: "R", seasonNumber: -1, mediaType: "MOVIE", playCount: 3, lastPlayedAt: d("2025-06-01") });
    const t = await full();
    assert.equal(t.get(10)!.verdict.state, "watched");
    assert.equal(t.get(20)!.verdict.state, "watched");
    await assertParity([10, 20]);
  });

  test(`#1 (${order}): a play of the shared key stored under the OTHER tmdb id credits both, neither twice`, async () => {
    plexLib.push(...lib());
    plays.push(play({ tmdbId: 20, mediaType: "MOVIE", sourceItemId: "R", title: "Bravo Two" }));
    const t = await full();
    assert.equal(t.get(10)!.verdict.state, "watched");
    assert.equal(t.get(10)!.evidence.plays, 1);
    assert.equal(t.get(20)!.evidence.plays, 1, "the tmdb-id group and the key group are the same play");
    await assertParity([10, 20]);
  });

  test(`#1/#4 (${order}): a session of the shared key is playing now on both titles, once each`, async () => {
    plexLib.push(...lib());
    sessions.push(session({ tmdbId: 20, sourceItemId: "R", title: "Bravo Two" }));
    const t = await full();
    assert.equal(t.get(10)!.playingNow, true);
    assert.equal(t.get(20)!.playingNow, true);
    assert.equal(t.get(10)!.evidence.plays, 1);
    assert.equal(t.get(20)!.evidence.plays, 1);
    await assertParity([10, 20]);
  });
}

test("#4: a session whose tmdb id names ANOTHER library title marks the key's owner playing too", async () => {
  plexLib.push(plex(31, "MOVIE", "X-Ray", { key: "kx" }), plex(32, "MOVIE", "Yankee", { key: "ky" }));
  sessions.push(session({ tmdbId: 32, sourceItemId: "kx", title: "Yankee" }));
  const t = await full();
  assert.equal(t.get(31)!.playingNow, true);
  assert.equal(t.get(31)!.verdict.state, "watched");
  assert.equal(t.get(31)!.evidence.plays, 1);
  assert.equal(t.get(32)!.playingNow, true);
  assert.equal(t.get(32)!.evidence.plays, 1);
  await assertParity([31, 32]);
  const both = await narrowed([[31, "MOVIE"], [32, "MOVIE"]]);
  assert.deepEqual(summary(both.get(31)), summary(t.get(31)));
  assert.deepEqual(summary(both.get(32)), summary(t.get(32)));
});

test("#2: a tmdb-less play keyed to an UNCHOSEN same-named title is placed there in the narrowed read, never soft", async () => {
  plexLib.push(
    plex(1091, "MOVIE", "The Thing", { key: "rk1", keys: ["rk1", "rk1-4k"] }),
    plex(60935, "MOVIE", "The Thing", { key: "rk2" }),
    plex(2316, "TV", "The Office", { key: "us" }),
    plex(2996, "TV", "The Office", { key: "uk" }),
  );
  plays.push(
    play({ sourceItemId: "rk1", title: "The Thing" }),
    play({ sourceItemId: "rk1-4k", title: "The Thing" }), // another copy's key (plexRatingKeys)
    play({ mediaType: "TV", sourceItemId: "uk-ep", sourceShowId: "uk", seasonNumber: 1, title: "The Office" }),
  );
  const t = await full();
  assert.equal(t.get(1091)!.verdict.state, "watched");
  assert.equal(t.get(60935)!.verdict.state, "neverWatched");
  assert.equal(t.get(60935)!.evidence.softPlays, 0);
  assert.equal(t.get(2996)!.verdict.state, "watched");
  assert.equal(t.get(2316)!.evidence.softPlays, 0);
  await assertParity([1091, 60935, 2316, 2996]);
});

test("#2: a tmdb-less live session keyed to an unchosen same-named title is not soft evidence in the narrowed read either", async () => {
  plexLib.push(plex(1091, "MOVIE", "The Thing", { key: "rk1" }), plex(60935, "MOVIE", "The Thing", { key: "rk2" }));
  jfLib.push(jf(1091, "MOVIE", "The Thing", "jf-1091", ["jf-1091", "jf-1091-dup"]), jf(60935, "MOVIE", "The Thing", "jf-60935"));
  sessions.push(session({ sourceItemId: "rk1", title: "The Thing" }), session({ source: "jellyfin", sourceItemId: "jf-1091-dup", title: "The Thing" }));
  const t = await full();
  assert.equal(t.get(1091)!.playingNow, true);
  assert.equal(t.get(60935)!.playingNow, false);
  assert.equal(t.get(60935)!.evidence.softPlays, 0);
  await assertParity([1091, 60935]);
});

const arrIndex = (entries: Array<{ tmdbId: number; instance: string; added: Date | null }>): ArrIndex => {
  const byKey = new Map<string, Array<Record<string, unknown>>>();
  for (const e of entries) {
    const k = `MOVIE:${e.tmdbId}`; // cleanupKey
    byKey.set(k, [...(byKey.get(k) ?? []), {
      service: "radarr", instance: e.instance, arrId: e.tmdbId, tmdbId: e.tmdbId, tvdbId: null, title: "t", sizeOnDisk: 1, airing: null, added: e.added,
    }]);
  }
  return { byKey, tvdbOnly: new Map(), errors: [] } as unknown as ArrIndex;
};

test("#3: a fulfilment older than the instance's own re-add is the deleted copy's — the window starts at the re-add", async () => {
  plexLib.push({ ...plex(690, "MOVIE", "Quebec", { key: "rk690" }), addedAt: d("2026-09-20") });
  requests.push({ tmdbId: 690, mediaType: "MOVIE", status: "AVAILABLE", arrInstance: "", availableAt: d("2023-01-01"), cleanedUpAt: null });
  const readded = arrIndex([{ tmdbId: 690, instance: "", added: d("2026-09-20") }]);
  assert.equal((await full(readded)).get(690)!.shelfStart?.toISOString(), d("2026-09-20").toISOString());
  await assertParity([690], readded);
  // Control: an arr entry from BEFORE the fulfilment — a continuous presence,
  // so the delivery still lengthens the claim past a reset media-server date.
  // The arr's own earlier add is never an arrival (audit C119): the delivery is.
  const continuous = arrIndex([{ tmdbId: 690, instance: "", added: d("2022-12-01") }]);
  assert.equal((await full(continuous)).get(690)!.shelfStart?.toISOString(), d("2023-01-01").toISOString());
  // Another instance's re-add says nothing about this request's copy.
  const other = arrIndex([{ tmdbId: 690, instance: "4k", added: d("2026-09-20") }]);
  assert.equal((await full(other)).get(690)!.shelfStart?.toISOString(), d("2023-01-01").toISOString());
});

test("#3: a request stamped by a deliberate delete (cleanedUpAt) is never an arrival", async () => {
  plexLib.push({ ...plex(691, "MOVIE", "Romeo", { key: "rk691" }), addedAt: d("2026-09-20") });
  requests.push(
    { tmdbId: 691, mediaType: "MOVIE", status: "AVAILABLE", arrInstance: "", availableAt: d("2023-01-01"), cleanedUpAt: d("2026-05-01") },
    { tmdbId: 691, mediaType: "MOVIE", status: "AVAILABLE", arrInstance: "4k", availableAt: d("2026-09-25"), cleanedUpAt: null },
  );
  const t = (await full()).get(691)!;
  assert.equal(t.shelfStart?.toISOString(), d("2026-09-20").toISOString(), "the media server's own date, not the deleted copy's delivery");
  await assertParity([691]);
});

test("C134: a show the two servers number differently gets other seasons' plays as SOFT evidence; a partial copy does not", async () => {
  // Oscar: Plex S1 = 4 episodes, Jellyfin S1 = 2 + S2 = 2 (TVDB vs TMDB order).
  plexLib.push(plex(670, "TV", "Oscar", { key: "rk670" }));
  jfLib.push(jf(670, "TV", "Oscar", "jf-670"));
  for (const e of [1, 2, 3, 4]) episodes.push({ source: "plex", tmdbId: 670, seasonNumber: 1, episodeNumber: e, addedAt: d("2025-03-01") });
  for (const s of [1, 2]) for (const e of [1, 2]) episodes.push({ source: "jellyfin", tmdbId: 670, seasonNumber: s, episodeNumber: e, addedAt: d("2025-03-01") });
  plays.push(play({ tmdbId: 670, mediaType: "TV", sourceItemId: "ep-670-3", seasonNumber: 1, title: "Oscar" }));
  // Papa: Plex S1-S3, Jellyfin S1 only with the same count — a partial copy.
  plexLib.push(plex(680, "TV", "Papa", { key: "rk680" }));
  jfLib.push(jf(680, "TV", "Papa", "jf-680"));
  for (const e of [1, 2]) {
    episodes.push({ source: "plex", tmdbId: 680, seasonNumber: 1, episodeNumber: e, addedAt: d("2025-03-01") });
    episodes.push({ source: "jellyfin", tmdbId: 680, seasonNumber: 1, episodeNumber: e, addedAt: d("2025-03-01") });
  }
  episodes.push({ source: "plex", tmdbId: 680, seasonNumber: 2, episodeNumber: 1, addedAt: d("2025-03-01") });
  episodes.push({ source: "plex", tmdbId: 680, seasonNumber: 3, episodeNumber: 1, addedAt: d("2025-03-01") });
  plays.push(play({ tmdbId: 680, mediaType: "TV", sourceItemId: "ep-680-1", seasonNumber: 1, title: "Papa" }));
  const t = await full();
  assert.deepEqual(summary(t.get(670))!.seasons, [[1, "watched"], [2, "possiblyWatched"]]);
  assert.deepEqual(summary(t.get(680))!.seasons, [[1, "watched"], [2, "neverWatched"], [3, "neverWatched"]]);
  await assertParity([670, 680]);
});

test("R2-nw#3: a season one server holds PARTIALLY is not a renumbering; counts that CROSS are", async () => {
  // Quebec: both servers hold S1-S3, Jellyfin's S3 is one episode short (not
  // scanned yet). Only S1 was watched: S2 and S3 stay never watched.
  plexLib.push(plex(710, "TV", "Quebec", { key: "rk710" }));
  jfLib.push(jf(710, "TV", "Quebec", "jf-710"));
  for (const sn of [1, 2, 3]) for (const e of [1, 2, 3]) {
    episodes.push({ source: "plex", tmdbId: 710, seasonNumber: sn, episodeNumber: e, addedAt: d("2025-03-01") });
    if (!(sn === 3 && e === 3)) episodes.push({ source: "jellyfin", tmdbId: 710, seasonNumber: sn, episodeNumber: e, addedAt: d("2025-03-01") });
  }
  plays.push(play({ tmdbId: 710, mediaType: "TV", sourceItemId: "ep-710-1", seasonNumber: 1, title: "Quebec" }));
  // Romeo: both hold S1 and S2, Plex 3+1 and Jellyfin 2+2 — the same four
  // episodes numbered differently, so a play's season can't be placed.
  plexLib.push(plex(720, "TV", "Romeo", { key: "rk720" }));
  jfLib.push(jf(720, "TV", "Romeo", "jf-720"));
  for (const e of [1, 2, 3]) episodes.push({ source: "plex", tmdbId: 720, seasonNumber: 1, episodeNumber: e, addedAt: d("2025-03-01") });
  episodes.push({ source: "plex", tmdbId: 720, seasonNumber: 2, episodeNumber: 1, addedAt: d("2025-03-01") });
  for (const sn of [1, 2]) for (const e of [1, 2]) episodes.push({ source: "jellyfin", tmdbId: 720, seasonNumber: sn, episodeNumber: e, addedAt: d("2025-03-01") });
  plays.push(play({ tmdbId: 720, mediaType: "TV", sourceItemId: "ep-720-1", seasonNumber: 1, title: "Romeo" }));
  const t = await full();
  assert.deepEqual(summary(t.get(710))!.seasons, [[1, "watched"], [2, "neverWatched"], [3, "neverWatched"]]);
  assert.deepEqual(summary(t.get(720))!.seasons, [[1, "watched"], [2, "possiblyWatched"]]);
  await assertParity([710, 720]);
});

test("C123: the report never calls a title eligible while an instance of its service could not be listed", () => {
  const down = [{ service: "radarr" as const, instance: "4k", error: "HTTP 503" }];
  assert.equal(arrServiceReadable(down, "MOVIE"), false);
  assert.equal(arrServiceReadable(down, "TV"), true);
  assert.equal(arrServiceReadable([], "MOVIE"), true);
  assert.equal(arrServiceReadable([{ service: "sonarr", instance: "", error: "x" }], "TV"), false);
  // Structural: "eligible" carries the check (the delete route's refusal).
  const src = readFileSync(new URL("../src/lib/never-watched-report.ts", import.meta.url), "utf8");
  const line = src.split("\n").find((l) => /const eligible =/.test(l)) ?? "";
  assert.match(line, /arrServiceReadable\(arr\.errors, t\.mediaType\)/, line);
});
