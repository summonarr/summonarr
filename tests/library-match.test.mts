// The library match check: the pure rules (src/lib/library-match.ts) and the
// data module's pure halves (projection, stored-report parse/drop, the item
// move a single-item fix writes — src/lib/library-match-data.ts).
//
// Fixtures are the live cases from the 2026-10-13 Jellyfin scan that motivated
// the check: "Ghost in the Shell (2017)" matched to the 1995 film (tmdb 9323)
// beside a correct 1995 copy, an IMDb-only item the sync drops, an extra in a
// matched folder ("Repulsion (1965)/A.British.Horror.Film…"), and a folder
// Radarr doesn't manage whose year disagrees ("Black Christmas (2006)" → 1974).
process.env.TOKEN_ENCRYPTION_KEY = "ab".repeat(32);

import { test } from "node:test";
import assert from "node:assert/strict";

const {
  judgeLibraryMatches,
  indexArrFolders,
  fixableFlag,
  folderYear,
  ownFolder,
} = await import("../src/lib/library-match.ts");
const { projectArrRows, parseLibraryMatchReport, dropMatchFlagInTx, moveItemToTitleInTx, LIBRARY_MATCH_REPORT_KEY } =
  await import("../src/lib/library-match-data.ts");
type ServerMatchEntry = import("../src/lib/library-match.ts").ServerMatchEntry;
type ArrMatchEntry = import("../src/lib/library-match.ts").ArrMatchEntry;

function jf(over: Partial<ServerMatchEntry> & { itemKey: string; path: string }): ServerMatchEntry {
  return { server: "jellyfin", serverInstance: "", mediaType: "MOVIE", title: null, year: null, tmdbIds: [], imdbId: null, tvdbId: null, ...over };
}
function radarr(over: Partial<ArrMatchEntry> & { path: string }): ArrMatchEntry {
  return { service: "radarr", instance: "", mediaType: "MOVIE", tmdbId: null, imdbId: null, tvdbId: null, title: null, year: null, ...over };
}

const GITS_1995 = radarr({ path: "/data/movies/Ghost in the Shell (1995)", tmdbId: 9323, imdbId: "tt0113568", title: "Ghost in the Shell", year: 1995 });
const GITS_2017 = radarr({ path: "/data/movies/Ghost in the Shell (2017)", tmdbId: 315837, imdbId: "tt1219827", title: "Ghost in the Shell", year: 2017 });

test("a copy matched to the WRONG title is flagged with Radarr's title as the suggestion — the correct copy beside it is not", () => {
  const { flags, counts } = judgeLibraryMatches([
    jf({ itemKey: "a1", path: "/mnt/movies/Ghost in the Shell (1995)/gits.1995.mkv", tmdbIds: [9323], imdbId: "tt0113568", title: "Ghost in the Shell", year: 1995 }),
    jf({ itemKey: "b2", path: "/mnt/movies/Ghost in the Shell (2017)/gits.2017.mkv", tmdbIds: [9323], imdbId: "tt0113568", title: "Ghost in the Shell", year: 1995 }),
  ], [GITS_1995, GITS_2017]);
  assert.equal(flags.length, 1);
  const [f] = flags;
  assert.equal(f.kind, "wrongMatch");
  assert.equal(f.itemKey, "b2", "the 2017 folder's copy, never the correctly matched 1995 one");
  assert.equal(f.folder, "Ghost in the Shell (2017)");
  assert.equal(f.file, "gits.2017.mkv");
  assert.equal(f.serverTmdbId, 9323);
  assert.deepEqual(f.arr, { service: "radarr", instance: "", tmdbId: 315837, tvdbId: null, title: "Ghost in the Shell", year: 2017 });
  assert.equal(f.sibling, false);
  assert.equal(fixableFlag(f), true);
  assert.deepEqual(counts, { checked: 2, agreed: 1, notManaged: 0, flagged: 1 });
});

test("ONE shared id is agreement — tmdb, imdb or tvdb — so a TMDB duplicate of the same film is never flagged", () => {
  const { flags, counts } = judgeLibraryMatches([
    jf({ itemKey: "t", path: "/m/Ghost in the Shell (1995)/a.mkv", tmdbIds: [9323] }),
    jf({ itemKey: "i", path: "/m/Ghost in the Shell (2017)/b.mkv", tmdbIds: [999999], imdbId: "tt1219827" }),
  ], [GITS_1995, GITS_2017]);
  assert.deepEqual(flags, []);
  assert.equal(counts.agreed, 2);

  const series = judgeLibraryMatches([
    { ...jf({ itemKey: "s", path: "/mnt/television/The Office (US)", tmdbIds: [12345], tvdbId: 73244 }), mediaType: "TV" },
  ], [{ ...radarr({ path: "/tv/The Office (US)", tvdbId: 73244 }), service: "sonarr", mediaType: "TV" }]);
  assert.deepEqual(series.flags, [], "Sonarr v3 knows only the tvdb id — agreeing on it is agreement");
});

test("an item the server knows only by IMDb is 'no TMDB id' with Radarr's suggestion; a Plex legacy-agent item the sync resolves is not", () => {
  const leftHolding = radarr({ path: "/data/movies/Left Holding Baby (2007)", tmdbId: 54321, imdbId: "tt1076827", title: "Left Holding Baby", year: 2007 });
  const { flags } = judgeLibraryMatches([
    jf({ itemKey: "imdb-only", path: "/mnt/movies/Left Holding Baby (2007)/Left Holding Baby.2007.mkv", imdbId: "tt1076827" }),
    { ...jf({ itemKey: "123", path: "/plex/Left Holding Baby (2007)/x.mkv", imdbId: "tt1076827" }), server: "plex", legacyPlaced: true },
  ], [leftHolding]);
  assert.equal(flags.length, 1);
  assert.equal(flags[0].kind, "noTmdbId");
  assert.equal(flags[0].itemKey, "imdb-only");
  assert.equal(flags[0].arr?.tmdbId, 54321);
  assert.equal(fixableFlag(flags[0]), true);
});

test("an item with no ids at all in a managed folder is 'no TMDB id' with the suggestion; in an unmanaged folder, with none", () => {
  const { flags, counts } = judgeLibraryMatches([
    jf({ itemKey: "managed", path: "/mnt/movies/Invictus (2009)/weird-name.par2.mkv" }),
    jf({ itemKey: "loose", path: "/mnt/movies/UNKNOWN.0.BR-Rip.mkv" }),
  ], [radarr({ path: "/data/movies/Invictus (2009)", tmdbId: 22954, title: "Invictus", year: 2009 })]);
  const byKey = new Map(flags.map((f) => [f.itemKey, f]));
  assert.equal(byKey.get("managed")?.kind, "noTmdbId");
  assert.equal(byKey.get("managed")?.arr?.tmdbId, 22954);
  assert.equal(byKey.get("loose")?.kind, "noTmdbId");
  assert.equal(byKey.get("loose")?.arr, null);
  assert.equal(fixableFlag(byKey.get("loose")!), false, "no referee, no fix");
  assert.equal(counts.notManaged, 1);
});

test("an extra in a folder another item already matches is flagged `sibling` and never offered a fix", () => {
  const repulsion = radarr({ path: "/data/movies/Repulsion (1965)", tmdbId: 11481, imdbId: "tt0059646", title: "Repulsion", year: 1965 });
  const { flags } = judgeLibraryMatches([
    jf({ itemKey: "film", path: "/mnt/movies/Repulsion (1965)/Repulsion.1965.mkv", tmdbIds: [11481] }),
    jf({ itemKey: "extra", path: "/mnt/movies/Repulsion (1965)/A.British.Horror.Film.2003.mkv" }),
    jf({ itemKey: "wrong-extra", path: "/mnt/movies/Repulsion (1965)/Making.Of.mkv", tmdbIds: [777] }),
  ], [repulsion]);
  assert.deepEqual(flags.map((f) => [f.itemKey, f.sibling]).sort(), [["extra", true], ["wrong-extra", true]]);
  assert.ok(flags.every((f) => !fixableFlag(f)));
});

test("year mismatch: only where no Radarr/Sonarr manages the folder, only from a '(YYYY)' folder, and only beyond two years", () => {
  const { flags } = judgeLibraryMatches([
    jf({ itemKey: "bc", path: "/mnt/movies/Black Christmas (2006)/bc.mkv", tmdbIds: [16938], year: 1974 }),
    jf({ itemKey: "off-by-one", path: "/mnt/movies/Battle Royale (2001)/br.mkv", tmdbIds: [3176], year: 2000 }),
    // A festival premiere two years before the wide release — seen live ("Our Friend (2021)" → 2019).
    jf({ itemKey: "festival", path: "/mnt/movies/Our Friend (2021)/of.mkv", tmdbIds: [526019], year: 2019 }),
    jf({ itemKey: "three-off", path: "/mnt/movies/Murder in the Woods (2020)/m.mkv", tmdbIds: [1], year: 2017 }),
    jf({ itemKey: "no-year", path: "/mnt/movies/Some Movie/sm.mkv", tmdbIds: [1], year: 1990 }),
    jf({ itemKey: "managed", path: "/mnt/movies/Ghost in the Shell (2017)/x.mkv", tmdbIds: [315837], year: 1995 }),
  ], [GITS_2017]);
  assert.deepEqual(flags.map((f) => [f.itemKey, f.kind]).sort(), [["bc", "yearMismatch"], ["three-off", "yearMismatch"]]);
  assert.ok(flags.every((f) => f.arr === null && !fixableFlag(f)), "a year flag has no suggestion to fix to");
});

test("a folder name two Radarr entries claim for DIFFERENT titles referees nothing; the same title in two instances still does", () => {
  const hd = radarr({ path: "/hd/Dune (2021)", tmdbId: 438631 });
  const k4 = { ...radarr({ path: "/4k/Dune (2021)", tmdbId: 438631 }), instance: "4k" };
  assert.equal(indexArrFolders([hd, k4]).get("MOVIE")?.get("dune (2021)")?.tmdbId, 438631);

  const other = { ...radarr({ path: "/anime/Dune (2021)", tmdbId: 1 }), instance: "anime" };
  const idx = indexArrFolders([hd, other, k4]);
  assert.equal(idx.get("MOVIE")?.has("dune (2021)"), false, "ambiguous, and stays ambiguous when a third entry agrees with one side");
  const { flags, counts } = judgeLibraryMatches([jf({ itemKey: "d", path: "/m/Dune (2021)/d.mkv", tmdbIds: [5] })], [hd, other]);
  assert.deepEqual(flags, []);
  assert.equal(counts.notManaged, 1);
});

test("folders compare case- and Unicode-normalisation-insensitively; a show is judged by its folder anywhere in the path", () => {
  const amelie = radarr({ path: "/data/movies/Am\u00e9lie (2001)", tmdbId: 194 });
  const nfd = "Ame\u0301lie (2001)".toUpperCase();
  const { flags, counts } = judgeLibraryMatches([jf({ itemKey: "m", path: `/mnt/movies/${nfd}/a.mkv`, tmdbIds: [1] })], [amelie]);
  assert.equal(flags[0]?.kind, "wrongMatch");
  assert.equal(counts.notManaged, 0);

  const show = { ...radarr({ path: "/tv/Doctor Who (2005)", tvdbId: 78804, tmdbId: 57243 }), service: "sonarr" as const, mediaType: "TV" as const };
  const plexEpisodePath = { ...jf({ itemKey: "77", path: "/plex/tv/Doctor Who (2005)/Season 1/s01e01.mkv", tmdbIds: [121] }), server: "plex" as const, mediaType: "TV" as const };
  assert.equal(judgeLibraryMatches([plexEpisodePath], [show]).flags[0]?.arr?.tmdbId, 57243);
});

test("flags sort wrong matches first; within a kind the fixable ones first, then those with no suggestion, then the extras", () => {
  const repulsion = radarr({ path: "/r/Repulsion (1965)", tmdbId: 11481 });
  const invictus = radarr({ path: "/r/Invictus (2009)", tmdbId: 22954 });
  const unmatched = judgeLibraryMatches([
    jf({ itemKey: "a-unmanaged", path: "/m/Aardvark/a.mkv", title: "Aardvark" }),
    jf({ itemKey: "z-fixable", path: "/m/Invictus (2009)/x.mkv", title: "Zzz" }),
  ], [invictus]);
  assert.deepEqual(unmatched.flags.map((f) => f.itemKey), ["z-fixable", "a-unmanaged"]);
  const { flags } = judgeLibraryMatches([
    jf({ itemKey: "year", path: "/m/Black Christmas (2006)/bc.mkv", tmdbIds: [16938], year: 1974, title: "Black Christmas" }),
    jf({ itemKey: "film", path: "/m/Repulsion (1965)/r.mkv", tmdbIds: [11481] }),
    jf({ itemKey: "sib", path: "/m/Repulsion (1965)/extra.mkv", tmdbIds: [2], title: "A" }),
    jf({ itemKey: "wrong", path: "/m/Ghost in the Shell (2017)/g.mkv", tmdbIds: [9323], title: "Z" }),
  ], [repulsion, GITS_2017]);
  assert.deepEqual(flags.map((f) => f.itemKey), ["wrong", "sib", "year"]);
});

test("folderYear / ownFolder read the folder the item sits in", () => {
  assert.equal(folderYear("Black Christmas (2006)"), 2006);
  assert.equal(folderYear("Doctor Who"), null);
  assert.equal(ownFolder("/mnt/movies/X (1999)/x.mkv"), "X (1999)");
  assert.equal(ownFolder("/mnt/television/Show (2020)"), "Show (2020)");
  assert.equal(ownFolder("C:\\Media\\Film (2010)\\f.mkv"), "Film (2010)");
  assert.equal(ownFolder(null), null);
});

test("projectArrRows keeps only rows with a folder and reads ids strictly (Sonarr v4's tmdbId 0 is none)", () => {
  const rows = projectArrRows("sonarr", "anime", [
    { tvdbId: 81797, tmdbId: 0, imdbId: "tt0388629", title: "One Piece", year: 1999, path: "/tv/One Piece" },
    { tvdbId: 1, title: "No folder" },
    { tvdbId: "2", tmdbId: 3.5, imdbId: "nope", title: 5, year: -1, path: "/tv/X" },
    null,
  ]);
  assert.deepEqual(rows, [
    { service: "sonarr", instance: "anime", mediaType: "TV", tmdbId: null, tvdbId: 81797, imdbId: "tt0388629", title: "One Piece", year: 1999, path: "/tv/One Piece" },
    { service: "sonarr", instance: "anime", mediaType: "TV", tmdbId: null, tvdbId: null, imdbId: null, title: null, year: null, path: "/tv/X" },
  ]);
  assert.equal(projectArrRows("radarr", "", [{ tmdbId: 5, tvdbId: 9, path: "/m/A" }])[0].tvdbId, null, "a movie's tvdb id is never read");
  assert.deepEqual(projectArrRows("radarr", "", { not: "an array" }), []);
});

// ── stored report ──────────────────────────────────────────────────────────

const flag = (itemKey: string, server: "plex" | "jellyfin" = "jellyfin", serverInstance = "") => ({
  kind: "wrongMatch" as const, server, serverInstance, mediaType: "MOVIE" as const, itemKey, title: null, year: null,
  folder: "F (2000)", file: "f.mkv", path: "/m/F (2000)/f.mkv", serverTmdbId: 1, arr: null, sibling: false,
});
const report = (flags: ReturnType<typeof flag>[]) => ({
  version: 1, checkedAt: "2026-10-13T00:00:00.000Z", sources: [], counts: { checked: 9, agreed: 5, notManaged: 2, flagged: flags.length }, flags, truncated: 0,
});

test("parseLibraryMatchReport refuses anything but a version-1 report", () => {
  assert.deepEqual(parseLibraryMatchReport(JSON.stringify(report([flag("a")])))?.flags.map((f) => f.itemKey), ["a"]);
  assert.equal(parseLibraryMatchReport(JSON.stringify({ ...report([]), version: 2 })), null);
  assert.equal(parseLibraryMatchReport("{not json"), null);
  assert.equal(parseLibraryMatchReport(null), null);
  assert.equal(parseLibraryMatchReport(JSON.stringify({ version: 1, flags: [] })), null);
});

function reportTx(stored: string | null) {
  const calls: string[] = [];
  let value = stored;
  const tx = {
    $executeRaw: async (sql: unknown) => { calls.push(`lock:${JSON.stringify((sql as { values?: unknown[] }).values ?? sql)}`); return 0; },
    setting: {
      findUnique: async (args: { where: { key: string } }) => { calls.push(`read:${args.where.key}`); return value === null ? null : { key: args.where.key, value }; },
      update: async (args: { where: { key: string }; data: { value: string } }) => { calls.push(`write:${args.where.key}`); value = args.data.value; return {}; },
    },
  };
  return { tx, calls, value: () => value };
}

test("dropMatchFlagInTx removes exactly the fixed item's flag (server + instance + key), under the report-row lock", async () => {
  const r = reportTx(JSON.stringify(report([flag("a"), flag("a", "plex"), flag("a", "jellyfin", "remote"), flag("b")])));
  await dropMatchFlagInTx(r.tx as never, "jellyfin", "", "a");
  assert.equal(r.calls[0].startsWith("lock:"), true, "the lock is taken before the read");
  const after = parseLibraryMatchReport(r.value())!;
  assert.deepEqual(after.flags.map((f) => `${f.server}:${f.serverInstance}:${f.itemKey}`), ["plex::a", "jellyfin:remote:a", "jellyfin::b"]);
  assert.equal(after.counts.flagged, 3);

  const none = reportTx(JSON.stringify(report([flag("b")])));
  await dropMatchFlagInTx(none.tx as never, "jellyfin", "", "a");
  assert.ok(!none.calls.some((c) => c.startsWith("write:")), "nothing to drop, nothing written");
  const empty = reportTx(null);
  await dropMatchFlagInTx(empty.tx as never, "jellyfin", "", "a");
  assert.deepEqual(empty.calls.filter((c) => c.startsWith("read:")), [`read:${LIBRARY_MATCH_REPORT_KEY}`]);
});

// ── the item move a single-item fix writes ─────────────────────────────────

type Row = { tmdbId: number; mediaType: string; serverInstance: string; jellyfinItemId: string | null; jellyfinItemIds: string[]; filePath: string | null };
function libraryTx(rows: Row[]) {
  const key = (w: { tmdbId: number; mediaType: string; serverInstance: string }) => rows.find((r) => r.tmdbId === w.tmdbId && r.mediaType === w.mediaType && r.serverInstance === w.serverInstance);
  return {
    jellyfinLibraryItem: {
      findMany: async (args: { where: { serverInstance: string; mediaType: string; tmdbId: { not: number }; OR: [{ jellyfinItemId: { in: string[] } }, { jellyfinItemIds: { hasSome: string[] } }] } }) => {
        const w = args.where;
        const ids = new Set(w.OR[0].jellyfinItemId.in);
        return rows.filter((r) => r.serverInstance === w.serverInstance && r.mediaType === w.mediaType && r.tmdbId !== w.tmdbId.not
          && ((r.jellyfinItemId !== null && ids.has(r.jellyfinItemId)) || r.jellyfinItemIds.some((k) => ids.has(k)))).map((r) => ({ ...r }));
      },
      findUnique: async (args: { where: { tmdbId_mediaType_serverInstance: { tmdbId: number; mediaType: string; serverInstance: string } } }) => {
        const r = key(args.where.tmdbId_mediaType_serverInstance);
        return r ? { ...r } : null;
      },
      update: async (args: { where: { tmdbId_mediaType_serverInstance: { tmdbId: number; mediaType: string; serverInstance: string } }; data: Partial<Row> }) => {
        Object.assign(key(args.where.tmdbId_mediaType_serverInstance)!, args.data);
        return {};
      },
      create: async (args: { data: Row }) => { rows.push({ ...args.data }); return {}; },
      deleteMany: async (args: { where: { tmdbId: number; mediaType: string; serverInstance: string } }) => {
        const r = key(args.where);
        if (r) rows.splice(rows.indexOf(r), 1);
        return { count: r ? 1 : 0 };
      },
    },
  };
}

test("moving ONE copy leaves the correct copy on the old title and adds this one to the corrected title", async () => {
  const rows: Row[] = [
    { tmdbId: 9323, mediaType: "MOVIE", serverInstance: "", jellyfinItemId: "a1", jellyfinItemIds: ["a1", "b2"], filePath: "/m/Ghost in the Shell (1995)/g.mkv" },
  ];
  await moveItemToTitleInTx(libraryTx(rows) as never, "jellyfin", "", "MOVIE", "b2", "b2", 315837, "/m/Ghost in the Shell (2017)/g.mkv");
  assert.deepEqual(rows, [
    { tmdbId: 9323, mediaType: "MOVIE", serverInstance: "", jellyfinItemId: "a1", jellyfinItemIds: ["a1"], filePath: "/m/Ghost in the Shell (1995)/g.mkv" },
    { tmdbId: 315837, mediaType: "MOVIE", serverInstance: "", jellyfinItemId: "b2", jellyfinItemIds: ["b2"], filePath: "/m/Ghost in the Shell (2017)/g.mkv" },
  ]);
});

test("moving a row's CANONICAL copy hands the row to its next copy (path unknown); moving its only copy deletes it; an existing target row is merged", async () => {
  const rows: Row[] = [
    { tmdbId: 9323, mediaType: "MOVIE", serverInstance: "", jellyfinItemId: "b2", jellyfinItemIds: ["b2", "a1"], filePath: "/m/2017/g.mkv" },
    { tmdbId: 1, mediaType: "MOVIE", serverInstance: "", jellyfinItemId: "solo", jellyfinItemIds: ["solo"], filePath: "/m/solo.mkv" },
    { tmdbId: 315837, mediaType: "MOVIE", serverInstance: "", jellyfinItemId: "c3", jellyfinItemIds: ["c3"], filePath: "/m/other/g.mkv" },
    { tmdbId: 9323, mediaType: "MOVIE", serverInstance: "remote", jellyfinItemId: "b2", jellyfinItemIds: ["b2"], filePath: "/r.mkv" },
  ];
  const tx = libraryTx(rows) as never;
  await moveItemToTitleInTx(tx, "jellyfin", "", "MOVIE", "b2", "b2-new", 315837, "/m/2017/g.mkv");
  await moveItemToTitleInTx(tx, "jellyfin", "", "MOVIE", "solo", "solo", 2, null);
  const by = (t: number, i = "") => rows.find((r) => r.tmdbId === t && r.serverInstance === i);
  assert.deepEqual(by(9323), { tmdbId: 9323, mediaType: "MOVIE", serverInstance: "", jellyfinItemId: "a1", jellyfinItemIds: ["a1"], filePath: null });
  assert.deepEqual(by(315837)?.jellyfinItemIds, ["c3", "b2-new"], "merged — the target's own copy stays canonical");
  assert.equal(by(315837)?.jellyfinItemId, "c3");
  assert.equal(by(1), undefined, "a row left with no copy is deleted");
  assert.equal(by(2)?.jellyfinItemId, "solo");
  assert.deepEqual(by(9323, "remote")?.jellyfinItemIds, ["b2"], "another server's row is never touched");
});
