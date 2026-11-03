// The request-side aggregates of /admin/stats against a REAL Postgres. The unit
// suite stubs $queryRaw, so none of this SQL (percentile_cont, GROUPING SETS,
// FILTER, the optional `AND createdAt >= since` clause built with Prisma.sql —
// guardrail 23a) was ever executed before.
import { test, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { prisma, resetDb, makeUser, makeRequest, daysAgo, closeDb } from "./_harness.mts";
import {
  getFulfillmentStats,
  getRequestsByMonth,
  getPendingQueue,
  getMostWantedPending,
  getStuckRequests,
  getRequestSources,
  getTopRequesters,
} from "@/lib/admin-stats-data.ts";
import { invalidateFeatureFlagCache } from "@/lib/features.ts";

before(resetDb);
beforeEach(async () => {
  await resetDb();
  invalidateFeatureFlagCache();
});
after(closeDb);

const plus = (d: Date, seconds: number): Date => new Date(d.getTime() + seconds * 1000);

async function seedFulfillment() {
  const u = await makeUser();
  const a = daysAgo(10); // admin-approved after 1h, available after 3h
  await makeRequest(u.id, { createdAt: a, approvedAt: plus(a, 3600), availableAt: plus(a, 10800), status: "AVAILABLE" });
  const b = daysAgo(9); // auto-approved (1s < the 2s window), still downloading
  await makeRequest(u.id, { createdAt: b, approvedAt: plus(b, 1), status: "APPROVED" });
  const c = daysAgo(30); // TV, legacy backfill (approvedAt === createdAt), available a day later
  await makeRequest(u.id, { mediaType: "TV", createdAt: c, approvedAt: c, availableAt: plus(c, 86400), status: "AVAILABLE" });
  // never approved: must not appear in any figure
  await makeRequest(u.id, { createdAt: daysAgo(5), status: "PENDING" });
  await makeRequest(u.id, { createdAt: daysAgo(5), status: "AVAILABLE", availableAt: daysAgo(4) });
}

test("getFulfillmentStats without a window: medians, legacy rows, auto vs admin, per media type", async () => {
  await seedFulfillment();
  const s = await getFulfillmentStats(null);
  assert.deepEqual(s.approve, { count: 1, medianSeconds: 3600, p90Seconds: 3600 });
  assert.deepEqual(s.download, { count: 1, medianSeconds: 7200, p90Seconds: 7200 });
  assert.equal(s.total.count, 2);
  assert.equal(s.total.medianSeconds, 48600); // (10800 + 86400) / 2
  assert.equal(s.total.avgSeconds, 48600);
  assert.ok(Math.abs((s.total.p90Seconds ?? 0) - (10800 + 0.9 * (86400 - 10800))) < 1e-6);
  assert.equal(s.autoApproved, 1);
  assert.equal(s.adminApproved, 1);
  assert.deepEqual(s.byMediaType.MOVIE.download, { count: 1, medianSeconds: 7200, p90Seconds: 7200 });
  assert.deepEqual(s.byMediaType.MOVIE.total, { count: 1, medianSeconds: 10800, p90Seconds: 10800 });
  // the legacy row sits out of download but still counts request -> available
  assert.equal(s.byMediaType.TV.download.count, 0);
  assert.equal(s.byMediaType.TV.download.medianSeconds, null);
  assert.deepEqual(s.byMediaType.TV.total, { count: 1, medianSeconds: 86400, p90Seconds: 86400 });
});

test("getFulfillmentStats with a window: the optional since clause drops the old row", async () => {
  await seedFulfillment();
  const s = await getFulfillmentStats(daysAgo(20));
  assert.equal(s.total.count, 1, "the 30-day-old TV request is outside the window");
  assert.equal(s.total.medianSeconds, 10800);
  assert.equal(s.byMediaType.TV.total.count, 0);
  assert.equal(s.autoApproved, 1);
  assert.equal(s.adminApproved, 1);
});

test("getFulfillmentStats: an availableAt before the approval has a total but no download time", async () => {
  const u = await makeUser();
  const created = daysAgo(10);
  // approved 2h in, but marked available 1h in (a library sync beat the approval)
  await makeRequest(u.id, { createdAt: created, approvedAt: plus(created, 7200), availableAt: plus(created, 3600), status: "AVAILABLE" });
  const s = await getFulfillmentStats(null);
  assert.equal(s.download.count, 0);
  assert.equal(s.total.count, 1);
  assert.equal(s.total.medianSeconds, 3600);
});

test("getFulfillmentStats on an empty table returns zeros and nulls", async () => {
  const s = await getFulfillmentStats(null);
  assert.deepEqual(s.approve, { count: 0, medianSeconds: null, p90Seconds: null });
  assert.equal(s.total.avgSeconds, null);
  assert.equal(s.autoApproved, 0);
});

test("getRequestsByMonth: 12 UTC months oldest first, empty months present, statuses split, old rows excluded", async () => {
  const u = await makeUser();
  const now = new Date();
  const y = now.getUTCFullYear();
  const m = now.getUTCMonth();
  const at = (monthsBack: number, day: number) => new Date(Date.UTC(y, m - monthsBack, day, 12));
  await makeRequest(u.id, { createdAt: at(0, 1), status: "PENDING" });
  await makeRequest(u.id, { createdAt: at(2, 15), status: "AVAILABLE" });
  await makeRequest(u.id, { createdAt: at(2, 20), status: "DECLINED" });
  await makeRequest(u.id, { createdAt: at(11, 3), status: "APPROVED" });
  await makeRequest(u.id, { createdAt: at(12, 15), status: "APPROVED" }); // 13th month: out

  const months = await getRequestsByMonth();
  assert.equal(months.length, 12);
  const label = (back: number) => {
    const d = new Date(Date.UTC(y, m - back, 1));
    return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`;
  };
  assert.deepEqual(months.map((b) => b.month), Array.from({ length: 12 }, (_, i) => label(11 - i)));
  const by = new Map(months.map((b) => [b.month, b]));
  assert.deepEqual(by.get(label(0))!.byStatus, { PENDING: 1, APPROVED: 0, DECLINED: 0, AVAILABLE: 0 });
  assert.equal(by.get(label(2))!.count, 2);
  assert.equal(by.get(label(2))!.byStatus.AVAILABLE, 1);
  assert.equal(by.get(label(2))!.byStatus.DECLINED, 1);
  assert.equal(by.get(label(1))!.count, 0);
  assert.equal(by.get(label(11))!.byStatus.APPROVED, 1);
  assert.equal(months.reduce((n, b) => n + b.count, 0), 4);
});

test("getPendingQueue: only never-approved PENDING, distinct titles, warn/alert ages", async () => {
  const a = await makeUser();
  const b = await makeUser();
  const oldest = daysAgo(8);
  await makeRequest(a.id, { tmdbId: 1, createdAt: oldest });
  await makeRequest(b.id, { tmdbId: 1, createdAt: daysAgo(4) });
  await makeRequest(a.id, { tmdbId: 2, createdAt: daysAgo(0.01) });
  await makeRequest(a.id, { tmdbId: 3, createdAt: daysAgo(20), approvedAt: daysAgo(19) }); // rolled-back push: not queue work
  await makeRequest(a.id, { tmdbId: 4, createdAt: daysAgo(20), status: "APPROVED" });
  // TMDB movie and TV ids overlap: tmdbId 2 as a SERIES is a different title
  await makeRequest(b.id, { tmdbId: 2, mediaType: "TV", createdAt: daysAgo(0.02) });

  const q = await getPendingQueue();
  assert.equal(q.requests, 4);
  assert.equal(q.titles, 3);
  assert.equal(q.olderThanWarn, 2);
  assert.equal(q.olderThanAlert, 1);
  assert.equal(q.oldestCreatedAt, oldest.toISOString());
});

test("getPendingQueue on an empty queue", async () => {
  const q = await getPendingQueue();
  assert.deepEqual(q, { requests: 0, titles: 0, oldestCreatedAt: null, olderThanWarn: 0, olderThanAlert: 0 });
});

test("getMostWantedPending: ranked by distinct requesters, then oldest, honours the limit", async () => {
  const [a, b, c] = [await makeUser(), await makeUser(), await makeUser()];
  await makeRequest(a.id, { tmdbId: 10, title: "Two Askers", createdAt: daysAgo(1) });
  await makeRequest(b.id, { tmdbId: 10, title: "Two Askers", createdAt: daysAgo(2) });
  await makeRequest(a.id, { tmdbId: 20, title: "Newer Single", createdAt: daysAgo(1) });
  await makeRequest(c.id, { tmdbId: 30, title: "Older Single", createdAt: daysAgo(6) });
  await makeRequest(c.id, { tmdbId: 40, title: "Approved", status: "APPROVED" });

  const all = await getMostWantedPending(8);
  assert.deepEqual(all.map((t) => [t.tmdbId, t.requesters]), [[10, 2], [30, 1], [20, 1]]);
  assert.equal(all[0].title, "Two Askers");
  const top1 = await getMostWantedPending(1);
  assert.deepEqual(top1.map((t) => t.tmdbId), [10]);
});

async function seedStuck() {
  const u = await makeUser();
  const ids: Record<string, string> = {};
  let n = 700;
  const add = async (name: string, over: Record<string, unknown>): Promise<number> => {
    const tmdbId = ++n;
    ids[name] = (await makeRequest(u.id, { tmdbId, ...over })).id;
    return tmdbId;
  };
  await add("pushFailed", { status: "PENDING", approvedAt: daysAgo(2) });
  const slowMovie = await add("slowMovie", { status: "APPROVED", approvedAt: daysAgo(10) });
  const freshMovie = await add("freshMovie", { status: "APPROVED", approvedAt: daysAgo(1) });
  await add("lostMovie", { status: "APPROVED", approvedAt: daysAgo(3), lastArrPushAt: daysAgo(1) });
  const okMovie = await add("okMovie", { status: "APPROVED", approvedAt: daysAgo(3), lastArrPushAt: daysAgo(1) });
  const slowTv = await add("slowTv", { mediaType: "TV", status: "APPROVED", approvedAt: daysAgo(9) });
  await add("lostTv", { mediaType: "TV", status: "APPROVED", approvedAt: daysAgo(4), lastArrPushAt: daysAgo(1) });
  await add("unpushed", { status: "APPROVED", approvedAt: daysAgo(5) });
  await prisma.radarrWantedItem.createMany({ data: [{ tmdbId: slowMovie }, { tmdbId: freshMovie }] });
  await prisma.radarrAvailableItem.create({ data: { tmdbId: okMovie } });
  await prisma.sonarrWantedItem.create({ data: { tmdbId: slowTv } });
  return ids;
}

test("getStuckRequests: classifies push-failed / slow-download / not-in-arr and orders the oldest", async () => {
  const ids = await seedStuck();
  const s = await getStuckRequests(10);
  assert.deepEqual(s.counts, { "push-failed": 1, "not-in-arr": 2, "slow-download": 2 });
  const reasons = new Map(s.oldest.map((r) => [r.id, r.reason]));
  assert.equal(reasons.get(ids.pushFailed), "push-failed");
  assert.equal(reasons.get(ids.slowMovie), "slow-download");
  assert.equal(reasons.get(ids.slowTv), "slow-download");
  assert.equal(reasons.get(ids.lostMovie), "not-in-arr");
  assert.equal(reasons.get(ids.lostTv), "not-in-arr");
  for (const quiet of ["freshMovie", "okMovie", "unpushed"]) assert.equal(reasons.has(ids[quiet]), false, quiet);
  // oldest approval first
  assert.deepEqual(s.oldest.map((r) => r.id).slice(0, 2), [ids.slowMovie, ids.slowTv]);
  // the limit applies to the list, not to the counts
  const limited = await getStuckRequests(2);
  assert.equal(limited.oldest.length, 2);
  assert.equal(limited.counts["not-in-arr"], 2);
});

test("getStuckRequests: a disabled Radarr silences its movie verdicts but not PENDING push failures", async () => {
  const ids = await seedStuck();
  await prisma.setting.create({ data: { key: "feature.integration.radarr", value: "false" } });
  invalidateFeatureFlagCache();
  const s = await getStuckRequests(10);
  assert.deepEqual(s.counts, { "push-failed": 1, "not-in-arr": 1, "slow-download": 1 });
  const got = new Set(s.oldest.map((r) => r.id));
  assert.ok(got.has(ids.pushFailed) && got.has(ids.slowTv) && got.has(ids.lostTv));
  assert.ok(!got.has(ids.slowMovie) && !got.has(ids.lostMovie));
});

test("getRequestSources: ledger sources counted with and without a window", async () => {
  const u = await makeUser();
  const r1 = await makeRequest(u.id, { tmdbId: 1, createdAt: daysAgo(2) });
  const r2 = await makeRequest(u.id, { tmdbId: 2, createdAt: daysAgo(2) });
  const r3 = await makeRequest(u.id, { tmdbId: 3, createdAt: daysAgo(40) });
  await makeRequest(u.id, { tmdbId: 4, createdAt: daysAgo(2) }); // plain web request: no ledger row
  for (const [r, source, tmdbId] of [[r1, "watchlist", 1], [r2, "plex-watchlist", 2], [r3, "watchlist", 3]] as const) {
    await prisma.autoRequestLedger.create({
      data: { userId: u.id, tmdbId, mediaType: "MOVIE", source, outcome: "requested", requestId: r.id },
    });
  }
  assert.deepEqual(await getRequestSources(null, 10), { watchlist: 2, plexWatchlist: 1, other: 7 });
  assert.deepEqual(await getRequestSources(daysAgo(30), 3), { watchlist: 1, plexWatchlist: 1, other: 1 });
});

test("getTopRequesters: counts per account, tie-broken by name, window and limit", async () => {
  const mk = (name: string, deactivated = false) =>
    prisma.user.create({
      data: { email: `${name}-${Math.random()}@db-suite.test`, name, ...(deactivated ? { deactivatedAt: new Date() } : {}) },
      select: { id: true },
    });
  const bob = await mk("Bob");
  const alice = await mk("Alice");
  const cara = await mk("Cara", true);
  await makeRequest(bob.id, { status: "AVAILABLE" });
  await makeRequest(bob.id, { status: "DECLINED" });
  await makeRequest(alice.id, {});
  await makeRequest(alice.id, { status: "AVAILABLE" });
  await makeRequest(cara.id, {});
  await makeRequest(cara.id, { createdAt: daysAgo(60) });

  const all = await getTopRequesters(null, 10);
  assert.deepEqual(all.map((r) => [r.name, r.count, r.available, r.declined, r.disabled]), [
    ["Alice", 2, 1, 0, false],
    ["Bob", 2, 1, 1, false],
    ["Cara", 2, 0, 0, true],
  ]);
  const win = await getTopRequesters(daysAgo(30), 10);
  assert.equal(win.find((r) => r.name === "Cara")!.count, 1, "the 60-day-old request is outside the window");
  const lim = await getTopRequesters(null, 1);
  assert.deepEqual(lim.map((r) => r.name), ["Alice"]);
});
