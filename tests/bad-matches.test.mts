// Unit tests for getBadMatches (src/lib/bad-matches.ts) — the headless
// bad-match detector for native admin clients (the web admin/library page
// computes the same thing inline; this module is the contract the iOS client
// consumes). A "bad match" is one physical file/folder that Plex and Jellyfin
// resolved to DIFFERENT TMDB ids — the detector aligns the two libraries by
// relative file path and reports disagreements. Contracts pinned:
//
//  - path alignment: each server's mount point is INFERRED as the longest
//    shared directory prefix of its own paths and stripped, so libraries
//    bind-mounted at different roots (/plexmedia vs /data — the normal Docker
//    situation) still compare equal; Windows backslash paths normalise to
//    forward slashes and match a Linux twin; rows with no filePath are
//    ignored entirely;
//  - multi-server: that mount inference is PER serverInstance. Two Plex
//    servers with unrelated roots used to be prefix-inferred as one flat set,
//    collapsing the shared prefix to "" so nothing was stripped and the join
//    missed every item — the report went empty and read as "no problems
//    found". Each instance's strip prefix is read from its own
//    plex<Slug>MoviePathStripPrefix/… Setting, falling back to the shared
//    default-instance key when it has none, and instances merge into one
//    keyspace with the default winning a same-relative-path collision;
//  - agreement (same tmdbId + mediaType at the same relative path) is never
//    reported; a tmdbId mismatch is, carrying both sides' metadata and the
//    server-native keys (plexRatingKey/jellyfinItemId) the fix-match UI needs;
//  - TV items key on the SERIES folder (first path segment after the
//    configured strip prefix), not the season/episode path, and the sonarr
//    verdict lookup uses that same series key. Mount inference is therefore
//    per (serverInstance, MEDIA TYPE): one mount across movies + TV stops at
//    their shared parent, leaving the library dir on every TV rel so segment 0
//    is "tv" for every show and the whole TV half collapses onto one key;
//  - the ARR tie-breaker reads the cached `arr:radarr|sonarr:paths` map (each
//    title's folder path → tmdbId, the one map the admin library page and
//    fix-match's file-info share) through its folder-BASENAME index: arr
//    agreeing with Plex flags the JELLYFIN side and vice versa; an arr id
//    matching neither side yields a verdict of null while still exposing
//    arrTmdbId; a basename two titles share gives no verdict; a cache hit never
//    re-writes the cache; unconfigured ARR (no url/key Settings) degrades to
//    null verdicts with no warning; a cold map reads every instance at once,
//    and a map missing a down instance is kept only briefly;
//  - a FAILED arr map build (DB/fetch error) is non-fatal: it warns with the
//    [bad-matches] scope — the source comment's "don't swallow silently"
//    contract — and the mismatch list still returns;
//  - posters resolve TmdbMediaCore-first, fall back to the movie:/tv:
//    `:details` blobs for ids core missed (a null-poster core row falls
//    through to the blob), and stay null when neither has data; with zero
//    mismatches the poster query is skipped entirely;
//  - activeType filters to the requested media type.
//
// No DB or network: every delegate the module touches (plex/jellyfin library
// items, setting, tmdbMediaCore, tmdbCache) is shadowed in-memory
// (tests/_helpers.mts). The ARR verdict path is exercised through the REAL
// getCache/setCache against seeded arr:*:paths rows; the cold-map tests script
// Radarr through a replaced globalThis.fetch (the safe-fetch test seam) on
// RFC1918 literals, so no DNS or live HTTP is ever reached.
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";

process.env.TOKEN_ENCRYPTION_KEY = "ab".repeat(32); // prisma.ts pulls in token-crypto

// ── console capture (the module warns on arr map failures) ─────────────────
const warns: string[] = [];
const errors: string[] = [];
console.warn = (...args: unknown[]) => { warns.push(args.map(String).join(" ")); };
console.error = (...args: unknown[]) => { errors.push(args.map(String).join(" ")); };

// Dynamic imports so the env/console stubs precede the module-graph load.
const { prisma } = await import("../src/lib/prisma.ts");
const { shadowPrismaModel } = await import("./_helpers.mts");
const { getBadMatchReport, loadArrPathIndex, cachedArrNameIndex } = await import("../src/lib/bad-matches.ts");
const { resetLogDedup } = await import("../src/lib/log-dedup.ts");
const badMatchList = async (activeType?: "MOVIE" | "TV") => (await getBadMatchReport(activeType)).badMatches;

// ── scripted Radarr (cold-map tests only) ───────────────────────────────────
const fetchCalls: string[] = [];
let respond: (url: URL) => Response | Promise<Response> = (url) => {
  throw new Error(`unexpected fetch ${url}`);
};
globalThis.fetch = (async (input: RequestInfo | URL) => {
  const url = new URL(String(input));
  fetchCalls.push(url.origin + url.pathname);
  return respond(url);
}) as typeof fetch;
const okJson = (data: unknown) =>
  new Response(JSON.stringify(data), { status: 200, headers: { "content-type": "application/json" } });

// ── in-memory delegates ─────────────────────────────────────────────────────
type MediaType = "MOVIE" | "TV";
type PlexRow = {
  tmdbId: number; mediaType: MediaType; filePath: string | null;
  plexRatingKey: string | null; title: string | null; year: string | null;
  serverInstance: string;
};
type JfRow = {
  tmdbId: number; mediaType: MediaType; filePath: string | null;
  jellyfinItemId: string | null; title: string | null; year: string | null;
  serverInstance: string;
};

let plexRows: PlexRow[] = [];
let jfRows: JfRow[] = [];
type FindManyArgs = { take?: number; orderBy?: unknown };
const plexFindManyCalls: FindManyArgs[] = [];
const jfFindManyCalls: FindManyArgs[] = [];
shadowPrismaModel(prisma, "plexLibraryItem", {
  findMany: async (args: FindManyArgs): Promise<PlexRow[]> => {
    plexFindManyCalls.push(args);
    return plexRows;
  },
});
shadowPrismaModel(prisma, "jellyfinLibraryItem", {
  findMany: async (args: FindManyArgs): Promise<JfRow[]> => {
    jfFindManyCalls.push(args);
    return jfRows;
  },
});

let settingRows: { key: string; value: string }[] = [];
let settingFindUnique: (key: string) => Promise<{ key: string; value: string } | null> =
  async () => null;
shadowPrismaModel(prisma, "setting", {
  findMany: async (args: { where: { key: { in: string[] } } }) =>
    settingRows.filter((r) => args.where.key.in.includes(r.key)),
  findUnique: async (args: { where: { key: string } }) => settingFindUnique(args.where.key),
});

let coreRows: { tmdbId: number; mediaType: MediaType; posterPath: string | null }[] = [];
type CoreWhere = { OR: { mediaType: MediaType; tmdbId: { in: number[] } }[] };
const coreCalls: { where: CoreWhere }[] = [];
shadowPrismaModel(prisma, "tmdbMediaCore", {
  findMany: async (args: { where: CoreWhere }) => {
    coreCalls.push(args);
    return coreRows.filter((r) =>
      args.where.OR.some((c) => c.mediaType === r.mediaType && c.tmdbId.in.includes(r.tmdbId)),
    );
  },
});

type CacheRow = { key: string; data: string; cachedAt: Date; expiresAt: Date };
const cacheRows = new Map<string, CacheRow>();
const cacheUpserts: string[] = [];
const cacheGets: string[] = [];
shadowPrismaModel(prisma, "tmdbCache", {
  findUnique: async (args: { where: { key: string } }): Promise<CacheRow | null> => {
    cacheGets.push(args.where.key);
    return cacheRows.get(args.where.key) ?? null;
  },
  findMany: async (args: { where: { key: { in: string[] } } }): Promise<CacheRow[]> =>
    args.where.key.in
      .map((k) => cacheRows.get(k))
      .filter((r): r is CacheRow => r !== undefined),
  upsert: async (args: { where: { key: string }; create: CacheRow }): Promise<CacheRow> => {
    cacheUpserts.push(args.where.key);
    cacheRows.set(args.where.key, args.create);
    return args.create;
  },
  deleteMany: async (): Promise<{ count: number }> => ({ count: 0 }),
});

// ── fixture helpers ─────────────────────────────────────────────────────────
// serverInstance defaults to "" — the single-server shape every existing
// deployment has, and a non-null column so the row always carries a string.
function plexItem(tmdbId: number, mediaType: MediaType, filePath: string | null, serverInstance = ""): PlexRow {
  return { tmdbId, mediaType, filePath, plexRatingKey: `plex-${tmdbId}`, title: `Plex ${tmdbId}`, year: "2020", serverInstance };
}
function jfItem(tmdbId: number, mediaType: MediaType, filePath: string | null, serverInstance = ""): JfRow {
  return { tmdbId, mediaType, filePath, jellyfinItemId: `jf-${tmdbId}`, title: `JF ${tmdbId}`, year: "2020", serverInstance };
}

// Seed a FRESH arr path-map cache row so loadArrPathIndex takes the cache-hit
// path (real getCache) and never reaches settings / the dynamic arr import.
// Entries are arr folder paths; the verdict reads their basenames.
function seedArrPaths(service: "radarr" | "sonarr", entries: [string, number][]): void {
  const key = `arr:${service}:paths`;
  cacheRows.set(key, {
    key,
    data: JSON.stringify(entries),
    cachedAt: new Date(),
    expiresAt: new Date(Date.now() + 3600_000),
  });
}

// Two-movie base: Alpha conflicts (plex 100 vs jellyfin 999), Beta agrees
// (200/200). Two rows per server anchor the inferred mounts at
// /plexmedia/movies/ and /data/movies/ — DIFFERENT roots on purpose.
function seedConflictingMovies(): void {
  plexRows = [
    plexItem(100, "MOVIE", "/plexmedia/movies/Alpha (2020)/Alpha.mkv"),
    plexItem(200, "MOVIE", "/plexmedia/movies/Beta (2019)/Beta.mkv"),
  ];
  jfRows = [
    jfItem(999, "MOVIE", "/data/movies/Alpha (2020)/Alpha.mkv"),
    jfItem(200, "MOVIE", "/data/movies/Beta (2019)/Beta.mkv"),
  ];
}

beforeEach(() => {
  plexRows = [];
  jfRows = [];
  settingRows = [];
  settingFindUnique = async () => null;
  coreRows = [];
  cacheRows.clear();
  cacheUpserts.length = 0;
  cacheGets.length = 0;
  plexFindManyCalls.length = 0;
  jfFindManyCalls.length = 0;
  coreCalls.length = 0;
  warns.length = 0;
  errors.length = 0;
  fetchCalls.length = 0;
  respond = (url) => {
    throw new Error(`unexpected fetch ${url}`);
  };
  resetLogDedup();
});

// ── detection & path alignment ──────────────────────────────────────────────

test("agreeing libraries across different mounts → no matches, poster lookup skipped, capped reads", async () => {
  plexRows = [
    plexItem(100, "MOVIE", "/plexmedia/movies/Alpha (2020)/Alpha.mkv"),
    plexItem(200, "MOVIE", "/plexmedia/movies/Beta (2019)/Beta.mkv"),
  ];
  jfRows = [
    jfItem(100, "MOVIE", "/data/movies/Alpha (2020)/Alpha.mkv"),
    jfItem(200, "MOVIE", "/data/movies/Beta (2019)/Beta.mkv"),
  ];

  assert.deepEqual(await badMatchList(), []);
  assert.equal(coreCalls.length, 0); // posterPathMap short-circuits on zero mismatches
  assert.equal(cacheUpserts.length, 0);
  // The arr path maps are consumed only per-match, so with zero mismatches they
  // must not be built at all: no `arr:*:paths` cache read (and therefore no
  // cold-cache arrFetch fan-out across every syncable instance either).
  assert.ok(
    !cacheGets.some((k) => k.startsWith("arr:")),
    `arr path maps are not built when there are no mismatches (reads: ${cacheGets.join(", ")})`,
  );
  assert.deepEqual(warns, []); // unconfigured ARR degrades silently, not warnly
  // The library reads are capped (LIBRARY_ITEM_CAP) so a huge library can't
  // be slurped unbounded into one request — and ordered like the admin library
  // page, so a library past the cap is cut at the same rows on every read
  // rather than an arbitrary subset per table.
  const pageOrder = [{ serverInstance: "asc" }, { mediaType: "asc" }, { tmdbId: "asc" }];
  for (const call of [plexFindManyCalls[0], jfFindManyCalls[0]]) {
    assert.equal(call.take, 25_000);
    assert.deepEqual(call.orderBy, pageOrder);
  }
  assert.equal((await getBadMatchReport()).capped, false);
});

test("a library table at the row cap is reported as capped (additive to the bad-match list)", async () => {
  plexRows = Array.from({ length: 25_000 }, (_, i) => plexItem(i + 1, "MOVIE", null));
  const report = await getBadMatchReport();
  assert.deepEqual(report, { badMatches: [], capped: true });
});

test("a tmdbId disagreement at the same relative path is reported with both sides' metadata", async () => {
  seedConflictingMovies();
  const matches = await badMatchList();
  assert.deepEqual(matches, [
    {
      relativePath: "Alpha (2020)/Alpha.mkv", // mount-stripped, identical on both servers
      // serverInstance rides on each side beside its server-local id: a client
      // applying the fix must target the server the ratingKey/itemId came from.
      plex: { tmdbId: 100, mediaType: "MOVIE", title: "Plex 100", posterPath: null, releaseYear: "2020", serverInstance: "" },
      plexRatingKey: "plex-100",
      jellyfin: { tmdbId: 999, mediaType: "MOVIE", title: "JF 999", posterPath: null, releaseYear: "2020", serverInstance: "" },
      jellyfinItemId: "jf-999",
      arrTmdbId: null, // ARR unconfigured — no tie-breaker available
      arrVerdict: null,
    },
  ]);
});

test("Windows backslash paths on one server normalise and still align with a Linux twin", async () => {
  plexRows = [
    plexItem(100, "MOVIE", "/plexmedia/movies/Alpha (2020)/Alpha.mkv"),
    plexItem(200, "MOVIE", "/plexmedia/movies/Beta (2019)/Beta.mkv"),
  ];
  jfRows = [
    jfItem(999, "MOVIE", "D:\\Media\\Movies\\Alpha (2020)\\Alpha.mkv"),
    jfItem(200, "MOVIE", "D:\\Media\\Movies\\Beta (2019)\\Beta.mkv"),
  ];
  const matches = await badMatchList();
  assert.equal(matches.length, 1);
  assert.equal(matches[0].relativePath, "Alpha (2020)/Alpha.mkv");
  assert.equal(matches[0].jellyfin.tmdbId, 999);
});

test("rows with null or empty filePath are ignored — no phantom matches, no crash", async () => {
  seedConflictingMovies();
  plexRows.push(plexItem(300, "MOVIE", null), plexItem(301, "MOVIE", ""));
  jfRows.push(jfItem(3999, "MOVIE", null));
  const matches = await badMatchList();
  assert.deepEqual(matches.map((m) => m.relativePath), ["Alpha (2020)/Alpha.mkv"]);
});

// ── multi-server (serverInstance) path normalisation ────────────────────────

test("a second Plex server on an unrelated mount root still reports its bad match", async () => {
  // THE regression pin. /plexmedia/… and /mnt/nas/video/… share no leading
  // segment, so inferring one mount across both servers collapses it to "",
  // nothing is stripped, every Plex key stays absolute and the Jellyfin join
  // misses EVERY item — the whole report comes back [] and reads as "no
  // problems found". Per-instance inference keeps both roots correct.
  plexRows = [
    plexItem(100, "MOVIE", "/plexmedia/movies/Alpha (2020)/Alpha.mkv"),
    plexItem(200, "MOVIE", "/plexmedia/movies/Beta (2019)/Beta.mkv"),
    plexItem(777, "MOVIE", "/mnt/nas/video/Gamma (2021)/Gamma.mkv", "remote"),
    plexItem(300, "MOVIE", "/mnt/nas/video/Delta (2018)/Delta.mkv", "remote"),
  ];
  jfRows = [
    jfItem(100, "MOVIE", "/data/movies/Alpha (2020)/Alpha.mkv"),
    jfItem(200, "MOVIE", "/data/movies/Beta (2019)/Beta.mkv"),
    jfItem(999, "MOVIE", "/data/movies/Gamma (2021)/Gamma.mkv"),
    jfItem(300, "MOVIE", "/data/movies/Delta (2018)/Delta.mkv"),
  ];

  const matches = await badMatchList();
  assert.deepEqual(matches.map((m) => m.relativePath), ["Gamma (2021)/Gamma.mkv"]);
  assert.equal(matches[0].plex.tmdbId, 777); // the named server's row
  assert.equal(matches[0].plexRatingKey, "plex-777");
  assert.equal(matches[0].jellyfin.tmdbId, 999);
});

test("a named instance's own strip prefix is applied to its rows, not the default's", async () => {
  // Each server keeps two library dirs so the inferred mount stops above them
  // and the library dir survives into the relative path — which is exactly what
  // the *PathStripPrefix settings exist to peel. The two servers spell that dir
  // differently ("movies" vs "films"), so only a per-instance key can align both.
  settingRows = [
    { key: "plexMoviePathStripPrefix", value: "movies" },
    { key: "plexRemoteMoviePathStripPrefix", value: "films" },
  ];
  plexRows = [
    plexItem(100, "MOVIE", "/plexmedia/movies/Alpha (2020)/Alpha.mkv"),
    plexItem(200, "MOVIE", "/plexmedia/kids/Beta (2019)/Beta.mkv"),
    plexItem(777, "MOVIE", "/srv/media/films/Gamma (2021)/Gamma.mkv", "remote"),
    plexItem(300, "MOVIE", "/srv/media/docs/Delta (2018)/Delta.mkv", "remote"),
  ];
  jfRows = [
    jfItem(101, "MOVIE", "/data/movies/Alpha (2020)/Alpha.mkv"),
    jfItem(999, "MOVIE", "/data/movies/Gamma (2021)/Gamma.mkv"),
  ];

  // Sorted: report order follows the merge order (named instances, then the
  // default) and is incidental — what matters is that BOTH servers aligned.
  const matches = await badMatchList();
  assert.deepEqual(
    matches.map((m) => [m.relativePath, m.plex.tmdbId, m.jellyfin.tmdbId]).sort(),
    [["Alpha (2020)/Alpha.mkv", 100, 101], ["Gamma (2021)/Gamma.mkv", 777, 999]],
  );
});

test("a named instance with no strip prefix of its own inherits the shared default key", async () => {
  // Only the legacy plexMoviePathStripPrefix row exists — the shape of every
  // deployment that has never configured a per-server prefix. The named server
  // must still get "movies" peeled or it never joins.
  settingRows = [{ key: "plexMoviePathStripPrefix", value: "movies" }];
  plexRows = [
    plexItem(100, "MOVIE", "/plexmedia/movies/Alpha (2020)/Alpha.mkv"),
    plexItem(200, "MOVIE", "/plexmedia/kids/Beta (2019)/Beta.mkv"),
    plexItem(777, "MOVIE", "/srv/media/movies/Gamma (2021)/Gamma.mkv", "remote"),
    plexItem(300, "MOVIE", "/srv/media/docs/Delta (2018)/Delta.mkv", "remote"),
  ];
  jfRows = [
    jfItem(101, "MOVIE", "/data/movies/Alpha (2020)/Alpha.mkv"),
    jfItem(999, "MOVIE", "/data/movies/Gamma (2021)/Gamma.mkv"),
  ];

  const matches = await badMatchList();
  assert.deepEqual(
    matches.map((m) => [m.relativePath, m.plex.tmdbId]).sort(),
    [["Alpha (2020)/Alpha.mkv", 100], ["Gamma (2021)/Gamma.mkv", 777]],
  );
});

test("two Plex servers mirroring one relative path collapse to a single row, default winning", async () => {
  // A mirrored library: the same relative paths on both servers under different
  // roots. The Plex↔Jellyfin join is relative-path keyed and cannot be
  // instance-scoped, so the two entries for one physical file collapse — that
  // must report ONE bad match, not two, and the mirror must not perturb the
  // agreeing title next to it.
  plexRows = [
    plexItem(100, "MOVIE", "/plexmedia/movies/Alpha (2020)/Alpha.mkv"),
    plexItem(200, "MOVIE", "/plexmedia/movies/Beta (2019)/Beta.mkv"),
    plexItem(100, "MOVIE", "/mnt/nas/video/Alpha (2020)/Alpha.mkv", "remote"),
    plexItem(200, "MOVIE", "/mnt/nas/video/Beta (2019)/Beta.mkv", "remote"),
  ];
  jfRows = [
    jfItem(999, "MOVIE", "/data/movies/Alpha (2020)/Alpha.mkv"),
    jfItem(200, "MOVIE", "/data/movies/Beta (2019)/Beta.mkv"),
  ];

  const matches = await badMatchList();
  assert.deepEqual(matches.map((m) => m.relativePath), ["Alpha (2020)/Alpha.mkv"]);
  assert.equal(matches[0].plex.tmdbId, 100);

  // Same collision, but the two servers disagree about the file. The merge order
  // is deterministic — default instance last, so it wins — rather than whatever
  // order the rows happened to come back in.
  plexRows[2] = plexItem(101, "MOVIE", "/mnt/nas/video/Alpha (2020)/Alpha.mkv", "remote");
  const [contested] = await badMatchList();
  assert.equal(contested.plex.tmdbId, 100);
  assert.equal(contested.plexRatingKey, "plex-100");
});

// ── ARR verdicts (via the cached path map) ──────────────────────────────────

test("radarr agreeing with Plex flags the jellyfin side; the cache hit never re-writes the cache", async () => {
  seedConflictingMovies();
  // The cached map holds Radarr's folder paths; the verdict reads their
  // BASENAMES — for movies, the file's parent dir — which is what survives
  // across different bind-mount roots.
  seedArrPaths("radarr", [["/radarr/movies/Alpha (2020)", 100]]);

  const [match] = await badMatchList();
  assert.equal(match.arrTmdbId, 100);
  assert.equal(match.arrVerdict, "jellyfin"); // jellyfin holds the wrong id
  assert.deepEqual(cacheUpserts, []); // hit path must not churn the cache row
  assert.deepEqual(warns, []);
});

test("radarr agreeing with Jellyfin flags plex; an id matching neither side exposes arrTmdbId but no verdict", async () => {
  plexRows = [
    plexItem(100, "MOVIE", "/plexmedia/movies/Alpha (2020)/Alpha.mkv"),
    plexItem(200, "MOVIE", "/plexmedia/movies/Beta (2019)/Beta.mkv"),
  ];
  jfRows = [
    jfItem(999, "MOVIE", "/data/movies/Alpha (2020)/Alpha.mkv"),
    jfItem(201, "MOVIE", "/data/movies/Beta (2019)/Beta.mkv"),
  ];
  seedArrPaths("radarr", [
    ["/radarr/movies/Alpha (2020)", 999], // arr sides with jellyfin
    ["/radarr/movies/Beta (2019)", 555], // arr disagrees with BOTH — a third opinion is not a verdict
  ]);

  const matches = await badMatchList();
  assert.equal(matches.length, 2);
  const alpha = matches.find((m) => m.relativePath.startsWith("Alpha"))!;
  const beta = matches.find((m) => m.relativePath.startsWith("Beta"))!;
  assert.equal(alpha.arrTmdbId, 999);
  assert.equal(alpha.arrVerdict, "plex");
  assert.equal(beta.arrTmdbId, 555);
  assert.equal(beta.arrVerdict, null);
});

test("TV matches key on the SERIES folder (strip prefix applied) and consult the sonarr map with that key", async () => {
  // Mixed library so the inferred mounts are /plexmedia/ and /data/ and the
  // "tv/" library segment survives into the relative path — exactly what the
  // *TvPathStripPrefix settings exist to peel off ("tv", no trailing slash,
  // pins the prefix normalisation).
  settingRows = [
    { key: "plexTvPathStripPrefix", value: "tv" },
    { key: "jellyfinTvPathStripPrefix", value: "tv" },
  ];
  plexRows = [
    plexItem(100, "MOVIE", "/plexmedia/movies/Alpha (2020)/Alpha.mkv"),
    plexItem(300, "TV", "/plexmedia/tv/ShowX/Season 01/e1.mkv"),
    plexItem(400, "TV", "/plexmedia/tv/ShowY/Season 02/e5.mkv"),
  ];
  jfRows = [
    jfItem(100, "MOVIE", "/data/movies/Alpha (2020)/Alpha.mkv"),
    jfItem(3999, "TV", "/data/tv/ShowX/Season 01/e1.mkv"),
    jfItem(400, "TV", "/data/tv/ShowY/Season 02/e5.mkv"),
  ];
  seedArrPaths("sonarr", [["/sonarr/tv/ShowX", 300]]);

  const matches = await badMatchList();
  assert.equal(matches.length, 1);
  const m = matches[0];
  // Series-level identity: NOT the season/episode path — folderOf() would
  // yield "Season 01" and never match Sonarr's series folder.
  assert.equal(m.relativePath, "ShowX");
  assert.equal(m.plex.tmdbId, 300);
  assert.equal(m.jellyfin.tmdbId, 3999);
  assert.equal(m.arrTmdbId, 300);
  assert.equal(m.arrVerdict, "jellyfin");
});

test("TV keys stay per-show with NO strip prefix configured — mounts are inferred per media type", async () => {
  // The default deployment: movies and TV in sibling library dirs, no
  // *TvPathStripPrefix set (the settings UI's own /api/admin/library-sample-paths
  // preview infers its mount per media type, so the field correctly reads as
  // unnecessary). Inferring ONE mount across both types stops at the shared
  // parent (/data/), leaving "tv/" on every TV rel — and toMatchKey takes
  // segment 0 for TV, so EVERY show collapses onto the single key "tv": the real
  // Show A mismatch disappears behind the last writer and two unrelated shows
  // get paired instead.
  plexRows = [
    plexItem(100, "MOVIE", "/data/movies/Foo (2020)/foo.mkv"),
    plexItem(300, "TV", "/data/tv/Show A/Season 01/e01.mkv"),
    plexItem(400, "TV", "/data/tv/Show B/Season 01/e01.mkv"),
  ];
  jfRows = [
    jfItem(100, "MOVIE", "/media/movies/Foo (2020)/foo.mkv"),
    jfItem(3999, "TV", "/media/tv/Show A/Season 01/e01.mkv"),
    jfItem(400, "TV", "/media/tv/Show B/Season 01/e01.mkv"),
  ];

  assert.deepEqual(
    (await badMatchList()).map((m) => [m.relativePath, m.plex.tmdbId, m.jellyfin.tmdbId]),
    [["Show A", 300, 3999]],
  );

  // Both shows wrong: two DISTINCT keys, not one merged row.
  jfRows[2] = jfItem(4999, "TV", "/media/tv/Show B/Season 01/e01.mkv");
  assert.deepEqual(
    (await badMatchList()).map((m) => [m.relativePath, m.plex.tmdbId, m.jellyfin.tmdbId]),
    [["Show A", 300, 3999], ["Show B", 400, 4999]],
  );
});

test("activeType filters the report to the requested media type", async () => {
  settingRows = [
    { key: "plexTvPathStripPrefix", value: "tv" },
    { key: "jellyfinTvPathStripPrefix", value: "tv" },
  ];
  plexRows = [
    plexItem(100, "MOVIE", "/plexmedia/movies/Alpha (2020)/Alpha.mkv"),
    plexItem(200, "MOVIE", "/plexmedia/movies/Beta (2019)/Beta.mkv"),
    plexItem(300, "TV", "/plexmedia/tv/ShowX/Season 01/e1.mkv"),
    plexItem(400, "TV", "/plexmedia/tv/ShowY/Season 02/e5.mkv"),
  ];
  jfRows = [
    jfItem(999, "MOVIE", "/data/movies/Alpha (2020)/Alpha.mkv"),
    jfItem(200, "MOVIE", "/data/movies/Beta (2019)/Beta.mkv"),
    jfItem(3999, "TV", "/data/tv/ShowX/Season 01/e1.mkv"),
    jfItem(400, "TV", "/data/tv/ShowY/Season 02/e5.mkv"),
  ];

  // Mounts are inferred per (instance, MEDIA TYPE), so the movie rows infer
  // /plexmedia/movies/ (not the /plexmedia/ shared parent) and the "movies/"
  // library dir never reaches the key — no *MoviePathStripPrefix needed.
  const all = await badMatchList();
  assert.deepEqual(all.map((m) => m.relativePath), ["Alpha (2020)/Alpha.mkv", "ShowX"]);

  const movies = await badMatchList("MOVIE");
  assert.deepEqual(movies.map((m) => m.relativePath), ["Alpha (2020)/Alpha.mkv"]);

  const tv = await badMatchList("TV");
  assert.deepEqual(tv.map((m) => m.relativePath), ["ShowX"]);
});

// ── posters & degraded ARR ──────────────────────────────────────────────────

test("posters: TmdbMediaCore first, details-blob fallback for core misses AND null-poster core rows, else null", async () => {
  plexRows = [
    plexItem(100, "MOVIE", "/plexmedia/movies/Alpha (2020)/Alpha.mkv"),
    plexItem(200, "MOVIE", "/plexmedia/movies/Beta (2019)/Beta.mkv"),
  ];
  jfRows = [
    jfItem(999, "MOVIE", "/data/movies/Alpha (2020)/Alpha.mkv"),
    jfItem(201, "MOVIE", "/data/movies/Beta (2019)/Beta.mkv"),
  ];
  coreRows = [
    { tmdbId: 100, mediaType: "MOVIE", posterPath: "/alpha-core.jpg" }, // core hit
    { tmdbId: 999, mediaType: "MOVIE", posterPath: null }, // null core row must NOT block the blob
  ];
  cacheRows.set("movie:999:details", {
    key: "movie:999:details",
    data: JSON.stringify({ posterPath: "/alpha-blob.jpg" }),
    cachedAt: new Date(),
    expiresAt: new Date(Date.now() + 3600_000),
  });
  cacheRows.set("movie:201:details", {
    key: "movie:201:details",
    data: JSON.stringify({}), // blob without a poster — stays null
    cachedAt: new Date(),
    expiresAt: new Date(Date.now() + 3600_000),
  });

  const matches = await badMatchList();
  const posters = Object.fromEntries(
    matches.flatMap((m) => [
      [m.plex.tmdbId, m.plex.posterPath],
      [m.jellyfin.tmdbId, m.jellyfin.posterPath],
    ]),
  );
  assert.deepEqual(posters, {
    100: "/alpha-core.jpg", // core column, no blob parse
    999: "/alpha-blob.jpg", // fell through the null core row to the blob
    200: null, // nothing anywhere
    201: null, // blob existed but carried no poster
  });
  // One `tmdbId IN (…)` per media type, never one OR term per pair.
  assert.deepEqual(coreCalls.map((c) => c.where), [{ OR: [{ mediaType: "MOVIE", tmdbId: { in: [100, 999, 200, 201] } }] }]);
});

test("a failing ARR map build warns with the [bad-matches] scope and is non-fatal to the report", async () => {
  seedConflictingMovies();
  // No cached arr map + a settings read that blows up = the catch path. The
  // source comment demands a warn here: silent degradation used to read as
  // "no problems found".
  settingFindUnique = async () => {
    throw new Error("settings table unavailable");
  };

  const matches = await badMatchList();
  assert.equal(matches.length, 1); // the mismatch still surfaces
  assert.equal(matches[0].arrTmdbId, null);
  assert.equal(matches[0].arrVerdict, null);
  assert.ok(
    warns.some((w) => w.includes("[bad-matches] ARR path map fetch failed") && w.includes("settings table unavailable")),
    `expected a scoped warn, got: ${JSON.stringify(warns)}`,
  );
});

// ── season folders and dotted names (single-path groups) ───────────────────

test("a one-show TV library with flat episodes keys on the show folder — a name starting 'Series' is not a season folder", async () => {
  plexRows = [plexItem(300, "TV", "/plexmedia/tv/Series of Unfortunate Events/e1.mkv")];
  jfRows = [jfItem(3999, "TV", "/data/tv/Series of Unfortunate Events/e1.mkv")];
  assert.deepEqual((await badMatchList()).map((m) => m.relativePath), ["Series of Unfortunate Events"]);

  // A real season folder still keeps the show folder as the key.
  plexRows = [plexItem(300, "TV", "/plexmedia/tv/Show A/Season 01/e1.mkv")];
  jfRows = [jfItem(3999, "TV", "/data/tv/Show A/Season 01/e1.mkv")];
  assert.deepEqual((await badMatchList()).map((m) => m.relativePath), ["Show A"]);
});

test("a Jellyfin series folder with a dotted name is a folder, not a file", async () => {
  // Jellyfin stores the series folder itself; "S.H.I.E.L.D" read as a file
  // with a ".D" extension moved the mount a level up and keyed the show "tv".
  plexRows = [plexItem(300, "TV", "/plexmedia/tv/Agents of S.H.I.E.L.D/Season 1/e1.mkv")];
  jfRows = [jfItem(3999, "TV", "/data/tv/Agents of S.H.I.E.L.D")];
  assert.deepEqual((await badMatchList()).map((m) => m.relativePath), ["Agents of S.H.I.E.L.D"]);
});

// ── the shared Radarr/Sonarr folder map ─────────────────────────────────────

test("a basename two Radarr titles share referees nothing; the same title under two roots still does", async () => {
  seedConflictingMovies();
  seedArrPaths("radarr", [["/radarr/a/Alpha (2020)", 100], ["/radarr/b/Alpha (2020)", 555]]);
  const [ambiguous] = await badMatchList();
  assert.deepEqual([ambiguous.arrTmdbId, ambiguous.arrVerdict], [null, null]);

  cacheRows.clear();
  seedArrPaths("radarr", [["/radarr/hd/Alpha (2020)", 100], ["/radarr/4k/Alpha (2020)", 100]]);
  const [mirrored] = await badMatchList();
  assert.deepEqual([mirrored.arrTmdbId, mirrored.arrVerdict], [100, "jellyfin"]);
});

const RADARR_HD = "http://10.0.5.1:7878";
const RADARR_UHD = "http://10.0.5.2:7878";
function configureTwoRadarrs(): void {
  settingRows = [
    { key: "radarrUrl", value: RADARR_HD },
    { key: "radarrApiKey", value: "hd-key" },
    { key: "radarrUhdUrl", value: RADARR_UHD },
    { key: "radarrUhdApiKey", value: "uhd-key" },
  ];
  settingFindUnique = async (key) =>
    key === "arrRadarrInstances" ? { key, value: JSON.stringify([{ slug: "uhd", name: "UHD" }]) } : null;
}
const stored = (key: string) => cacheRows.get(key)!;
const ttlSeconds = (key: string) => Math.round((stored(key).expiresAt.getTime() - stored(key).cachedAt.getTime()) / 1000);

test("a cold map reads every instance at once, and ONE catalogue fetch per instance serves the full-path and basename lookups", async () => {
  configureTwoRadarrs();
  let openGate!: () => void;
  const gate = new Promise<void>((resolve) => { openGate = resolve; });
  respond = (url) => {
    if (url.origin === RADARR_HD) {
      return gate.then(() => okJson([
        { tmdbId: 100, path: "/movies/Alpha (2020)/" },
        { tmdbId: 300, path: "/movies/Shared (2001)" },
      ]));
    }
    if (url.origin === RADARR_UHD) {
      return okJson([
        { tmdbId: 777, path: "/uhd/Gamma (2021)" },
        { tmdbId: 301, path: "/movies/Shared (2001)" }, // same folder as the default's: the default wins
      ]);
    }
    throw new Error(`unexpected fetch ${url}`);
  };

  const pending = loadArrPathIndex("MOVIE");
  for (let i = 0; i < 50 && fetchCalls.length < 2; i++) await new Promise((r) => setImmediate(r));
  const bothInFlight = fetchCalls.length === 2;
  openGate();
  const index = await pending;
  assert.ok(bothInFlight, "the second instance is read while the first is still answering");

  assert.deepEqual([...index.byPath], [
    ["/movies/Alpha (2020)", 100],
    ["/movies/Shared (2001)", 300],
    ["/uhd/Gamma (2021)", 777],
  ]);
  assert.equal(index.byName.get("Alpha (2020)"), 100);
  assert.equal(index.incomplete, false);
  assert.deepEqual(cacheUpserts, ["arr:radarr:paths"], "one cache key, holding the full paths");
  assert.equal(ttlSeconds("arr:radarr:paths"), 6 * 60 * 60);

  // The basename-only reader (fix-match's file-info) and a second build come
  // from that one entry — no further fetch.
  assert.equal((await cachedArrNameIndex("MOVIE"))?.get("Gamma (2021)"), 777);
  assert.equal((await loadArrPathIndex("MOVIE")).byPath.size, 3);
  assert.deepEqual(fetchCalls.sort(), [`${RADARR_HD}/api/v3/movie`, `${RADARR_UHD}/api/v3/movie`]);
  assert.deepEqual(warns, []);
});

test("a map missing a down instance is kept only briefly, not refetched on every read, and its failure warns once", async () => {
  configureTwoRadarrs();
  respond = (url) => {
    if (url.origin === RADARR_HD) return new Response("boom", { status: 500 });
    if (url.origin === RADARR_UHD) return okJson([{ tmdbId: 777, path: "/uhd/Gamma (2021)" }]);
    throw new Error(`unexpected fetch ${url}`);
  };

  const first = await loadArrPathIndex("MOVIE");
  assert.equal(first.incomplete, true);
  assert.deepEqual([...first.byPath], [["/uhd/Gamma (2021)", 777]], "the instance that answered still counts");
  assert.ok(ttlSeconds("arr:radarr:paths") <= 5 * 60, `a partial map keeps minutes, not hours (${ttlSeconds("arr:radarr:paths")}s)`);
  assert.deepEqual(JSON.parse(stored("arr:radarr:paths").data), { entries: [["/uhd/Gamma (2021)", 777]], incomplete: true });

  const again = await loadArrPathIndex("MOVIE");
  assert.equal(again.incomplete, true);
  assert.equal(fetchCalls.length, 2, "a read inside the short window is served from the cache");

  // Past the window the same failure is fetched again but not logged again.
  cacheRows.clear();
  await loadArrPathIndex("MOVIE");
  assert.equal(fetchCalls.length, 4);
  const logged = warns.filter((w) => w.includes("[bad-matches] ARR path map fetch failed"));
  assert.equal(logged.length, 1, warns.join(" | "));
  assert.ok(logged[0].includes("radarr instance \"\"") && !logged[0].includes("hd-key"), logged[0]);
});

test("only the service a conflict is judged by is read: a movie-only report never touches the Sonarr map", async () => {
  seedConflictingMovies();
  seedArrPaths("radarr", [["/radarr/movies/Alpha (2020)", 100]]);
  const [match] = await badMatchList();
  assert.equal(match.arrVerdict, "jellyfin");
  assert.ok(cacheGets.includes("arr:radarr:paths"));
  assert.ok(!cacheGets.includes("arr:sonarr:paths"), `no Sonarr read (reads: ${cacheGets.join(", ")})`);
});

test("concurrent cold reads of one map share a single catalogue fetch per instance", async () => {
  configureTwoRadarrs();
  respond = (url) => okJson([{ tmdbId: url.origin === RADARR_HD ? 100 : 777, path: `/m/${url.origin.length}` }]);
  const [a, b] = await Promise.all([loadArrPathIndex("MOVIE"), loadArrPathIndex("MOVIE")]);
  assert.equal(a, b, "the second caller joins the first build");
  assert.equal(fetchCalls.length, 2);
});

test("mount group keys round-trip, and a group whose first row has no path still gets a mount", async () => {
  const { inferGroupMounts, mountGroupKey, parseMountGroupKey } = await import("../src/lib/bad-matches.ts");
  assert.deepEqual(parseMountGroupKey(mountGroupKey("", "TV")), { serverInstance: "", mediaType: "TV" });
  assert.deepEqual(parseMountGroupKey(mountGroupKey("uhd", "MOVIE")), { serverInstance: "uhd", mediaType: "MOVIE" });
  const mounts = inferGroupMounts(new Map([
    [mountGroupKey("", "MOVIE"), [
      { filePath: null, mediaType: "MOVIE" as const },
      { filePath: "/data/movies/Alpha (2020)/Alpha.mkv", mediaType: "MOVIE" as const },
    ]],
  ]));
  assert.equal(mounts.get(mountGroupKey("", "MOVIE")), "/data/movies/");
});
