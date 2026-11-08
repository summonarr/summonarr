// The download-queue walk behind "is this title downloading?" (src/lib/arr-queue-cache.ts,
// re-exported by arr.ts): the library scan and the download check read it.
//
// The walk is paged and capped at QUEUE_MAX_PAGES pages of 250. A queue longer
// than that used to be cached as if it were the whole queue, so a title queued
// past the cap read "not downloading" (and the library scan ran early) and the
// counts under-reported. Now:
//   - a walk that stopped before the end of the queue is INCOMPLETE: a title it
//     didn't see is unknown (null), never a confident false, and a count is null;
//   - a title it did see is still a confident true;
//   - a page holding more than a page's worth (an arr ignoring pageSize, whose
//     later pages would repeat it) ends the walk as incomplete too;
//   - a complete walk answers exactly as before.
//
// No DB, no network: prisma.setting/tmdbCache are shadowed, dns.lookup is
// stubbed, every arr is an RFC1918 IP literal, and globalThis.fetch is scripted.
// The queue is cached per URL for 15s, so every test uses its own URL.
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import dns from "node:dns/promises";

process.env.NEXTAUTH_SECRET ??= "unit-test-session-secret-0123456789abcdef";
process.env.TOKEN_ENCRYPTION_KEY ??= "ab".repeat(32);
process.env.DATABASE_URL ??= "postgresql://unit:unit@127.0.0.1:9/never_connects";
delete process.env.TMDB_READ_TOKEN;

const fakeLookup = async () => [{ address: "93.184.216.34", family: 4 }];
(dns as { lookup: unknown }).lookup = fakeLookup;
if ((dns as { lookup: unknown }).lookup !== fakeLookup) {
  throw new Error("could not stub dns.lookup — aborting before a real DNS query can leave the process");
}
console.warn = () => {};
console.error = () => {};

const PAGE = 250;
let pageOf: (page: number) => unknown = () => ({ records: [], totalRecords: 0 });
let lookupAnswer: unknown[] = [];
const queueReads: number[] = [];

function json(body: unknown): Response {
  return new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
}

globalThis.fetch = (async (input: RequestInfo | URL) => {
  const url = new URL(String(input));
  if (url.pathname === "/api/v3/queue") {
    const page = Number(url.searchParams.get("page"));
    queueReads.push(page);
    return json(pageOf(page));
  }
  if (url.pathname === "/api/v3/series/lookup") return json(lookupAnswer);
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
shadowPrismaModel(prisma, "tmdbCache", {
  findUnique: async () => null,
  findMany: async () => [],
  upsert: async () => ({}),
  deleteMany: async () => ({ count: 0 }),
});

const { isMovieDownloadingInRadarr, countRadarrQueue, isSeriesDownloadingInSonarr, countSonarrQueue } = await import("../src/lib/arr.ts");
const { QUEUE_MAX_PAGES, foldQueueRecord } = await import("../src/lib/arr-queue-cache.ts");

let instance = 0;
beforeEach(() => {
  instance += 1;
  settings.clear();
  settings.set("radarrUrl", `http://10.0.11.${instance}:7878`);
  settings.set("radarrApiKey", "radarr-key");
  settings.set("sonarrUrl", `http://10.0.12.${instance}:8989`);
  settings.set("sonarrApiKey", "sonarr-key");
  queueReads.length = 0;
  lookupAnswer = [];
});

// A queue of `total` movie records, tmdbIds 1..total, paged as Radarr pages it.
const movieQueue = (total: number) => (page: number) => {
  const start = (page - 1) * PAGE;
  const records = [];
  for (let i = start; i < Math.min(start + PAGE, total); i++) records.push({ movie: { tmdbId: i + 1 } });
  return { records, totalRecords: total };
};

test("a queue longer than the walk's cap: a title past it is UNKNOWN, never 'not downloading', and the count is unknown", async () => {
  const total = (QUEUE_MAX_PAGES + 2) * PAGE;
  pageOf = movieQueue(total);
  const lastRead = QUEUE_MAX_PAGES * PAGE;
  assert.equal(await isMovieDownloadingInRadarr(total), null, "queued past the cap: not seen, so unknown");
  assert.equal(queueReads.length, QUEUE_MAX_PAGES, "the walk stops at its cap");
  assert.equal(await isMovieDownloadingInRadarr(lastRead), true, "a title the walk saw is still a confident true");
  assert.equal(await countRadarrQueue(), null, "the count of a partly read queue is unknown");
});

test("a complete walk answers as before: absent is false, present is true, the count is exact", async () => {
  pageOf = movieQueue(PAGE + 10);
  assert.equal(await isMovieDownloadingInRadarr(PAGE + 10), true);
  assert.equal(await isMovieDownloadingInRadarr(99_999), false);
  assert.equal(await countRadarrQueue(), PAGE + 10);
  assert.deepEqual(queueReads, [1, 2], "two pages, read once and cached");
});

test("a page holding more than a page's worth (pageSize ignored) ends the walk as incomplete", async () => {
  const all = { records: Array.from({ length: PAGE + 50 }, (_, i) => ({ movie: { tmdbId: i + 1 } })), totalRecords: PAGE + 50 };
  pageOf = () => all;
  assert.equal(await isMovieDownloadingInRadarr(PAGE + 25), null, "past the first page's worth: unknown");
  assert.equal(await isMovieDownloadingInRadarr(3), true);
  assert.equal(await countRadarrQueue(), null);
  assert.deepEqual(queueReads, [1]);
});

test("Sonarr: an incomplete walk leaves a series it didn't see unknown, whether or not the queue is mapped", async () => {
  const total = (QUEUE_MAX_PAGES + 1) * PAGE;
  // Mapped records (each names its tmdbId): no lookup is needed to know the walk can't tell.
  pageOf = (page) => {
    const start = (page - 1) * PAGE;
    const records = [];
    for (let i = start; i < Math.min(start + PAGE, total); i++) records.push({ series: { tvdbId: 100_000 + i, tmdbId: i + 1 } });
    return { records, totalRecords: total };
  };
  assert.equal(await isSeriesDownloadingInSonarr(total), null);
  assert.equal(await isSeriesDownloadingInSonarr(1), true);
  assert.equal(await countSonarrQueue(), null);
});

test("Sonarr: an unmapped queue that was only partly read — the lookup's series not seen is unknown, a seen one is true", async () => {
  const total = (QUEUE_MAX_PAGES + 1) * PAGE;
  pageOf = (page) => {
    const start = (page - 1) * PAGE;
    const records = [];
    for (let i = start; i < Math.min(start + PAGE, total); i++) records.push({ series: { tvdbId: 100_000 + i } });
    return { records, totalRecords: total };
  };
  lookupAnswer = [{ tmdbId: 555, tvdbId: 100_000 + total - 1 }];
  assert.equal(await isSeriesDownloadingInSonarr(555), null, "its tvdbId is past the cap");
  settings.set("sonarrUrl", `http://10.0.13.${instance}:8989`);
  lookupAnswer = [{ tmdbId: 556, tvdbId: 100_000 }];
  assert.equal(await isSeriesDownloadingInSonarr(556), true);
});

test("an answer that isn't a queue page is a failed read: unknown, not an empty queue", async () => {
  pageOf = () => ({ totalRecords: 3 });
  assert.equal(await isMovieDownloadingInRadarr(1), null);
  assert.equal(await countRadarrQueue(), null);
});

test("foldQueueRecord: positive integer ids only; a series without a tmdbId marks the queue unmapped", () => {
  const state = { tmdbIds: new Set<number>(), tvdbIds: new Set<number>(), unmapped: false, complete: true };
  foldQueueRecord("radarr", { movie: { tmdbId: "603" } }, state);
  foldQueueRecord("radarr", { movie: null }, state);
  foldQueueRecord("radarr", { movie: { tmdbId: 603 } }, state);
  assert.deepEqual([...state.tmdbIds], [603]);

  const tv = { tmdbIds: new Set<number>(), tvdbIds: new Set<number>(), unmapped: false, complete: true };
  foldQueueRecord("sonarr", { series: { tvdbId: 1, tmdbId: 2 } }, tv);
  assert.equal(tv.unmapped, false);
  foldQueueRecord("sonarr", { series: { tvdbId: 3, tmdbId: 0 } }, tv);
  assert.equal(tv.unmapped, true);
  assert.deepEqual([...tv.tvdbIds], [1, 3]);
  assert.deepEqual([...tv.tmdbIds], [2]);
});
