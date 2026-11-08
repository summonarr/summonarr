// Tests for the TVDB cross-reference fallback in Sonarr series resolution
// (src/lib/arr-id-map.ts, re-exported by arr.ts: resolveTmdbToTvdb,
// pickSeriesByTvdbCrossRef, and its use in addSeriesToSonarr + the read paths).
//
// The incident: approving TMDB 304842 ("The Drop: A Snowfall Saga", premiered
// eight days earlier) failed with "Sonarr: no series found for tmdbId 304842".
// Live probes of Sonarr's metadata service showed `term=tmdb:304842` answering []
// while its TVDB record 478738 already carried tmdbId 304842 — the id-lookup index
// lags new shows by days. A `tvdb:` lookup would have added it.
//
// The pins that matter:
//   1. THE FALLBACK FIRES ONLY ON A MISS, and a verified tmdb lookup never pays
//      for a TMDB call.
//   2. IT CAN'T ADD THE WRONG SHOW. The tvdb row must carry the TVDB id TMDB gave,
//      and a row whose own TMDB id names a different title is refused.
//   3. THE WEBHOOK'S FORGERY CHECK STAYS SONARR-SOURCED. TMDB's cross-reference is
//      user-edited third-party data; a wrong edit must not turn a genuine Download
//      event into ids-disagree. That path opts out, and still verifies on the
//      payload's own tvdbId.
//   4. THE RESOLVER NEVER THROWS, and only a definitive TMDB answer is cached.
//
// No DB, no network: prisma.setting/tmdbCache are shadowed in-memory, dns.lookup
// is stubbed (the download-check.test idiom), Sonarr is an RFC1918 IP literal so
// its SSRF check needs no DNS, and globalThis.fetch is scripted per test.
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import dns from "node:dns/promises";
import { readFileSync } from "node:fs";

process.env.NEXTAUTH_SECRET ??= "unit-test-session-secret-0123456789abcdef";
process.env.TOKEN_ENCRYPTION_KEY ??= "ab".repeat(32);
process.env.DATABASE_URL ??= "postgresql://unit:unit@127.0.0.1:9/never_connects";
delete process.env.TMDB_READ_TOKEN; // set per test — tmdbAuth() reads it at call time

// A PUBLIC answer: api.themoviedb.org goes through safeFetchTrusted (allowPrivate false).
const fakeLookup = async () => [{ address: "93.184.216.34", family: 4 }];
(dns as { lookup: unknown }).lookup = fakeLookup;
if ((dns as { lookup: unknown }).lookup !== fakeLookup) {
  throw new Error("could not stub dns.lookup — aborting before a real DNS query can leave the process");
}

const warns: string[] = [];
console.warn = (...args: unknown[]) => { warns.push(args.map(String).join(" ")); };
console.error = () => {};

// ── scripted upstreams ──────────────────────────────────────────────────────
type Call = { url: URL; method: string; body?: string };
const calls: Call[] = [];
let tmdbLookup: unknown[] = [];
let tvdbLookup: (tvdbId: number) => unknown[] = () => [];
let tmdbExternalIds: () => Response = () => json({ tvdb_id: null });
let seriesLibrary: (tvdbId: string | null) => unknown[] = () => [];
let seriesStatus = 200;
let sonarrQueue: unknown = { records: [], totalRecords: 0 };

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
  const url = new URL(String(input));
  calls.push({ url, method: init?.method ?? "GET", body: typeof init?.body === "string" ? init.body : undefined });
  if (url.hostname === "api.themoviedb.org") return tmdbExternalIds();
  if (url.pathname === "/api/v3/series/lookup") {
    const term = url.searchParams.get("term") ?? "";
    if (term.startsWith("tmdb:")) return json(tmdbLookup);
    if (term.startsWith("tvdb:")) return json(tvdbLookup(Number(term.slice(5))));
    throw new Error(`unexpected lookup term ${term}`);
  }
  if (url.pathname === "/api/v3/series" && (init?.method ?? "GET") === "POST") return json({ id: 1 });
  if (url.pathname === "/api/v3/series") {
    return seriesStatus === 200 ? json(seriesLibrary(url.searchParams.get("tvdbId"))) : json({ message: "boom" }, seriesStatus);
  }
  if (url.pathname === "/api/v3/queue") return json(sonarrQueue);
  throw new Error(`unexpected fetch ${url}`);
}) as unknown as typeof fetch;

const { prisma } = await import("../src/lib/prisma.ts");
const { shadowPrismaModel } = await import("./_helpers.mts");

const settings = new Map<string, string>();
shadowPrismaModel(prisma, "setting", {
  findMany: async (args: { where: { key: { in: string[] } } }) =>
    args.where.key.in.filter((k) => settings.has(k)).map((k) => ({ key: k, value: settings.get(k)! })),
  findUnique: async (args: { where: { key: string } }) => {
    const value = settings.get(args.where.key);
    return value === undefined ? null : { key: args.where.key, value };
  },
});

type CacheRow = { data: string; expiresAt: Date };
const cache = new Map<string, CacheRow>();
const cacheWrites: { key: string; data: unknown; ttlSeconds: number }[] = [];
shadowPrismaModel(prisma, "tmdbCache", {
  findUnique: async (args: { where: { key: string } }) => {
    const row = cache.get(args.where.key);
    return row ? { key: args.where.key, ...row } : null;
  },
  upsert: async (args: { where: { key: string }; create: { data: string; expiresAt: Date } }) => {
    cache.set(args.where.key, { data: args.create.data, expiresAt: args.create.expiresAt });
    cacheWrites.push({
      key: args.where.key,
      data: JSON.parse(args.create.data),
      ttlSeconds: Math.round((args.create.expiresAt.getTime() - Date.now()) / 1000),
    });
    return {};
  },
  deleteMany: async () => ({ count: 0 }),
});

const {
  addSeriesToSonarr,
  getSeriesFirstAired,
  getSonarrSeriesCompletion,
  isSeriesDownloadedInSonarr,
  isSeriesDownloadingInSonarr,
  pickSeriesByTvdbCrossRef,
  resolveTmdbToTvdb,
  resolveTvdbIdFromTmdbId,
} = await import("../src/lib/arr.ts");
// The read paths reuse a verified lookup for a while (arr-id-map.ts); every case
// here scripts its own lookup answers, so none may be served a previous case's.
const { _resetSeriesLookupCacheForTests } = await import("../src/lib/arr-id-map.ts");

const DAY = 24 * 60 * 60;
const TMDB = 304842;
const TVDB = 478738;
const dropRow = (over: Record<string, unknown> = {}) => ({
  title: "The Drop: A Snowfall Saga",
  tvdbId: TVDB,
  tmdbId: TMDB,
  year: 2026,
  images: [],
  titleSlug: "the-drop-a-snowfall-saga",
  seasons: [{ seasonNumber: 1, monitored: true }],
  firstAired: "2026-09-08T00:00:00Z",
  status: "continuing",
  ...over,
});
const seedCrossRef = (tmdbId: number, tvdbId: number | null) =>
  cache.set(`tmdb-to-tvdb:${tmdbId}`, { data: JSON.stringify({ tvdbId }), expiresAt: new Date(Date.now() + 86_400_000) });

const tmdbCalls = () => calls.filter((c) => c.url.hostname === "api.themoviedb.org");
const lookups = (prefix: "tmdb:" | "tvdb:") =>
  calls.filter((c) => c.url.pathname === "/api/v3/series/lookup" && (c.url.searchParams.get("term") ?? "").startsWith(prefix));
const seriesPosts = () => calls.filter((c) => c.url.pathname === "/api/v3/series" && c.method === "POST");

beforeEach(() => {
  calls.length = 0;
  warns.length = 0;
  cache.clear();
  cacheWrites.length = 0;
  settings.clear();
  settings.set("sonarrUrl", "http://10.0.0.3:8989");
  settings.set("sonarrApiKey", "sonarr-key");
  settings.set("sonarrRootFolder", "/tv");
  settings.set("sonarrQualityProfileId", "1");
  delete process.env.TMDB_READ_TOKEN;
  tmdbLookup = [];
  tvdbLookup = () => [];
  tmdbExternalIds = () => json({ tvdb_id: null });
  seriesLibrary = () => [];
  seriesStatus = 200;
  sonarrQueue = { records: [], totalRecords: 0 };
  _resetSeriesLookupCacheForTests();
});

// ═══ pickSeriesByTvdbCrossRef ═══════════════════════════════════════════════

test("pick: the row carrying TMDB's TVDB id, wherever it sits", () => {
  const rows = [{ tvdbId: 1, tmdbId: 9 }, { tvdbId: TVDB, tmdbId: TMDB }];
  assert.equal(pickSeriesByTvdbCrossRef(rows, TVDB, TMDB)?.tvdbId, TVDB);
});

test("pick: refuses a row whose own TMDB id names a DIFFERENT title — the databases disagree", () => {
  assert.equal(pickSeriesByTvdbCrossRef([{ tvdbId: TVDB, tmdbId: 71694 }], TVDB, TMDB), null);
});

test("pick: a row with no TMDB claim (Sonarr v3, or an unmapped TVDB record) trusts the cross-reference", () => {
  for (const tmdbId of [undefined, 0, -1]) {
    assert.equal(pickSeriesByTvdbCrossRef([{ tvdbId: TVDB, tmdbId }], TVDB, TMDB)?.tvdbId, TVDB, `tmdbId=${tmdbId}`);
  }
});

test("pick: no row with the requested TVDB id ⇒ null, never a lone-row guess", () => {
  assert.equal(pickSeriesByTvdbCrossRef([{ tvdbId: 1234 }], TVDB, TMDB), null);
  assert.equal(pickSeriesByTvdbCrossRef([], TVDB, TMDB), null);
});

// ═══ resolveTmdbToTvdb ══════════════════════════════════════════════════════

test("resolver: a cache hit answers without touching TMDB — including a cached 'none'", async () => {
  process.env.TMDB_READ_TOKEN = "t";
  seedCrossRef(TMDB, TVDB);
  assert.equal(await resolveTmdbToTvdb(TMDB), TVDB);
  seedCrossRef(111, null);
  assert.equal(await resolveTmdbToTvdb(111), null);
  assert.equal(tmdbCalls().length, 0);
});

test("resolver: a definitive TMDB answer is cached — 30 days resolved, 6 hours unresolved (200 null or 404)", async () => {
  process.env.TMDB_READ_TOKEN = "t";
  tmdbExternalIds = () => json({ imdb_id: "tt36210894", tvdb_id: TVDB });
  assert.equal(await resolveTmdbToTvdb(TMDB), TVDB);
  const call = tmdbCalls()[0];
  assert.equal(call.url.pathname, `/3/tv/${TMDB}/external_ids`);
  assert.deepEqual(cacheWrites.at(-1), { key: `tmdb-to-tvdb:${TMDB}`, data: { tvdbId: TVDB }, ttlSeconds: 30 * DAY });

  tmdbExternalIds = () => json({ tvdb_id: null });
  assert.equal(await resolveTmdbToTvdb(222), null);
  assert.deepEqual(cacheWrites.at(-1), { key: "tmdb-to-tvdb:222", data: { tvdbId: null }, ttlSeconds: 6 * 60 * 60 });

  tmdbExternalIds = () => json({ status_message: "not found" }, 404);
  assert.equal(await resolveTmdbToTvdb(333), null);
  assert.deepEqual(cacheWrites.at(-1)?.key, "tmdb-to-tvdb:333");
});

test("resolver: a transient failure is NOT cached and never throws", async () => {
  process.env.TMDB_READ_TOKEN = "t";
  tmdbExternalIds = () => json({ status_message: "busy" }, 503);
  assert.equal(await resolveTmdbToTvdb(TMDB), null);
  tmdbExternalIds = () => { throw new Error("socket hang up"); };
  assert.equal(await resolveTmdbToTvdb(TMDB), null);
  assert.equal(cacheWrites.length, 0);
  assert.equal(warns.filter((w) => w.startsWith("[arr] tmdb-to-tvdb")).length, 2);
});

test("resolver: no TMDB credential and no cached answer ⇒ null with no fetch; bad ids short-circuit", async () => {
  assert.equal(await resolveTmdbToTvdb(TMDB), null);
  assert.equal(await resolveTmdbToTvdb(0), null);
  assert.equal(await resolveTmdbToTvdb(1.5), null);
  assert.equal(tmdbCalls().length, 0);
});

// ═══ addSeriesToSonarr ══════════════════════════════════════════════════════

test("add: the live incident — tmdb lookup [] ⇒ TMDB's TVDB id ⇒ tvdb lookup ⇒ the series is added", async () => {
  process.env.TMDB_READ_TOKEN = "t";
  tmdbLookup = [];
  tmdbExternalIds = () => json({ tvdb_id: TVDB });
  tvdbLookup = (id) => (id === TVDB ? [dropRow()] : []);

  assert.equal(await addSeriesToSonarr(TMDB), TVDB);
  const posts = seriesPosts();
  assert.equal(posts.length, 1);
  const body = JSON.parse(posts[0].body!) as { tvdbId: number; title: string };
  assert.equal(body.tvdbId, TVDB);
  assert.equal(body.title, "The Drop: A Snowfall Saga");
});

test("add: a verified tmdb lookup never consults TMDB or issues a tvdb lookup", async () => {
  process.env.TMDB_READ_TOKEN = "t";
  tmdbLookup = [dropRow()];
  assert.equal(await addSeriesToSonarr(TMDB), TVDB);
  assert.equal(tmdbCalls().length, 0);
  assert.equal(lookups("tvdb:").length, 0);
});

test("add: no cross-reference ⇒ the not-found error says so, and nothing is added", async () => {
  process.env.TMDB_READ_TOKEN = "t";
  tmdbExternalIds = () => json({ tvdb_id: null });
  await assert.rejects(
    () => addSeriesToSonarr(TMDB),
    { message: `Sonarr: no series found for tmdbId ${TMDB}; no TVDB id available from TMDB to fall back on` },
  );
  assert.equal(lookups("tvdb:").length, 0);
  assert.equal(seriesPosts().length, 0);
});

test("add: a tvdb row naming another TMDB title is refused — the wrong show is never added", async () => {
  seedCrossRef(TMDB, TVDB);
  tvdbLookup = () => [dropRow({ tmdbId: 71694, title: "Snowfall" })];
  await assert.rejects(
    () => addSeriesToSonarr(TMDB),
    { message: `Sonarr: no series found for tmdbId ${TMDB}; TMDB's TVDB id ${TVDB} didn't match a Sonarr series either` },
  );
  assert.equal(seriesPosts().length, 0);
});

test("add: an UNVERIFIED tmdb answer still falls back, and keeps its own message", async () => {
  seedCrossRef(TMDB, TVDB);
  tmdbLookup = [{ ...dropRow({ tvdbId: 1, tmdbId: 9 }) }, { ...dropRow({ tvdbId: 2, tmdbId: 8 }) }];
  tvdbLookup = () => [];
  await assert.rejects(
    () => addSeriesToSonarr(TMDB),
    { message: `Sonarr: lookup for tmdbId ${TMDB} returned no matching series; TMDB's TVDB id ${TVDB} didn't match a Sonarr series either` },
  );
  assert.equal(lookups("tvdb:").length, 1);
});

// ═══ read paths ═════════════════════════════════════════════════════════════

test("read path: getSeriesFirstAired resolves the same new show through the cross-reference", async () => {
  seedCrossRef(TMDB, TVDB);
  tvdbLookup = () => [dropRow()];
  assert.equal(await getSeriesFirstAired(TMDB), "2026-09-08T00:00:00Z");
});

// ═══ the webhook's download verify opts out ═════════════════════════════════

test("webhook verify: stays Sonarr-sourced — a WRONG TMDB cross-reference can't refuse a genuine Download", async () => {
  // Sonarr can't resolve the tmdb id yet, and TMDB's (user-edited) cross-reference
  // points at another series. Using it here would read the payload as forged.
  seedCrossRef(TMDB, 111);
  tvdbLookup = () => [dropRow({ tvdbId: 111, tmdbId: undefined })];
  seriesLibrary = (tvdbId) =>
    tvdbId === String(TVDB)
      ? [{ tvdbId: TVDB, status: "continuing", seasons: [{ seasonNumber: 1, monitored: true, statistics: { episodeFileCount: 8, episodeCount: 8 } }] }]
      : [];

  const verdict = await isSeriesDownloadedInSonarr({ tvdbId: TVDB, tmdbId: TMDB });
  assert.deepEqual(verdict, { downloaded: true, tmdbId: null, episodeFileCount: 8, episodeCount: 8 });
  assert.equal(lookups("tvdb:").length, 0, "the verify never consults the cross-reference");
  assert.ok(!warns.some((w) => w.includes("payload ids disagree")));
});

// ═══ live wanted / downloading verdicts ══════════════════════════════════════

test("live completion: a PARTLY downloaded series is not complete (still wanted) — same guardrail-14a rule as the sync writer", async () => {
  // The arr-state diagnostic reads "wanted" as `!complete` off this one call.
  tmdbLookup = [dropRow()];
  const lib = (files: number) => (tvdbId: string | null) =>
    tvdbId === String(TVDB)
      ? [{ tvdbId: TVDB, status: "continuing", seasons: [{ seasonNumber: 1, monitored: true, statistics: { episodeFileCount: files, episodeCount: 24 } }] }]
      : [];
  seriesLibrary = lib(5);
  const partial = await getSonarrSeriesCompletion(TMDB);
  assert.equal(partial?.complete, false, "5 of 24 aired episodes is still wanted");
  assert.equal(partial?.episodeFileCount, 5);
  assert.equal(partial?.episodeCount, 24);
  assert.equal(partial?.tvdbId, TVDB);
  seriesLibrary = lib(24);
  assert.equal((await getSonarrSeriesCompletion(TMDB))?.complete, true, "a complete series is not wanted");
  seriesLibrary = lib(0);
  assert.equal((await getSonarrSeriesCompletion(TMDB))?.complete, false);
  seriesLibrary = () => [];
  assert.equal(await getSonarrSeriesCompletion(TMDB), null, "a series not in the library has no completion");
});

// ═══ resolveTvdbIdFromTmdbId — the tvdbId persisted onto an issue ════════════

const unfilteredLibraryReads = () =>
  calls.filter((c) => c.url.pathname === "/api/v3/series" && c.method === "GET" && !c.url.searchParams.has("tvdbId"));

test("issue tvdbId: a cross-reference confirmed by Sonarr's own library row resolves with ONE filtered read — no lookup, no full library", async () => {
  seedCrossRef(TMDB, TVDB);
  tmdbLookup = [dropRow({ tvdbId: 1234 })]; // would answer differently if it were asked
  seriesLibrary = (tvdbId) => (tvdbId === String(TVDB) ? [{ id: 9, tvdbId: TVDB, tmdbId: TMDB }] : []);
  assert.equal(await resolveTvdbIdFromTmdbId(TMDB), TVDB);
  assert.equal(lookups("tmdb:").length, 0, "Sonarr's own row confirmed it");
  assert.equal(unfilteredLibraryReads().length, 0, "never the whole library");
  assert.deepEqual(
    calls.filter((c) => c.url.pathname === "/api/v3/series").map((c) => c.url.searchParams.get("tvdbId")),
    [String(TVDB)],
  );
});

test("issue tvdbId: a library row naming ANOTHER title, or none (Sonarr v3), never decides — the verified lookup does", async () => {
  seedCrossRef(TMDB, TVDB);
  for (const rowTmdbId of [71694, undefined, 0]) {
    calls.length = 0;
    _resetSeriesLookupCacheForTests();
    seriesLibrary = (tvdbId) => (tvdbId === String(TVDB) ? [{ id: 9, tvdbId: TVDB, ...(rowTmdbId === undefined ? {} : { tmdbId: rowTmdbId }) }] : []);
    // Sonarr's tmdb lookup names this title at another TVDB id: only it may decide.
    tmdbLookup = [dropRow({ tvdbId: 1234 })];
    assert.equal(await resolveTvdbIdFromTmdbId(TMDB), 1234, `row tmdbId=${rowTmdbId}`);
    assert.equal(lookups("tmdb:").length, 1, `row tmdbId=${rowTmdbId}: the lookup was consulted`);
    assert.equal(unfilteredLibraryReads().length, 0);
  }
});

test("issue tvdbId: no cross-reference goes straight to the lookup; an unverified lookup is null, never a guess", async () => {
  tmdbLookup = [dropRow()];
  assert.equal(await resolveTvdbIdFromTmdbId(TMDB), TVDB);
  assert.equal(calls.filter((c) => c.url.pathname === "/api/v3/series").length, 0, "no library read without a candidate");

  calls.length = 0;
  _resetSeriesLookupCacheForTests();
  tmdbLookup = [dropRow({ tvdbId: 1, tmdbId: 9 }), dropRow({ tvdbId: 2, tmdbId: 8 })];
  assert.equal(await resolveTvdbIdFromTmdbId(TMDB), null);
  assert.equal(unfilteredLibraryReads().length, 0);
});

test("issue tvdbId: a Sonarr failure is null, and an unconfigured Sonarr is null with no call", async () => {
  seedCrossRef(TMDB, TVDB);
  seriesStatus = 503;
  assert.equal(await resolveTvdbIdFromTmdbId(TMDB), null);

  calls.length = 0;
  settings.clear();
  assert.equal(await resolveTvdbIdFromTmdbId(TMDB), null);
  assert.equal(calls.length, 0);
});

test("downloading: an UNRESOLVABLE series is unknown (null), never a confident 'not in queue'", async () => {
  // The queue holds a series with no tmdbId (Sonarr v3, or one it never mapped),
  // so the queue alone can't rule this title out and the lookup must decide. The
  // tmdb lookup misses, and TMDB's cross-reference is unavailable (no credential,
  // nothing cached) — callers must defer, not fire a "download pending" notify.
  // Own URL: arr.ts caches each instance's queue for 15s.
  settings.set("sonarrUrl", "http://10.0.0.31:8989");
  sonarrQueue = { records: [{ series: { tvdbId: 1 } }], totalRecords: 1 };
  tmdbLookup = [];
  assert.equal(await isSeriesDownloadingInSonarr(TMDB), null);
  assert.equal(lookups("tmdb:").length, 1, "the lookup was consulted because the queue had an unmapped series");
});

// ═══ structure ══════════════════════════════════════════════════════════════

test("structure: one tvdb lookup URL, used by the add path; the webhook verify is the lone opt-out", () => {
  // arr.ts re-exports flat siblings; the rule holds across all of them.
  const read = (file: string) => readFileSync(new URL(`../src/lib/${file}`, import.meta.url), "utf8");
  const body = (source: string, signature: string) => {
    const fn = source.slice(source.indexOf(signature));
    return fn.slice(0, fn.indexOf("\n}\n"));
  };
  const source = ["arr.ts", "arr-client.ts", "arr-config.ts", "arr-id-map.ts", "arr-lookup.ts", "arr-add.ts", "arr-releases.ts", "arr-queue-cache.ts"].map(read).join("\n");
  assert.equal((source.match(/series\/lookup\?term=tvdb:\$\{/g) ?? []).length, 1, "exactly one tvdb lookup URL (the shared helper)");

  // The add path resolves through the same function as the read paths, and that
  // function falls back to the cross-reference.
  assert.match(body(read("arr-add.ts"), "async function lookupSeriesForAdd("), /resolveSonarrSeries\(/, "the add path uses the shared resolution");
  assert.match(body(read("arr-id-map.ts"), "export async function resolveSonarrSeries("), /lookupSeriesByTvdbCrossRef\(/, "…which falls back to the cross-reference");

  // The call-site object form only — the helper's doc comment names the flag too.
  assert.equal((source.match(/\{ tvdbCrossRef: false \}/g) ?? []).length, 1, "one opt-out only");
  assert.match(body(read("arr.ts"), "export async function isSeriesDownloadedInSonarr"), /\{ tvdbCrossRef: false \}/, "…and it is the webhook's download verify");
});
