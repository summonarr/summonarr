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
//   9. A fulfilled request's availableAt is an ARRIVAL date (the earliest of
//      every arrival source opens the window) — AVAILABLE requests only, and the
//      EARLIEST of them.
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
let requests: Row[] = [];
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
shadowPrismaModel(prisma, "mediaRequest", { groupBy: async (args: Parameters<typeof groupBy>[1]) => groupBy(requests, args) });
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
    plex(630, "TV", "Mike", { key: "rk630" }),
    plex(640, "MOVIE", "November", { key: "rk640" }),
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
    // 5. playing now, matched by the SHOW's key only: the episode's own key and
    //    its title match nothing, so neither the item-key nor the soft path can
    //    rescue it.
    { source: "plex", serverInstance: "", tmdbId: null, mediaType: "TV", title: "Mike (episode title)", seasonNumber: 1, sourceItemId: "ep-631", sourceShowId: "rk630", lastSeenAt: d("2026-09-30") },
    // 5. playing now, matched by tmdb id only (a key and a title that match nothing).
    { source: "plex", serverInstance: "", tmdbId: 640, mediaType: "MOVIE", title: "zzz", seasonNumber: null, sourceItemId: "no-such-key", sourceShowId: null, lastSeenAt: d("2026-09-30") },
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
    { tmdbId: 630, seasonNumber: 1, episodeNumber: 1, addedAt: d("2025-03-01") },
  ];
  requests = [];
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

test("5. a session playing now clears a SHOW by its show key (and its season), and a title by tmdb id", async () => {
  const t = byId(await loadLibraryWatchFacts(null, { now: NOW, seasons: true }));
  const mike = t.get(630)!;
  assert.equal(mike.verdict.state, "watched", "playing now, matched by show key");
  assert.equal(mike.playingNow, true, "the cleanup playingNow exclusion reads this for a show too");
  assert.deepEqual((mike.seasons ?? []).map((s) => [s.seasonNumber, s.state]), [[1, "watched"]]);
  assert.equal(mike.evidence.softPlays, 0, "hard evidence, not a title match");
  const november = t.get(640)!;
  assert.equal(november.verdict.state, "watched", "playing now, matched by tmdb id");
  assert.equal(november.playingNow, true);
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
  // A show whose ONLY evidence is the media server's own record by SHOW key:
  // the narrowed upstream read must ask for show keys too, not movie keys alone.
  plexLib.push(plex(620, "TV", "Kilo", { key: "rk620" }));
  episodes.push({ tmdbId: 620, seasonNumber: 1, episodeNumber: 1, addedAt: d("2025-03-01") });
  upstream.push({ source: "plex", serverInstance: "", itemKey: "rk620", seasonNumber: 1, mediaType: "TV", playCount: 1, lastPlayedAt: d("2025-06-01") });
  const full = byId(await loadLibraryWatchFacts(null, { now: NOW, seasons: true }));
  assert.equal(full.get(620)!.verdict.state, "watched", "the full read sees Kilo's upstream show record");
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

test("9. a fulfilled request's availableAt opens the window — the EARLIEST AVAILABLE one, never a declined request's date", async () => {
  requests.push(
    { tmdbId: 500, mediaType: "MOVIE", status: "AVAILABLE", availableAt: d("2024-06-01") },
    { tmdbId: 500, mediaType: "MOVIE", status: "AVAILABLE", availableAt: d("2024-09-01") }, // a later fulfilment: not the arrival
    { tmdbId: 500, mediaType: "MOVIE", status: "DECLINED", availableAt: d("2023-01-01") }, // never fulfilled
    { tmdbId: 500, mediaType: "MOVIE", status: "AVAILABLE", availableAt: null },
  );
  const echo = byId(await loadLibraryWatchFacts(null, { now: NOW })).get(500)!;
  assert.equal(echo.shelfStart?.toISOString(), d("2024-06-01").toISOString(), "earlier than the media server's addedAt (2025-03-01)");
  const one = await loadLibraryWatchFacts(null, { now: NOW, only: [{ tmdbId: 500, mediaType: "MOVIE" }] });
  assert.equal(one.titles[0].shelfStart?.toISOString(), d("2024-06-01").toISOString(), "the narrowed read reaches the same arrival");
  // No request: the media server's own date.
  requests.length = 0;
  const bare = byId(await loadLibraryWatchFacts(null, { now: NOW })).get(500)!;
  assert.equal(bare.shelfStart?.toISOString(), d("2025-03-01").toISOString());
});

test("a holder on an untracked source is unobservable, naming the server", async () => {
  jfLib.push({ tmdbId: 500, mediaType: "MOVIE", serverInstance: "remote", title: "Echo", year: "2020", addedAt: d("2025-03-01"), jellyfinItemId: "jf-500", jellyfinItemIds: [] });
  const echo = byId(await loadLibraryWatchFacts(null, { now: NOW })).get(500)!;
  assert.equal(echo.verdict.state, "unobservable");
  assert.equal(echo.verdict.reason, "noHistory", "jellyfin:remote has recorded nothing");
  assert.deepEqual(echo.verdict.reasonServers, ["jellyfin:remote"]);
});

// ── upstreamUnchecked: the loader's half of the 14d hold-back ───────────────
// Audit C132: the pure cleanup rule was pinned with a hand-built
// `upstreamUnchecked`, but the LOADER computing it (holders whose upstream
// health isn't "ok") was not — `!== "ok"` → `=== "failed"`, or `[]`, left every
// test green. C159: a truncated read is "incomplete" and holds too. C016: a
// server that holds no title is listed for coverage but `holds: false`.
const STATUS_PLEX = "upstreamWatch:status:plex:";
const STATUS_JF = "upstreamWatch:status:jellyfin:";
const upstreamStatus = (over: Record<string, unknown> = {}) => JSON.stringify({
  fetchedAt: d("2026-09-30").toISOString(), attemptedAt: d("2026-09-30").toISOString(), ok: true,
  entries: 10, matched: 10, samples: 0, agreed: 0, error: null, ...over,
});
async function withStatuses<T>(rows: Record<string, string>, fn: () => Promise<T>): Promise<T> {
  for (const [k, v] of Object.entries(rows)) settings.set(k, v);
  try {
    return await fn();
  } finally {
    for (const k of Object.keys(rows)) settings.delete(k);
  }
}

test("C132 upstreamUnchecked: a STALE holder is named; a fresh ok one is not (Charlie: plex + jellyfin; Alpha: plex only)", async () => {
  await withStatuses({ [STATUS_PLEX]: upstreamStatus(), [STATUS_JF]: upstreamStatus({ fetchedAt: d("2026-09-01").toISOString() }) }, async () => {
    const t = byId(await loadLibraryWatchFacts(null, { now: NOW }));
    assert.deepEqual(t.get(300)!.upstreamUnchecked, ["jellyfin"], "stale (30 days) is not a check");
    assert.deepEqual(t.get(100)!.upstreamUnchecked, [], "a fresh ok check holds nothing back");
  });
});

test("C132 upstreamUnchecked: a FAILED refresh and a parser that matched nothing both hold", async () => {
  await withStatuses({ [STATUS_PLEX]: upstreamStatus(), [STATUS_JF]: upstreamStatus({ ok: false, error: "HTTP 401" }) }, async () => {
    assert.deepEqual(byId(await loadLibraryWatchFacts(null, { now: NOW })).get(300)!.upstreamUnchecked, ["jellyfin"], "failed");
  });
  await withStatuses({ [STATUS_PLEX]: upstreamStatus(), [STATUS_JF]: upstreamStatus({ entries: 5, matched: 0 }) }, async () => {
    assert.deepEqual(byId(await loadLibraryWatchFacts(null, { now: NOW })).get(300)!.upstreamUnchecked, ["jellyfin"], "matched nothing");
  });
});

test("C132 upstreamUnchecked: NO status row at all is 'never' — the holder is named", async () => {
  const t = byId(await loadLibraryWatchFacts(null, { now: NOW }));
  assert.deepEqual(t.get(100)!.upstreamUnchecked, ["plex"]);
  assert.deepEqual(t.get(300)!.upstreamUnchecked, ["jellyfin", "plex"]);
});

test("C159 a TRUNCATED read parses as truncated and holds its titles back as 'incomplete'; a pre-field row reads complete", async () => {
  await withStatuses({ [STATUS_PLEX]: upstreamStatus({ truncated: true }) }, async () => {
    const facts = await loadLibraryWatchFacts(null, { now: NOW });
    const plexCov = facts.coverage.find((c) => c.server === "plex")!;
    assert.equal(plexCov.upstream?.truncated, true, "the parser keeps the field");
    assert.equal(plexCov.upstreamHealth, "incomplete");
    assert.deepEqual(byId(facts).get(100)!.upstreamUnchecked, ["plex"], "a partial snapshot is never zero plays (14d)");
  });
  await withStatuses({ [STATUS_PLEX]: upstreamStatus() }, async () => {
    const plexCov = (await loadLibraryWatchFacts(null, { now: NOW })).coverage.find((c) => c.server === "plex")!;
    assert.equal(plexCov.upstream?.truncated, false, "a row written before the field is a complete read");
    assert.equal(plexCov.upstreamHealth, "ok");
  });
});

test("C016 coverage marks which servers HOLD titles: a status-only or history-only server is listed with holds=false", async () => {
  plays.push(play({ source: "jellyfin", serverInstance: "gone", tmdbId: 999997, mediaType: "MOVIE", startedAt: d("2025-02-01") }));
  await withStatuses({ "upstreamWatch:status:plex:removed": upstreamStatus({ fetchedAt: d("2026-01-01").toISOString() }) }, async () => {
    const cov = new Map((await loadLibraryWatchFacts(null, { now: NOW })).coverage.map((c) => [c.server, c]));
    assert.equal(cov.get("plex")!.holds, true);
    assert.equal(cov.get("jellyfin")!.holds, true);
    assert.equal(cov.get("plex:removed")!.holds, false, "a de-registered slug's leftover status");
    assert.equal(cov.get("jellyfin:gone")?.holds ?? false, false, "history kept for a server that holds nothing (19/28)");
  });
});
