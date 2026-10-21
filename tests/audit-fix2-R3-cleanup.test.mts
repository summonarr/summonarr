// Review round 2, cleanup slice:
//   1. The read paths (cleanup page, never-watched report, /admin/stats) never
//      wait on TMDB's tmdb→tvdb cross-reference: a cold cache is read as "no
//      cross-reference" and filled in ONE bounded background drain; only the
//      delete route ("fetch") awaits a live lookup. A Sonarr v3 library put one
//      external_ids fetch per show inside the page render (a 502 behind a proxy).
//   2. The Library cleanup page shows a Protect/Unprotect at once and reloads
//      the report once per burst of clicks (the GET allows 30 a minute).
// The execute's uncertain-total-failure re-assert (item 3) is pinned beside the
// other C014 tests in tests/library-cleanup-routes.test.mts.
// No DB, no network: tmdbCache is shadowed in memory, dns.lookup is stubbed and
// globalThis.fetch answers TMDB's external_ids.
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import dns from "node:dns/promises";
import { readFileSync } from "node:fs";

process.env.NEXTAUTH_SECRET ??= "unit-test-session-secret-0123456789abcdef";
process.env.TOKEN_ENCRYPTION_KEY ??= "ab".repeat(32);
process.env.DATABASE_URL ??= "postgresql://unit:unit@127.0.0.1:9/never_connects";
process.env.TMDB_READ_TOKEN = "t";

const fakeLookup = async () => [{ address: "93.184.216.34", family: 4 }];
(dns as { lookup: unknown }).lookup = fakeLookup;
if ((dns as { lookup: unknown }).lookup !== fakeLookup) {
  throw new Error("could not stub dns.lookup — aborting before a real DNS query can leave the process");
}
console.warn = () => {};

// TMDB's answer per tmdb id; a fetch is recorded and may be parked.
let tvdbFor = new Map<number, number>();
let externalIdFetches: number[] = [];
globalThis.fetch = (async (input: RequestInfo | URL) => {
  const url = new URL(String(input));
  const m = /^\/3\/tv\/(\d+)\/external_ids$/.exec(url.pathname);
  if (url.hostname !== "api.themoviedb.org" || !m) throw new Error(`unexpected fetch ${url}`);
  const id = Number(m[1]);
  externalIdFetches.push(id);
  return Response.json({ tvdb_id: tvdbFor.get(id) ?? null });
}) as unknown as typeof fetch;

const { prisma } = await import("../src/lib/prisma.ts");
const { shadowPrismaModel } = await import("./_helpers.mts");

let cache = new Map<string, string>();
let cacheReads: string[] = [];
shadowPrismaModel(prisma, "tmdbCache", {
  findUnique: async (args: { where: { key: string } }) => {
    cacheReads.push(args.where.key);
    const data = cache.get(args.where.key);
    return data === undefined ? null : { key: args.where.key, data, expiresAt: new Date(Date.now() + 86_400_000) };
  },
  findMany: async () => [],
  upsert: async (args: { where: { key: string }; create: { data: string } }) => {
    cache.set(args.where.key, args.create.data);
    return {};
  },
  deleteMany: async () => ({ count: 0 }),
});

const { resolveTmdbToTvdb } = await import("../src/lib/arr.ts");
const { crossRefFillIdle, lookupTmdbToTvdb, resolveArrTargets, tmdbToTvdbCacheKey } = await import("../src/lib/library-cleanup-arr.ts");
const { fillAiring } = await import("../src/lib/library-cleanup-data.ts");
const { applyLocalProtection, createCoalescedReload } = await import("../src/lib/cleanup-delete-plan.ts");

type Index = Parameters<typeof resolveArrTargets>[1];
function v3Index(): Index {
  // Sonarr v3: the series carries no tmdbId, so it is reachable only by tvdb id.
  const entry = { service: "sonarr", instance: "", arrId: 9, tmdbId: null, tvdbId: 9000, title: "Show", sizeOnDisk: 5, airing: true, added: null };
  return { byKey: new Map(), tvdbOnly: new Map([[9000, [entry]]]), errors: [] } as unknown as Index;
}

beforeEach(async () => {
  await crossRefFillIdle();
  tvdbFor = new Map([[900, 9000], [901, 9001]]);
  externalIdFetches = [];
  cache = new Map();
  cacheReads = [];
});

test("item 1: the cleanup cache key is the one resolveTmdbToTvdb reads", async () => {
  cache.set(tmdbToTvdbCacheKey(900), JSON.stringify({ tvdbId: 9000 }));
  assert.equal(await resolveTmdbToTvdb(900), 9000);
  assert.deepEqual(cacheReads, [tmdbToTvdbCacheKey(900)]);
  assert.deepEqual(externalIdFetches, [], "a cached answer costs no TMDB call");
});

test("item 1: a read-path ('cached') target resolution makes NO TMDB call on a cold cache; the background fill then answers the next load", async () => {
  const index = v3Index();
  const cold = await resolveArrTargets([{ tmdbId: 900, mediaType: "TV" }], index, "cached");
  assert.deepEqual(externalIdFetches, [], "nothing waited on TMDB inside the read");
  assert.deepEqual(cold.get("TV:900") ?? cold.values().next().value, [], "a cold cross-reference reads as no extra target");
  await crossRefFillIdle();
  assert.deepEqual(externalIdFetches, [900], "the miss was filled in the background, once");
  const warm = await resolveArrTargets([{ tmdbId: 900, mediaType: "TV" }], index, "cached");
  assert.equal([...warm.values()][0].length, 1, "the next load finds the tvdb-only series");
  assert.deepEqual(externalIdFetches, [900], "and costs no further TMDB call");
});

test("item 1: the delete route's 'fetch' resolution awaits TMDB, so a cold cache still finds every copy", async () => {
  const targets = await resolveArrTargets([{ tmdbId: 900, mediaType: "TV" }], v3Index(), "fetch");
  assert.deepEqual(externalIdFetches, [900]);
  assert.equal([...targets.values()][0].length, 1);
});

test("item 1: concurrent cold reads share ONE background lookup per title", async () => {
  await Promise.all([lookupTmdbToTvdb([900, 901], "cached"), lookupTmdbToTvdb([900, 901], "cached"), lookupTmdbToTvdb([901], "cached")]);
  await crossRefFillIdle();
  assert.deepEqual([...externalIdFetches].sort(), [900, 901]);
});

test("item 1: fillAiring defaults to the cache — the never-watched report's call never waits on TMDB", async () => {
  const titles = [{ tmdbId: 900, mediaType: "TV", airing: null }] as unknown as Parameters<typeof fillAiring>[0];
  await fillAiring(titles, v3Index());
  assert.deepEqual(externalIdFetches, []);
  assert.equal(titles[0].airing, null);
  await crossRefFillIdle();
  await fillAiring(titles, v3Index());
  assert.equal(titles[0].airing, true, "the filled cross-reference reaches the tvdb-only series' status");
  const cold = [{ tmdbId: 901, mediaType: "TV", airing: null }] as unknown as Parameters<typeof fillAiring>[0];
  tvdbFor.set(901, 9000);
  await fillAiring(cold, v3Index(), "fetch");
  assert.equal(cold[0].airing, true, "the delete route's re-judgement still resolves in-call");
});

test("item 1: the read routes pass 'cached', the delete route 'fetch', and the report layer defaults to the cache", () => {
  const read = (p: string) => readFileSync(new URL(`../src/${p}`, import.meta.url), "utf8");
  assert.match(read("app/api/admin/cleanup/route.ts"), /computeCleanupReport\(arr, new Date\(\), undefined, \{ resolveTargets: true, crossRef: "cached" \}\)/);
  const del = read("app/api/admin/cleanup/delete/route.ts");
  assert.match(del, /resolveArrTargets\(items, arr, "fetch"\)/);
  assert.match(del, /computeCleanupReport\(arr, now, items, \{ tvdbIds: tvdbIdsByKey, crossRef: "fetch" \}\)/);
  const data = read("lib/library-cleanup-data.ts");
  assert.match(data, /const crossRef = opts\.crossRef \?\? "cached";/);
  assert.match(data, /resolveArrTargets\(facts\.titles\.filter\(opts\.resolveTargets\), arr, opts\.crossRef \?\? "cached"\)/);
  assert.match(data, /crossRef: CrossRefMode = "cached"/);
  assert.doesNotMatch(data, /resolveTmdbToTvdb/, "the report layer never calls the fetching lookup directly");
});

// ── item 2 ──────────────────────────────────────────────────────────────────
function fakeTimers() {
  let now = 0;
  let next = 1;
  const pending = new Map<number, { at: number; fn: () => void }>();
  return {
    timers: {
      set: (fn: () => void, ms: number) => { const h = next++; pending.set(h, { at: now + ms, fn }); return h; },
      clear: (h: unknown) => { pending.delete(h as number); },
    },
    advance(ms: number) {
      const end = now + ms;
      for (;;) {
        const due = [...pending.entries()].filter(([, t]) => t.at <= end).sort((a, b) => a[1].at - b[1].at)[0];
        if (!due) break;
        pending.delete(due[0]);
        now = due[1].at;
        due[1].fn();
      }
      now = end;
    },
  };
}

test("item 2: a burst of 31 protects, one every 2 s, costs a handful of reloads — never one per click", () => {
  const clock = fakeTimers();
  const reload = createCoalescedReload(clock.timers, 3_000, 10_000);
  let loads = 0;
  for (let i = 0; i < 31; i++) {
    reload.schedule(() => loads++);
    clock.advance(2_000);
  }
  clock.advance(3_000);
  assert.ok(loads >= 6 && loads <= 8, `about one reload per 10 s, got ${loads}`);
});

test("item 2: a reload fires once after the clicks stop, with the latest loader; cancel drops it", () => {
  const clock = fakeTimers();
  const reload = createCoalescedReload(clock.timers, 3_000, 10_000);
  const fired: string[] = [];
  reload.schedule(() => fired.push("a"));
  clock.advance(1_000);
  reload.schedule(() => fired.push("b"));
  clock.advance(2_999);
  assert.equal(fired.length, 0);
  clock.advance(1);
  assert.deepEqual(fired, ["b"]);
  clock.advance(20_000);
  assert.deepEqual(fired, ["b"], "the max-wait timer was cleared with it");
  reload.schedule(() => fired.push("c"));
  reload.cancel();
  clock.advance(20_000);
  assert.deepEqual(fired, ["b"]);
});

test("item 2: the local patch protects / unprotects one row and the protected list", () => {
  const report = {
    rows: [
      { tmdbId: 1, mediaType: "MOVIE", excludedBy: [] as string[], candidate: true },
      { tmdbId: 2, mediaType: "TV", excludedBy: ["airing"], candidate: false },
    ],
    protected: [] as Array<{ tmdbId: number; mediaType: string; title: string | null; reason: string | null; createdAt: string }>,
    totals: { candidates: 1 },
  };
  const on = applyLocalProtection(report, { tmdbId: 1, mediaType: "MOVIE", title: "A" }, true, "2026-10-12T00:00:00.000Z");
  assert.deepEqual(on.rows[0], { tmdbId: 1, mediaType: "MOVIE", excludedBy: ["protected"], candidate: false });
  assert.equal(on.rows[1], report.rows[1], "other rows untouched");
  assert.deepEqual(on.protected.map((p) => p.tmdbId), [1]);
  assert.equal(on.totals, report.totals);
  const off = applyLocalProtection(on, { tmdbId: 1, mediaType: "MOVIE", title: "A" }, false, "x");
  assert.deepEqual(off.rows[0], report.rows[0]);
  assert.deepEqual(off.protected, []);
  const twoX = applyLocalProtection(applyLocalProtection(report, { tmdbId: 2, mediaType: "TV", title: null }, true, "x"), { tmdbId: 2, mediaType: "TV", title: null }, false, "x");
  assert.deepEqual(twoX.rows[1], report.rows[1], "another exclusion keeps the row held back");
  assert.equal(applyLocalProtection(on, { tmdbId: 1, mediaType: "MOVIE", title: "A" }, true, "y").protected.length, 1, "no duplicate entry");
});

test("item 2: the page's Protect patches the report and schedules ONE coalesced reload instead of awaiting a load per click", () => {
  const src = readFileSync(new URL("../src/components/admin/library-cleanup.tsx", import.meta.url), "utf8");
  const start = src.indexOf("async function setProtected(");
  const body = src.slice(start, src.indexOf("\n  }\n", start));
  assert.doesNotMatch(body, /await load\(\)/, "a reload per click is back");
  assert.match(body, /setReport\(\(r\) => \(r \? applyLocalProtection\(r, row, on, /);
  assert.match(body, /protectReload\.schedule\(\(\) => void load\(\)\)/);
  assert.match(body, /loadSeq\.current\+\+;/, "a load in flight (pre-click state) is superseded");
  assert.match(src, /const \[protectReload\] = useState\(\(\) => createCoalescedReload\(\)\);/);
  assert.match(src, /const seq = \+\+loadSeq\.current;\n[^\n]*\n\s+protectReload\.cancel\(\);/, "any load answers for a pending reload");
  assert.match(src, /useEffect\(\(\) => \(\) => protectReload\.cancel\(\), \[protectReload\]\);/);
});
