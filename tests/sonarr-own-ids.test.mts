// Tests for the two Sonarr checks that answer from Sonarr's OWN ids before its
// series/lookup endpoint (src/lib/arr.ts):
//   - isSeriesDownloadedInSonarr — the Sonarr webhook's download verify and
//     forgery check. The library row read by ?tvdbId= carries Sonarr's own
//     tmdbId; it decides whether the payload's two ids agree.
//   - isSeriesDownloadingInSonarr — the library scan's and the download check's
//     "is it still in the queue?". Each queue record's series carries its tmdbId.
//
// Why: `series/lookup` makes Sonarr query its internet metadata service. When
// that stalled in production (2026-10-26), every lookup timed out after 30s: the
// webhook could verify nothing, and the library scan read each failed queue
// check as "still downloading" and retried four times per import.
//
// The pins:
//   1. A genuine event / a queued title is answered with ZERO lookups, even
//      while the lookup is down.
//   2. The library row is the authority for the forgery check: a row naming a
//      different tmdbId is refused even when the lookup would have agreed.
//   3. The lookup still decides when Sonarr's own data can't: a row or a queued
//      series with no usable tmdbId (Sonarr v3 never sends one; v4 leaves it 0
//      for a series it couldn't map). Its tri-state contract is unchanged:
//      a lookup that fails is unknown (null), never a confident answer.
//
// No DB, no network: prisma.setting/tmdbCache are shadowed in-memory, dns.lookup
// is stubbed, Sonarr is an RFC1918 IP literal (no DNS for its SSRF check), and
// globalThis.fetch is scripted. arr.ts caches each instance's queue for 15s, so
// every test that reads the queue uses its own Sonarr URL.
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import dns from "node:dns/promises";

process.env.NEXTAUTH_SECRET ??= "unit-test-session-secret-0123456789abcdef";
process.env.TOKEN_ENCRYPTION_KEY ??= "ab".repeat(32);
process.env.DATABASE_URL ??= "postgresql://unit:unit@127.0.0.1:9/never_connects";
delete process.env.TMDB_READ_TOKEN; // no TMDB cross-reference: the lookup fallback stays Sonarr-only

const fakeLookup = async () => [{ address: "93.184.216.34", family: 4 }];
(dns as { lookup: unknown }).lookup = fakeLookup;
if ((dns as { lookup: unknown }).lookup !== fakeLookup) {
  throw new Error("could not stub dns.lookup — aborting before a real DNS query can leave the process");
}

const warns: string[] = [];
console.warn = (...args: unknown[]) => { warns.push(args.map(String).join(" ")); };
console.error = () => {};

// ── scripted Sonarr ─────────────────────────────────────────────────────────
const calls: URL[] = [];
// What `series/lookup?term=tmdb:<id>` answers; "down" makes the request fail the
// way a stalled metadata service does (arrFetch throws).
let lookupAnswer: unknown[] | "down" = [];
let library: (tvdbId: string | null) => unknown[] = () => [];
let queuePages: unknown[] = [];
let queueStatus = 200;

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

globalThis.fetch = (async (input: RequestInfo | URL) => {
  const url = new URL(String(input));
  calls.push(url);
  if (url.pathname === "/api/v3/series/lookup") {
    if (lookupAnswer === "down") throw new Error("Request timed out after 30000ms");
    return json(lookupAnswer);
  }
  if (url.pathname === "/api/v3/series") return json(library(url.searchParams.get("tvdbId")));
  if (url.pathname === "/api/v3/queue") {
    if (queueStatus !== 200) return json({ message: "boom" }, queueStatus);
    const page = Number(url.searchParams.get("page") ?? "1");
    return json(queuePages[page - 1] ?? { records: [], totalRecords: 0 });
  }
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
// The queue check's lookup keeps its TMDB cross-reference fallback; with no
// credential and an empty cache it resolves nothing and touches no network.
shadowPrismaModel(prisma, "tmdbCache", {
  findUnique: async () => null,
  findMany: async () => [],
  upsert: async () => ({}),
  deleteMany: async () => ({ count: 0 }),
});

const { isSeriesDownloadedInSonarr, isSeriesDownloadingInSonarr, countSonarrQueue } = await import("../src/lib/arr.ts");

let instance = 0;
beforeEach(() => {
  calls.length = 0;
  warns.length = 0;
  settings.clear();
  instance += 1;
  settings.set("sonarrUrl", `http://10.0.7.${instance}:8989`);
  settings.set("sonarrApiKey", "sonarr-key");
  lookupAnswer = [];
  library = () => [];
  queuePages = [];
  queueStatus = 200;
});

const lookupCalls = () => calls.filter((u) => u.pathname === "/api/v3/series/lookup").length;
const season = (n: number, files: number, eps: number) => ({ seasonNumber: n, monitored: true, statistics: { episodeFileCount: files, episodeCount: eps } });
// A complete series row as /api/v3/series?tvdbId= returns it; tmdbId is spread
// only when given, so `undefined` means the key is absent (Sonarr v3).
const seriesRow = (tvdbId: number, tmdbId?: unknown) => ({
  tvdbId,
  ...(tmdbId === undefined ? {} : { tmdbId }),
  status: "continuing",
  seasons: [season(1, 10, 10)],
});
const onlyTvdb = (tvdbId: number, row: unknown) => (q: string | null) => (q === String(tvdbId) ? [row] : []);
const queueOf = (...series: Array<Record<string, unknown> | null>) => ({
  records: series.map((s) => (s === null ? {} : { series: s })),
  totalRecords: series.length,
});

// ═══ isSeriesDownloadedInSonarr — the webhook verify ═════════════════════════

test("verify: the library row's own tmdbId settles a genuine event — zero lookups, even with the lookup down", async () => {
  lookupAnswer = "down";
  library = onlyTvdb(777, seriesRow(777, 888));

  const verdict = await isSeriesDownloadedInSonarr({ tvdbId: 777, tmdbId: 888 });
  assert.deepEqual(verdict, { downloaded: true, episodeFileCount: 10, episodeCount: 10 });
  assert.equal(lookupCalls(), 0);
  assert.ok(!warns.some((w) => w.includes("isSeriesDownloadedInSonarr failed")), warns.join(" | "));
});

test("verify: an incomplete series still reports its counts from the library-row path", async () => {
  library = onlyTvdb(777, { ...seriesRow(777, 888), seasons: [season(1, 3, 10)] });
  const verdict = await isSeriesDownloadedInSonarr({ tvdbId: 777, tmdbId: 888 });
  assert.deepEqual(verdict, { downloaded: false, reason: "incomplete", episodeFileCount: 3, episodeCount: 10 });
  assert.equal(lookupCalls(), 0);
});

test("verify: a library row naming a DIFFERENT tmdbId is ids-disagree — and it wins over a lookup that would agree", async () => {
  // The forgery shape: a tvdbId Sonarr really downloaded, paired with another title's tmdbId.
  lookupAnswer = [{ tmdbId: 888, tvdbId: 777 }];
  library = onlyTvdb(777, seriesRow(777, 555));

  const verdict = await isSeriesDownloadedInSonarr({ tvdbId: 777, tmdbId: 888 });
  assert.deepEqual(verdict, { downloaded: false, reason: "ids-disagree" });
  assert.equal(lookupCalls(), 0, "Sonarr's own row decided; the lookup is not a second opinion");
  assert.ok(warns.some((w) => w.includes("payload ids disagree") && w.includes("in Sonarr's library")), warns.join(" | "));
});

test("verify: a row with no USABLE tmdbId falls back to the lookup — absent, 0, negative, fractional or a string", async () => {
  for (const tmdbId of [undefined, 0, -1, 888.5, "888"]) {
    calls.length = 0;
    library = onlyTvdb(777, seriesRow(777, tmdbId));

    lookupAnswer = [{ tmdbId: 888, tvdbId: 99999 }];
    assert.deepEqual(
      await isSeriesDownloadedInSonarr({ tvdbId: 777, tmdbId: 888 }),
      { downloaded: false, reason: "ids-disagree" },
      `tmdbId=${JSON.stringify(tmdbId)}: the lookup's disagreement must be honoured`,
    );
    assert.equal(lookupCalls(), 1, `tmdbId=${JSON.stringify(tmdbId)}: exactly one fallback lookup`);

    lookupAnswer = [{ tmdbId: 888, tvdbId: 777 }];
    assert.deepEqual(
      await isSeriesDownloadedInSonarr({ tvdbId: 777, tmdbId: 888 }),
      { downloaded: true, episodeFileCount: 10, episodeCount: 10 },
      `tmdbId=${JSON.stringify(tmdbId)}: an agreeing lookup lets the genuine event through`,
    );
  }
});

test("verify: with no usable tmdbId on the row and the lookup down, the verdict is unverifiable (null), never a guess", async () => {
  lookupAnswer = "down";
  library = onlyTvdb(777, seriesRow(777));
  assert.equal(await isSeriesDownloadedInSonarr({ tvdbId: 777, tmdbId: 888 }), null);
  assert.ok(warns.some((w) => w.includes("isSeriesDownloadedInSonarr failed")), warns.join(" | "));
});

test("verify: a tvdbId Sonarr doesn't have is absent — no lookup", async () => {
  lookupAnswer = [{ tmdbId: 888, tvdbId: 777 }];
  library = () => [];
  assert.deepEqual(await isSeriesDownloadedInSonarr({ tvdbId: 777, tmdbId: 888 }), { downloaded: false, reason: "absent" });
  assert.equal(lookupCalls(), 0);
});

test("verify: a tvdbId-only payload reads the library and nothing else", async () => {
  lookupAnswer = "down";
  library = onlyTvdb(777, seriesRow(777, 888));
  assert.deepEqual(await isSeriesDownloadedInSonarr({ tvdbId: 777 }), { downloaded: true, episodeFileCount: 10, episodeCount: 10 });
  assert.equal(lookupCalls(), 0);
});

test("verify: a tmdbId-only payload still needs ONE lookup to find the row", async () => {
  lookupAnswer = [{ tmdbId: 888, tvdbId: 777 }];
  library = onlyTvdb(777, seriesRow(777, 888));
  assert.deepEqual(await isSeriesDownloadedInSonarr({ tmdbId: 888 }), { downloaded: true, episodeFileCount: 10, episodeCount: 10 });
  assert.equal(lookupCalls(), 1);

  calls.length = 0;
  lookupAnswer = "down";
  assert.equal(await isSeriesDownloadedInSonarr({ tmdbId: 888 }), null, "no tvdbId and no lookup: unverifiable");
});

// ═══ isSeriesDownloadingInSonarr — the queue check ═══════════════════════════

test("queue: a record whose series carries the title's tmdbId is downloading — zero lookups, even with the lookup down", async () => {
  lookupAnswer = "down";
  queuePages = [queueOf({ tvdbId: 777, tmdbId: 888 }, { tvdbId: 1, tmdbId: 2 })];
  assert.equal(await isSeriesDownloadingInSonarr(888), true);
  assert.equal(lookupCalls(), 0);
});

test("queue: every queued series names its tmdbId and none is this one ⇒ not downloading, no lookup", async () => {
  lookupAnswer = [{ tmdbId: 888, tvdbId: 777 }];
  // A record with no series at all (an unknown download) can't hold this title either.
  queuePages = [queueOf({ tvdbId: 1, tmdbId: 2 }, { tvdbId: 3, tmdbId: 4 }, null)];
  assert.equal(await isSeriesDownloadingInSonarr(888), false);
  assert.equal(lookupCalls(), 0);
});

test("queue: an EMPTY queue is not downloading — no lookup (it used to resolve the title first)", async () => {
  lookupAnswer = "down";
  queuePages = [queueOf()];
  assert.equal(await isSeriesDownloadingInSonarr(888), false);
  assert.equal(lookupCalls(), 0);
});

test("queue: a queued series with no usable tmdbId sends the check to the lookup, which decides", async () => {
  for (const unmapped of [{ tvdbId: 777 }, { tvdbId: 777, tmdbId: 0 }, { tvdbId: 777, tmdbId: "888" }]) {
    // Fresh instance per case: the queue is cached for 15s per URL.
    instance += 1;
    settings.set("sonarrUrl", `http://10.0.7.${instance}:8989`);
    queuePages = [queueOf({ tvdbId: 1, tmdbId: 2 }, unmapped)];
    const label = JSON.stringify(unmapped);

    calls.length = 0;
    lookupAnswer = [{ tmdbId: 888, tvdbId: 777 }];
    assert.equal(await isSeriesDownloadingInSonarr(888), true, `${label}: the lookup maps 888 to the queued tvdbId`);
    assert.equal(lookupCalls(), 1, label);

    lookupAnswer = [{ tmdbId: 888, tvdbId: 5555 }];
    assert.equal(await isSeriesDownloadingInSonarr(888), false, `${label}: the lookup maps 888 elsewhere`);

    lookupAnswer = [];
    assert.equal(await isSeriesDownloadingInSonarr(888), null, `${label}: unresolvable is unknown, never 'not in queue'`);

    lookupAnswer = "down";
    assert.equal(await isSeriesDownloadingInSonarr(888), null, `${label}: a failed lookup is unknown`);
  }
});

test("queue: an unreadable queue is unknown (null) — no lookup", async () => {
  queueStatus = 500;
  lookupAnswer = [{ tmdbId: 888, tvdbId: 777 }];
  assert.equal(await isSeriesDownloadingInSonarr(888), null);
  assert.equal(lookupCalls(), 0);
});

test("queue: tmdbIds are collected across every page", async () => {
  lookupAnswer = "down";
  queuePages = [
    { records: [{ series: { tvdbId: 1, tmdbId: 2 } }], totalRecords: 300 },
    { records: [{ series: { tvdbId: 777, tmdbId: 888 } }], totalRecords: 300 },
  ];
  assert.equal(await isSeriesDownloadingInSonarr(888), true);
  assert.equal(calls.filter((u) => u.pathname === "/api/v3/queue").length, 2);
});

test("queue: countSonarrQueue still counts distinct queued series, mapped or not", async () => {
  queuePages = [queueOf({ tvdbId: 1, tmdbId: 2 }, { tvdbId: 1, tmdbId: 2 }, { tvdbId: 777 }, null)];
  assert.equal(await countSonarrQueue(), 2);
});
