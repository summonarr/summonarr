// User, library and issue aggregates of /admin/stats against a REAL Postgres
// (generate_series month grids, UNION/DISTINCT counts, percentile_cont, and the
// optional `AND … >= since` clause — guardrail 23a).
import { test, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { prisma, resetDb, makeUser, makeRequest, daysAgo, closeDb } from "./_harness.mts";
import { getUserStats, getLibraryStats, getLibraryGrowth, getIssueStats } from "@/lib/admin-stats-data.ts";

before(resetDb);
beforeEach(resetDb);
after(closeDb);

const nowUtc = new Date();
const Y = nowUtc.getUTCFullYear();
const M = nowUtc.getUTCMonth();
const monthLabel = (back: number) => {
  const d = new Date(Date.UTC(Y, M - back, 1));
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`;
};
const mid = (back: number) => new Date(Date.UTC(Y, M - back, 15, 12));

let sess = 0;
const session = (userId: string, lastSeenAt: Date) =>
  prisma.authSession.create({
    data: { sessionId: `db-suite-${++sess}`, userId, deviceType: "desktop", lastSeenAt, expiresAt: new Date(Date.now() + 86_400_000) },
  });

test("getUserStats: seen-in-30-days counts distinct ACTIVE accounts, requesters honour the window, new users bucket by month", async () => {
  const a = await makeUser();
  const b = await makeUser();
  const gone = await makeUser({ deactivated: true });
  await prisma.user.update({ where: { id: a.id }, data: { createdAt: mid(2) } });
  await prisma.user.update({ where: { id: b.id }, data: { createdAt: mid(2) } });
  await session(a.id, daysAgo(1));
  await session(a.id, daysAgo(2)); // same account twice: one
  await session(b.id, daysAgo(45)); // too old
  await session(gone.id, daysAgo(1)); // deactivated: excluded
  await makeRequest(a.id, { createdAt: daysAgo(2) });
  await makeRequest(a.id, { createdAt: daysAgo(3) });
  await makeRequest(b.id, { createdAt: daysAgo(90) });

  const all = await getUserStats(null);
  assert.equal(all.active, 2);
  assert.equal(all.disabled, 1);
  assert.equal(all.seenLast30Days, 1);
  assert.equal(all.requesters, 2);
  assert.equal(all.newByMonth.length, 12);
  assert.equal(all.newByMonth.find((m) => m.month === monthLabel(2))!.count, 2);
  assert.equal(all.newByMonth.find((m) => m.month === monthLabel(0))!.count, 1, "the deactivated user was created now");

  const win = await getUserStats(daysAgo(30));
  assert.equal(win.requesters, 1, "only a is inside the window");
});

test("getLibraryStats: distinct titles per service, the cross-server union, episodes and per-server rows", async () => {
  const p = (tmdbId: number, mediaType: "MOVIE" | "TV", serverInstance = "") => ({ tmdbId, mediaType, serverInstance });
  await prisma.plexLibraryItem.createMany({
    data: [p(1, "MOVIE"), p(1, "MOVIE", "b"), p(2, "MOVIE"), p(3, "TV")],
  });
  await prisma.jellyfinLibraryItem.createMany({ data: [p(1, "MOVIE"), p(4, "TV")] });
  await prisma.tVEpisodeCache.createMany({
    data: [1, 2, 3].map((e) => ({ source: "plex", tmdbId: 3, seasonNumber: 1, episodeNumber: e })),
  });
  await prisma.tVEpisodeCache.create({ data: { source: "jellyfin", tmdbId: 4, seasonNumber: 1, episodeNumber: 1 } });

  const s = await getLibraryStats();
  assert.deepEqual(s.perService.plex, { movies: 2, series: 1, episodes: 3 });
  assert.deepEqual(s.perService.jellyfin, { movies: 1, series: 1, episodes: 1 });
  assert.deepEqual(s.unique, { movies: 2, series: 2 }, "a movie on Plex AND Jellyfin is one title");
  const plexServers = s.servers.filter((x) => x.service === "plex");
  assert.deepEqual(plexServers.map((x) => [x.slug, x.movies, x.series]), [["", 2, 1], ["b", 1, 0]]);
});

test("getLibraryGrowth: a title counts once, in the month it was FIRST added anywhere", async () => {
  await prisma.plexLibraryItem.createMany({
    data: [
      { tmdbId: 1, mediaType: "MOVIE", addedAt: mid(2) },
      { tmdbId: 5, mediaType: "TV", addedAt: mid(1) },
      { tmdbId: 6, mediaType: "MOVIE" }, // no addedAt: invisible
      { tmdbId: 7, mediaType: "MOVIE", addedAt: mid(13) }, // outside the 12 months
    ],
  });
  await prisma.jellyfinLibraryItem.create({ data: { tmdbId: 1, mediaType: "MOVIE", addedAt: mid(3) } });

  const g = await getLibraryGrowth();
  assert.equal(g.length, 12);
  const by = new Map(g.map((r) => [r.month, r]));
  assert.deepEqual(by.get(monthLabel(3)), { month: monthLabel(3), movies: 1, series: 0 });
  assert.deepEqual(by.get(monthLabel(2)), { month: monthLabel(2), movies: 0, series: 0 }, "Plex's later add does not re-count it");
  assert.deepEqual(by.get(monthLabel(1)), { month: monthLabel(1), movies: 0, series: 1 });
  assert.equal(g.reduce((n, r) => n + r.movies + r.series, 0), 2);
});

async function seedIssues() {
  const u = await makeUser();
  const issue = (over: Record<string, unknown>) =>
    prisma.issue.create({
      data: { reportedBy: u.id, mediaType: "MOVIE", tmdbId: 1, title: "T", issueType: "BAD_VIDEO", ...over } as Parameters<
        typeof prisma.issue.create
      >[0]["data"],
    });
  const resolved = (seconds: number, resolvedAt: Date) =>
    issue({ status: "RESOLVED", createdAt: new Date(resolvedAt.getTime() - seconds * 1000), resolvedAt });
  await resolved(100, daysAgo(2));
  await resolved(300, daysAgo(3));
  await resolved(500, daysAgo(4));
  await resolved(900, daysAgo(35)); // resolved outside a 30-day window
  await issue({ status: "RESOLVED", createdAt: daysAgo(40) }); // resolvedAt unknown: left out
  await issue({ status: "OPEN", issueType: "WRONG_AUDIO", createdAt: daysAgo(1) });
  await issue({ status: "IN_PROGRESS", issueType: "WRONG_AUDIO", createdAt: daysAgo(2) });
}

test("getIssueStats without a window: time-to-resolve percentiles over every known resolution", async () => {
  await seedIssues();
  const s = await getIssueStats(null);
  assert.equal(s.open, 1);
  assert.equal(s.inProgress, 1);
  assert.equal(s.resolved, 5);
  assert.equal(s.resolve.count, 4);
  // percentile_cont over [100, 300, 500, 900]
  assert.equal(s.resolve.medianSeconds, 400);
  assert.ok(Math.abs((s.resolve.p90Seconds ?? 0) - 780) < 1e-6);
  assert.equal(s.resolvedInRange, 4);
  assert.deepEqual(s.backlogByType, [{ type: "WRONG_AUDIO", count: 2 }]);
});

test("getIssueStats with a window: the since clause bounds RESOLVED-at, not created-at", async () => {
  await seedIssues();
  const s = await getIssueStats(daysAgo(30));
  assert.equal(s.resolve.count, 3);
  assert.equal(s.resolve.medianSeconds, 300);
  assert.ok(Math.abs((s.resolve.p90Seconds ?? 0) - 460) < 1e-6);
  assert.equal(s.resolvedInRange, 3);
  // created-in-range uses createdAt: the 35d-old-resolution issue (created 35d+900s ago) and the 40d one are out
  assert.equal(s.createdInRange, 5);
});

test("getIssueStats: only RESOLVED issues feed the resolve time, and the window is on resolvedAt", async () => {
  const u = await makeUser();
  const mk = (over: Record<string, unknown>) =>
    prisma.issue.create({
      data: { reportedBy: u.id, mediaType: "MOVIE", tmdbId: 1, title: "T", issueType: "OTHER", ...over } as Parameters<
        typeof prisma.issue.create
      >[0]["data"],
    });
  // created long before the window, resolved inside it: counts (window is on resolvedAt)
  await mk({ status: "RESOLVED", createdAt: daysAgo(40), resolvedAt: daysAgo(5) });
  // a reopened issue that kept a stale resolvedAt must not count
  await mk({ status: "OPEN", createdAt: daysAgo(6), resolvedAt: daysAgo(4) });
  const s = await getIssueStats(daysAgo(30));
  assert.equal(s.resolve.count, 1);
  assert.ok(Math.abs((s.resolve.medianSeconds ?? 0) - 35 * 86400) < 1, "35 days from created to resolved");
  assert.equal(s.resolvedInRange, 1);
});
