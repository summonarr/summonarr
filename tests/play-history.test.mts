// Unit tests for the pure/stubable surface of src/lib/play-history.ts — the
// live-session finalize pipeline and its helpers. The live poller/SSE finalize
// is the SOLE writer of Jellyfin play history (CLAUDE.md guardrail 19), so the
// contracts pinned here are load-bearing for the whole activity feature:
//
//  - calculateWatched: the watched decision is `>=` on the percent ratio (the
//    exact-threshold session counts), and a zero/negative total duration is
//    never watched — the denominator guard against bad upstream metadata.
//  - computePlaytimeIncrement: only the "playing" prior state accumulates,
//    zero/backward deltas contribute nothing, and any single delta clamps at
//    MAX_PLAYTIME_DELTA_MS — the per-event guard against missed events,
//    machine sleep, or clock skew inflating playtime.
//  - applyFinalTick: folds the final increment into playtimeMs WITHOUT
//    touching lastSeenAt. recordCompletedSession's ActiveSession deleteMany is
//    a CAS on lastSeenAt against the value the caller read — mutating it here
//    would make the CAS never match and strand finalized sessions for 30 min
//    (the do-NOT-overwrite contract documented on the function).
//  - appendPlayHistoryFilter: the single source of truth for the dynamic
//    source/mediaType SQL suffix. Placeholders MUST start at
//    $(baseParams.length+1) and stay contiguous with the params array — the
//    803cd11 $1-offset bug class (CLAUDE.md: "the dynamic SQL builder starts
//    parameters at $1, not $2") is pinned dead across every filter combo,
//    including the zero-base-params case that shipped broken once.
//  - Setting-backed getters: exact-string "true" gating, per-source key
//    routing, range-validated integers with documented defaults (watched 80,
//    completion 90, arc gap 14), and the 15s TTL + in-flight coalescing (one
//    Setting.findMany serves every getter).
//  - resolveShowTmdbId: source-native show key → tmdbId via the cached
//    library tables, TV-scoped, null for empty/unmapped keys, and no
//    cross-source table bleed.
//  - resolveMediaServerUser: advisory-lock serialization (namespace 2020,
//    31-bit-masked FNV-1a key — Postgres has no (int, bigint) overload),
//    normalized-email User linking that never links deactivated or
//    other-server accounts, the dormant serverMachineId binding check
//    (MediaServerMismatchError), and set-only isServerAdmin — an update may
//    promote false→true but NEVER demote.
//  - recordCompletedSession: the `${sessionKey}:${startedAt.toISOString()}`
//    dedup key + createMany({ skipDuplicates: true }) — with the backfill
//    crons gone this is the WHOLE dedup story (guardrail 19) — plus the
//    lastSeenAt CAS delete, the sub-90s drop, the wall-clock cap on the
//    progressMs fallback (a seek-to-credits-and-quit can't mint watch time),
//    the Tautulli-style 10s end-of-file clamp, credits-aware
//    watched/completed, resume-group chaining, poster resolution from
//    TmdbCache (never the session's own posterPath), lookup-failure
//    degradation, and the SSE emission contract (skipSSE for batch callers).
//  - reanchorActiveSessionsOnBoot (guardrail 21): once-per-process promise
//    memo — concurrent boot callers share ONE updateMany — and a failed write
//    releases the memo so the next caller retries instead of leaving rows
//    exposed to the stale-anchor finalize.
//
// No DB or network: the shared extended client's model delegates and
// $transaction are shadowed in-memory (tests/_helpers.mts patterns). Date.now
// is wrapped with a forward-only offset purely to expire the module's 15s
// settings cache between configs; `new Date()` — the module's wall-clock
// source — intentionally stays on the real clock. console.warn/error are
// captured: warns are asserted where the module documents them, and a final
// test pins that nothing here ever console.errors (guardrail 7 silence).
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import type { ActiveSession } from "@/generated/prisma";

process.env.TOKEN_ENCRYPTION_KEY = "ab".repeat(32); // prisma.ts pulls in token-crypto

// ── console capture ─────────────────────────────────────────────────────────
const warns: string[] = [];
const errors: string[] = [];
console.warn = (...args: unknown[]) => { warns.push(args.map(String).join(" ")); };
console.error = (...args: unknown[]) => { errors.push(args.map(String).join(" ")); };

// ── forward-only clock offset (settings-cache TTL control) ──────────────────
const realDateNow = Date.now.bind(Date);
let clockOffsetMs = 0;
Date.now = () => realDateNow() + clockOffsetMs;

// ── module graph (dynamic imports so the stubs above precede it) ────────────
const { prisma } = await import("../src/lib/prisma.ts");
const { shadowPrismaModel, shadowPrismaClientMethod } = await import("./_helpers.mts");
const { sseEmitter } = await import("../src/lib/sse-emitter.ts");
const {
  MAX_PLAYTIME_DELTA_MS,
  MediaServerMismatchError,
  appendPlayHistoryFilter,
  applyFinalTick,
  calculateWatched,
  computePlaytimeIncrement,
  getArcGapDays,
  getCompletionThreshold,
  getWatchedThreshold,
  isPlayHistoryEnabled,
  isSourceEnabled,
  purgeOldHistory,
  reanchorActiveSessionsOnBoot,
  recordCompletedSession,
  resolveMediaServerUser,
  resolveShowTmdbId,
} = await import("../src/lib/play-history.ts");

// ── prisma stubs ────────────────────────────────────────────────────────────

// Setting.findMany (loadSettings). setSettings swaps the config AND advances
// the stubbed clock past the module's 15s TTL so the next getter re-fetches.
let settingsRows: Record<string, string> = {};
let settingFindManyCalls = 0;
shadowPrismaModel(prisma, "setting", {
  findMany: async () => {
    settingFindManyCalls++;
    return Object.entries(settingsRows).map(([key, value]) => ({ key, value }));
  },
});
function setSettings(rows: Record<string, string>): void {
  settingsRows = rows;
  clockOffsetMs += 16_000; // SETTINGS_CACHE_TTL is 15s — expire the cached config
}

type LibArgs = { where: Record<string, unknown>; select?: Record<string, unknown> };
const plexLibCalls: LibArgs[] = [];
let plexLibRow: { tmdbId: number | null } | null = null;
shadowPrismaModel(prisma, "plexLibraryItem", {
  findFirst: async (args: LibArgs) => {
    plexLibCalls.push(args);
    return plexLibRow;
  },
});
const jellyfinLibCalls: LibArgs[] = [];
let jellyfinLibRow: { tmdbId: number | null } | null = null;
shadowPrismaModel(prisma, "jellyfinLibraryItem", {
  findFirst: async (args: LibArgs) => {
    jellyfinLibCalls.push(args);
    return jellyfinLibRow;
  },
});

const activeSessionDeletes: Array<{ where: Record<string, unknown> }> = [];
let activeSessionDeleteError: Error | null = null;
const activeSessionUpdateManyCalls: Array<{ data: { lastSeenAt: Date } }> = [];
let activeSessionUpdateManyError: Error | null = null;
shadowPrismaModel(prisma, "activeSession", {
  deleteMany: async (args: { where: Record<string, unknown> }) => {
    activeSessionDeletes.push(args);
    if (activeSessionDeleteError) throw activeSessionDeleteError;
    return { count: 1 };
  },
  updateMany: async (args: { data: { lastSeenAt: Date } }) => {
    activeSessionUpdateManyCalls.push(args);
    if (activeSessionUpdateManyError) throw activeSessionUpdateManyError;
    return { count: 3 };
  },
  findMany: async () => [], // emitActiveSessionsSnapshot on the non-skipSSE path
});

type HistoryCreateArgs = { data: Array<Record<string, unknown>>; skipDuplicates?: boolean };
const historyCreates: HistoryCreateArgs[] = [];
const historyFindFirstCalls: Array<Record<string, unknown>> = [];
let priorUnwatchedRow: { id: string; referenceId: string | null } | null = null;
let historyFindFirstError = false;
const historyDeleteManyCalls: Array<{ where: { startedAt: { lt: Date } } }> = [];
let historyDeleteCount = 0;
shadowPrismaModel(prisma, "playHistory", {
  createMany: async (args: HistoryCreateArgs) => {
    historyCreates.push(args);
    return { count: args.data.length };
  },
  findFirst: async (args: Record<string, unknown>) => {
    historyFindFirstCalls.push(args);
    if (historyFindFirstError) throw new Error("history lookup down");
    return priorUnwatchedRow;
  },
  deleteMany: async (args: { where: { startedAt: { lt: Date } } }) => {
    historyDeleteManyCalls.push(args);
    return { count: historyDeleteCount };
  },
});

const tmdbCacheFindCalls: Array<{ where: { key: string } }> = [];
let tmdbCacheRow: { data: string } | null = null;
let tmdbCacheError = false;
shadowPrismaModel(prisma, "tmdbCache", {
  findUnique: async (args: { where: { key: string } }) => {
    tmdbCacheFindCalls.push(args);
    if (tmdbCacheError) throw new Error("cache down");
    return tmdbCacheRow;
  },
  findMany: async () => [], // snapshot poster batch (unused: no sessions)
});

// $transaction: run the callback against an in-memory tx facade.
type UserRow = { id: string; mediaServer: string | null; deactivatedAt: Date | null };
type MsuUpsertArgs = {
  where: { source_sourceUserId: { source: string; sourceUserId: string } };
  create: Record<string, unknown>;
  update: Record<string, unknown>;
};
const lockSqls: string[] = [];
const userFindCalls: Array<{ where: { email: string } }> = [];
let userRow: UserRow | null = null;
const msuFindCalls: Array<Record<string, unknown>> = [];
let msuExisting: { id: string; serverMachineId: string | null } | null = null;
const msuUpserts: MsuUpsertArgs[] = [];
let txOptions: unknown;
const txStub = {
  $executeRawUnsafe: async (sql: string) => {
    lockSqls.push(sql);
    return 0;
  },
  user: {
    findUnique: async (args: { where: { email: string } }) => {
      userFindCalls.push(args);
      return userRow;
    },
  },
  mediaServerUser: {
    findUnique: async (args: Record<string, unknown>) => {
      msuFindCalls.push(args);
      return msuExisting;
    },
    upsert: async (args: MsuUpsertArgs) => {
      msuUpserts.push(args);
      return { id: "msu-row-1" };
    },
  },
};
shadowPrismaClientMethod(
  prisma,
  "$transaction",
  async (fn: (tx: typeof txStub) => Promise<unknown>, opts?: unknown) => {
    txOptions = opts;
    return fn(txStub);
  },
);

// SSE capture — one listener for the whole file.
const sseEvents: Array<{ type: string; sessions?: unknown[] }> = [];
sseEmitter.on("event", (e: { type: string; sessions?: unknown[] }) => sseEvents.push(e));

beforeEach(() => {
  plexLibCalls.length = 0;
  jellyfinLibCalls.length = 0;
  plexLibRow = null;
  jellyfinLibRow = null;
  activeSessionDeletes.length = 0;
  activeSessionDeleteError = null;
  activeSessionUpdateManyCalls.length = 0;
  activeSessionUpdateManyError = null;
  historyCreates.length = 0;
  historyFindFirstCalls.length = 0;
  priorUnwatchedRow = null;
  historyFindFirstError = false;
  historyDeleteManyCalls.length = 0;
  historyDeleteCount = 0;
  tmdbCacheFindCalls.length = 0;
  tmdbCacheRow = null;
  tmdbCacheError = false;
  lockSqls.length = 0;
  userFindCalls.length = 0;
  userRow = null;
  msuFindCalls.length = 0;
  msuExisting = null;
  msuUpserts.length = 0;
  txOptions = undefined;
  sseEvents.length = 0;
  warns.length = 0;
  // NOTE: `errors` is deliberately never reset — the last test pins that the
  // module stays console.error-silent across the entire file (guardrail 7).
});

// ActiveSession factory — every scalar the generated model carries, with a
// representative Plex movie session as the base.
const BASE_STARTED_AT = new Date("2026-07-01T20:00:00.000Z");
function makeSession(overrides: Partial<ActiveSession> = {}): ActiveSession {
  return {
    id: "plex:key-1",
    source: "plex",
    sessionKey: "key-1",
    startedAt: BASE_STARTED_AT,
    lastSeenAt: new Date(BASE_STARTED_AT.getTime() + 40 * 60_000),
    state: "playing",
    mediaServerUserId: "msu-1",
    serverUsername: "alice",
    tmdbId: 550,
    mediaType: "MOVIE",
    title: "Fight Club",
    year: "1999",
    seasonNumber: null,
    episodeNumber: null,
    episodeTitle: null,
    sourceItemId: "item-1",
    posterPath: null,
    progressPercent: 83,
    progressMs: 2_000_000n,
    progressUpdatedAt: BASE_STARTED_AT,
    playtimeMs: 2_000_000n,
    durationMs: 2_400_000n,
    platform: "Roku",
    player: "Plex for Roku",
    device: "Roku Ultra",
    ipAddress: "192.168.1.50",
    playMethod: "DirectPlay",
    videoCodec: "h264",
    audioCodec: "aac",
    resolution: "1080",
    bitrate: 8000,
    videoDecision: "directplay",
    audioDecision: "directplay",
    container: "mkv",
    transcodeReason: null,
    location: "lan",
    bandwidth: 9000,
    secure: true,
    relayed: false,
    introStartMs: null,
    introEndMs: null,
    creditsStartMs: null,
    creditsEndMs: null,
    ...overrides,
  };
}

// ═══ calculateWatched ═══════════════════════════════════════════════════════

test("calculateWatched: the threshold boundary is >= — exact hit counts, one ms below does not", () => {
  assert.equal(calculateWatched(800_000, 1_000_000, 80), true); // exactly 80%
  assert.equal(calculateWatched(799_999, 1_000_000, 80), false); // 79.9999%
  assert.equal(calculateWatched(800_001, 1_000_000, 80), true);
  // Threshold 100 demands the full duration to the millisecond.
  assert.equal(calculateWatched(1_000_000, 1_000_000, 100), true);
  assert.equal(calculateWatched(999_999, 1_000_000, 100), false);
});

test("calculateWatched: zero or negative total duration is never watched, at any threshold", () => {
  assert.equal(calculateWatched(500_000, 0, 80), false);
  assert.equal(calculateWatched(500_000, 0, 0), false); // even a 0% threshold
  assert.equal(calculateWatched(500_000, -5_000, 0), false);
});

test("calculateWatched: threshold 0 marks any non-negative playback; overshoot past 100% counts; negative play does not", () => {
  assert.equal(calculateWatched(0, 1_000_000, 0), true); // 0 >= 0
  assert.equal(calculateWatched(1_200_000, 1_000_000, 80), true); // 120% (looped credits etc.)
  assert.equal(calculateWatched(-1, 1_000_000, 0), false); // negative ratio < 0
});

// ═══ computePlaytimeIncrement ═══════════════════════════════════════════════

test("computePlaytimeIncrement: a playing session accumulates the exact wall-clock delta as bigint", () => {
  const lastSeenAt = new Date("2026-07-01T20:00:00.000Z");
  const inc = computePlaytimeIncrement(
    { state: "playing", lastSeenAt },
    new Date(lastSeenAt.getTime() + 5_000),
  );
  assert.equal(typeof inc, "bigint");
  assert.equal(inc, 5_000n);
  assert.equal(
    computePlaytimeIncrement({ state: "playing", lastSeenAt }, new Date(lastSeenAt.getTime() + 1)),
    1n,
  );
});

test("computePlaytimeIncrement: pause/buffer/other prior states contribute nothing regardless of elapsed time", () => {
  const lastSeenAt = new Date("2026-07-01T20:00:00.000Z");
  const later = new Date(lastSeenAt.getTime() + 60_000);
  assert.equal(computePlaytimeIncrement({ state: "paused", lastSeenAt }, later), 0n);
  assert.equal(computePlaytimeIncrement({ state: "buffering", lastSeenAt }, later), 0n);
  assert.equal(computePlaytimeIncrement({ state: "stopped", lastSeenAt }, later), 0n);
});

test("computePlaytimeIncrement: zero and backward deltas contribute nothing (clock skew safety)", () => {
  const lastSeenAt = new Date("2026-07-01T20:00:00.000Z");
  assert.equal(computePlaytimeIncrement({ state: "playing", lastSeenAt }, lastSeenAt), 0n);
  assert.equal(
    computePlaytimeIncrement({ state: "playing", lastSeenAt }, new Date(lastSeenAt.getTime() - 1)),
    0n,
  );
});

test("computePlaytimeIncrement: a single delta clamps at MAX_PLAYTIME_DELTA_MS (5 min) — the sleep/skew guard", () => {
  assert.equal(MAX_PLAYTIME_DELTA_MS, 5 * 60 * 1000); // the guard's advertised size
  const lastSeenAt = new Date("2026-07-01T20:00:00.000Z");
  const at = (deltaMs: number) =>
    computePlaytimeIncrement({ state: "playing", lastSeenAt }, new Date(lastSeenAt.getTime() + deltaMs));
  assert.equal(at(MAX_PLAYTIME_DELTA_MS - 1), BigInt(MAX_PLAYTIME_DELTA_MS - 1));
  assert.equal(at(MAX_PLAYTIME_DELTA_MS), BigInt(MAX_PLAYTIME_DELTA_MS));
  assert.equal(at(MAX_PLAYTIME_DELTA_MS + 1), BigInt(MAX_PLAYTIME_DELTA_MS)); // clamped
  assert.equal(at(8 * 60 * 60 * 1000), BigInt(MAX_PLAYTIME_DELTA_MS)); // laptop slept overnight
});

// ═══ applyFinalTick ═════════════════════════════════════════════════════════

test("applyFinalTick: folds the increment into playtimeMs, preserves lastSeenAt (the CAS reference), and never mutates the input", () => {
  const session = makeSession({ state: "playing", playtimeMs: 10_000n });
  const now = new Date(session.lastSeenAt.getTime() + 5_000);
  const result = applyFinalTick(session, now);
  assert.equal(result.playtimeMs, 15_000n);
  // The CAS contract: recordCompletedSession deletes with the lastSeenAt the
  // caller READ. A fabricated "now" here would make the CAS never match.
  assert.equal(result.lastSeenAt, session.lastSeenAt);
  assert.equal(result.progressMs, session.progressMs); // untouched without an override
  assert.notEqual(result, session); // a new object…
  assert.equal(session.playtimeMs, 10_000n); // …and the input is unchanged
});

test("applyFinalTick: a paused session and a zero delta both leave playtimeMs unchanged", () => {
  const paused = makeSession({ state: "paused", playtimeMs: 10_000n });
  assert.equal(
    applyFinalTick(paused, new Date(paused.lastSeenAt.getTime() + 90_000)).playtimeMs,
    10_000n,
  );
  const playing = makeSession({ state: "playing", playtimeMs: 10_000n });
  assert.equal(applyFinalTick(playing, playing.lastSeenAt).playtimeMs, 10_000n);
});

test("applyFinalTick: progressMs override applies when provided (including 0n), stays untouched when absent, and the increment clamps", () => {
  const session = makeSession({ state: "playing", playtimeMs: 1_000n, progressMs: 2_000_000n });
  const now = new Date(session.lastSeenAt.getTime() + 30 * 60_000); // 30 min gap → clamp
  const overridden = applyFinalTick(session, now, { progressMs: 2_345_678n });
  assert.equal(overridden.progressMs, 2_345_678n);
  assert.equal(overridden.playtimeMs, 1_000n + BigInt(MAX_PLAYTIME_DELTA_MS)); // clamped fold
  // 0n is a real override — the guard is `!== undefined`, not truthiness.
  assert.equal(applyFinalTick(session, now, { progressMs: 0n }).progressMs, 0n);
  assert.equal(applyFinalTick(session, now, {}).progressMs, 2_000_000n);
  assert.equal(applyFinalTick(session, now, { progressMs: undefined }).progressMs, 2_000_000n);
});

// ═══ appendPlayHistoryFilter ════════════════════════════════════════════════

function placeholderIndices(sql: string): number[] {
  return [...sql.matchAll(/\$(\d+)/g)].map((m) => Number(m[1]));
}

test("appendPlayHistoryFilter: no recognized filters → empty suffix and a fresh copy of baseParams", () => {
  const base = [new Date("2026-01-01T00:00:00.000Z")];
  const { sql, params } = appendPlayHistoryFilter(base, {});
  assert.equal(sql, "");
  assert.deepEqual(params, base);
  assert.notEqual(params, base); // callers push onto the result — must not alias the input
  assert.equal(base.length, 1); // and the input is never mutated
});

test("appendPlayHistoryFilter: with ZERO base params the placeholders start at $1 — the 803cd11 offset bug pinned dead", () => {
  // getActivityCalendarUncached binds no params before this suffix; the shipped
  // bug was this exact path starting at $2.
  const src = appendPlayHistoryFilter([], { source: "plex" });
  assert.equal(src.sql, ` AND "source" = $1`);
  assert.deepEqual(src.params, ["plex"]);

  const mt = appendPlayHistoryFilter([], { mediaType: "TV" });
  assert.equal(mt.sql, ` AND "mediaType"::text = $1`);
  assert.deepEqual(mt.params, ["TV"]);
});

test("appendPlayHistoryFilter: source then mediaType bind contiguous $1,$2 in clause order", () => {
  const { sql, params } = appendPlayHistoryFilter([], { source: "jellyfin", mediaType: "MOVIE" });
  assert.equal(sql, ` AND "source" = $1 AND "mediaType"::text = $2`);
  assert.deepEqual(params, ["jellyfin", "MOVIE"]);
});

test("appendPlayHistoryFilter: existing base params shift the indices — SQL and params stay in lockstep", () => {
  const cutoff = new Date("2026-06-01T00:00:00.000Z");
  const { sql, params } = appendPlayHistoryFilter([cutoff, "already-bound"], {
    source: "plex",
    mediaType: "TV",
  });
  assert.equal(sql, ` AND "source" = $3 AND "mediaType"::text = $4`);
  assert.deepEqual(params, [cutoff, "already-bound", "plex", "TV"]);
});

test("appendPlayHistoryFilter: values outside the whitelist are ignored, never interpolated", () => {
  for (const opts of [
    { source: "emby" },
    { source: "Plex" }, // case-sensitive whitelist
    { source: "" },
    { mediaType: "movie" }, // enum casing matters
    { mediaType: "MUSIC" },
    { source: "plex'; DROP TABLE", mediaType: "TV'; --" },
  ]) {
    const { sql, params } = appendPlayHistoryFilter(["base"], opts);
    assert.equal(sql, "", `expected ${JSON.stringify(opts)} to be ignored`);
    assert.deepEqual(params, ["base"]);
  }
});

test("appendPlayHistoryFilter: tableAlias namespaces the columns for JOIN queries; placeholder audit across combos", () => {
  const aliased = appendPlayHistoryFilter([], { source: "plex", mediaType: "MOVIE", tableAlias: "p" });
  assert.equal(aliased.sql, ` AND p."source" = $1 AND p."mediaType"::text = $2`);

  // Property sweep: for every combination, placeholder indices are exactly
  // baseParams.length+1 … params.length (contiguous, ascending), and the base
  // params ride through untouched at the front.
  const combos: Array<{ base: unknown[]; opts: Parameters<typeof appendPlayHistoryFilter>[1] }> = [
    { base: [], opts: {} },
    { base: [], opts: { source: "plex" } },
    { base: [], opts: { mediaType: "TV" } },
    { base: [], opts: { source: "jellyfin", mediaType: "MOVIE" } },
    { base: [new Date()], opts: { source: "plex", mediaType: "TV" } },
    { base: ["a", "b", "c"], opts: { source: "jellyfin" } },
    { base: ["a", "b", "c"], opts: { source: "plex", mediaType: "MOVIE", tableAlias: "p" } },
  ];
  for (const { base, opts } of combos) {
    const { sql, params } = appendPlayHistoryFilter(base, opts);
    const appended = params.length - base.length;
    const indices = placeholderIndices(sql);
    assert.deepEqual(
      indices,
      Array.from({ length: appended }, (_, i) => base.length + 1 + i),
      `placeholders out of lockstep for base=${base.length} opts=${JSON.stringify(opts)}`,
    );
    assert.deepEqual(params.slice(0, base.length), base);
  }
});

// ═══ Setting-backed getters ═════════════════════════════════════════════════

test("settings getters: everything unset → documented defaults, served by ONE Setting.findMany (15s TTL cache)", async () => {
  setSettings({});
  const before = settingFindManyCalls;
  assert.equal(await isPlayHistoryEnabled(), false);
  assert.equal(await isSourceEnabled("plex"), false);
  assert.equal(await isSourceEnabled("jellyfin"), false);
  assert.equal(await getWatchedThreshold(), 80);
  assert.equal(await getCompletionThreshold(), 90);
  assert.equal(await getArcGapDays(), 14);
  assert.equal(settingFindManyCalls - before, 1); // six getters, one round-trip
});

test("settings getters: the exact string 'true' enables, and each source reads its OWN key", async () => {
  setSettings({ playHistoryEnabled: "true", playHistoryPlexEnabled: "true" });
  assert.equal(await isPlayHistoryEnabled(), true);
  assert.equal(await isSourceEnabled("plex"), true);
  assert.equal(await isSourceEnabled("jellyfin"), false); // its key is unset

  setSettings({ playHistoryJellyfinEnabled: "true" });
  assert.equal(await isSourceEnabled("jellyfin"), true);
  assert.equal(await isSourceEnabled("plex"), false);
});

test("settings getters: non-canonical truthy spellings do not enable ('TRUE', '1', ' true')", async () => {
  setSettings({
    playHistoryEnabled: "TRUE",
    playHistoryPlexEnabled: "1",
    playHistoryJellyfinEnabled: " true",
  });
  assert.equal(await isPlayHistoryEnabled(), false);
  assert.equal(await isSourceEnabled("plex"), false);
  assert.equal(await isSourceEnabled("jellyfin"), false);
});

test("threshold getters: range floors and ceilings are accepted verbatim (watched/completion 0–100, arc gap 1–365)", async () => {
  setSettings({
    playHistoryWatchedThreshold: "0",
    playHistoryCompletionThreshold: "100",
    playHistoryArcGapDays: "1",
  });
  assert.equal(await getWatchedThreshold(), 0);
  assert.equal(await getCompletionThreshold(), 100);
  assert.equal(await getArcGapDays(), 1);

  setSettings({
    playHistoryWatchedThreshold: "100",
    playHistoryCompletionThreshold: "0",
    playHistoryArcGapDays: "365",
  });
  assert.equal(await getWatchedThreshold(), 100);
  assert.equal(await getCompletionThreshold(), 0);
  assert.equal(await getArcGapDays(), 365);
});

test("threshold getters: out-of-range and junk values fall back to the defaults (80/90/14)", async () => {
  setSettings({
    playHistoryWatchedThreshold: "101",
    playHistoryCompletionThreshold: "-1",
    playHistoryArcGapDays: "0", // arc gap floor is 1, not 0
  });
  assert.equal(await getWatchedThreshold(), 80);
  assert.equal(await getCompletionThreshold(), 90);
  assert.equal(await getArcGapDays(), 14);

  setSettings({
    playHistoryWatchedThreshold: "abc",
    playHistoryCompletionThreshold: "", // empty string reads as unset
    playHistoryArcGapDays: "366",
  });
  assert.equal(await getWatchedThreshold(), 80);
  assert.equal(await getCompletionThreshold(), 90);
  assert.equal(await getArcGapDays(), 14);

  // parseInt truncation is CURRENT behavior: "55.9" → 55, "90px" → 90.
  setSettings({ playHistoryWatchedThreshold: "55.9", playHistoryCompletionThreshold: "90px" });
  assert.equal(await getWatchedThreshold(), 55);
  assert.equal(await getCompletionThreshold(), 90);
});

test("settings getters: concurrent callers after a cache expiry coalesce onto one in-flight findMany", async () => {
  setSettings({ playHistoryWatchedThreshold: "42" });
  const before = settingFindManyCalls;
  const [watched, completion, enabled] = await Promise.all([
    getWatchedThreshold(),
    getCompletionThreshold(),
    isPlayHistoryEnabled(),
  ]);
  assert.equal(watched, 42);
  assert.equal(completion, 90);
  assert.equal(enabled, false);
  assert.equal(settingFindManyCalls - before, 1);
});

// ═══ resolveShowTmdbId ══════════════════════════════════════════════════════

test("resolveShowTmdbId: empty show keys resolve to null without touching either library table", async () => {
  assert.equal(await resolveShowTmdbId("plex", null), null);
  assert.equal(await resolveShowTmdbId("plex", undefined), null);
  assert.equal(await resolveShowTmdbId("jellyfin", ""), null);
  assert.equal(plexLibCalls.length, 0);
  assert.equal(jellyfinLibCalls.length, 0);
});

test("resolveShowTmdbId: plex keys map via PlexLibraryItem, TV-scoped, and never touch the Jellyfin table", async () => {
  plexLibRow = { tmdbId: 1399 };
  assert.equal(await resolveShowTmdbId("plex", "rk-1399"), 1399);
  assert.equal(plexLibCalls.length, 1);
  assert.deepEqual(plexLibCalls[0].where, { plexRatingKey: "rk-1399", mediaType: "TV" });
  assert.equal(jellyfinLibCalls.length, 0);

  // Unmapped: a row without a tmdbId and no row at all both read as null.
  plexLibRow = { tmdbId: null };
  assert.equal(await resolveShowTmdbId("plex", "rk-unmapped"), null);
  plexLibRow = null;
  assert.equal(await resolveShowTmdbId("plex", "rk-missing"), null);
});

test("resolveShowTmdbId: jellyfin keys map via JellyfinLibraryItem and never touch the Plex table", async () => {
  jellyfinLibRow = { tmdbId: 66732 };
  assert.equal(await resolveShowTmdbId("jellyfin", "jf-item-1"), 66732);
  assert.equal(jellyfinLibCalls.length, 1);
  assert.deepEqual(jellyfinLibCalls[0].where, { jellyfinItemId: "jf-item-1", mediaType: "TV" });
  assert.equal(plexLibCalls.length, 0);
});

// ═══ resolveMediaServerUser ═════════════════════════════════════════════════

test("MediaServerMismatchError: a real Error subclass carrying the (source, sourceUserId) identity", () => {
  const err = new MediaServerMismatchError("plex", "u-9");
  assert.ok(err instanceof Error);
  assert.equal(err.name, "MediaServerMismatchError");
  assert.equal(err.source, "plex");
  assert.equal(err.sourceUserId, "u-9");
  assert.match(err.message, /plex:u-9 bound to a different server/);
});

test("resolveMediaServerUser: minimal upsert — advisory lock in namespace 2020 with a 31-bit key, no user lookup without an email, no binding pre-check without a machineId", async () => {
  const id = await resolveMediaServerUser({ source: "plex", sourceUserId: "u-1", username: "alice" });
  assert.equal(id, "msu-row-1");
  assert.deepEqual(txOptions, { timeout: 15_000 });

  // Advisory lock: pg_advisory_xact_lock(int, int) — the key MUST be masked
  // into the signed-int32 positive range or Postgres rejects the overload.
  assert.equal(lockSqls.length, 1);
  const m = lockSqls[0].match(/^SELECT pg_advisory_xact_lock\(2020, (\d+)\)$/);
  assert.ok(m, `unexpected lock statement: ${lockSqls[0]}`);
  const key = Number(m![1]);
  assert.ok(Number.isInteger(key) && key >= 0 && key <= 0x7fffffff, `lock key out of int32 range: ${key}`);

  // Deterministic per (source, sourceUserId); distinct identities get distinct keys.
  await resolveMediaServerUser({ source: "plex", sourceUserId: "u-1", username: "alice" });
  await resolveMediaServerUser({ source: "plex", sourceUserId: "u-2", username: "bob" });
  const keys = lockSqls.map((s) => Number(s.match(/\((\d+), (\d+)\)/)![2]));
  assert.equal(keys[0], keys[1]);
  assert.notEqual(keys[0], keys[2]);

  assert.equal(userFindCalls.length, 0); // no email → no User lookup
  assert.equal(msuFindCalls.length, 0); // no machineId → no binding pre-check
  assert.deepEqual(msuUpserts[0].where, { source_sourceUserId: { source: "plex", sourceUserId: "u-1" } });
  // Exact create/update shapes: deepEqual pins key ABSENCE too — no
  // isServerAdmin key may appear when the caller didn't send one.
  assert.deepEqual(msuUpserts[0].create, {
    source: "plex",
    sourceUserId: "u-1",
    username: "alice",
    email: null,
    thumbUrl: null,
    userId: null,
    serverMachineId: null,
  });
  assert.deepEqual(msuUpserts[0].update, { username: "alice" });
});

test("resolveMediaServerUser: emails are normalized once and used for BOTH the User lookup and the stored column; an active same-server user links", async () => {
  userRow = { id: "user-7", mediaServer: "PLEX", deactivatedAt: null }; // case-insensitive server match
  await resolveMediaServerUser({
    source: "plex",
    sourceUserId: "u-2",
    username: "Bob",
    email: "  Bob@Example.COM ",
    thumbUrl: "https://plex.tv/thumb.png",
  });
  assert.equal(userFindCalls.length, 1);
  assert.deepEqual(userFindCalls[0].where, { email: "bob@example.com" }); // NFKC+lowercase+trim
  assert.deepEqual(msuUpserts[0].create, {
    source: "plex",
    sourceUserId: "u-2",
    username: "Bob",
    email: "bob@example.com", // normalized copy is what round-trips later lookups
    thumbUrl: "https://plex.tv/thumb.png",
    userId: "user-7",
    serverMachineId: null,
  });
  assert.deepEqual(msuUpserts[0].update, {
    username: "Bob",
    email: "bob@example.com",
    thumbUrl: "https://plex.tv/thumb.png",
    userId: "user-7",
  });
});

test("resolveMediaServerUser: deactivated accounts and other-server accounts are NEVER linked", async () => {
  // Admin-deactivated account keeps its email — fresh watches must not attribute to it.
  userRow = { id: "user-8", mediaServer: null, deactivatedAt: new Date("2026-01-01T00:00:00.000Z") };
  await resolveMediaServerUser({ source: "plex", sourceUserId: "u-3", username: "carol", email: "carol@example.com" });
  assert.equal(msuUpserts[0].create.userId, null);
  assert.ok(!("userId" in msuUpserts[0].update), "update must not carry a userId for a deactivated account");

  // A user pinned to jellyfin must not be linked by a plex identity with the same email.
  userRow = { id: "user-9", mediaServer: "jellyfin", deactivatedAt: null };
  await resolveMediaServerUser({ source: "plex", sourceUserId: "u-4", username: "dave", email: "dave@example.com" });
  assert.equal(msuUpserts[1].create.userId, null);
  assert.ok(!("userId" in msuUpserts[1].update));
});

test("resolveMediaServerUser: a serverMachineId mismatch throws MediaServerMismatchError before any upsert; first-seen and matching machineIds proceed", async () => {
  msuExisting = { id: "row-1", serverMachineId: "machine-A" };
  await assert.rejects(
    resolveMediaServerUser({
      source: "plex",
      sourceUserId: "u-5",
      username: "eve",
      serverMachineId: "machine-B",
    }),
    (err: unknown) => {
      assert.ok(err instanceof MediaServerMismatchError);
      assert.equal(err.source, "plex");
      assert.equal(err.sourceUserId, "u-5");
      return true;
    },
  );
  assert.equal(msuUpserts.length, 0); // the hijack attempt never reaches the write
  assert.ok(
    warns.some((w) => w.includes("[play-history] refusing MediaServerUser upsert")),
    "the refusal must warn with the [play-history] scope",
  );

  // A row that never recorded a machineId accepts the first one offered…
  msuExisting = { id: "row-1", serverMachineId: null };
  await resolveMediaServerUser({ source: "plex", sourceUserId: "u-5", username: "eve", serverMachineId: "machine-B" });
  assert.equal(msuUpserts[0].create.serverMachineId, "machine-B");
  assert.equal(msuUpserts[0].update.serverMachineId, "machine-B");
  // …and the same machineId keeps working.
  msuExisting = { id: "row-1", serverMachineId: "machine-B" };
  await resolveMediaServerUser({ source: "plex", sourceUserId: "u-5", username: "eve", serverMachineId: "machine-B" });
  assert.equal(msuUpserts.length, 2);
});

test("resolveMediaServerUser: isServerAdmin is set-only — create records false, but an update may only ever promote to true", async () => {
  await resolveMediaServerUser({ source: "plex", sourceUserId: "u-6", username: "frank", isServerAdmin: false });
  assert.equal(msuUpserts[0].create.isServerAdmin, false);
  assert.ok(
    !("isServerAdmin" in msuUpserts[0].update),
    "false must NEVER demote an existing admin row (token rotation / fresh-client transients)",
  );

  await resolveMediaServerUser({ source: "plex", sourceUserId: "u-6", username: "frank", isServerAdmin: true });
  assert.equal(msuUpserts[1].create.isServerAdmin, true);
  assert.equal(msuUpserts[1].update.isServerAdmin, true);
});

// ═══ recordCompletedSession ═════════════════════════════════════════════════

test("recordCompletedSession: writes the full PlayHistory row via createMany({skipDuplicates}) keyed sessionKey:startedAt, then CAS-deletes the ActiveSession (guardrail 19)", async () => {
  setSettings({}); // watched threshold default 80
  tmdbCacheRow = { data: JSON.stringify({ posterPath: "/fc.jpg" }) };
  const session = makeSession(); // 2 000 000 ms played of 2 400 000 ms → 83.3%
  await recordCompletedSession(session, { skipSSE: true });

  assert.equal(historyCreates.length, 1);
  assert.equal(historyCreates[0].skipDuplicates, true); // INSERT … ON CONFLICT DO NOTHING — the whole dedup story
  assert.equal(historyCreates[0].data.length, 1);
  assert.deepEqual(historyCreates[0].data[0], {
    source: "plex",
    startedAt: session.startedAt,
    stoppedAt: session.lastSeenAt, // lastSeenAt > startedAt → it is the stop anchor
    duration: 2400,
    playDuration: 2000,
    pausedDuration: 400, // 40 min wall − 33:20 played
    watched: true, // 83.3% ≥ 80
    completed: false, // 83.3% < 95
    mediaServerUserId: "msu-1",
    tmdbId: 550,
    mediaType: "MOVIE",
    title: "Fight Club",
    year: "1999",
    posterPath: "/fc.jpg", // resolved from TmdbCache, raw path
    seasonNumber: null,
    episodeNumber: null,
    episodeTitle: null,
    sourceSessionId: "key-1:2026-07-01T20:00:00.000Z", // sessionKey + startedAt — unique per watch instance
    sourceItemId: "item-1",
    platform: "Roku",
    player: "Plex for Roku",
    device: "Roku Ultra",
    ipAddress: "192.168.1.50",
    playMethod: "DirectPlay",
    videoCodec: "h264",
    audioCodec: "aac",
    resolution: "1080",
    bitrate: 8000,
    videoDecision: "directplay",
    audioDecision: "directplay",
    container: "mkv",
    transcodeReason: null,
    location: "lan",
    bandwidth: 9000,
    secure: true,
    relayed: false,
    introStartMs: null,
    introEndMs: null,
    creditsStartMs: null,
    creditsEndMs: null,
    referenceId: null,
  });
  assert.equal(tmdbCacheFindCalls[0].where.key, "movie:550:details");

  // The delete is a CAS on the lastSeenAt the caller read — never a blind id delete.
  assert.equal(activeSessionDeletes.length, 1);
  assert.deepEqual(activeSessionDeletes[0].where, { id: "plex:key-1", lastSeenAt: session.lastSeenAt });
});

test("recordCompletedSession: sub-90s watches are dropped with no history row — but STILL CAS-delete the ActiveSession; 90s exactly is kept", async () => {
  setSettings({});
  const short = makeSession({
    playtimeMs: 89_999n, // floors to 89s < MIN_PLAY_DURATION_S
    progressMs: 0n,
    lastSeenAt: new Date(BASE_STARTED_AT.getTime() + 89_999),
  });
  await recordCompletedSession(short, { skipSSE: true });
  assert.equal(historyCreates.length, 0);
  assert.equal(historyFindFirstCalls.length, 0); // dropped before any downstream lookup
  assert.equal(tmdbCacheFindCalls.length, 0);
  assert.deepEqual(activeSessionDeletes[0].where, { id: short.id, lastSeenAt: short.lastSeenAt });

  const exact = makeSession({
    playtimeMs: 90_000n,
    progressMs: 0n,
    lastSeenAt: new Date(BASE_STARTED_AT.getTime() + 90_000),
  });
  await recordCompletedSession(exact, { skipSSE: true });
  assert.equal(historyCreates.length, 1);
  assert.equal(historyCreates[0].data[0].playDuration, 90);
  assert.equal(historyCreates[0].data[0].watched, false); // 90s of a 40-min file
});

test("recordCompletedSession: a seek-to-credits quit is completed (playhead) but NOT watched (wall-clock-capped play time)", async () => {
  setSettings({});
  // 5 minutes of wall time, then a seek to 4s-from-end and quit. progressMs is a
  // POSITION, not elapsed time — the fallback must not credit 2h of watching.
  const session = makeSession({
    durationMs: 7_200_000n,
    progressMs: 7_195_000n, // within the 10s end-of-file window → clamps to full duration
    playtimeMs: 0n,
    lastSeenAt: new Date(BASE_STARTED_AT.getTime() + 300_000),
  });
  await recordCompletedSession(session, { skipSSE: true });
  const row = historyCreates[0].data[0];
  assert.equal(row.duration, 7200);
  assert.equal(row.playDuration, 300); // capped at the 5-min wall window
  assert.equal(row.pausedDuration, 0);
  assert.equal(row.watched, false); // 300s / 7200s ≪ 80%
  assert.equal(row.completed, true); // playhead reached the end (clamped ratio 1.0 ≥ 0.95)
});

test("recordCompletedSession: the 10s end-of-file clamp boundary — duration−10s snaps to a full watch, one ms further out does not", async () => {
  setSettings({ playHistoryWatchedThreshold: "100" }); // makes the clamp observable in `watched`
  const clamped = makeSession({
    durationMs: 3_600_000n,
    progressMs: 3_590_000n, // exactly duration − 10 000 → >= boundary → clamped
    playtimeMs: 0n,
    lastSeenAt: new Date(BASE_STARTED_AT.getTime() + 3_600_000),
  });
  await recordCompletedSession(clamped, { skipSSE: true });
  assert.equal(historyCreates[0].data[0].playDuration, 3600);
  assert.equal(historyCreates[0].data[0].watched, true); // clamped to 100% of the file
  assert.equal(historyCreates[0].data[0].completed, true);

  const unclamped = makeSession({
    durationMs: 3_600_000n,
    progressMs: 3_589_999n, // 10 001 ms from the end → NOT clamped
    playtimeMs: 0n,
    lastSeenAt: new Date(BASE_STARTED_AT.getTime() + 3_600_000),
  });
  await recordCompletedSession(unclamped, { skipSSE: true });
  assert.equal(historyCreates[1].data[0].playDuration, 3589); // floor of the raw playhead
  assert.equal(historyCreates[1].data[0].watched, false); // 99.72% < 100
  assert.equal(historyCreates[1].data[0].completed, true); // 0.997 ≥ 0.95 either way
});

test("recordCompletedSession: a credits marker moves the watched/completed goalposts to the content end; invalid markers fall back to file duration", async () => {
  setSettings({}); // threshold 80
  // 50 min of content + 5 min of credits: 40:50 played is 81.7% of the CONTENT
  // (watched) but only 74.2% of the credit-inclusive file (would not be).
  const creditsAware = makeSession({
    durationMs: 3_300_000n,
    creditsStartMs: 3_000_000,
    playtimeMs: 2_450_000n,
    progressMs: 2_450_000n,
    lastSeenAt: new Date(BASE_STARTED_AT.getTime() + 3_000_000),
  });
  await recordCompletedSession(creditsAware, { skipSSE: true });
  assert.equal(historyCreates[0].data[0].watched, true);
  assert.equal(historyCreates[0].data[0].completed, false); // 0.817 < 0.95
  assert.equal(historyCreates[0].data[0].creditsStartMs, 3_000_000); // marker stamped through

  // A marker beyond the file duration is bogus → the file duration governs.
  const bogusMarker = makeSession({
    durationMs: 3_300_000n,
    creditsStartMs: 3_400_000,
    playtimeMs: 2_450_000n,
    progressMs: 2_450_000n,
    lastSeenAt: new Date(BASE_STARTED_AT.getTime() + 3_000_000),
  });
  await recordCompletedSession(bogusMarker, { skipSSE: true });
  assert.equal(historyCreates[1].data[0].watched, false); // 74.2% < 80

  // Reaching the credits IS completion: playhead at creditsStart → ratio 1.0.
  const reachedCredits = makeSession({
    durationMs: 3_300_000n,
    creditsStartMs: 3_000_000,
    playtimeMs: 2_450_000n,
    progressMs: 3_000_000n,
    lastSeenAt: new Date(BASE_STARTED_AT.getTime() + 3_100_000),
  });
  await recordCompletedSession(reachedCredits, { skipSSE: true });
  assert.equal(historyCreates[2].data[0].completed, true);
  assert.equal(historyCreates[2].data[0].watched, true);
});

test("recordCompletedSession: opts.stoppedAt wins over lastSeenAt; a degenerate lastSeenAt<=startedAt falls back to now", async () => {
  setSettings({});
  const explicitStop = new Date(BASE_STARTED_AT.getTime() + 3_600_000);
  const session = makeSession({
    playtimeMs: 1_800_000n,
    progressMs: 0n,
    lastSeenAt: new Date(BASE_STARTED_AT.getTime() + 600_000),
  });
  await recordCompletedSession(session, { skipSSE: true, stoppedAt: explicitStop });
  assert.deepEqual(historyCreates[0].data[0].stoppedAt, explicitStop);
  assert.equal(historyCreates[0].data[0].pausedDuration, 3600 - 1800); // elapsed measured to the explicit stop

  // lastSeenAt === startedAt (a first-tick finalize): stoppedAt falls back to
  // the real wall clock. `new Date()` is NOT offset by this file's Date.now
  // stub, so bound it with real Dates.
  const degenerate = makeSession({
    playtimeMs: 120_000n,
    progressMs: 0n,
    lastSeenAt: BASE_STARTED_AT,
  });
  const before = new Date();
  await recordCompletedSession(degenerate, { skipSSE: true });
  const after = new Date();
  const stoppedAt = historyCreates[1].data[0].stoppedAt as Date;
  assert.ok(
    stoppedAt.getTime() >= before.getTime() && stoppedAt.getTime() <= after.getTime(),
    "fallback stoppedAt must be the moment of finalize",
  );
});

test("recordCompletedSession: resume-grouping chains onto the prior unwatched watch — root id first, then the shared referenceId; exact 7-day lookback query", async () => {
  setSettings({});
  const session = makeSession();
  priorUnwatchedRow = { id: "prior-1", referenceId: null }; // the prior row IS the chain root
  await recordCompletedSession(session, { skipSSE: true });
  assert.equal(historyCreates[0].data[0].referenceId, "prior-1");
  assert.deepEqual(historyFindFirstCalls[0], {
    where: {
      source: "plex",
      sourceItemId: "item-1",
      mediaServerUserId: "msu-1",
      watched: false, // a watched prior means the next play is a rewatch, not a resume
      startedAt: {
        gte: new Date(session.lastSeenAt.getTime() - 7 * 24 * 60 * 60 * 1000), // stoppedAt − 7d
        lt: session.startedAt,
      },
    },
    orderBy: { startedAt: "desc" },
    select: { id: true, referenceId: true },
  });

  // A prior row already inside a chain shares its root, not its own id.
  priorUnwatchedRow = { id: "prior-2", referenceId: "chain-root" };
  await recordCompletedSession(makeSession(), { skipSSE: true });
  assert.equal(historyCreates[1].data[0].referenceId, "chain-root");

  // No sourceItemId → no lookup at all, root-less row.
  const lookupsSoFar = historyFindFirstCalls.length;
  await recordCompletedSession(makeSession({ sourceItemId: null }), { skipSSE: true });
  assert.equal(historyFindFirstCalls.length, lookupsSoFar);
  assert.equal(historyCreates[2].data[0].referenceId, null);
});

test("recordCompletedSession: poster comes from the TmdbCache details blob (tv: key for TV), never the session's own posterPath; miss and malformed JSON degrade to null", async () => {
  setSettings({});
  tmdbCacheRow = { data: JSON.stringify({ posterPath: "/got.jpg" }) };
  const tv = makeSession({
    tmdbId: 1399,
    mediaType: "TV",
    seasonNumber: 1,
    episodeNumber: 1,
    episodeTitle: "Winter Is Coming",
    posterPath: "/stale-session-copy.jpg", // must be ignored for the history row
  });
  await recordCompletedSession(tv, { skipSSE: true });
  assert.equal(tmdbCacheFindCalls[0].where.key, "tv:1399:details");
  assert.equal(historyCreates[0].data[0].posterPath, "/got.jpg");

  tmdbCacheRow = { data: "{not json" };
  await recordCompletedSession(makeSession({ posterPath: "/stale.jpg" }), { skipSSE: true });
  assert.equal(historyCreates[1].data[0].posterPath, null); // parse failure swallowed

  const cacheCallsSoFar = tmdbCacheFindCalls.length;
  await recordCompletedSession(makeSession({ tmdbId: null }), { skipSSE: true });
  assert.equal(tmdbCacheFindCalls.length, cacheCallsSoFar); // no id → no lookup
  assert.equal(historyCreates[2].data[0].posterPath, null);
});

test("recordCompletedSession: poster/resume-lookup/cleanup failures all degrade — the history row still lands and the call resolves", async () => {
  setSettings({});
  tmdbCacheError = true;
  historyFindFirstError = true;
  activeSessionDeleteError = new Error("deleteMany down");
  await recordCompletedSession(makeSession(), { skipSSE: true }); // must not reject
  assert.equal(historyCreates.length, 1);
  assert.equal(historyCreates[0].data[0].posterPath, null);
  assert.equal(historyCreates[0].data[0].referenceId, null);
  assert.equal(activeSessionDeletes.length, 1); // attempted, failure swallowed
});

test("recordCompletedSession: skipSSE keeps batch callers silent; the default path emits history-updated then a fresh sessions snapshot", async () => {
  setSettings({});
  await recordCompletedSession(makeSession(), { skipSSE: true });
  assert.equal(sseEvents.length, 0);

  await recordCompletedSession(makeSession());
  assert.deepEqual(
    sseEvents.map((e) => e.type),
    ["activity:history-updated", "activity:sessions"],
  );
  // The snapshot reflects the (now empty) ActiveSession table — the instant
  // now-playing clear that motivated the second emit.
  assert.deepEqual(sseEvents[1].sessions, []);
});

// ═══ reanchorActiveSessionsOnBoot (guardrail 21) ════════════════════════════
// ORDER-DEPENDENT PAIR: the once-guard is module-global for the process, so
// the failure case must run FIRST (a failure releases the memo; a success
// pins it for good).

test("reanchorActiveSessionsOnBoot: a failed updateMany resolves anyway, warns with scope, and releases the memo for a retry", async () => {
  activeSessionUpdateManyError = new Error("db unavailable at boot");
  await reanchorActiveSessionsOnBoot(); // must not reject
  assert.equal(activeSessionUpdateManyCalls.length, 1);
  assert.ok(
    warns.some((w) => w.includes("[play-history] boot re-anchor of ActiveSession.lastSeenAt failed")),
    "the failure must warn with the [play-history] scope",
  );
});

test("reanchorActiveSessionsOnBoot: concurrent boot callers share ONE updateMany, and later calls are no-ops for the process lifetime", async () => {
  await Promise.all([reanchorActiveSessionsOnBoot(), reanchorActiveSessionsOnBoot()]);
  assert.equal(activeSessionUpdateManyCalls.length, 1); // the SSE bootstrap / poller race collapses to one write
  assert.ok(activeSessionUpdateManyCalls[0].data.lastSeenAt instanceof Date);

  await reanchorActiveSessionsOnBoot();
  assert.equal(activeSessionUpdateManyCalls.length, 1); // once per process — restart is the reset
  assert.equal(warns.length, 0);
});

// ═══ purgeOldHistory ════════════════════════════════════════════════════════

test("purgeOldHistory: unset, zero, and negative retention are a no-op that never issues a delete", async () => {
  setSettings({});
  assert.equal(await purgeOldHistory(), 0);
  setSettings({ playHistoryRetentionDays: "0" });
  assert.equal(await purgeOldHistory(), 0);
  setSettings({ playHistoryRetentionDays: "-5" });
  assert.equal(await purgeOldHistory(), 0);
  assert.equal(historyDeleteManyCalls.length, 0);
});

test("purgeOldHistory: a configured retention deletes rows older than now−N days and reports the count", async () => {
  setSettings({ playHistoryRetentionDays: "30" });
  historyDeleteCount = 42;
  const callClock = Date.now(); // the same (offset) clock purgeOldHistory reads
  assert.equal(await purgeOldHistory(), 42);
  assert.equal(historyDeleteManyCalls.length, 1);
  const lt = historyDeleteManyCalls[0].where.startedAt.lt;
  assert.ok(lt instanceof Date);
  assert.ok(
    Math.abs(lt.getTime() - (callClock - 30 * 24 * 60 * 60 * 1000)) < 2_000,
    "cutoff must be 30 days before the moment of the call",
  );
});

// ═══ guardrail-7 silence ════════════════════════════════════════════════════
// `errors` is never reset in beforeEach: every path exercised above must have
// completed without a single console.error (warns are the only sanctioned
// diagnostics, and only on the failure paths asserted individually).

test("the module never console.errors across every path exercised in this file (guardrail 7)", () => {
  assert.deepEqual(errors, []);
});
