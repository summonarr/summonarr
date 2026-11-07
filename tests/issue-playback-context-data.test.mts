// The playback-context loader (src/lib/issue-playback-context-data.ts): which
// of the reporter's plays an issue snapshots. The pure picker is pinned in
// tests/issue-playback-context.test.mts; this pins what the loader READS, over
// an in-memory playHistory that applies the query's own where/orderBy/take.
//
// Pinned: a reporter who watched past the reported episode (more newer plays
// than the recent read holds) still gets the exact episode's play, exact:true,
// when it is inside the window — and a season issue its season's; a whole-title
// issue makes one read; no read selects a network identifier (guardrail 5j).
process.env.TOKEN_ENCRYPTION_KEY = "ab".repeat(32);

import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";

const { prisma } = await import("../src/lib/prisma.ts");
const { shadowPrismaModel } = await import("./_helpers.mts");
const { loadPlaybackContext } = await import("../src/lib/issue-playback-context-data.ts");
const { PLAYBACK_CONTEXT_CANDIDATES, PLAYBACK_CONTEXT_WINDOW_DAYS } = await import("../src/lib/issue-playback-context.ts");

const NOW = new Date("2026-10-31T12:00:00Z");
const daysAgo = (d: number) => new Date(NOW.getTime() - d * 86_400_000);

type Play = {
  id: string; mediaServerUserId: string; tmdbId: number; mediaType: string;
  source: string; startedAt: Date; stoppedAt: Date; seasonNumber: number | null; episodeNumber: number | null;
  platform: string | null; player: string | null; device: string | null; playMethod: string | null;
  videoDecision: string | null; audioDecision: string | null; videoCodec: string | null; audioCodec: string | null;
  resolution: string | null; container: string | null; bitrate: number | null; transcodeReason: string | null;
  location: string | null; relayed: boolean | null; ipAddress: string | null;
};
let plays: Play[] = [];
let seq = 0;
function play(over: Partial<Play>): Play {
  const stoppedAt = over.stoppedAt ?? daysAgo(1);
  return {
    id: `p${++seq}`, mediaServerUserId: "msu-1", tmdbId: 1396, mediaType: "TV",
    source: "plex", startedAt: new Date(stoppedAt.getTime() - 3_600_000), stoppedAt, seasonNumber: 1, episodeNumber: 1,
    platform: "Roku", player: "other", device: "Roku Ultra", playMethod: "DirectPlay",
    videoDecision: "direct play", audioDecision: "direct play", videoCodec: "h264", audioCodec: "aac",
    resolution: "1080", container: "mkv", bitrate: 8000, transcodeReason: null,
    location: "lan", relayed: false, ipAddress: "203.0.113.9", ...over,
  };
}

type FindArgs = {
  where: {
    mediaServerUserId: { in: string[] }; tmdbId: number; mediaType: string; stoppedAt: { gte: Date };
    seasonNumber?: number; episodeNumber?: number;
  };
  orderBy: Record<string, "asc" | "desc">;
  take: number;
  select: Record<string, boolean>;
};
const reads: FindArgs[] = [];

shadowPrismaModel(prisma, "user", { findUnique: async () => ({ plexUserId: null, jellyfinUserId: null }) });
shadowPrismaModel(prisma, "mediaServerUser", { findMany: async () => [{ id: "msu-1" }] });
shadowPrismaModel(prisma, "playHistory", {
  findMany: async (args: FindArgs) => {
    reads.push(args);
    const w = args.where;
    const [key] = Object.keys(args.orderBy) as Array<"startedAt" | "stoppedAt">;
    const dir = args.orderBy[key] === "asc" ? 1 : -1;
    return plays
      .filter((r) =>
        w.mediaServerUserId.in.includes(r.mediaServerUserId) && r.tmdbId === w.tmdbId && r.mediaType === w.mediaType &&
        r.stoppedAt >= w.stoppedAt.gte &&
        (w.seasonNumber === undefined || r.seasonNumber === w.seasonNumber) &&
        (w.episodeNumber === undefined || r.episodeNumber === w.episodeNumber))
      .sort((a, b) => dir * (a[key].getTime() - b[key].getTime()))
      .slice(0, args.take)
      .map((r) => Object.fromEntries(Object.keys(args.select).map((k) => [k, r[k as keyof Play]])));
  },
});

beforeEach(() => {
  plays = [];
  reads.length = 0;
});

const title = { tmdbId: 1396, mediaType: "TV" as const };

test("an episode issue gets the exact episode's play although more than a recent read's worth of newer plays came after it", async () => {
  // Binged S1E4..S1E33 after S1E3: every one newer than the play reported on.
  for (let e = 4; e < 4 + PLAYBACK_CONTEXT_CANDIDATES + 5; e++) plays.push(play({ episodeNumber: e, stoppedAt: daysAgo(10 - e / 10) }));
  plays.push(play({ episodeNumber: 3, stoppedAt: daysAgo(20), player: "exact" }));
  plays.push(play({ episodeNumber: 3, stoppedAt: daysAgo(30), player: "exact-earlier" }));

  const ctx = await loadPlaybackContext("reporter-1", title, { scope: "EPISODE", seasonNumber: 1, episodeNumber: 3 }, NOW);
  assert.equal(ctx?.player, "exact");
  assert.equal(ctx?.exact, true);
  assert.equal(reads.length, 2, "the recent plays and the episode's own newest");
});

test("a season issue gets its season's play past a binge of another season; out of the window it is still not found", async () => {
  for (let e = 1; e <= PLAYBACK_CONTEXT_CANDIDATES + 5; e++) plays.push(play({ seasonNumber: 2, episodeNumber: e, stoppedAt: daysAgo(5 - e / 10) }));
  plays.push(play({ seasonNumber: 1, episodeNumber: 7, stoppedAt: daysAgo(30), player: "season-one" }));
  const ctx = await loadPlaybackContext("reporter-1", title, { scope: "SEASON", seasonNumber: 1, episodeNumber: null }, NOW);
  assert.deepEqual([ctx?.player, ctx?.exact], ["season-one", true]);

  // The window still bounds it: an older season-1 play is not "what they just saw".
  plays = plays.filter((p) => p.seasonNumber !== 1);
  plays.push(play({ seasonNumber: 1, episodeNumber: 7, stoppedAt: daysAgo(PLAYBACK_CONTEXT_WINDOW_DAYS + 1), player: "too-old" }));
  const old = await loadPlaybackContext("reporter-1", title, { scope: "SEASON", seasonNumber: 1, episodeNumber: null }, NOW);
  assert.notEqual(old?.player, "too-old");
  assert.equal(old?.exact, false, "falls back to a play of the title");
});

test("a whole-title issue makes one read; no read selects a network identifier", async () => {
  plays.push(play({ player: "newest", stoppedAt: daysAgo(1) }), play({ player: "older", stoppedAt: daysAgo(3) }));
  const ctx = await loadPlaybackContext("reporter-1", title, { scope: "FULL", seasonNumber: null, episodeNumber: null }, NOW);
  assert.deepEqual([ctx?.player, ctx?.exact], ["newest", true]);
  assert.equal(reads.length, 1);

  await loadPlaybackContext("reporter-1", title, { scope: "EPISODE", seasonNumber: 1, episodeNumber: 1 }, NOW);
  for (const r of reads) {
    assert.equal(r.select.ipAddress, undefined, "never the IP (guardrail 5j)");
    assert.equal(r.select.location, true, "lan/wan/relay only");
  }
  assert.ok(!JSON.stringify(ctx).includes("203.0.113.9"));
});
