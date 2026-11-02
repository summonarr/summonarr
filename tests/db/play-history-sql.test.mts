// Play-history raw SQL against a REAL Postgres: the activity calendar (and its
// dynamic $N filter placeholders — the 803cd11 bug class), the heatmap cell
// drill-down, TRANSCODE_REASON_SQL, and the Statistics fan-out. The unit suite
// stubs $queryRawUnsafe, so none of this SQL had ever run.
import { test, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { prisma, resetDb, daysAgo, closeDb } from "./_harness.mts";
import {
  getActivityCalendar,
  getHeatmapCellDetail,
  getPlayHistoryStats,
  getMostRewatched,
  getTranscodeOffenders,
  clearActivityCache,
} from "@/lib/play-history.ts";

before(resetDb);
beforeEach(async () => {
  await resetDb();
  clearActivityCache(); // every aggregate is memoized per filter set
});
after(closeDb);

async function makeServerUser(source: "plex" | "jellyfin", username: string) {
  return prisma.mediaServerUser.create({
    data: { source, sourceUserId: `${source}-${username}`, username },
    select: { id: true },
  });
}

let sid = 0;
async function play(userId: string, source: "plex" | "jellyfin", startedAt: Date, over: Record<string, unknown> = {}) {
  return prisma.playHistory.create({
    data: {
      source,
      mediaServerUserId: userId,
      startedAt,
      stoppedAt: new Date(startedAt.getTime() + 3_600_000),
      duration: 7200,
      playDuration: 3600,
      watched: true,
      mediaType: "MOVIE",
      tmdbId: 100,
      title: "Movie A",
      sourceSessionId: `s${++sid}`,
      ...over,
    } as Parameters<typeof prisma.playHistory.create>[0]["data"],
  });
}

const todayUtc = (() => {
  const n = new Date();
  return Date.UTC(n.getUTCFullYear(), n.getUTCMonth(), n.getUTCDate());
})();
const dayStart = (back: number, hour = 12) => new Date(todayUtc - back * 86_400_000 + hour * 3_600_000);
const ymd = (back: number) => new Date(todayUtc - back * 86_400_000).toISOString().slice(0, 10);

async function seedCalendar() {
  const plex = await makeServerUser("plex", "alice");
  const jf = await makeServerUser("jellyfin", "bob");
  await play(plex.id, "plex", dayStart(0, 0)); // today, MOVIE
  await play(plex.id, "plex", dayStart(0, 0), { mediaType: "TV", tmdbId: 200, seasonNumber: 1, episodeNumber: 1 });
  await play(jf.id, "jellyfin", dayStart(2), { mediaType: "TV", tmdbId: 200, seasonNumber: 1, episodeNumber: 2 });
  await play(jf.id, "jellyfin", dayStart(364, 0)); // the first day of the 365-day window: in
  await play(plex.id, "plex", dayStart(365, 23)); // one day before: out
  await play(plex.id, "plex", dayStart(1), { watched: false }); // unwatched: never on the heatmap
  return { plex, jf };
}

test("getActivityCalendar with no filter: 365-day UTC window, watched only, per-day counts, ascending", async () => {
  await seedCalendar();
  assert.deepEqual(await getActivityCalendar(), [
    { day: ymd(364), count: 1 },
    { day: ymd(2), count: 1 },
    { day: ymd(0), count: 2 },
  ]);
});

test("getActivityCalendar filtered path: source, mediaType and both bind $1/$2 correctly", async () => {
  await seedCalendar();
  assert.deepEqual(await getActivityCalendar("plex"), [{ day: ymd(0), count: 2 }]);
  assert.deepEqual(await getActivityCalendar("jellyfin"), [
    { day: ymd(364), count: 1 },
    { day: ymd(2), count: 1 },
  ]);
  assert.deepEqual(await getActivityCalendar(undefined, "TV"), [
    { day: ymd(2), count: 1 },
    { day: ymd(0), count: 1 },
  ]);
  // two placeholders at once: $1 = source, $2 = mediaType
  assert.deepEqual(await getActivityCalendar("plex", "TV"), [{ day: ymd(0), count: 1 }]);
  assert.deepEqual(await getActivityCalendar("jellyfin", "MOVIE"), [{ day: ymd(364), count: 1 }]);
});

test("getActivityCalendar ignores a non-whitelisted filter instead of binding it", async () => {
  await seedCalendar();
  const unfiltered = await getActivityCalendar();
  clearActivityCache();
  assert.deepEqual(await getActivityCalendar("emby; DROP TABLE x", "MUSIC"), unfiltered);
});

test("getHeatmapCellDetail (day mode): aggregates, legacy Plex reasons normalized, Jellyfin reasons verbatim", async () => {
  const plex = await makeServerUser("plex", "alice");
  const jf = await makeServerUser("jellyfin", "bob");
  const day = dayStart(3, 10);
  await play(plex.id, "plex", day, {
    playMethod: "Transcode", transcodeReason: "Video codec not supported", resolution: "1080p",
    location: "lan", completed: true, bitrate: 8000, playDuration: 1800,
  });
  await play(plex.id, "plex", dayStart(3, 14), { playMethod: "DirectPlay", resolution: "1080", location: "wan", playDuration: 5400 });
  await play(jf.id, "jellyfin", dayStart(3, 16), {
    playMethod: "Transcode", transcodeReason: "Video codec not supported", resolution: "4k", location: "relay",
    mediaType: "TV", tmdbId: 200, title: "Show",
  });
  await play(plex.id, "plex", dayStart(3, 18), { watched: false }); // not counted
  await play(plex.id, "plex", dayStart(4, 12)); // previous day
  await play(plex.id, "plex", dayStart(2, 1)); // next day

  const d = await getHeatmapCellDetail({ mode: "day", day: ymd(3) });
  assert.equal(d.totalPlays, 3);
  assert.deepEqual(d.methods, { directPlay: 1, directStream: 0, transcode: 2, other: 0 });
  assert.deepEqual(d.source, { plex: 2, jellyfin: 1 });
  assert.deepEqual(d.mediaType, { movie: 2, tv: 1, other: 0 });
  assert.deepEqual(d.network, { lan: 1, wan: 1, relay: 1 });
  assert.equal(d.completedCount, 1);
  assert.equal(d.watchHours, 3); // (1800 + 5400 + 3600) / 3600
});

test("getHeatmapCellDetail (day mode): transcode reasons", async () => {
  const plex = await makeServerUser("plex", "alice");
  const jf = await makeServerUser("jellyfin", "bob");
  await play(plex.id, "plex", dayStart(3, 10), { playMethod: "Transcode", transcodeReason: "Video codec not supported" });
  await play(plex.id, "plex", dayStart(3, 11), { playMethod: "Transcode", transcodeReason: "Video transcoded" });
  await play(jf.id, "jellyfin", dayStart(3, 12), { playMethod: "Transcode", transcodeReason: "Video codec not supported" });
  const d = await getHeatmapCellDetail({ mode: "day", day: ymd(3) });
  // Plex's legacy label and the new one share a bucket; Jellyfin's identical words stay its own.
  assert.deepEqual(
    d.topTranscodeReasons.sort((a, b) => a.reason.localeCompare(b.reason)),
    [
      { reason: "Video codec not supported", count: 1 },
      { reason: "Video transcoded", count: 2 },
    ],
  );
  // source filter adds a dynamic placeholder AFTER the day placeholder
  clearActivityCache();
  const onlyJf = await getHeatmapCellDetail({ mode: "day", day: ymd(3), source: "jellyfin" });
  assert.equal(onlyJf.totalPlays, 1);
  assert.deepEqual(onlyJf.topTranscodeReasons, [{ reason: "Video codec not supported", count: 1 }]);
});

test("getHeatmapCellDetail: resolution buckets, titles, top users, userId scope, hour mode", async () => {
  const alice = await makeServerUser("plex", "alice");
  const bob = await makeServerUser("plex", "bob");
  const when = dayStart(2, 20); // 20:00 UTC
  await play(alice.id, "plex", when, { resolution: "1080p" });
  await play(alice.id, "plex", new Date(when.getTime() + 60_000), { resolution: "1080" });
  await play(bob.id, "plex", new Date(when.getTime() + 120_000), { resolution: "720p", title: "Movie B", tmdbId: 101 });
  await play(bob.id, "plex", dayStart(2, 9), { resolution: "720p" }); // different hour

  const dow = new Date(when).getUTCDay();
  const hourCell = await getHeatmapCellDetail({ mode: "hour", dow, hour: 20, days: 30 });
  assert.equal(hourCell.totalPlays, 3);
  assert.deepEqual(hourCell.topResolutions[0], { resolution: hourCell.topResolutions[0].resolution, count: 2 });
  assert.equal(hourCell.topResolutions.length, 2, '"1080p" and "1080" collapse into one bucket');
  assert.deepEqual(hourCell.topTitles.map((t) => [t.title, t.count]), [["Movie A", 2], ["Movie B", 1]]);
  assert.deepEqual(hourCell.topUsers.map((u) => [u.username, u.count]), [["alice", 2], ["bob", 1]]);

  clearActivityCache();
  const scoped = await getHeatmapCellDetail({ mode: "hour", dow, hour: 20, userId: bob.id });
  assert.equal(scoped.totalPlays, 1);
  assert.deepEqual(scoped.topUsers, [], "user-scoped pages list no viewers");
});

async function seedStats() {
  const alice = await makeServerUser("plex", "alice");
  const bob = await makeServerUser("jellyfin", "bob");
  await play(alice.id, "plex", daysAgo(1), { playMethod: "Transcode", transcodeReason: "Video codec not supported" });
  await play(alice.id, "plex", daysAgo(2), { playMethod: "DirectPlay" }); // a rewatch of tmdb 100
  await play(bob.id, "jellyfin", daysAgo(3), { playMethod: "Transcode", transcodeReason: "Video codec not supported" });
  await play(bob.id, "jellyfin", daysAgo(3), { mediaType: "TV", tmdbId: 200, title: "Show", seasonNumber: 1, episodeNumber: 1 });
  await play(alice.id, "plex", daysAgo(4), { mediaType: "TV", tmdbId: 200, title: "Show", seasonNumber: 1, episodeNumber: 1, watched: false });
  await play(alice.id, "plex", daysAgo(400), { tmdbId: 300, title: "Ancient" }); // outside any window
  return { alice, bob };
}

test("getPlayHistoryStats: window, watched-only plays, unfiltered analytics, and the Plex-only reason rewrite", async () => {
  await seedStats();
  const s = await getPlayHistoryStats({ days: 30 });
  assert.equal(s.totalPlays, 4, "watched plays inside 30 days");
  assert.equal(s.uniqueViewers, 2);
  assert.equal(s.uniqueTitles, 2);
  assert.deepEqual(s.sourceSplit.sort((a, b) => a.source.localeCompare(b.source)), [
    { source: "jellyfin", count: 2 },
    { source: "plex", count: 3 },
  ]);
  assert.deepEqual(
    s.transcodeReasons.sort((a, b) => a.reason.localeCompare(b.reason)),
    [
      { reason: "Video codec not supported", count: 1 }, // Jellyfin's own
      { reason: "Video transcoded", count: 1 }, // Plex's legacy label, rewritten
    ],
  );
  assert.deepEqual(s.topWatched.find((t) => t.tmdbId === 100 && t.mediaType === "MOVIE")?.plays, 3);
  assert.deepEqual(s.topRewatched.map((t) => [t.tmdbId, t.plays, t.viewers]), [[100, 3, 2]]);
});

test("getPlayHistoryStats with a source + mediaType filter: every dynamic $N lands on the right value", async () => {
  await seedStats();
  const s = await getPlayHistoryStats({ days: 30, source: "plex", mediaType: "MOVIE" });
  assert.equal(s.totalPlays, 2);
  assert.equal(s.uniqueViewers, 1);
  assert.deepEqual(s.sourceSplit, [{ source: "plex", count: 2 }]);
  assert.deepEqual(s.transcodeReasons, [{ reason: "Video transcoded", count: 1 }]);
  assert.equal(s.prevPeriod.totalPlays, 0);
});

test("getPlayHistoryStats: a wider window reaches further back, a narrower one trims", async () => {
  await seedStats();
  assert.equal((await getPlayHistoryStats({ days: 2 })).totalPlays, 1); // only the 1-day-old watch (2d row sits on the edge's far side)
  clearActivityCache();
  assert.equal((await getPlayHistoryStats({ days: 500 })).totalPlays, 5);
});

test("getMostRewatched and getTranscodeOffenders: filter + limit placeholders", async () => {
  const { alice } = await seedStats();
  const re = await getMostRewatched({ days: 30 }, 5);
  assert.deepEqual(re.map((r) => [r.tmdbId, r.plays, r.viewers]), [[100, 3, 2]]);
  // a second rewatched title with fewer plays: the LIMIT keeps the most-played one
  const bob = (await prisma.mediaServerUser.findFirstOrThrow({ where: { username: "bob" } })).id;
  await play(bob, "jellyfin", daysAgo(2), { tmdbId: 400, title: "Twice" });
  await play(bob, "jellyfin", daysAgo(1), { tmdbId: 400, title: "Twice" });
  clearActivityCache();
  assert.deepEqual((await getMostRewatched({ days: 30 }, 5)).map((r) => r.tmdbId), [100, 400]);
  clearActivityCache();
  assert.deepEqual((await getMostRewatched({ days: 30 }, 1)).map((r) => r.tmdbId), [100]);
  clearActivityCache();
  await prisma.playHistory.deleteMany({ where: { tmdbId: 400 } });
  const reFiltered = await getMostRewatched({ days: 30, source: "jellyfin" }, 5);
  assert.deepEqual(reFiltered, [], "the Jellyfin viewer watched tmdb 100 once");

  const off = await getTranscodeOffenders({ days: 30 }, 5);
  assert.deepEqual(off.topUsers.map((u) => [u.username, u.source, u.count]).sort(), [["alice", "plex", 1], ["bob", "jellyfin", 1]]);
  const offPlex = await getTranscodeOffenders({ days: 30, source: "plex" }, 1);
  assert.deepEqual(offPlex.topUsers.map((u) => [u.id, u.count]), [[alice.id, 1]]);
});
