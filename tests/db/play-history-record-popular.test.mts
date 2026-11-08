// Play-history writes and the /popular ranking against a REAL Postgres: the
// finalize that extends an early record of the same sitting, the batched
// retention purge, the per-title recent-plays select, and /popular pages sliced
// from one ranking statement. The unit suite stubs the delegates and
// $queryRawUnsafe, so none of these ran against a database there.
import { test, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { prisma, resetDb, closeDb } from "./_harness.mts";
import type { ActiveSession, Prisma } from "@/generated/prisma";
import {
  clearActivityCache,
  getMediaPlayStats,
  getMostPopularOnServer,
  invalidatePlayHistorySettings,
  purgeOldHistory,
  recordCompletedSession,
} from "@/lib/play-history.ts";
import { PURGE_BATCH_SIZE } from "@/lib/play-history-record.ts";

before(resetDb);
beforeEach(async () => {
  await resetDb();
  clearActivityCache();
  invalidatePlayHistorySettings();
});
after(closeDb);

async function makeServerUser(username: string) {
  return prisma.mediaServerUser.create({
    data: { source: "plex", sourceUserId: `plex-${username}`, username },
    select: { id: true },
  });
}

let sid = 0;
function playRow(userId: string, startedAt: Date, over: Record<string, unknown> = {}) {
  return {
    source: "plex",
    mediaServerUserId: userId,
    startedAt,
    stoppedAt: new Date(startedAt.getTime() + 3_600_000),
    duration: 7200,
    playDuration: 7000,
    watched: true,
    mediaType: "MOVIE",
    tmdbId: 100,
    title: "Movie A",
    sourceSessionId: `s${++sid}`,
    ...over,
  } as Prisma.PlayHistoryCreateManyInput;
}

const DAY = 86_400_000;

// One sitting's start, shared by every finalize of it (the dedup key is sessionKey:startedAt).
const SITTING_START = new Date(Date.now() - 2 * 3_600_000);

function liveSession(userId: string, over: Partial<ActiveSession> = {}): ActiveSession {
  const startedAt = SITTING_START;
  return {
    id: "plex:k1", source: "plex", serverInstance: "", sessionKey: "k1", startedAt,
    lastSeenAt: new Date(startedAt.getTime() + 20 * 60_000), state: "playing", mediaServerUserId: userId,
    serverUsername: "alice", tmdbId: null, mediaType: "MOVIE", title: "Movie A", year: "1999",
    seasonNumber: null, episodeNumber: null, episodeTitle: null, sourceItemId: null, sourceShowId: null,
    posterPath: null, progressPercent: 10, progressMs: 0n, startProgressMs: 0n, progressUpdatedAt: startedAt,
    playtimeMs: 20n * 60_000n, durationMs: 7_200_000n, platform: "Roku", player: "Plex", device: "Roku",
    ipAddress: "10.0.0.2", playMethod: "DirectPlay", videoCodec: "h264", audioCodec: "aac", resolution: "1080",
    bitrate: 8000, videoDecision: "directplay", audioDecision: "directplay", container: "mkv", transcodeReason: null,
    location: "lan", bandwidth: 9000, secure: true, relayed: false, introStartMs: null, introEndMs: null,
    creditsStartMs: null, creditsEndMs: null,
    ...over,
  };
}

test("a sitting recorded early is extended by its later, longer finalize — one row, never shortened", async () => {
  const msu = await makeServerUser("alice");
  const early = liveSession(msu.id); // 20 min in: what a stale cleanup would record
  await recordCompletedSession(early, { skipSSE: true });
  const later = liveSession(msu.id, {
    lastSeenAt: new Date(early.startedAt.getTime() + 115 * 60_000),
    playtimeMs: 115n * 60_000n,
    progressMs: 7_150_000n,
  });
  await recordCompletedSession(later, { skipSSE: true });

  const rows = await prisma.playHistory.findMany({ select: { playDuration: true, watched: true, completed: true, stoppedAt: true } });
  assert.equal(rows.length, 1, "still one row for the sitting");
  assert.equal(rows[0].playDuration, 115 * 60);
  assert.equal(rows[0].watched, true);
  assert.equal(rows[0].completed, true);
  assert.equal(rows[0].stoppedAt.getTime(), later.lastSeenAt.getTime());

  await recordCompletedSession(early, { skipSSE: true }); // a stale, shorter repeat
  const after = await prisma.playHistory.findMany({ select: { playDuration: true } });
  assert.deepEqual(after, [{ playDuration: 115 * 60 }], "a shorter record never replaces a longer one");
});

test("the retention purge deletes past-cutoff rows in batches and keeps the rest", async () => {
  const msu = await makeServerUser("alice");
  const old = new Date(Date.now() - 60 * DAY);
  await prisma.playHistory.createMany({
    data: Array.from({ length: PURGE_BATCH_SIZE + 3 }, () => playRow(msu.id, old)),
  });
  await prisma.playHistory.create({ data: playRow(msu.id, new Date(Date.now() - 2 * DAY)) });
  await prisma.setting.create({ data: { key: "playHistoryRetentionDays", value: "30" } });
  invalidatePlayHistorySettings();

  assert.equal(await purgeOldHistory(), PURGE_BATCH_SIZE + 3);
  assert.equal(await prisma.playHistory.count(), 1);
});

test("the per-title bundle's recent plays come back through the explicit select, viewer included", async () => {
  const msu = await makeServerUser("alice");
  await prisma.playHistory.create({ data: playRow(msu.id, new Date(Date.now() - DAY), { platform: "Roku" }) });
  const stats = await getMediaPlayStats(100, "MOVIE");
  assert.equal(stats.recentPlays.length, 1);
  const p = stats.recentPlays[0];
  assert.equal(p.mediaServerUser.username, "alice");
  assert.equal(p.platform, "Roku");
  assert.equal("ipAddress" in p, false);
  assert.equal(stats.totalPlays, 1);
});

test("/popular: pages are slices of one ranking, ordered by the sort, with the ranking's totals", async () => {
  const users = await Promise.all(["a", "b", "c"].map(makeServerUser));
  const at = new Date(Date.now() - 3 * DAY);
  // Movie 1 completed by three viewers, movie 2 by two, movie 3 by one.
  for (const [tmdbId, viewers] of [[1, 3], [2, 2], [3, 1]] as const) {
    for (const u of users.slice(0, viewers)) {
      await prisma.playHistory.create({ data: playRow(u.id, at, { tmdbId, title: `Movie ${tmdbId}` }) });
    }
  }
  const first = await getMostPopularOnServer({ mediaType: "MOVIE", sort: "viewers", limit: 2 });
  assert.deepEqual(first.items.map((i) => [i.tmdbId, i.viewers]), [[1, 3], [2, 2]]);
  assert.deepEqual([first.totalItems, first.totalPages, first.page], [3, 2, 1]);
  const second = await getMostPopularOnServer({ mediaType: "MOVIE", sort: "viewers", page: 2, limit: 2 });
  assert.deepEqual(second.items.map((i) => i.tmdbId), [3]);
  const past = await getMostPopularOnServer({ mediaType: "MOVIE", sort: "viewers", page: 9, limit: 2 });
  assert.deepEqual([past.items.length, past.totalItems], [0, 3]);
  const trending = await getMostPopularOnServer({ mediaType: "MOVIE", sort: "trending" });
  assert.deepEqual(trending.items.map((i) => i.tmdbId), [1, 2, 3], "the 30-day window binds and filters");
});
