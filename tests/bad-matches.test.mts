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
//  - agreement (same tmdbId + mediaType at the same relative path) is never
//    reported; a tmdbId mismatch is, carrying both sides' metadata and the
//    server-native keys (plexRatingKey/jellyfinItemId) the fix-match UI needs;
//  - TV items key on the SERIES folder (first path segment after the
//    configured strip prefix), not the season/episode path, and the sonarr
//    verdict lookup uses that same series key;
//  - the ARR tie-breaker reads the cached `arr:radarr|sonarr:paths:name` map
//    (folder-basename → tmdbId): arr agreeing with Plex flags the JELLYFIN
//    side and vice versa; an arr id matching neither side yields a verdict of
//    null while still exposing arrTmdbId; a cache hit never re-writes the
//    cache; unconfigured ARR (no url/key Settings) degrades to null verdicts
//    with no warning;
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
// getCache/setCache against seeded arr:*:paths rows, so the dynamic
// `import("@/lib/arr")` — and any live HTTP — is never reached.
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
const { getBadMatches } = await import("../src/lib/bad-matches.ts");

// ── in-memory delegates ─────────────────────────────────────────────────────
type MediaType = "MOVIE" | "TV";
type PlexRow = {
  tmdbId: number; mediaType: MediaType; filePath: string | null;
  plexRatingKey: string | null; title: string | null; year: string | null;
};
type JfRow = {
  tmdbId: number; mediaType: MediaType; filePath: string | null;
  jellyfinItemId: string | null; title: string | null; year: string | null;
};

let plexRows: PlexRow[] = [];
let jfRows: JfRow[] = [];
const plexFindManyCalls: { take?: number }[] = [];
shadowPrismaModel(prisma, "plexLibraryItem", {
  findMany: async (args: { take?: number }): Promise<PlexRow[]> => {
    plexFindManyCalls.push(args);
    return plexRows;
  },
});
shadowPrismaModel(prisma, "jellyfinLibraryItem", {
  findMany: async (): Promise<JfRow[]> => jfRows,
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
const coreCalls: unknown[] = [];
shadowPrismaModel(prisma, "tmdbMediaCore", {
  findMany: async (args: { where: { OR: { tmdbId: number; mediaType: MediaType }[] } }) => {
    coreCalls.push(args);
    return coreRows.filter((r) =>
      args.where.OR.some((c) => c.tmdbId === r.tmdbId && c.mediaType === r.mediaType),
    );
  },
});

type CacheRow = { key: string; data: string; cachedAt: Date; expiresAt: Date };
const cacheRows = new Map<string, CacheRow>();
const cacheUpserts: string[] = [];
shadowPrismaModel(prisma, "tmdbCache", {
  findUnique: async (args: { where: { key: string } }): Promise<CacheRow | null> =>
    cacheRows.get(args.where.key) ?? null,
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
function plexItem(tmdbId: number, mediaType: MediaType, filePath: string | null): PlexRow {
  return { tmdbId, mediaType, filePath, plexRatingKey: `plex-${tmdbId}`, title: `Plex ${tmdbId}`, year: "2020" };
}
function jfItem(tmdbId: number, mediaType: MediaType, filePath: string | null): JfRow {
  return { tmdbId, mediaType, filePath, jellyfinItemId: `jf-${tmdbId}`, title: `JF ${tmdbId}`, year: "2020" };
}

// Seed a FRESH arr path-map cache row so buildArrPathMap takes the cache-hit
// path (real getCache) and never reaches settings / the dynamic arr import.
function seedArrPaths(service: "radarr" | "sonarr", entries: [string, number][]): void {
  const key = `arr:${service}:paths:name`;
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
  plexFindManyCalls.length = 0;
  coreCalls.length = 0;
  warns.length = 0;
  errors.length = 0;
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

  assert.deepEqual(await getBadMatches(), []);
  assert.equal(coreCalls.length, 0); // posterPathMap short-circuits on zero mismatches
  assert.equal(cacheUpserts.length, 0);
  assert.deepEqual(warns, []); // unconfigured ARR degrades silently, not warnly
  // The library reads are capped (LIBRARY_ITEM_CAP) so a huge library can't
  // be slurped unbounded into one request.
  assert.equal(plexFindManyCalls[0].take, 25_000);
});

test("a tmdbId disagreement at the same relative path is reported with both sides' metadata", async () => {
  seedConflictingMovies();
  const matches = await getBadMatches();
  assert.deepEqual(matches, [
    {
      relativePath: "Alpha (2020)/Alpha.mkv", // mount-stripped, identical on both servers
      plex: { tmdbId: 100, mediaType: "MOVIE", title: "Plex 100", posterPath: null, releaseYear: "2020" },
      plexRatingKey: "plex-100",
      jellyfin: { tmdbId: 999, mediaType: "MOVIE", title: "JF 999", posterPath: null, releaseYear: "2020" },
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
  const matches = await getBadMatches();
  assert.equal(matches.length, 1);
  assert.equal(matches[0].relativePath, "Alpha (2020)/Alpha.mkv");
  assert.equal(matches[0].jellyfin.tmdbId, 999);
});

test("rows with null or empty filePath are ignored — no phantom matches, no crash", async () => {
  seedConflictingMovies();
  plexRows.push(plexItem(300, "MOVIE", null), plexItem(301, "MOVIE", ""));
  jfRows.push(jfItem(3999, "MOVIE", null));
  const matches = await getBadMatches();
  assert.deepEqual(matches.map((m) => m.relativePath), ["Alpha (2020)/Alpha.mkv"]);
});

// ── ARR verdicts (via the cached path map) ──────────────────────────────────

test("radarr agreeing with Plex flags the jellyfin side; the cache hit never re-writes the cache", async () => {
  seedConflictingMovies();
  // Cached map keys by the media FOLDER basename — for movies, the file's
  // parent dir — which is what survives across different bind-mount roots.
  seedArrPaths("radarr", [["Alpha (2020)", 100]]);

  const [match] = await getBadMatches();
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
    ["Alpha (2020)", 999], // arr sides with jellyfin
    ["Beta (2019)", 555], // arr disagrees with BOTH — a third opinion is not a verdict
  ]);

  const matches = await getBadMatches();
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
  seedArrPaths("sonarr", [["ShowX", 300]]);

  const matches = await getBadMatches();
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

  // In a mixed library the inferred mount stops at /plexmedia/ (movies/ and
  // tv/ diverge one segment in), so movie rels keep the "movies/" library dir
  // — only a *MoviePathStripPrefix would peel it, and none is configured here.
  const all = await getBadMatches();
  assert.deepEqual(all.map((m) => m.relativePath), ["movies/Alpha (2020)/Alpha.mkv", "ShowX"]);

  const movies = await getBadMatches("MOVIE");
  assert.deepEqual(movies.map((m) => m.relativePath), ["movies/Alpha (2020)/Alpha.mkv"]);

  const tv = await getBadMatches("TV");
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

  const matches = await getBadMatches();
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
});

test("a failing ARR map build warns with the [bad-matches] scope and is non-fatal to the report", async () => {
  seedConflictingMovies();
  // No cached arr map + a settings read that blows up = the catch path. The
  // source comment demands a warn here: silent degradation used to read as
  // "no problems found".
  settingFindUnique = async () => {
    throw new Error("settings table unavailable");
  };

  const matches = await getBadMatches();
  assert.equal(matches.length, 1); // the mismatch still surfaces
  assert.equal(matches[0].arrTmdbId, null);
  assert.equal(matches[0].arrVerdict, null);
  assert.ok(
    warns.some((w) => w.includes("[bad-matches] ARR path map fetch failed") && w.includes("settings table unavailable")),
    `expected a scoped warn, got: ${JSON.stringify(warns)}`,
  );
});
