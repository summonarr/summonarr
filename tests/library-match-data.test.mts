// runLibraryMatchCheck end to end over an in-memory Setting store and scripted
// Jellyfin + Radarr servers: the real listers, the real judge, the stored
// report. The outcomes that matter for a check that offers fixes:
//   - a copy folded into another title's row by the sync is found and flagged;
//   - a Radarr that can't be read referees NOTHING — never a wrongMatch on an
//     item it would have agreed with — and is named in `sources`;
//   - an aborted run stores nothing (guardrail 41), the previous report stays;
//   - a Sonarr suggestion resolved from its TVDB id after judging re-ranks its
//     flag before the stored list is cut;
//   - a flag a fix drops while the check is listing stays dropped (37e).
process.env.TOKEN_ENCRYPTION_KEY = "ab".repeat(32);
process.env.TRUST_PROXY = "true";

import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";

const warns: string[] = [];
console.warn = (...args: unknown[]) => { warns.push(args.map(String).join(" ")); };

const settings = new Map<string, string>();
type Where = { key: string | { in?: string[]; startsWith?: string } };
const matches = (key: string, w: Where["key"]) =>
  typeof w === "string" ? key === w : (w.in ? w.in.includes(key) : true) && (w.startsWith ? key.startsWith(w.startsWith) : true);
const settingDelegate = {
  findUnique: async (a: { where: { key: string } }) => (settings.has(a.where.key) ? { key: a.where.key, value: settings.get(a.where.key)! } : null),
  findMany: async (a: { where: Where }) => [...settings].filter(([k]) => matches(k, a.where.key)).map(([key, value]) => ({ key, value })),
  upsert: async (a: { where: { key: string }; create: { value: string }; update: { value: string } }) => {
    settings.set(a.where.key, settings.has(a.where.key) ? a.update.value : a.create.value);
    return {};
  },
  update: async (a: { where: { key: string }; data: { value: string } }) => { settings.set(a.where.key, a.data.value); return {}; },
};
let locks = 0;
// tvdb-to-tmdb cross-reference rows (arr.ts resolveTvdbToTmdb reads them first).
const tvdbCache = new Map<number, number>();
(globalThis as unknown as { prisma: unknown }).prisma = {
  setting: settingDelegate,
  $transaction: async (fn: (tx: unknown) => Promise<unknown>) => fn({ setting: settingDelegate, $executeRaw: async () => { locks++; return 0; } }),
  tmdbCache: {
    findMany: async (a: { where: { key: { in: string[] } } }) => a.where.key.in.flatMap((key) => {
      const tmdbId = tvdbCache.get(Number(key.slice("tvdb-to-tmdb:".length)));
      return tmdbId === undefined ? [] : [{ key, data: JSON.stringify({ tmdbId }), expiresAt: new Date(Date.now() + 3_600_000) }];
    }),
  },
  mediaRequest: { findMany: async () => [] },
};

const JF = "http://10.77.0.1:8096";
const RADARR = "http://10.77.0.2:7878";
const SONARR = "http://10.77.0.3:8989";
let radarrStatus = 200;
// Extra titles Radarr lists after the two below (no folder match, no flag).
let radarrExtra = 0;
// Jellyfin series and Sonarr series (the TV tests only).
let jfSeries: unknown[] = [];
let sonarrSeries: unknown[] = [];
// Runs as Radarr answers — after the run has started listing.
let onRadarrListing: (() => Promise<void>) | null = null;
globalThis.fetch = (async (input: RequestInfo | URL) => {
  const url = new URL(String(input));
  const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
  if (url.origin === JF && url.pathname === "/Items") {
    if (url.searchParams.get("CollapseBoxSetItems") !== "false") return json({ Items: [{ Id: "box", Type: "BoxSet" }], TotalRecordCount: 1 });
    if (url.searchParams.get("IncludeItemTypes") === "Series") return json({ Items: jfSeries, TotalRecordCount: jfSeries.length });
    return json({
      Items: [
        { Id: "a1", Type: "Movie", Name: "Ghost in the Shell", ProductionYear: 1995, Path: "/mnt/movies/Ghost in the Shell (1995)/a.mkv", ProviderIds: { Tmdb: "9323" } },
        { Id: "b2", Type: "Movie", Name: "Ghost in the Shell", ProductionYear: 1995, Path: "/mnt/movies/Ghost in the Shell (2017)/b.mkv", ProviderIds: { Tmdb: "9323" } },
      ],
      TotalRecordCount: 2,
    });
  }
  if (url.origin === SONARR && url.pathname === "/api/v3/series") return json(sonarrSeries);
  if (url.origin === RADARR && url.pathname === "/api/v3/movie") {
    if (onRadarrListing) await onRadarrListing();
    if (radarrStatus !== 200) return new Response("boom", { status: radarrStatus });
    return json([
      { tmdbId: 9323, imdbId: "tt0113568", title: "Ghost in the Shell", year: 1995, path: "/data/movies/Ghost in the Shell (1995)" },
      { tmdbId: 315837, imdbId: "tt1219827", title: "Ghost in the Shell", year: 2017, path: "/data/movies/Ghost in the Shell (2017)" },
      ...Array.from({ length: radarrExtra }, (_, i) => ({ tmdbId: 1_000_000 + i, path: `/data/movies/x${i}` })),
    ]);
  }
  throw new Error(`unexpected fetch ${url}`);
}) as typeof fetch;

const { runLibraryMatchCheck, readLibraryMatchReport, dropMatchFlagInTx, LIBRARY_MATCH_REPORT_KEY } = await import("../src/lib/library-match-data.ts");

beforeEach(() => {
  settings.clear();
  settings.set("jellyfinUrl", JF);
  settings.set("jellyfinApiKey", "jf-key");
  settings.set("radarrUrl", RADARR);
  settings.set("radarrApiKey", "radarr-key");
  radarrStatus = 200;
  radarrExtra = 0;
  jfSeries = [];
  sonarrSeries = [];
  onRadarrListing = null;
  tvdbCache.clear();
  locks = 0;
  warns.length = 0;
});

test("finds the copy the sync folds into the 1995 film's row, and stores the report under the report-row lock", async () => {
  const report = await runLibraryMatchCheck({ now: new Date("2026-10-13T12:00:00.000Z") });
  assert.ok(report);
  assert.deepEqual(report.sources, [
    { service: "jellyfin", instance: "", ok: true, items: 2 },
    { service: "radarr", instance: "", ok: true, items: 2 },
  ]);
  assert.deepEqual(report.flags.map((f) => [f.kind, f.itemKey, f.serverTmdbId, f.arr?.tmdbId]), [["wrongMatch", "b2", 9323, 315837]]);
  assert.deepEqual(report.counts, { checked: 2, agreed: 1, notManaged: 0, flagged: 1 });
  assert.equal(report.checkedAt, "2026-10-13T12:00:00.000Z");
  assert.equal(locks, 1);
  assert.deepEqual(await readLibraryMatchReport(), report, "what the page reads back is what was judged");
});

test("a Radarr that can't be read referees nothing: no wrongMatch, the instance named with its error kind", async () => {
  radarrStatus = 500;
  const report = await runLibraryMatchCheck();
  assert.ok(report);
  assert.deepEqual(report.sources.find((s) => s.service === "radarr"), { service: "radarr", instance: "", ok: false, kind: "server", items: 0 });
  assert.ok(report.flags.every((f) => f.kind !== "wrongMatch" && f.arr === null));
  assert.equal(report.counts.notManaged, 2);
  // The folder year still speaks — with no suggestion, so nothing is offered a fix.
  assert.deepEqual(report.flags.map((f) => [f.kind, f.itemKey]), [["yearMismatch", "b2"]]);
});

test("an aborted run stores nothing and the previous report stays", async () => {
  settings.set(LIBRARY_MATCH_REPORT_KEY, "previous");
  const controller = new AbortController();
  controller.abort();
  assert.equal(await runLibraryMatchCheck({ signal: controller.signal }), null);
  assert.equal(settings.get(LIBRARY_MATCH_REPORT_KEY), "previous");
});

test("a Radarr listing past where a spread push throws is read whole, not marked unreadable (guardrail 5i)", async () => {
  radarrExtra = 130_000;
  const report = await runLibraryMatchCheck();
  assert.ok(report);
  assert.deepEqual(report.sources.find((s) => s.service === "radarr"), { service: "radarr", instance: "", ok: true, items: 130_002 });
  assert.deepEqual(report.flags.map((f) => [f.kind, f.itemKey, f.arr?.tmdbId]), [["wrongMatch", "b2", 315837]], "it still referees");
});

test("a Sonarr suggestion resolved from its TVDB id moves its flag ahead of one left with no suggestion", async () => {
  // Sonarr v3 sends no TMDB id: the suggestion is filled from TMDB's TVDB
  // cross-reference AFTER judging, and a fixable flag must not keep the
  // alphabetical place it had as an unfixable one (the stored list is cut at
  // MAX_STORED_FLAGS and the page renders the first few hundred).
  settings.set("sonarrUrl", SONARR);
  settings.set("sonarrApiKey", "sonarr-key");
  jfSeries = [
    { Id: "s-a", Type: "Series", Name: "Aaa", Path: "/mnt/tv/Alpha Show", ProviderIds: { Tmdb: "5", Tvdb: "333" } },
    { Id: "s-z", Type: "Series", Name: "Zzz", Path: "/mnt/tv/Zulu Show", ProviderIds: { Tmdb: "6", Tvdb: "444" } },
  ];
  sonarrSeries = [
    { tvdbId: 111, title: "Alpha Show", path: "/tv/Alpha Show" },
    { tvdbId: 222, title: "Zulu Show", path: "/tv/Zulu Show" },
  ];
  tvdbCache.set(222, 999); // only Zulu's resolves
  const report = await runLibraryMatchCheck();
  assert.ok(report);
  const tv = report.flags.filter((f) => f.mediaType === "TV");
  assert.deepEqual(tv.map((f) => [f.kind, f.itemKey, f.arr?.tmdbId]), [["wrongMatch", "s-z", 999], ["wrongMatch", "s-a", null]]);
  assert.deepEqual((await readLibraryMatchReport())?.flags.filter((f) => f.mediaType === "TV").map((f) => f.itemKey), ["s-z", "s-a"]);
});

test("a flag a fix drops while the check is listing is not brought back by the check's report (guardrail 37e)", async () => {
  // The stored report flags b2. The admin fixes it while the check is still
  // listing — the fix drops its flag under the report-row lock — and the
  // check's own listing, taken before the fix landed, still sees it wrong.
  const stored = {
    version: 1, checkedAt: "2026-10-12T00:00:00.000Z", sources: [], truncated: 0,
    counts: { checked: 2, agreed: 1, notManaged: 0, flagged: 1 },
    flags: [{
      kind: "wrongMatch", server: "jellyfin", serverInstance: "", mediaType: "MOVIE", itemKey: "b2", title: "Ghost in the Shell", year: 1995,
      folder: "Ghost in the Shell (2017)", file: "b.mkv", path: "/mnt/movies/Ghost in the Shell (2017)/b.mkv", serverTmdbId: 9323,
      arr: { service: "radarr", instance: "", tmdbId: 315837, tvdbId: null, title: "Ghost in the Shell", year: 2017 }, sibling: false,
    }],
  };
  settings.set(LIBRARY_MATCH_REPORT_KEY, JSON.stringify(stored));
  onRadarrListing = async () => {
    onRadarrListing = null;
    await dropMatchFlagInTx({ setting: settingDelegate, $executeRaw: async () => 0 } as never, "jellyfin", "", "b2");
  };
  const report = await runLibraryMatchCheck({ now: new Date("2026-10-13T12:00:00.000Z") });
  assert.ok(report);
  assert.deepEqual(report.flags.map((f) => f.itemKey), [], "the fixed item's flag stays dropped");
  assert.equal(report.counts.flagged, 0);
  assert.equal(report.counts.checked, 2, "everything else the run found is kept");
  assert.equal(report.checkedAt, "2026-10-13T12:00:00.000Z");
  assert.deepEqual(await readLibraryMatchReport(), report);

  // With no fix in between, the same flag is reported as before.
  const again = await runLibraryMatchCheck();
  assert.deepEqual(again?.flags.map((f) => f.itemKey), ["b2"]);
  assert.equal(again?.counts.flagged, 1);
});

test("a Sonarr TMDB id resolved from its TVDB id is judged with, so an item carrying it agrees instead of staying a wrong match", async () => {
  settings.set("sonarrUrl", SONARR);
  settings.set("sonarrApiKey", "sonarr-key");
  jfSeries = [
    { Id: "s-a", Type: "Series", Name: "Alpha", Path: "/mnt/tv/Alpha Show", ProviderIds: { Tmdb: "5", Tvdb: "333" } },
    { Id: "s-z", Type: "Series", Name: "Zulu", Path: "/mnt/tv/Zulu Show", ProviderIds: { Tmdb: "6", Tvdb: "444" } },
  ];
  sonarrSeries = [
    { tvdbId: 111, title: "Alpha Show", path: "/tv/Alpha Show" },
    { tvdbId: 222, title: "Zulu Show", path: "/tv/Zulu Show" },
  ];
  tvdbCache.set(111, 5); // the server's own id: Alpha is matched correctly
  tvdbCache.set(222, 999);
  const report = await runLibraryMatchCheck();
  assert.ok(report);
  assert.deepEqual(report.flags.filter((f) => f.mediaType === "TV").map((f) => [f.itemKey, f.arr?.tmdbId]), [["s-z", 999]]);
  assert.equal(report.counts.agreed, 2, "the movie that agrees and Alpha");
  assert.equal(report.counts.flagged, report.flags.length);
});
