// The overview's Recent plays rows (src/components/admin/recent-plays/map.ts):
// one mapping for the server's page 1 and the card's "Load more" pages, the
// live-refresh merge past page 1, and the de-duplicating append.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  appendPlays,
  mergeRefreshedPlays,
  toRecentPlay,
  type RecentPlay,
  type RecentPlaySource,
} from "../src/components/admin/recent-plays/map.ts";

const source: RecentPlaySource = {
  id: "p1", source: "plex", serverInstance: "", title: "The Matrix", tmdbId: 603, mediaType: "MOVIE",
  startedAt: new Date("2026-11-01T20:00:00Z"), stoppedAt: new Date("2026-11-01T22:00:00Z"), duration: 7200,
  playDuration: 7000, pausedDuration: 200, watched: true, platform: "Chrome", player: "Plex Web", device: "Mac",
  ipAddress: "10.0.0.5", playMethod: "DirectPlay", resolution: "1080p", videoCodec: "h264", audioCodec: "aac",
  bitrate: 8000, container: "mkv", videoDecision: "directplay", audioDecision: "directplay", seasonNumber: null,
  episodeNumber: null, episodeTitle: null, mediaServerUserId: "msu1",
  mediaServerUser: { username: "alice", source: "plex", thumbUrl: null },
};

test("a Prisma row and an API row map to the same play", () => {
  const fromPrisma = toRecentPlay(source);
  const fromApi = toRecentPlay(JSON.parse(JSON.stringify(source)));
  assert.deepEqual(fromPrisma, fromApi);
  assert.equal(fromPrisma.startedAt, "2026-11-01T20:00:00.000Z");
  assert.equal(fromPrisma.username, "alice");
  assert.equal(fromPrisma.userSource, "plex");
});

test("only the card's fields are picked, never a spread of the whole row", () => {
  const row = { ...source, sourceSessionId: "secret-session", transcodeReason: "x", posterPath: "/a.jpg" };
  const play = toRecentPlay(row);
  assert.equal("sourceSessionId" in play, false);
  assert.equal("transcodeReason" in play, false);
  assert.equal("mediaServerUser" in play, false);
});

test("a play whose user didn't come back is named by the caller's fallback", () => {
  const play = toRecentPlay({ ...source, mediaServerUser: null, stoppedAt: null }, "Unknown");
  assert.equal(play.username, "Unknown");
  assert.equal(play.userSource, "");
  assert.equal(play.stoppedAt, null);
});

const play = (id: string, startedAt: string): RecentPlay => ({ ...toRecentPlay(source), id, startedAt });

test("a refreshed page 1 merges its new plays in the server's order, keeping the loaded pages", () => {
  const prev = [play("c", "2026-11-01T20:00:00Z"), play("b", "2026-11-01T19:00:00Z"), play("a", "2026-11-01T18:00:00Z")];
  const merged = mergeRefreshedPlays(prev, [play("e", "2026-11-01T21:00:00Z"), play("d", "2026-11-01T20:00:00Z"), prev[0]]);
  assert.deepEqual(merged.map((p) => p.id), ["e", "d", "c", "b", "a"], "startedAt desc, then id desc");
  assert.equal(mergeRefreshedPlays(prev, [prev[1]]), prev, "nothing new keeps the same list");
});

test("a further page joins the end without repeating a row", () => {
  const prev = [play("c", "2026-11-01T20:00:00Z"), play("b", "2026-11-01T19:00:00Z")];
  assert.deepEqual(appendPlays(prev, [prev[1], play("a", "2026-11-01T18:00:00Z")]).map((p) => p.id), ["c", "b", "a"]);
});

test("the overview page seeds Recent plays through the card's own mapping and names the statistics zone", () => {
  const page = readFileSync(new URL("../src/app/(app)/admin/activity/page.tsx", import.meta.url), "utf8");
  assert.match(page, /const serializedRecentPlays = recentPlays\.map\(\(p\) => toRecentPlay\(p\)\);/);
  assert.doesNotMatch(page, /userThumb: p\.mediaServerUser\.thumbUrl/, "no second copy of the field list");
  const card = page.slice(page.indexOf("<ActivityRecentPlays"));
  assert.match(card.slice(0, card.indexOf("/>")), /timeZone=\{stats\.timeZone\}/);
});
