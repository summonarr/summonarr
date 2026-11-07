// The personal watch history against a REAL Postgres. The list groups plays in
// SQL (groupKeySql's CASE ladder) while the entry detail rebuilds the same group
// with Prisma (groupIdentity), and the unit suite checks each against its own JS
// mirror — so only a real database can show the two agree. Also runs the search
// (a window bool_or that selects whole groups) and Wrapped's prime day and hour
// and blank-device filter, which the stubs never execute.
import { test, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { prisma, resetDb, makeUser, closeDb } from "./_harness.mts";
import { getMyWatchHistory, getMyWatchHistoryEntry } from "@/lib/my-watch-history.ts";
import { clearActivityCache, getWrappedForServerUsers } from "@/lib/play-history.ts";

before(resetDb);
beforeEach(async () => {
  await resetDb();
  clearActivityCache();
});
after(closeDb);

async function serverUser(userId: string, source: "plex" | "jellyfin", serverInstance: string) {
  return prisma.mediaServerUser.create({
    data: { source, serverInstance, sourceUserId: `${source}-${serverInstance}-${userId}`, username: "viewer", userId },
    select: { id: true },
  });
}

let sid = 0;
let minute = 0;
async function play(msuId: string, source: "plex" | "jellyfin", serverInstance: string, over: Record<string, unknown> = {}) {
  const startedAt = new Date(Date.UTC(2025, 2, 1, 20, ++minute));
  return prisma.playHistory.create({
    data: {
      source,
      serverInstance,
      mediaServerUserId: msuId,
      startedAt,
      stoppedAt: new Date(startedAt.getTime() + 3_600_000),
      duration: 7200,
      playDuration: 100 * minute,
      watched: true,
      mediaType: "MOVIE",
      title: "Untitled",
      sourceSessionId: `s${++sid}`,
      ...over,
    } as Parameters<typeof prisma.playHistory.create>[0]["data"],
    select: { id: true },
  });
}

async function seed() {
  const user = await makeUser();
  const plexA = await serverUser(user.id, "plex", "");
  const plexB = await serverUser(user.id, "plex", "second");
  // tmdb movie, watched on both servers: ONE entry (a tmdbId is global).
  await play(plexA.id, "plex", "", { tmdbId: 603, title: "The Matrix" });
  await play(plexB.id, "plex", "second", { tmdbId: 603, title: "The Matrix" });
  // tmdb episode whose plays carry two titles.
  await play(plexA.id, "plex", "", { tmdbId: 1399, mediaType: "TV", title: "Show", seasonNumber: 1, episodeNumber: 5, episodeTitle: "Episode 5" });
  await play(plexA.id, "plex", "", { tmdbId: 1399, mediaType: "TV", title: "Show", seasonNumber: 1, episodeNumber: 5, episodeTitle: "The Real Title" });
  // Unmatched, same ratingKey on two servers: TWO entries (a sourceItemId is server-local).
  await play(plexA.id, "plex", "", { title: "Home Video A", sourceItemId: "42" });
  await play(plexA.id, "plex", "", { title: "Home Video A", sourceItemId: "42" });
  await play(plexB.id, "plex", "second", { title: "Home Video B", sourceItemId: "42" });
  // Unmatched with no item id: stands alone.
  await play(plexA.id, "plex", "", { title: "Loose Clip" });
  return user;
}

test("every list entry's play count and play time equal its detail view's", async () => {
  const user = await seed();
  const page = await getMyWatchHistory(user.id);
  assert.equal(page.total, 5);
  assert.equal(page.items.length, 5);
  const counts = page.items.map((i) => i.playCount).sort();
  assert.deepEqual(counts, [1, 1, 2, 2, 2]);
  for (const item of page.items) {
    const detail = await getMyWatchHistoryEntry(user.id, item.id);
    assert.ok(detail, item.title);
    assert.equal(detail.item.playCount, item.playCount, item.title);
    assert.equal(detail.item.totalPlaySeconds, item.totalPlaySeconds, item.title);
    assert.equal(detail.plays.length, item.playCount, item.title);
  }
});

test("a search lists the whole group when any play matches, and the total counts the same groups", async () => {
  const user = await seed();
  const page = await getMyWatchHistory(user.id, { search: "real title" });
  assert.equal(page.total, 1);
  assert.equal(page.items.length, 1);
  assert.equal(page.items[0].playCount, 2);
  const detail = await getMyWatchHistoryEntry(user.id, page.items[0].id);
  assert.equal(detail?.item.playCount, 2);
  assert.equal(detail?.item.totalPlaySeconds, page.items[0].totalPlaySeconds);

  const tv = await getMyWatchHistory(user.id, { mediaType: "TV", search: "episode" });
  assert.equal(tv.total, 1);
  assert.equal(tv.items[0].playCount, 2);
});

test("Wrapped: prime day and hour count watched plays, and a blank device never wins the go-to screen", async () => {
  const user = await makeUser();
  const msu = await serverUser(user.id, "plex", "");
  // The blank values are the MOST common: an empty-string-blind filter would pick them.
  await play(msu.id, "plex", "", { tmdbId: 1, device: "", platform: " " });
  await play(msu.id, "plex", "", { tmdbId: 2, device: "", platform: " " });
  await play(msu.id, "plex", "", { tmdbId: 3, device: "Living Room TV", platform: "tvOS" });
  await play(msu.id, "plex", "", { tmdbId: 4, watched: false, device: "Phone" });
  const w = await getWrappedForServerUsers([msu.id], 2025, "UTC");
  assert.equal(w.topDevice, "Living Room TV");
  assert.equal(w.topPlatform, "tvOS");
  // 2025-03-01 was a Saturday; every watched play started in the 20:00 UTC hour.
  assert.equal(w.primeDow, 6);
  assert.equal(w.primeHour, 20);
});
