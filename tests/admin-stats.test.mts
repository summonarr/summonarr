// Admin Statistics (/admin/stats + GET /api/admin/stats):
//   - the pure half (src/lib/admin-stats.ts): range parsing, disk merging,
//     durations, shares;
//   - the prisma half (src/lib/admin-stats-data.ts), against an in-memory
//     prisma whose $queryRaw records the composed SQL. The structural pins
//     here each name a defect the page shipped with:
//       * fulfillment averaged EVERY AVAILABLE row — copies created
//         already-available (availableAt = creation) and unapproved requests a
//         library sync marked available read as near-instant fulfillments;
//       * "Users" counted disabled and purged accounts;
//       * the month series joined on to_char(createdAt) (every row formatted,
//         no index) and the API's copy dropped zero months;
//       * top requesters grouped by name+email with no tiebreak;
//       * library counts double-counted a title held by two servers.
// No DB, no network.
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";

process.env.TOKEN_ENCRYPTION_KEY = "cd".repeat(32);
process.env.NEXTAUTH_SECRET = "admin-stats-test-secret-0123456789abcd";
(process.env as Record<string, string | undefined>).NODE_ENV = "test";

globalThis.fetch = (async () => {
  throw new Error("no network in tests");
}) as unknown as typeof fetch;

const { prisma } = await import("../src/lib/prisma.ts");
const { Prisma } = await import("@/generated/prisma");
const { shadowPrismaModel, shadowPrismaClientMethod } = await import("./_helpers.mts");
const pure = await import("../src/lib/admin-stats.ts");
const data = await import("../src/lib/admin-stats-data.ts");

// ── in-memory prisma ────────────────────────────────────────────────────────

type Captured = { sql: string; values: unknown[] };
const rawCalls: Captured[] = [];
let rawResponder: (sql: string) => unknown[] = () => [];
const ops: Array<{ op: string; args: unknown }> = [];

shadowPrismaClientMethod(prisma, "$queryRaw", async (first: TemplateStringsArray | { sql: string; values: unknown[] }, ...values: unknown[]) => {
  // admin-stats-data passes a pre-built Prisma.sql (see the note there); a
  // tagged-template call is re-composed the same way so nested fragments are
  // flattened into the text either way.
  const composed = "sql" in first && !Array.isArray(first) ? first : Prisma.sql(first as TemplateStringsArray, ...values);
  rawCalls.push({ sql: composed.sql, values: composed.values });
  return rawResponder(composed.sql);
});

const groupByResults = new Map<string, unknown[]>();
const countResults: Array<{ match: (args: unknown) => boolean; value: number }> = [];
const model = (name: string) => ({
  groupBy: async (args: unknown) => {
    ops.push({ op: `${name}.groupBy`, args });
    return groupByResults.get(name) ?? [];
  },
  count: async (args: unknown) => {
    ops.push({ op: `${name}.count`, args });
    return countResults.find((c) => c.match(args))?.value ?? 0;
  },
  findFirst: async (args: unknown) => {
    ops.push({ op: `${name}.findFirst`, args });
    return null;
  },
  findMany: async (args: unknown) => {
    ops.push({ op: `${name}.findMany`, args });
    return [];
  },
  findUnique: async (args: unknown) => {
    ops.push({ op: `${name}.findUnique`, args });
    return null;
  },
});
for (const m of ["mediaRequest", "user", "issue", "plexLibraryItem", "jellyfinLibraryItem", "tVEpisodeCache", "deletionVote", "setting"]) {
  shadowPrismaModel(prisma, m, model(m));
}

beforeEach(() => {
  rawCalls.length = 0;
  ops.length = 0;
  groupByResults.clear();
  countResults.length = 0;
  rawResponder = () => [];
});

const norm = (s: string) => s.replace(/\s+/g, " ");

// ── pure ────────────────────────────────────────────────────────────────────

test("parseStatsRange accepts only the four presets and defaults to all time", () => {
  for (const r of ["30", "90", "365", "all"]) assert.equal(pure.parseStatsRange(r), r);
  for (const r of [undefined, null, "", "7", "abc", "3650"]) assert.equal(pure.parseStatsRange(r), "all");
});

test("statsRangeSince: null for all time, N days back otherwise", () => {
  const now = new Date("2026-10-05T12:00:00Z");
  assert.equal(pure.statsRangeSince("all", now), null);
  assert.equal(pure.statsRangeSince("30", now)?.toISOString(), "2026-09-05T12:00:00.000Z");
});

test("durationParts picks minutes / hours / days at the right boundaries", () => {
  assert.deepEqual(pure.durationParts(30 * 60), { unit: "minutes", value: 30 });
  assert.deepEqual(pure.durationParts(3599), { unit: "minutes", value: 60 });
  assert.deepEqual(pure.durationParts(3600), { unit: "hours", value: 1 });
  assert.deepEqual(pure.durationParts(36 * 3600), { unit: "days", value: 1.5 });
});

test("share is null — not 0 — when there is nothing to divide by", () => {
  assert.equal(pure.share(0, 0), null);
  assert.equal(pure.share(1, 4), 0.25);
});

test("diskUsedPct clamps a disk reporting more free than total, and a zero total", () => {
  assert.equal(pure.diskUsedPct(100, 150), 0);
  assert.equal(pure.diskUsedPct(0, 0), 0);
  assert.equal(pure.diskUsedPct(100, -5), 100);
  assert.equal(pure.diskUsedPct(200, 50), 75);
});

test("mergeDiskGroups: one mount reported by Radarr AND Sonarr is ONE disk, credited to both", () => {
  const disk = { path: "/data", label: "", totalSpace: 1000, freeSpace: 400 };
  const merged = pure.mergeDiskGroups([
    { source: "Radarr", entries: [disk] },
    { source: "Sonarr", entries: [{ ...disk, freeSpace: 390 }] },
    { source: "Sonarr (Anime)", entries: [disk] },
  ]);
  assert.equal(merged.length, 1);
  assert.deepEqual(merged[0].reportedBy, ["Radarr", "Sonarr", "Sonarr (Anime)"]);
  assert.equal(merged[0].freeSpace, 390, "the lower free reading wins — never under-report fullness");
  assert.equal(merged[0].usedPct, 61);
  assert.equal(merged[0].label, "/data", "a blank label falls back to the path");
});

test("mergeDiskGroups keeps two different volumes mounted at the same path apart, and drops zero-size entries", () => {
  const merged = pure.mergeDiskGroups([
    { source: "Radarr", entries: [{ path: "/media", totalSpace: 1000, freeSpace: 900 }, { path: "/empty", totalSpace: 0, freeSpace: 0 }] },
    { source: "Sonarr", entries: [{ path: "/media", totalSpace: 5000, freeSpace: 100 }] },
  ]);
  assert.equal(merged.length, 2);
  assert.deepEqual(merged.map((d) => d.totalSpace), [5000, 1000], "fullest first");
});

test("utcMonthKey buckets in UTC", () => {
  assert.equal(pure.utcMonthKey(new Date("2026-01-31T23:30:00-05:00")), "2026-02");
});

// ── fulfillment ─────────────────────────────────────────────────────────────

test("fulfillment only weighs APPROVED requests, and keeps backfilled approvals out of the approve/download figures", async () => {
  await data.getFulfillmentStats(null);
  const sql = norm(rawCalls[0].sql);
  assert.match(sql, /WHERE r\."approvedAt" IS NOT NULL/, "an unapproved (mirrored / library-marked) request must not count");
  assert.match(sql, /r\."approvedAt" = r\."createdAt" AS legacy/);
  assert.match(sql, /COUNT\(download_s\) FILTER \(WHERE NOT legacy\)/);
  assert.match(sql, /percentile_cont\(0\.5\)/, "a median, not just a mean");
  assert.ok(!/AND r\."createdAt" >=/.test(sql), "all time adds no window");
});

test("fulfillment applies the period window to createdAt", async () => {
  const since = new Date("2026-09-01T00:00:00Z");
  await data.getFulfillmentStats(since);
  assert.match(norm(rawCalls[0].sql), /AND r\."createdAt" >= (\?|\$\d+)/);
  assert.ok(rawCalls[0].values.includes(since));
});

test("fulfillment maps the grand-total row and the per-media-type rows apart", async () => {
  rawResponder = () => [
    { media_type: null, approve_n: 2n, approve_med: 45000, approve_p90: 78000, download_n: 3n, download_med: 86400, download_p90: 150000, total_n: 4n, total_med: 129600, total_p90: 230000, total_avg: 134100, auto_n: 5n, admin_n: 2n },
    { media_type: "TV", approve_n: 0n, approve_med: null, approve_p90: null, download_n: 0n, download_med: null, download_p90: null, total_n: 1n, total_med: 259200, total_p90: 259200, total_avg: 259200, auto_n: 0n, admin_n: 0n },
  ];
  const f = await data.getFulfillmentStats(null);
  assert.deepEqual(f.total, { count: 4, medianSeconds: 129600, p90Seconds: 230000, avgSeconds: 134100 });
  assert.deepEqual(f.approve, { count: 2, medianSeconds: 45000, p90Seconds: 78000 });
  assert.equal(f.autoApproved, 5);
  assert.equal(f.adminApproved, 2);
  assert.deepEqual(f.byMediaType.TV.total, { count: 1, medianSeconds: 259200, p90Seconds: 259200 });
  assert.deepEqual(f.byMediaType.MOVIE.total, { count: 0, medianSeconds: null, p90Seconds: null }, "an absent group is empty, not inherited");
});

// ── months ──────────────────────────────────────────────────────────────────

test("the month series range-joins on the raw timestamp and fills every month", async () => {
  rawResponder = () => [
    { month: "2026-09", status: null, count: 0n },
    { month: "2026-10", status: "PENDING", count: 2n },
    { month: "2026-10", status: "AVAILABLE", count: 3n },
  ];
  const months = await data.getRequestsByMonth();
  const sql = norm(rawCalls[0].sql);
  assert.match(sql, /r\."createdAt" >= m\.start AND r\."createdAt" < m\.start \+ INTERVAL '1 month'/);
  assert.ok(!/to_char\(date_trunc\('month', r\."createdAt"\)\)/.test(sql), "formatting every row is the non-sargable join");
  assert.match(sql, /generate_series/);
  assert.deepEqual(months.map((m) => [m.month, m.count]), [["2026-09", 0], ["2026-10", 5]]);
  assert.equal(months[1].byStatus.AVAILABLE, 3);
});

// ── queue / stuck ───────────────────────────────────────────────────────────

test("the pending queue excludes a PENDING row that carries an approval (a rolled-back push is not queue work)", async () => {
  rawResponder = () => [{ requests: 3n, titles: 2n, oldest: new Date("2026-09-01T00:00:00Z"), warn: 2n, alert: 1n }];
  const q = await data.getPendingQueue();
  assert.match(norm(rawCalls[0].sql), /r\.status = 'PENDING' AND r\."approvedAt" IS NULL/);
  assert.deepEqual(q, { requests: 3, titles: 2, oldestCreatedAt: "2026-09-01T00:00:00.000Z", olderThanWarn: 2, olderThanAlert: 1 });
});

test("stuck requests match the *arr caches on the request's OWN instance (guardrail 32) and only look at approved rows", async () => {
  rawResponder = (sql) =>
    /GROUP BY reason/.test(sql)
      ? [{ reason: "push-failed", count: 2n }, { reason: "slow-download", count: 1n }]
      : [];
  const s = await data.getStuckRequests();
  const sql = norm(rawCalls[0].sql);
  assert.match(sql, /"RadarrWantedItem" w WHERE w\."tmdbId" = r\."tmdbId" AND w\."arrInstance" = r\."arrInstance"/);
  assert.match(sql, /"SonarrWantedItem" w WHERE w\."tmdbId" = r\."tmdbId" AND w\."arrInstance" = r\."arrInstance"/);
  assert.match(sql, /WHERE r\."approvedAt" IS NOT NULL AND r\.status IN \('PENDING', 'APPROVED'\)/);
  assert.match(sql, /WHEN r\.status = 'PENDING' THEN 'push-failed'/);
  assert.deepEqual(s.counts, { "push-failed": 2, "not-in-arr": 0, "slow-download": 1 });
});

// ── users ───────────────────────────────────────────────────────────────────

test("active users exclude disabled (and therefore purged) accounts", async () => {
  await data.countActiveUsers();
  assert.deepEqual(ops.find((o) => o.op === "user.count")?.args, { where: { deactivatedAt: null } });
});

test("top requesters group by account id with a stable tiebreak", async () => {
  await data.getTopRequesters(null);
  const sql = norm(rawCalls[0].sql);
  assert.match(sql, /GROUP BY u\.id/);
  assert.match(sql, /ORDER BY count DESC, u\.name ASC NULLS LAST, u\.id ASC/);
});

// ── requests ────────────────────────────────────────────────────────────────

test("the request overview counts mirrored copies as AVAILABLE rows nobody approved, inside the window", async () => {
  const since = new Date("2026-09-01T00:00:00Z");
  groupByResults.set("mediaRequest", []);
  await data.getRequestOverview(since);
  const counts = ops.filter((o) => o.op === "mediaRequest.count").map((o) => o.args);
  assert.deepEqual(counts, [
    { where: { createdAt: { gte: since }, approvedAt: { not: null } } },
    { where: { createdAt: { gte: since }, status: "AVAILABLE", approvedAt: null } },
  ]);
});

// ── library ─────────────────────────────────────────────────────────────────

test("library counts are DISTINCT titles — a title on two servers is one title — with a per-server breakdown", async () => {
  groupByResults.set("plexLibraryItem", [
    { serverInstance: "", mediaType: "MOVIE", _count: { _all: 10 } },
    { serverInstance: "remote", mediaType: "MOVIE", _count: { _all: 4 } },
  ]);
  rawResponder = () => [
    { service: "plex", mediaType: "MOVIE", n: 12n },
    { service: "all", mediaType: "MOVIE", n: 13n },
  ];
  const lib = await data.getLibraryStats();
  const sql = norm(rawCalls[0].sql);
  assert.match(sql, /COUNT\(DISTINCT "tmdbId"\)::bigint AS n FROM "PlexLibraryItem"/);
  assert.match(sql, /SELECT "tmdbId", "mediaType" FROM "PlexLibraryItem" UNION SELECT "tmdbId", "mediaType" FROM "JellyfinLibraryItem"/);
  assert.equal(lib.perService.plex.movies, 12, "not 14 — the per-server rows overlap");
  assert.equal(lib.unique.movies, 13);
  assert.deepEqual(lib.servers.map((s) => [s.slug, s.movies]), [["", 10], ["remote", 4]]);
});

// ── issues ──────────────────────────────────────────────────────────────────

test("issue time-to-resolve reads resolvedAt (never updatedAt) and windows on it", async () => {
  const since = new Date("2026-09-01T00:00:00Z");
  await data.getIssueStats(since);
  const sql = norm(rawCalls[0].sql);
  assert.match(sql, /EXTRACT\(EPOCH FROM \(i\."resolvedAt" - i\."createdAt"\)\)/);
  assert.match(sql, /AND i\."resolvedAt" >= (\?|\$\d+)/);
  assert.ok(!/updatedAt/.test(sql));
  const unclaimed = ops.find((o) => o.op === "issue.count" && JSON.stringify(o.args).includes("claimedBy"));
  assert.deepEqual(unclaimed?.args, { where: { status: { in: ["OPEN", "IN_PROGRESS"] }, claimedBy: null } }, "IN_PROGRESS counts as unresolved");
});
