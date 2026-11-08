// The pure helpers the play-history aggregate layer is built from (the
// play-history-*.ts modules): SQL literal quoting, the bind collector, the
// capped named-statement runner, the finalize arithmetic, the Statistics and
// heatmap shaping, the /popular ranking statement and the heatmap-cell WHERE.
// The aggregate entry points themselves are pinned by play-history-sql.test,
// activity-stats.test and play-history.test.
import { test } from "node:test";
import assert from "node:assert/strict";
import type { ActiveSession } from "@/generated/prisma";

process.env.TOKEN_ENCRYPTION_KEY = "ab".repeat(32); // prisma.ts pulls in token-crypto

const { prisma } = await import("../src/lib/prisma.ts");
const { shadowPrismaModel, shadowPrismaClientMethod } = await import("./_helpers.mts");
const {
  sqlStringLiteral,
  sqlParams,
  TRANSCODE_REASON_SQL,
  OTHER_REASONS_SQL,
  TRANSCODE_SQL,
  DIRECT_PLAY_SQL,
  DIRECT_STREAM_SQL,
} = await import("../src/lib/play-history-sql-fragments.ts");
const { runCapped, STATS_STATEMENT_CONCURRENCY } = await import("../src/lib/play-history-aggregate.ts");
const { measurePlay, judgePlay, SESSION_COMPLETED_RATIO } = await import("../src/lib/play-history-record.ts");
const { heatmapMargins, arcCompletion } = await import("../src/lib/play-history-stats.ts");
const { heatmapCellWhere, toHeatmapCellDetail } = await import("../src/lib/play-history-calendar.ts");
const { popularRankingStatement, MAX_POPULAR_ROWS } = await import("../src/lib/play-history-popular.ts");
const { idScope, getPlayStatsForServerUsers } = await import("../src/lib/play-history-user-stats.ts");
const { getWrappedForServerUsers } = await import("../src/lib/play-history-wrapped.ts");
const { getMediaPlayStats } = await import("../src/lib/play-history-media-stats.ts");
const reasons = await import("../src/lib/transcode-reasons.ts");
const { PLAY_METHODS } = await import("../src/lib/play-history-filters.ts");

const placeholders = (sql: string) => [...sql.matchAll(/\$(\d+)/g)].map((m) => Number(m[1]));
const settle = () => new Promise((r) => setImmediate(r));

// ── SQL literals ─────────────────────────────────────────────────────────────

test("sqlStringLiteral doubles single quotes, so a label with an apostrophe stays one literal", () => {
  assert.equal(sqlStringLiteral("Transcode"), "'Transcode'");
  assert.equal(sqlStringLiteral("Viewer's choice"), "'Viewer''s choice'");
  assert.equal(sqlStringLiteral("''"), "''''''");
});

test("every constant spliced into the reason and play-method SQL goes through sqlStringLiteral", () => {
  for (const [from, to] of Object.entries(reasons.LEGACY_PLEX_REASON_LABELS)) {
    assert.ok(TRANSCODE_REASON_SQL.includes(`REPLACE(`) && TRANSCODE_REASON_SQL.includes(sqlStringLiteral(from)), from);
    assert.ok(TRANSCODE_REASON_SQL.includes(sqlStringLiteral(to)), to);
  }
  assert.ok(TRANSCODE_REASON_SQL.includes(`THEN ${sqlStringLiteral(reasons.UNKNOWN_REASON)}`));
  assert.equal(OTHER_REASONS_SQL, sqlStringLiteral(reasons.OTHER_REASONS));
  // The literals are the recognised play methods, so the SQL and the list filter agree.
  assert.deepEqual([DIRECT_PLAY_SQL, DIRECT_STREAM_SQL, TRANSCODE_SQL], PLAY_METHODS.map(sqlStringLiteral));
});

// ── binds ────────────────────────────────────────────────────────────────────

test("sqlParams hands out $N in bind order; an empty list renders NULL and binds nothing", () => {
  const p = sqlParams();
  assert.equal(p.bindList([]), "NULL");
  assert.equal(p.bind("first"), "$1");
  assert.equal(p.bindList(["a", "b"]), "$2, $3");
  assert.deepEqual(p.values, ["first", "a", "b"]);
});

test("idScope: the ids first, then the extras, and placeholders that match the params", () => {
  const two = idScope(["a", "b"], "2025-01-01", "UTC");
  assert.deepEqual(two, { idIn: "$1, $2", refs: ["$3", "$4"], params: ["a", "b", "2025-01-01", "UTC"] });
  const none = idScope([], "UTC");
  assert.deepEqual(none, { idIn: "NULL", refs: ["$1"], params: ["UTC"] });
});

// ── the capped runner ────────────────────────────────────────────────────────

test("runCapped returns each statement's result under its own name, starting them in order, at most three at once", async () => {
  const started: string[] = [];
  let inFlight = 0;
  let peak = 0;
  const task = (name: string, value: number) => async () => {
    started.push(name);
    inFlight++;
    peak = Math.max(peak, inFlight);
    await settle();
    inFlight--;
    return value;
  };
  const r = await runCapped({ a: task("a", 1), b: task("b", 2), c: task("c", 3), d: task("d", 4), e: task("e", 5) });
  assert.deepEqual(r, { a: 1, b: 2, c: 3, d: 4, e: 5 });
  assert.deepEqual(started, ["a", "b", "c", "d", "e"]);
  assert.equal(peak, STATS_STATEMENT_CONCURRENCY);
});

// ── finalize arithmetic ──────────────────────────────────────────────────────

const STARTED = new Date("2026-07-01T20:00:00.000Z");
function session(over: Partial<ActiveSession>): ActiveSession {
  return {
    startedAt: STARTED,
    lastSeenAt: new Date(STARTED.getTime() + 60 * 60_000),
    progressMs: 0n,
    startProgressMs: 0n,
    playtimeMs: 0n,
    durationMs: 1_000_000n,
    creditsStartMs: null,
    ...over,
  } as ActiveSession;
}

test("judgePlay: `completed` is the playhead reaching SESSION_COMPLETED_RATIO of the content, whatever the admin's arc threshold", () => {
  assert.equal(SESSION_COMPLETED_RATIO, 0.95);
  const now = new Date();
  const at = (progressMs: bigint) => {
    const s = session({ progressMs, playtimeMs: 900_000n });
    return judgePlay(s, measurePlay(s, now), 80).completed;
  };
  assert.equal(at(950_000n), true, "95% exactly");
  assert.equal(at(949_999n), false);
});

test("measurePlay: the end-of-file clamp snaps a stop within 10 s of the end to the full runtime", () => {
  const now = new Date();
  assert.equal(measurePlay(session({ progressMs: 990_000n }), now).clampedProgressMs, 1_000_000);
  assert.equal(measurePlay(session({ progressMs: 989_999n }), now).clampedProgressMs, 989_999);
});

test("measurePlay: accumulated playtime never exceeds the row's wall-clock span", () => {
  const now = new Date();
  // lastSeenAt is an hour after start, so stoppedAt − startedAt is 3,600 s.
  const over = measurePlay(session({ playtimeMs: 5_400_000n }), now);
  assert.equal(over.playDurationMs, 3_600_000, "90 min of ticks in a 60 min window is capped at 60 min");
  assert.equal(over.playDurationS, 3_600);
  assert.equal(judgePlay(session({}), over, 80).pausedDurationS, 0);
  const under = measurePlay(session({ playtimeMs: 1_200_000n }), now);
  assert.equal(under.playDurationMs, 1_200_000, "playtime inside the window is kept as is");
  const stopped = new Date(STARTED.getTime() + 10 * 60_000);
  assert.equal(
    measurePlay(session({ playtimeMs: 1_200_000n }), now, stopped).playDurationMs,
    600_000,
    "the cap follows an explicit stoppedAt",
  );
});

// ── Statistics shaping ───────────────────────────────────────────────────────

test("heatmapMargins sums the grid into hour and day-of-week totals, in bucket order, empty buckets omitted", () => {
  const m = heatmapMargins([
    { dow: 3, hour: 20, count: 2n },
    { dow: 1, hour: 20, count: 1n },
    { dow: 1, hour: 7, count: 4n },
  ]);
  assert.deepEqual(m.playsByHour, [{ hour: 7, count: 4 }, { hour: 20, count: 3 }]);
  assert.deepEqual(m.playsByDow, [{ dow: 1, count: 5 }, { dow: 3, count: 2 }]);
});

test("arcCompletion: the rate over arcs with a runtime, and the non-empty buckets in label order", () => {
  assert.deepEqual(arcCompletion({ watched: 1n, total: 4n, b0: 0n, b25: 2n, b50: 0n, b75: 2n }), {
    rate: 25,
    buckets: [{ bucket: "25-50%", count: 2 }, { bucket: "75-100%", count: 2 }],
  });
  assert.deepEqual(arcCompletion(undefined), { rate: 0, buckets: [] });
});

// ── heatmap cell ─────────────────────────────────────────────────────────────

test("heatmapCellWhere: a day cell binds the day then the zone; a user-scoped hour cell drops the window", () => {
  const day = heatmapCellWhere({ mode: "day", day: "2026-03-14", source: "plex" }, "Europe/Berlin");
  assert.deepEqual(day.params, ["2026-03-14", "Europe/Berlin", "plex"]);
  assert.deepEqual([...new Set(placeholders(day.where))].sort(), [1, 2, 3]);

  const user = heatmapCellWhere({ mode: "hour", dow: 2, hour: 21, days: 30, userId: "u1" }, "UTC");
  assert.ok(!user.params.some((p) => p instanceof Date), "the per-user grid is all-history");
  assert.deepEqual(user.params, ["UTC", 2, 21, "u1"]);

  const admin = heatmapCellWhere({ mode: "hour", dow: 2, hour: 21, days: 30 }, "UTC");
  assert.ok(admin.params[0] instanceof Date, "the admin grid keeps its window");
});

test("toHeatmapCellDetail: no aggregate row reads as an empty cell, not NaN", () => {
  const d = toHeatmapCellDetail(undefined, { reasons: [], resolutions: [], titles: [], topUserRows: [] });
  assert.equal(d.totalPlays, 0);
  assert.equal(d.completedPct, 0);
  assert.deepEqual(d.methods, { directPlay: 0, directStream: 0, transcode: 0, other: 0 });
  assert.equal(d.dataTransferredGb, 0);
});

// ── /popular ranking statement ───────────────────────────────────────────────

test("popularRankingStatement: every optional push keeps the placeholders in lockstep; the LIMIT is the ranking cap", () => {
  const since = new Date("2026-10-01T00:00:00Z");
  for (const mediaType of [undefined, "MOVIE", "TV"] as const) {
    for (const sort of ["plays", "viewers", "trending"] as const) {
      const { sql, params } = popularRankingStatement({ mediaType, sort, completionRatio: 0.9, arcGapSeconds: 1209600, trendingSince: since });
      const used = new Set(placeholders(sql));
      assert.deepEqual([...used].sort((a, b) => a - b), params.map((_, i) => i + 1), `${mediaType}/${sort}`);
      assert.equal(params[params.length - 1], MAX_POPULAR_ROWS);
      assert.equal(params.includes(since), sort === "trending");
      assert.doesNotMatch(sql, /OFFSET/);
    }
  }
});

// ── per-person and per-title bundles: the pool cap ───────────────────────────

let inFlight = 0;
let peakInFlight = 0;
let hold: Promise<void> | null = null;
const track = async <T,>(value: T): Promise<T> => {
  inFlight++;
  peakInFlight = Math.max(peakInFlight, inFlight);
  try {
    if (hold) await hold;
    return value;
  } finally {
    inFlight--;
  }
};
shadowPrismaClientMethod(prisma, "$queryRawUnsafe", () => track([]));
shadowPrismaModel(prisma, "playHistory", {
  count: () => track(0),
  findMany: () => track([]),
  findFirst: () => track(null),
});
shadowPrismaModel(prisma, "plexLibraryItem", { findFirst: async () => null });
shadowPrismaModel(prisma, "jellyfinLibraryItem", { findFirst: async () => null });
shadowPrismaModel(prisma, "setting", { findMany: async () => [], findUnique: async () => null });

async function peakOf(load: () => Promise<unknown>): Promise<{ parked: number; peak: number }> {
  inFlight = 0;
  peakInFlight = 0;
  let release!: () => void;
  hold = new Promise<void>((r) => { release = r; });
  const run = load();
  let parked = 0;
  try {
    for (let i = 0; i < 20; i++) await settle();
    parked = inFlight;
  } finally {
    hold = null;
    release();
  }
  await run;
  return { parked, peak: peakInFlight };
}

test("the per-person stats, Wrapped and per-title bundles keep at most three statements in flight (the pool holds five)", async () => {
  for (const [label, load] of [
    ["getPlayStatsForServerUsers", () => getPlayStatsForServerUsers(["msu-1"], "UTC")],
    ["getWrappedForServerUsers", () => getWrappedForServerUsers(["msu-1"], 2025, "UTC")],
    ["getMediaPlayStats", () => getMediaPlayStats(603, "MOVIE")],
  ] as const) {
    const { parked, peak } = await peakOf(load);
    assert.equal(parked, STATS_STATEMENT_CONCURRENCY, `${label}: parked at the cap — the fan-out did start`);
    assert.equal(peak, STATS_STATEMENT_CONCURRENCY, `${label}: never more than the cap at once`);
  }
});

// ── the per-title recent plays and the now-playing snapshot ──────────────────

test("getMediaPlayStats reads only the recent-play columns the media page shows — never the IP or the marker columns", async () => {
  let args: { select?: Record<string, unknown>; include?: unknown } | null = null;
  shadowPrismaModel(prisma, "playHistory", {
    count: async () => 0,
    findMany: async (a: { select?: Record<string, unknown>; include?: unknown }) => { args = a; return []; },
    findFirst: async () => null,
  });
  await getMediaPlayStats(604, "MOVIE");
  assert.ok(args, "the recent plays were read");
  const read = args as { select?: Record<string, unknown>; include?: unknown };
  assert.equal(read.include, undefined, "a whole-row include");
  assert.ok(read.select, "an explicit select");
  for (const column of ["ipAddress", "introStartMs", "creditsEndMs", "audioCodec", "posterPath"]) {
    assert.equal(column in read.select, false, column);
  }
  for (const column of ["id", "watched", "platform", "duration", "playDuration", "startedAt", "mediaServerUser"]) {
    assert.ok(column in read.select, column);
  }
});

test("emitActiveSessionsSnapshot: posters come from the shared live lookup (TmdbMediaCore first), and the payload carries numbers and an ISO start", async () => {
  const { emitActiveSessionsSnapshot } = await import("../src/lib/play-history-snapshot.ts");
  const { sseEmitter } = await import("../src/lib/sse-emitter.ts");
  shadowPrismaModel(prisma, "activeSession", {
    findMany: async () => [{
      id: "plex:k1", source: "plex", state: "playing", mediaServerUserId: "msu-1", serverUsername: "alice",
      title: "Shogun", tmdbId: 126308, mediaType: "TV", year: "2024", seasonNumber: 1, episodeNumber: 2,
      episodeTitle: "Servants of Two Masters", progressPercent: 40, progressMs: 1_200_000n, durationMs: 3_000_000n,
      platform: "Roku", player: "Plex", device: "Roku", ipAddress: "10.0.0.2", startedAt: STARTED,
      playMethod: "DirectPlay", videoCodec: "hevc", audioCodec: "eac3", resolution: "4k", bitrate: 20000,
      videoDecision: "directplay", audioDecision: "directplay", container: "mkv", location: "lan", bandwidth: 21000,
      secure: true, relayed: false, introStartMs: null, introEndMs: null, creditsStartMs: null, creditsEndMs: null,
    }],
  });
  shadowPrismaModel(prisma, "tmdbMediaCore", {
    findMany: async () => [{ tmdbId: 126308, mediaType: "TV", posterPath: "/shogun.jpg" }],
  });
  shadowPrismaModel(prisma, "tmdbCache", { findMany: async () => [] });
  const events: Array<{ type: string; sessions?: Array<Record<string, unknown>> }> = [];
  const listener = (e: { type: string; sessions?: Array<Record<string, unknown>> }) => events.push(e);
  sseEmitter.on("event", listener);
  try {
    await emitActiveSessionsSnapshot();
  } finally {
    sseEmitter.off("event", listener);
  }
  const s = events.find((e) => e.type === "activity:sessions")?.sessions?.[0];
  assert.ok(s, "one session in the payload");
  assert.equal(s.posterUrl, "https://image.tmdb.org/t/p/w342/shogun.jpg");
  assert.equal(s.progressMs, 1_200_000);
  assert.equal(s.durationMs, 3_000_000);
  assert.equal(s.startedAt, STARTED.toISOString());
  assert.equal(s.episodeTitle, "Servants of Two Masters");
});
