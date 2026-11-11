import "server-only";
// Watch sync, Plex ⇄ Jellyfin — the DATA half (prisma + the two servers). The
// rules live in watch-sync.ts; read its header first. Run by the watch-sync
// cron (/api/cron/watch-sync, lock WATCH_SYNC_LOCK_ID) and by the admin page's
// "Run now", always under that one lock.
//
// One run, in two phases, each direction gated by the pair's `direction`:
//   1. PLAN.
//      - Plex → Jellyfin: per pair, read the paired account's Plex history back
//        to its read point minus the overlap (the whole history on a first run)
//        and resolve its plays to Jellyfin item ids (WatchSyncMark, "pending").
//      - Jellyfin → Plex: per pair, read the Jellyfin user's played items back to
//        its read point minus the overlap and resolve them to Plex ratingKeys
//        (WatchSyncPlexMark, "pending").
//      Both ledgers insert with createMany skipDuplicates: an item is planned
//      once per pair, ever. A read point only moves after that direction's plan
//      was queued in full; a failed lookup holds it, so the next run re-reads
//      rather than skipping what it could not place.
//   2. APPLY. Per pair and direction, up to WATCH_SYNC_BATCH pending (or
//      retryable failed) items. The target's own played state is read first and
//      an item already played there is recorded "already" without a write —
//      a Jellyfin mark with datePlayed bumps its PlayCount, and that same check
//      is what stops a mark echoing back the other way.
//
// Plex writes need the Plex account's OWN token (scrobble marks for the token's
// user). PlexServer resolves it per run with the owner's token — plex.ts has
// the endpoints and why. Tokens live only in that per-run object.
//
// Every phase observes the lock's AbortSignal and RETURNS on abort (guardrail 41).

import type { Prisma } from "@/generated/prisma";
import { prisma } from "./prisma";
import { mapLimit } from "./concurrency";
import { getPlexConfig } from "./plex-config";
import { getJellyfinConfig } from "./jellyfin-config";
import {
  getPlexEpisodeKeys,
  getPlexHomeUserToken,
  getPlexMachineId,
  getPlexSharedServerTokens,
  getPlexInProgress,
  getPlexAllInProgress,
  getPlexLibrarySections,
  getPlexUser,
  getPlexUserStates,
  getPlexViewCounts,
  getPlexWatchHistory,
  scrobblePlexItem,
  setPlexProgress,
  type PlexWatchHistory,
} from "./plex";
import {
  getJellyfinEpisodeIds,
  getJellyfinInProgress,
  getJellyfinPlayedSince,
  getJellyfinUserStates,
  markJellyfinPlayed,
  setJellyfinPosition,
} from "./jellyfin";
import { indexPlexRowsByKey } from "./plex-dedupe";
import { processSingleton } from "./process-singleton";
import type { JellyfinPlayedItem, PlexHistoryEntry } from "./upstream-watch";
import {
  WATCH_SYNC_BATCH,
  WATCH_SYNC_FULL_MAX_BATCHES,
  WATCH_SYNC_HISTORY_TRUNCATED_MESSAGE,
  WATCH_SYNC_MAX_ATTEMPTS,
  WATCH_SYNC_PLAN_CHUNK,
  WATCH_SYNC_RUN_BUDGET_MS,
  WATCH_SYNC_STOPPED_MESSAGE,
  chunkReadTo,
  oldestFirst,
  WATCH_SYNC_PROGRESS_MAX_UNITS,
  WATCH_SYNC_FULL_PROGRESS_MAX_UNITS,
  decideProgress,
  isWatchedWithoutResume,
  latestState,
  parseWatchSyncDirection,
  progressUnitKey,
  targetIdsFor,
  indexEpisodes,
  newestPlayedAt,
  newestViewedAt,
  planMarks,
  playsForPair,
  playsFromJellyfin,
  readBackTo,
  safeWatchSyncError,
  seriesNeeded,
  syncsToward,
  type EpisodeIdRow,
  type MarkTargets,
  type PlannedMark,
  type PlexTitle,
  type ProgressState,
  type WatchSyncDirection,
  type WatchSyncMarkStatus,
  type WatchSyncPairInput,
  type WatchSyncPlay,
} from "./watch-sync";

export const WATCH_SYNC_FEATURE_KEY = "feature.admin.watchSync";

// Ledger inserts are idempotent (skipDuplicates) and need no transaction, so
// they are chunked here directly rather than through batchCreateMany, whose
// void return can't report how many rows were new.
const LEDGER_INSERT_CHUNK = 5_000;
// Ids per IN / hasSome lookup. A first run's key lists scale with the account's
// whole history, and past Postgres' 32,766 bind parameters Prisma either refuses
// the query (P2029) or splits it into statements it runs in parallel on one
// connection (guardrail 23c).
export const WATCH_SYNC_KEY_CHUNK = 5_000;
// Concurrent upstream calls while applying one pair's batch.
const APPLY_CONCURRENCY = 4;

export interface WatchSyncDirectionResult {
  // Newly queued items this run.
  queued: number;
  // Plays on the source whose title isn't in that server's library cache.
  unresolved: number;
  // Plays whose title or episode isn't on the target server.
  unmatched: number;
  marked: number;
  already: number;
  missing: number;
  failed: number;
  error?: string;
}

// Resume points copied this run (titles, not copies), per direction.
export interface WatchSyncProgressResult {
  toJellyfin: number;
  toPlex: number;
  failed: number;
  error?: string;
}

export interface WatchSyncPairResult {
  pairId: string;
  // null when the pair's direction doesn't include it.
  toJellyfin: WatchSyncDirectionResult | null;
  toPlex: WatchSyncDirectionResult | null;
  // null when the pair doesn't sync resume points.
  progress: WatchSyncProgressResult | null;
  // A problem with the pair itself (both directions stopped).
  error?: string;
}

export interface WatchSyncRunResult {
  pairs: WatchSyncPairResult[];
  aborted: boolean;
}

export function watchSyncProblems(result: WatchSyncRunResult): number {
  const bad = (d: WatchSyncDirectionResult | null) => d !== null && (d.error !== undefined || d.failed > 0);
  const badProgress = (g: WatchSyncProgressResult | null) => g !== null && (g.error !== undefined || g.failed > 0);
  return result.pairs.filter((p) => p.error !== undefined || bad(p.toJellyfin) || bad(p.toPlex) || badProgress(p.progress)).length;
}

// The pair's errors that are this module's own words.
const PLEX_NOT_CONFIGURED = "Plex server is not configured";
const JELLYFIN_NOT_CONFIGURED = "Jellyfin server is not configured";
const NO_PLEX_ACCESS = "No Plex access for this account — is this Plex server shared with it (or is it a PIN-protected home user)?";

// The owner's plays are held while plex.tv can't say who the owner is (19e);
// the cause, when there is one, says why.
function ownerUnknownMessage(cause: unknown): string {
  const why = cause === null || cause === undefined ? "" : ` (${safeWatchSyncError(cause)})`;
  return `Couldn't identify the Plex server owner this run${why}; will retry`;
}

type PairRow = {
  id: string;
  // Parsed on load: null = an unknown stored value, which syncs nothing.
  direction: WatchSyncDirection | null;
  syncProgress: boolean;
  historyReadTo: Date | null;
  jellyfinReadTo: Date | null;
  plexUser: { source: string; serverInstance: string; sourceUserId: string; isServerAdmin: boolean };
  jellyfinUser: { source: string; serverInstance: string; sourceUserId: string; active: boolean };
};

function emptyDirection(): WatchSyncDirectionResult {
  return { queued: 0, unresolved: 0, unmatched: 0, marked: 0, already: 0, missing: 0, failed: 0 };
}

// The first error a result records wins: later ones are usually its fallout.
function noteError(target: { error?: string } | null | undefined, err: unknown): void {
  if (target && target.error === undefined) target.error = typeof err === "string" ? err : safeWatchSyncError(err);
}

// What the admin page shows while a run is going. Process-wide (guardrail 27a):
// the cron route and "Run now" are different route chunks.
export interface WatchSyncRunState {
  running: boolean;
  startedAt: number | null;
  pairId: string | null;
}
const runState = processSingleton("watch-sync:run-state", (): WatchSyncRunState => ({ running: false, startedAt: null, pairId: null }));

export function watchSyncRunState(): WatchSyncRunState {
  return { ...runState };
}

// `budgetMs` and `plexHistoryMaxItems` are test seams; production always runs
// on WATCH_SYNC_RUN_BUDGET_MS and getPlexWatchHistory's own read cap.
export async function runWatchSync(
  { signal: lockSignal, pairIds, budgetMs = WATCH_SYNC_RUN_BUDGET_MS, plexHistoryMaxItems, full = false }:
    { signal?: AbortSignal; pairIds?: readonly string[]; budgetMs?: number; plexHistoryMaxItems?: number; full?: boolean } = {},
): Promise<WatchSyncRunResult> {
  if (lockSignal?.aborted) return { pairs: [], aborted: true };
  runState.running = true;
  runState.startedAt = Date.now();
  runState.pairId = null;
  try {
    return await runWatchSyncInner(lockSignal, pairIds, budgetMs, plexHistoryMaxItems, full);
  } finally {
    runState.running = false;
    runState.startedAt = null;
    runState.pairId = null;
  }
}

async function loadPairs(pairIds: readonly string[] | undefined): Promise<PairRow[]> {
  const rows = await prisma.watchSyncPair.findMany({
    where: { enabled: true, ...(pairIds ? { id: { in: [...pairIds] } } : {}) },
    select: {
      id: true,
      direction: true,
      syncProgress: true,
      historyReadTo: true,
      jellyfinReadTo: true,
      plexUser: { select: { source: true, serverInstance: true, sourceUserId: true, isServerAdmin: true } },
      jellyfinUser: { select: { source: true, serverInstance: true, sourceUserId: true, active: true } },
    },
    orderBy: { createdAt: "asc" },
  });
  return rows.map((p) => ({ ...p, direction: parseWatchSyncDirection(p.direction) }));
}

function initialResult(p: PairRow): WatchSyncPairResult {
  const toJellyfin = syncsToward(p.direction, "toJellyfin");
  const toPlex = syncsToward(p.direction, "toPlex");
  return {
    pairId: p.id,
    toJellyfin: toJellyfin ? emptyDirection() : null,
    toPlex: toPlex ? emptyDirection() : null,
    progress: p.syncProgress && (toJellyfin || toPlex) ? { toJellyfin: 0, toPlex: 0, failed: 0 } : null,
  };
}

// Why a pair can't run at all, or null. A pair whose rows are not (plex,
// jellyfin) can't come from the admin route, but a hand-edited row must not
// reach a server. Neither may a Jellyfin user who has left the server. A Plex
// account's `active` is NOT checked: nothing ever sets a Plex identity active
// again, so a server removed and re-added under its slug keeps working pairs
// flagged inactive. Removing an instance deletes its pairs instead
// (media-instances route).
function pairProblem(p: PairRow): string | null {
  if (p.plexUser.source !== "plex" || p.jellyfinUser.source !== "jellyfin") return "Pair does not link a Plex account to a Jellyfin user";
  if (!p.jellyfinUser.active) return "Jellyfin user is no longer on the server";
  return null;
}

type StepKey = "toJellyfin" | "toPlex" | "progress";

// A normal run applies one batch (WATCH_SYNC_BATCH) per direction and the next
// run continues. A FULL sync (moving a user between platforms) keeps applying
// until the queue stops yielding finished items — a failed item is retried
// across runs, never spun on here — or the run's budget ends.
// Only the first batch may retry earlier failures; later ones take new pending
// items alone, so a transient error can't burn an item's five attempts in one run.
async function drain(full: boolean, signal: AbortSignal, applyOnce: (pendingOnly: boolean) => Promise<number>): Promise<void> {
  for (let n = 0; n < WATCH_SYNC_FULL_MAX_BATCHES; n++) {
    const finished = await applyOnce(n > 0);
    if (!full || finished === 0 || signal.aborted) return;
  }
}

// One pair's steps: plan and apply each direction, then resume points. A step
// that throws (a database error, say) is that step's error: the pair's other
// steps still run. Returns the steps that ran to the end.
async function runPair(
  p: PairRow,
  r: WatchSyncPairResult,
  plex: PlexServer,
  jellyfin: JellyfinLookups,
  signal: AbortSignal,
  plexHistoryMaxItems: number | undefined,
  full: boolean,
): Promise<Set<StepKey>> {
  const completed = new Set<StepKey>();
  const step = async (key: StepKey, target: { error?: string }, work: () => Promise<void>) => {
    try {
      await work();
      if (!signal.aborted) completed.add(key);
    } catch (err) {
      noteError(target, err);
    }
  };
  const toJellyfin = r.toJellyfin;
  if (toJellyfin) {
    const run: DirectionRun = { pair: p, plex, jellyfin, r: toJellyfin, fail: (e) => noteError(toJellyfin, e), signal };
    await step("toJellyfin", toJellyfin, async () => {
      await planToJellyfin(run, plexHistoryMaxItems);
      if (!signal.aborted) await drain(full, signal, (pendingOnly) => applyToJellyfin(run, pendingOnly));
    });
  }
  const toPlex = r.toPlex;
  if (toPlex && !signal.aborted) {
    const run: DirectionRun = { pair: p, plex, jellyfin, r: toPlex, fail: (e) => noteError(toPlex, e), signal };
    await step("toPlex", toPlex, async () => {
      await planToPlex(run);
      if (!signal.aborted) await drain(full, signal, (pendingOnly) => applyToPlex(run, pendingOnly));
    });
  }
  // After the played-state apply, so a title just marked watched reads as
  // watched here (watched beats in-progress).
  const progress = r.progress;
  if (progress && !signal.aborted) await step("progress", progress, () => syncProgress(p, plex, jellyfin, progress, signal, full));
  return completed;
}

// Whatever didn't finish says so — on the pair, in the result and (by the
// route) in the log. What did finish was queued and recorded as it went.
function markUnfinished(results: Iterable<WatchSyncPairResult>, completed: ReadonlyMap<string, ReadonlySet<StepKey>>): void {
  for (const r of results) {
    if (r.error !== undefined) continue;
    const done = completed.get(r.pairId);
    for (const key of ["toJellyfin", "toPlex", "progress"] as const) {
      const target = r[key];
      if (target && !done?.has(key)) target.error ??= WATCH_SYNC_STOPPED_MESSAGE;
    }
  }
}

// A plain JSON copy of a result for the lastResult column (undefined fields dropped).
function toJsonValue(r: WatchSyncPairResult): Prisma.InputJsonValue {
  return JSON.parse(JSON.stringify(r)) as Prisma.InputJsonValue;
}

// Recorded per pair for the admin page. Best-effort: a failed write must not
// turn a run that marked items into an error. updateMany: a pair an admin
// removed during the run is simply gone.
async function recordPairResults(pairs: readonly WatchSyncPairResult[]): Promise<void> {
  const now = new Date();
  for (const r of pairs) {
    await prisma.watchSyncPair
      .updateMany({ where: { id: r.pairId }, data: { lastRunAt: now, lastResult: toJsonValue(r) } })
      .catch((err) => console.error("[watch-sync] could not record a pair's result:", safeWatchSyncError(err)));
  }
}

async function runWatchSyncInner(
  lockSignal: AbortSignal | undefined,
  pairIds: readonly string[] | undefined,
  budgetMs: number,
  plexHistoryMaxItems: number | undefined,
  full: boolean,
): Promise<WatchSyncRunResult> {
  // The run's own budget, below the lock's timeout: on it the run stops between
  // steps, records what it did and says it will continue (never a silent stop).
  const budget = AbortSignal.timeout(budgetMs);
  const signal = lockSignal ? AbortSignal.any([lockSignal, budget]) : budget;

  const pairs = await loadPairs(pairIds);
  if (pairs.length === 0) return { pairs: [], aborted: false };
  const results = new Map<string, WatchSyncPairResult>(pairs.map((p) => [p.id, initialResult(p)]));

  const jellyfin = new JellyfinLookups(signal);
  const plexServers = new Map<string, PlexServer>();
  const plexServer = (slug: string) => {
    let s = plexServers.get(slug);
    if (!s) { s = new PlexServer(slug, signal); plexServers.set(slug, s); }
    return s;
  };

  // A pair's steps finish before the next pair starts, so a run that stops on
  // its budget leaves earlier pairs fully done and the rest continuing next
  // run. A failure that hits every step shows on every pair, so the run still
  // reads as degraded.
  const valid = pairs.filter((p) => {
    const problem = pairProblem(p);
    if (problem) noteError(results.get(p.id), problem);
    return problem === null;
  });
  const completed = new Map<string, Set<StepKey>>();
  for (const p of valid) {
    if (signal.aborted) break;
    runState.pairId = p.id;
    completed.set(p.id, await runPair(p, results.get(p.id)!, plexServer(p.plexUser.serverInstance), jellyfin, signal, plexHistoryMaxItems, full));
  }
  if (signal.aborted) markUnfinished(results.values(), completed);

  const done = finish(results, signal.aborted);
  await recordPairResults(done.pairs);
  return done;
}

function finish(results: Map<string, WatchSyncPairResult>, aborted: boolean): WatchSyncRunResult {
  return { pairs: [...results.values()], aborted };
}

async function queueMarks(
  marks: readonly PlannedMark[],
  insert: (chunk: readonly PlannedMark[]) => Promise<number>,
): Promise<number> {
  let queued = 0;
  for (let s = 0; s < marks.length; s += LEDGER_INSERT_CHUNK) queued += await insert(marks.slice(s, s + LEDGER_INSERT_CHUNK));
  return queued;
}

// One IN-list read in WATCH_SYNC_KEY_CHUNK pieces, one after another. No keys,
// no query.
async function readInChunks<T>(keys: readonly string[], read: (chunk: string[]) => Promise<T[]>): Promise<T[]> {
  const out: T[] = [];
  for (let i = 0; i < keys.length; i += WATCH_SYNC_KEY_CHUNK) {
    for (const row of await read(keys.slice(i, i + WATCH_SYNC_KEY_CHUNK))) out.push(row);
  }
  return out;
}

// One direction of one pair in this run: what plan and apply share.
interface DirectionRun {
  pair: PairRow;
  plex: PlexServer;
  jellyfin: JellyfinLookups;
  r: WatchSyncDirectionResult;
  fail: (err: unknown) => void;
  signal: AbortSignal;
}

// One direction's ledger table (WatchSyncMark → Jellyfin item ids,
// WatchSyncPlexMark → Plex ratingKeys) behind one shape, so planning and
// applying are written once for both.
interface MarkLedger {
  // Queue new marks; returns how many were new (skipDuplicates: once per pair, ever).
  insert(pairId: string, marks: readonly PlannedMark[]): Promise<number>;
  // Which of `ids` this sync has already marked on the target: its echo.
  markedAmong(pairId: string, ids: readonly string[]): Promise<Set<string>>;
  // The next batch to apply: pending, or failed and still retryable.
  nextBatch(pairId: string, pendingOnly?: boolean): Promise<Array<{ id: string; datePlayed: Date | null }>>;
  setStatus(pairId: string, ids: string[], status: AppliedStatus): Promise<unknown>;
  // updateMany throughout: a pair removed mid-run took its marks with it.
  setFailed(pairId: string, ids: string[], error: string): Promise<unknown>;
}

const RETRYABLE = [{ status: "pending" }, { status: "failed", attempts: { lt: WATCH_SYNC_MAX_ATTEMPTS } }];

const JELLYFIN_LEDGER: MarkLedger = {
  insert: async (pairId, marks) => (await prisma.watchSyncMark.createMany({
    data: marks.map((m) => ({ pairId, jellyfinItemId: m.targetId, datePlayed: m.datePlayed })),
    skipDuplicates: true,
  })).count,
  markedAmong: async (pairId, ids) => new Set((await readInChunks(ids, (chunk) => prisma.watchSyncMark.findMany({
    where: { pairId, status: "marked", jellyfinItemId: { in: chunk } },
    select: { jellyfinItemId: true },
  }))).map((m) => m.jellyfinItemId)),
  nextBatch: async (pairId, pendingOnly) => (await prisma.watchSyncMark.findMany({
    where: { pairId, ...(pendingOnly ? { status: "pending" } : { OR: RETRYABLE }) },
    select: { jellyfinItemId: true, datePlayed: true },
    orderBy: { createdAt: "asc" },
    take: WATCH_SYNC_BATCH,
  })).map((m) => ({ id: m.jellyfinItemId, datePlayed: m.datePlayed })),
  setStatus: (pairId, ids, status) =>
    prisma.watchSyncMark.updateMany({ where: { pairId, jellyfinItemId: { in: ids } }, data: { status, lastError: null } }),
  setFailed: (pairId, ids, error) => prisma.watchSyncMark.updateMany({
    where: { pairId, jellyfinItemId: { in: ids } },
    data: { status: "failed", attempts: { increment: 1 }, lastError: error },
  }),
};

const PLEX_LEDGER: MarkLedger = {
  insert: async (pairId, marks) => (await prisma.watchSyncPlexMark.createMany({
    data: marks.map((m) => ({ pairId, plexRatingKey: m.targetId, datePlayed: m.datePlayed })),
    skipDuplicates: true,
  })).count,
  markedAmong: async (pairId, ids) => new Set((await readInChunks(ids, (chunk) => prisma.watchSyncPlexMark.findMany({
    where: { pairId, status: "marked", plexRatingKey: { in: chunk } },
    select: { plexRatingKey: true },
  }))).map((m) => m.plexRatingKey)),
  nextBatch: async (pairId, pendingOnly) => (await prisma.watchSyncPlexMark.findMany({
    where: { pairId, ...(pendingOnly ? { status: "pending" } : { OR: RETRYABLE }) },
    select: { plexRatingKey: true, datePlayed: true },
    orderBy: { createdAt: "asc" },
    take: WATCH_SYNC_BATCH,
  })).map((m) => ({ id: m.plexRatingKey, datePlayed: m.datePlayed })),
  setStatus: (pairId, ids, status) =>
    prisma.watchSyncPlexMark.updateMany({ where: { pairId, plexRatingKey: { in: ids } }, data: { status, lastError: null } }),
  setFailed: (pairId, ids, error) => prisma.watchSyncPlexMark.updateMany({
    where: { pairId, plexRatingKey: { in: ids } },
    data: { status: "failed", attempts: { increment: 1 }, lastError: error },
  }),
};

// ── Plex → Jellyfin ──────────────────────────────────────────────────────────

// The paired account's Plex history after its read point, or null when the
// direction can't read it this run (the reason is already on the result).
async function readPairPlexHistory(
  run: DirectionRun,
  maxItems: number | undefined,
): Promise<{ history: PlexWatchHistory; owner: string | null } | null> {
  const { pair, plex, fail, signal } = run;
  const cfg = await plex.config();
  if (!cfg) { fail(PLEX_NOT_CONFIGURED); return null; }
  try {
    const { id: owner, error } = await plex.owner();
    // The owner's plays are recorded under the local account id "1"
    // (normalizePlexAccountId). Unknown owner ⇒ the owner's pair waits rather
    // than reading past those plays.
    if (owner === null && pair.plexUser.isServerAdmin) {
      fail(ownerUnknownMessage(error));
      return null;
    }
    const accountId = pair.plexUser.sourceUserId === owner ? "1" : pair.plexUser.sourceUserId;
    const since = readBackTo(pair.historyReadTo);
    // Only this account's history, only after the read point (Plex-side
    // filters; playsForPair filters again).
    const history = await getPlexWatchHistory(cfg.url, cfg.token, {
      signal,
      accountId,
      ...(since ? { stopBefore: since } : {}),
      ...(maxItems !== undefined ? { maxItems } : {}),
    });
    return { history, owner };
  } catch (err) {
    fail(err);
    return null;
  }
}

async function planToJellyfin(run: DirectionRun, maxItems: number | undefined): Promise<void> {
  const { pair, plex, jellyfin, r, signal } = run;
  const read = await readPairPlexHistory(run, maxItems);
  if (!read) return;
  const { history, owner } = read;
  // A walk the signal cut short is partial: plan none of it (guardrail 41).
  if (history.aborted || signal.aborted) return;
  const entries: PlexHistoryEntry[] = history.entries;

  const input: WatchSyncPairInput = { id: pair.id, plexAccountId: pair.plexUser.sourceUserId, historyReadTo: pair.historyReadTo };
  const keys = new Set<string>();
  for (const e of entries) {
    if (e.kind === "movie") keys.add(e.itemKey);
    else if (e.showKey) keys.add(e.showKey);
  }
  const plexTitleForKey = await plex.titlesFor([...keys]);
  // Plex items this sync marked for the account: their history is our echo.
  const echo = await PLEX_LEDGER.markedAmong(pair.id, [...new Set(entries.map((e) => e.itemKey))]);
  const { plays, unresolved } = playsForPair(entries, input, owner, plexTitleForKey, echo);
  r.unresolved = unresolved;

  const planned = await planInChunks(run, plays, JELLYFIN_LEDGER, "historyReadTo",
    (chunk) => jellyfin.targetsFor(pair.jellyfinUser.serverInstance, chunk));
  // The read stopped at its cap: the oldest plays were never read, and the read
  // point moves past them (19e: say so, never skip silently). Recorded after
  // planning and BESIDE any lookup error (not through noteError, which keeps
  // only the first): a chunk's checkpoint may already have moved the read
  // point, and no later (incremental) read would notice.
  if (history.truncated) {
    r.error = r.error === undefined ? WATCH_SYNC_HISTORY_TRUNCATED_MESSAGE : `${r.error} — ${WATCH_SYNC_HISTORY_TRUNCATED_MESSAGE}`;
  }
  if (!planned || signal.aborted) return;
  // Everything read was planned: the read point is the newest record read,
  // unresolved and echo records included.
  await advance(pair, "historyReadTo", newestViewedAt(entries));
}

// Plan plays oldest first, a chunk at a time: resolve the chunk's targets,
// queue its marks, then move the read point to the chunk's newest play. A
// failed lookup or insert stops planning with the read point where the last
// finished chunk left it. true = every chunk was planned.
async function planInChunks(
  run: DirectionRun,
  plays: readonly WatchSyncPlay[],
  ledger: MarkLedger,
  readPoint: "historyReadTo" | "jellyfinReadTo",
  resolve: (chunk: readonly WatchSyncPlay[]) => Promise<MarkTargets>,
): Promise<boolean> {
  const { pair, r, fail, signal } = run;
  const ordered = oldestFirst(plays);
  for (let i = 0; i < ordered.length; i += WATCH_SYNC_PLAN_CHUNK) {
    if (signal.aborted) return false;
    const chunk = ordered.slice(i, i + WATCH_SYNC_PLAN_CHUNK);
    try {
      const targets = await resolve(chunk);
      if (signal.aborted) return false;
      const plan = planMarks(chunk, targets);
      r.unmatched += plan.unmatched;
      r.queued += await queueMarks(plan.marks, (marks) => ledger.insert(pair.id, marks));
    } catch (err) {
      fail(err);
      return false;
    }
    await advance(pair, readPoint, chunkReadTo(chunk));
  }
  return true;
}

async function advance(pair: PairRow, column: "historyReadTo" | "jellyfinReadTo", readTo: Date | null): Promise<void> {
  const current = pair[column];
  if (!readTo || (current && readTo <= current)) return;
  // updateMany: a pair an admin removed during the run is not an exception.
  await prisma.watchSyncPair.updateMany({ where: { id: pair.id }, data: { [column]: readTo } });
  pair[column] = readTo;
}

async function applyToJellyfin(run: DirectionRun, pendingOnly = false): Promise<number> {
  const { pair, jellyfin, r, fail, signal } = run;
  const batch = await JELLYFIN_LEDGER.nextBatch(pair.id, pendingOnly);
  if (batch.length === 0) return 0;

  const userId = pair.jellyfinUser.sourceUserId;
  let cfg: { url: string; apiKey: string };
  let played: Set<string>;
  try {
    cfg = await jellyfin.config(pair.jellyfinUser.serverInstance);
    if (signal.aborted) return 0;
    // The user's OWN played state for exactly this batch's items. Without it a
    // mark could double a PlayCount; try next run. An item Jellyfin doesn't
    // return is left to the mark, whose 404 records it "missing".
    const states = await getJellyfinUserStates(cfg.url, cfg.apiKey, userId, batch.map((m) => m.id));
    played = new Set<string>();
    for (const [id, s] of states) if (s.played) played.add(id);
  } catch (err) {
    fail(err);
    return 0;
  }
  if (signal.aborted) return 0;
  const { url, apiKey } = cfg;

  const outcome = await applyBatch(batch, signal, (id) => played.has(id),
    (m) => markJellyfinPlayed(url, apiKey, userId, m.id, m.datePlayed));
  await recordOutcome(outcome, r, JELLYFIN_LEDGER, pair.id);
  return outcome.marked.length + outcome.already.length + outcome.missing.length;
}

// ── Jellyfin → Plex ──────────────────────────────────────────────────────────

async function planToPlex(run: DirectionRun): Promise<void> {
  const { pair, plex, jellyfin, r, fail, signal } = run;
  let items: JellyfinPlayedItem[];
  try {
    const cfg = await jellyfin.config(pair.jellyfinUser.serverInstance);
    const since = readBackTo(pair.jellyfinReadTo);
    items = await getJellyfinPlayedSince(cfg.url, cfg.apiKey, pair.jellyfinUser.sourceUserId, since ? { since, signal } : { signal });
  } catch (err) {
    fail(err);
    return;
  }
  if (signal.aborted) return;
  if (items.length > 0) {
    // Jellyfin items this sync marked for the user: our own echo.
    const echo = await JELLYFIN_LEDGER.markedAmong(pair.id, [...new Set(items.map((i) => i.itemKey))]);
    const titleForId = await jellyfin.titlesFor(pair.jellyfinUser.serverInstance, items);
    const { plays, unresolved } = playsFromJellyfin(items, titleForId, echo);
    r.unresolved = unresolved;
    const planned = await planInChunks(run, plays, PLEX_LEDGER, "jellyfinReadTo", (chunk) => plex.targetsFor(chunk));
    if (!planned || signal.aborted) return;
  }
  await advance(pair, "jellyfinReadTo", newestPlayedAt(items));
}

async function applyToPlex(run: DirectionRun, pendingOnly = false): Promise<number> {
  const { pair, plex, r, fail, signal } = run;
  const batch = await PLEX_LEDGER.nextBatch(pair.id, pendingOnly);
  if (batch.length === 0) return 0;

  const cfg = await plex.config();
  if (!cfg) { fail(PLEX_NOT_CONFIGURED); return 0; }
  let token: string | null;
  let viewCounts: Map<string, number>;
  try {
    token = await plex.userToken(pair.plexUser.sourceUserId, pair.plexUser.isServerAdmin);
    if (!token) { fail(NO_PLEX_ACCESS); return 0; }
    // The account's OWN played state: already watched → "already", no scrobble.
    viewCounts = await getPlexViewCounts(cfg.url, token, batch.map((m) => m.id));
  } catch (err) {
    fail(err);
    return 0;
  }
  if (signal.aborted) return 0;
  const userToken = token;
  const outcome = await applyBatch(
    batch,
    signal,
    (id) => (viewCounts.get(id) ?? 0) > 0,
    (m) => (viewCounts.has(m.id) ? scrobblePlexItem(cfg.url, userToken, m.id) : Promise.resolve("missing" as const)),
  );
  await recordOutcome(outcome, r, PLEX_LEDGER, pair.id);
  return outcome.marked.length + outcome.already.length + outcome.missing.length;
}

// ── Resume positions ─────────────────────────────────────────────────────────
//
// Discovery: the titles in progress on EITHER side (Jellyfin's resumable list,
// the Plex account's On Deck). Then each title's state is read on BOTH sides,
// for every copy, as the user — and decideProgress picks the write, if any. A
// position is written as user data only (Jellyfin) or with /:/progress as the
// user (Plex); neither is a played-state change, and nothing clears one.

async function syncProgress(
  pair: PairRow,
  plex: PlexServer,
  jellyfin: JellyfinLookups,
  r: WatchSyncProgressResult,
  signal: AbortSignal | undefined,
  full: boolean,
): Promise<void> {
  const fail = (err: unknown) => noteError(r, err);
  const maxUnits = full ? WATCH_SYNC_FULL_PROGRESS_MAX_UNITS : WATCH_SYNC_PROGRESS_MAX_UNITS;
  const jfSlug = pair.jellyfinUser.serverInstance;
  const jfUser = pair.jellyfinUser.sourceUserId;
  let jfCfg: { url: string; apiKey: string };
  let plexCfg: { url: string; token: string } | null;
  let token: string | null;
  try {
    jfCfg = await jellyfin.config(jfSlug);
    plexCfg = await plex.config();
    if (!plexCfg) { fail(PLEX_NOT_CONFIGURED); return; }
    // Reading the Plex side needs the account's own token too, in either direction.
    token = await plex.userToken(pair.plexUser.sourceUserId, pair.plexUser.isServerAdmin);
    if (!token) { fail(NO_PLEX_ACCESS); return; }
  } catch (err) {
    fail(err);
    return;
  }
  const plexUrl = plexCfg.url;
  const userToken = token;

  try {
    // A full sync reads EVERY partial watch on each side (Plex: each section's
    // inProgress filter, since On Deck is one episode per show and a short
    // window); a normal run stays on the cheap resume lists.
    const [jfItems, plexItems] = await Promise.all([
      getJellyfinInProgress(jfCfg.url, jfCfg.apiKey, jfUser, { full }),
      full
        ? getPlexLibrarySections(plexUrl, userToken, signal).then((sections) => getPlexAllInProgress(plexUrl, userToken, sections, signal))
        : getPlexInProgress(plexUrl, userToken),
    ]);
    if (signal?.aborted) return;

    const jfTitle = await jellyfin.titlesFor(jfSlug, jfItems.map((i) => ({ kind: i.kind, itemKey: i.itemId, showKey: i.showKey })));
    const plexTitle = await plex.titlesFor(plexItems.map((i) => (i.kind === "movie" ? i.ratingKey : i.showKey)).filter((k): k is string => !!k));

    // Titles in progress anywhere, taken from the two lists in turn (each in its
    // own order: newest Jellyfin play first, On Deck order), so a long list on
    // one side can't fill the cap and starve the other side's titles.
    const units = new Map<string, WatchSyncPlay>();
    const add = (title: PlexTitle | null, kind: "movie" | "episode", season: number | null, episode: number | null) => {
      if (!title || units.size >= maxUnits) return;
      if ((kind === "movie") !== (title.mediaType === "MOVIE")) return;
      const play: WatchSyncPlay = { tmdbId: title.tmdbId, mediaType: title.mediaType, seasonNumber: season, episodeNumber: episode, viewedAt: null };
      const key = progressUnitKey(play);
      if (key && !units.has(key)) units.set(key, play);
    };
    const longest = Math.max(jfItems.length, plexItems.length);
    for (let n = 0; n < longest && units.size < maxUnits; n++) {
      const j = jfItems[n];
      if (j) add(jfTitle(j.kind === "movie" ? j.itemId : j.showKey ?? ""), j.kind, j.seasonNumber, j.episodeNumber);
      const x = plexItems[n];
      if (x) add(plexTitle(x.kind === "movie" ? x.ratingKey : x.showKey ?? ""), x.kind, x.seasonNumber, x.episodeNumber);
    }
    if (units.size === 0) return;

    // Every copy on each side, and its state as the user.
    const plays = [...units.values()];
    const [plexTargets, jfTargets] = await Promise.all([plex.targetsFor(plays), jellyfin.targetsFor(jfSlug, plays)]);
    if (signal?.aborted) return;
    const plexKeys = plays.flatMap((p) => [...targetIdsFor(p, plexTargets)]);
    const jfIds = plays.flatMap((p) => [...targetIdsFor(p, jfTargets)]);
    const [plexStates, jfStates] = await Promise.all([
      getPlexUserStates(plexUrl, userToken, plexKeys),
      getJellyfinUserStates(jfCfg.url, jfCfg.apiKey, jfUser, jfIds),
    ]);
    if (signal?.aborted) return;

    const writes: Array<{ target: "toJellyfin" | "toPlex"; ids: readonly string[]; positionMs: number }> = [];
    for (const p of plays) {
      const plexCopies = targetIdsFor(p, plexTargets).filter((k) => plexStates.has(k)).map((k): [string, ProgressState] => {
        const s = plexStates.get(k)!;
        return [k, { positionMs: s.viewOffset, durationMs: s.durationMs, lastActivity: s.lastViewedAt, played: s.viewCount > 0 }];
      });
      const jfCopies = targetIdsFor(p, jfTargets).filter((id) => jfStates.has(id)).map((id): [string, ProgressState] => {
        const s = jfStates.get(id)!;
        return [id, { positionMs: s.positionMs, durationMs: s.durationMs, lastActivity: s.lastPlayedAt, played: s.played }];
      });
      const d = decideProgress(latestState(plexCopies.map(([, s]) => s)), latestState(jfCopies.map(([, s]) => s)), pair.direction);
      if (!d) continue;
      // The decision reads one copy per side; a sibling copy the user watched
      // still never takes the position (19e).
      const ids = (d.target === "toPlex" ? plexCopies : jfCopies).filter(([, s]) => !isWatchedWithoutResume(s)).map(([id]) => id);
      if (ids.length > 0) writes.push({ target: d.target, ids, positionMs: d.positionMs });
    }

    // Counted per title, like the totals beside it: a title any of whose
    // copies failed is one failure, else one copied resume point when a copy
    // took it.
    await mapLimit(writes, APPLY_CONCURRENCY, async (w) => {
      if (signal?.aborted) return;
      let ok = false;
      let failed = false;
      for (const id of w.ids) {
        try {
          const res = w.target === "toPlex"
            ? await setPlexProgress(plexUrl, userToken, id, w.positionMs)
            : await setJellyfinPosition(jfCfg.url, jfCfg.apiKey, jfUser, id, w.positionMs);
          if (res === "marked") ok = true;
        } catch (err) {
          failed = true;
          fail(err);
        }
      }
      if (failed) r.failed++;
      else if (ok) r[w.target]++;
    });
  } catch (err) {
    fail(err);
  }
}

// ── shared apply bookkeeping ─────────────────────────────────────────────────

type BatchOutcome = { marked: string[]; already: string[]; missing: string[]; failed: Array<{ id: string; error: string }> };

async function applyBatch(
  batch: ReadonlyArray<{ id: string; datePlayed: Date | null }>,
  signal: AbortSignal | undefined,
  alreadyPlayed: (id: string) => boolean,
  write: (m: { id: string; datePlayed: Date | null }) => Promise<"marked" | "missing">,
): Promise<BatchOutcome> {
  const out: BatchOutcome = { marked: [], already: [], missing: [], failed: [] };
  await mapLimit(batch, APPLY_CONCURRENCY, async (m) => {
    if (signal?.aborted) return;
    if (alreadyPlayed(m.id)) { out.already.push(m.id); return; }
    try {
      (await write(m) === "marked" ? out.marked : out.missing).push(m.id);
    } catch (err) {
      out.failed.push({ id: m.id, error: safeWatchSyncError(err) });
    }
  });
  return out;
}

// The statuses an apply settles a mark on ("failed" goes through
// MarkLedger.setFailed, which also counts the attempt).
type AppliedStatus = Exclude<WatchSyncMarkStatus, "pending" | "failed">;

// Recorded even on abort: what was applied must not be re-applied. Failures
// sharing an error text are written together: a degraded upstream fails a
// whole batch the same way, and that is one update, not one per item.
async function recordOutcome(o: BatchOutcome, r: WatchSyncDirectionResult, ledger: MarkLedger, pairId: string): Promise<void> {
  if (o.marked.length > 0) await ledger.setStatus(pairId, o.marked, "marked");
  if (o.already.length > 0) await ledger.setStatus(pairId, o.already, "already");
  if (o.missing.length > 0) await ledger.setStatus(pairId, o.missing, "missing");
  const byError = new Map<string, string[]>();
  for (const f of o.failed) {
    const ids = byError.get(f.error);
    if (ids) ids.push(f.id);
    else byError.set(f.error, [f.id]);
  }
  for (const [error, ids] of byError) await ledger.setFailed(pairId, ids, error);
  r.marked += o.marked.length;
  r.already += o.already.length;
  r.missing += o.missing.length;
  r.failed += o.failed.length;
}

// ── per-run upstream lookups ─────────────────────────────────────────────────

// Every copy of a title on one server: the canonical column OR the array column
// (guardrail 37 for Jellyfin item ids, 37c for Plex ratingKeys).
function everyCopy(one: string | null, all: readonly string[] | null | undefined): string[] {
  return [...new Set([...(one ? [one] : []), ...(all ?? []).filter(Boolean)])];
}

// The library rows some plays can land on: each played movie and each series an
// episode play belongs to, by TMDB id. null when the plays name nothing, so the
// caller answers empty targets without a read or a config check.
function playedTitlesWhere(plays: readonly WatchSyncPlay[]) {
  const movieIds = [...new Set(plays.filter((p) => p.mediaType === "MOVIE").map((p) => p.tmdbId))];
  const tvIds = seriesNeeded(plays);
  if (movieIds.length === 0 && tvIds.length === 0) return null;
  return [
    ...(movieIds.length > 0 ? [{ mediaType: "MOVIE" as const, tmdbId: { in: movieIds } }] : []),
    ...(tvIds.length > 0 ? [{ mediaType: "TV" as const, tmdbId: { in: tvIds } }] : []),
  ];
}

const NO_TARGETS = (): MarkTargets => ({ movies: new Map(), episodes: new Map() });

// A target server's library rows for some plays → what they can mark: every
// copy of each movie, and per series every copy's episodes by (season,
// episode). Each copy's episode list is a paged walk on the server (cached per
// run by the caller's `episodesOf`), so the distinct copies are read a few at
// a time rather than one after another.
async function buildMarkTargets<R extends { tmdbId: number; mediaType: string }>(
  rows: readonly R[],
  copiesOf: (r: R) => string[],
  episodesOf: (copy: string) => Promise<EpisodeIdRow[]>,
  signal: AbortSignal | undefined,
): Promise<MarkTargets> {
  const movies = new Map<number, string[]>();
  const episodes = new Map<number, Map<string, string[]>>();
  for (const r of rows) if (r.mediaType === "MOVIE") movies.set(r.tmdbId, copiesOf(r));
  const shows = rows.filter((r) => r.mediaType === "TV");
  const lists = new Map<string, EpisodeIdRow[]>();
  await mapLimit([...new Set(shows.flatMap(copiesOf))], APPLY_CONCURRENCY, async (copy) => {
    if (signal?.aborted) return;
    lists.set(copy, await episodesOf(copy));
  });
  // An aborted read is partial; the caller checks the signal and plans nothing.
  if (signal?.aborted) return { movies, episodes };
  for (const r of shows) {
    const all: EpisodeIdRow[] = [];
    for (const copy of copiesOf(r)) for (const ep of lists.get(copy) ?? []) all.push(ep);
    episodes.set(r.tmdbId, indexEpisodes(all));
  }
  return { movies, episodes };
}

// One Plex server for one run: config, owner, episode lists and the paired
// accounts' own tokens, each read at most once. The tokens never leave this
// object (no store, no log, no response).
class PlexServer {
  readonly slug: string;
  private readonly signal: AbortSignal | undefined;
  private cfgP: Promise<{ url: string; token: string } | null> | null = null;
  private ownerP: Promise<{ id: string | null; error: unknown }> | null = null;
  private sharedP: Promise<Map<string, string>> | null = null;
  private readonly homeTokens = new Map<string, Promise<string | null>>();
  private readonly episodes = new Map<string, Promise<EpisodeIdRow[]>>();

  constructor(slug: string, signal: AbortSignal | undefined) {
    this.slug = slug;
    this.signal = signal;
  }

  config(): Promise<{ url: string; token: string } | null> {
    if (!this.cfgP) {
      // getPlexConfig's findUnique reads (guardrail 35's Plex note). A failed
      // read is not cached: the next pair on this server asks again.
      const p = getPlexConfig(this.slug).then((c) => (c.url && c.token ? { url: c.url, token: c.token } : null));
      p.catch(() => { if (this.cfgP === p) this.cfgP = null; });
      this.cfgP = p;
    }
    return this.cfgP;
  }

  // The server owner's plex.tv id, read once per run. null when unconfigured
  // or plex.tv couldn't say, with the cause kept so the pair's error names it.
  owner(): Promise<{ id: string | null; error: unknown }> {
    this.ownerP ??= this.config().then(
      (c) => (c ? getPlexUser(c.token).then((u) => ({ id: u.id, error: null }), (error: unknown) => ({ id: null, error })) : { id: null, error: null }),
      (error: unknown) => ({ id: null, error }),
    );
    return this.ownerP;
  }

  // The account's own token for this server: the owner's is the admin token;
  // a shared user's comes from shared_servers; a managed home user's from the
  // home switch. null = no access we can obtain.
  async userToken(plexAccountId: string, isServerAdmin: boolean): Promise<string | null> {
    const cfg = await this.config();
    if (!cfg) return null;
    const { id: owner, error: ownerError } = await this.owner();
    // The owner's token is the admin token only once plex.tv has named them.
    // `isServerAdmin` is set-only (a token rotation never clears it), and the
    // read path already holds when the owner can't be identified. Using the
    // admin token for every sticky admin flag would scrobble a former owner's
    // pending marks onto whoever holds the token now (guardrail 19e).
    if (owner === null && isServerAdmin) throw new Error(ownerUnknownMessage(ownerError));
    if (owner !== null && plexAccountId === owner) return cfg.token;
    if (!this.sharedP) {
      this.sharedP = (async () => {
        const machineId = await getPlexMachineId(cfg.url, cfg.token);
        if (!machineId) throw new Error("Couldn't read the Plex server's machine identifier");
        return getPlexSharedServerTokens(cfg.token, machineId);
      })();
      this.sharedP.catch(() => { this.sharedP = null; });
    }
    const shared = (await this.sharedP).get(plexAccountId);
    if (shared) return shared;
    let home = this.homeTokens.get(plexAccountId);
    if (!home) {
      home = getPlexHomeUserToken(cfg.token, plexAccountId);
      this.homeTokens.set(plexAccountId, home);
      // A failed switch (a rate limit, plex.tv down) is not "no token": the
      // next pair for this account asks again.
      home.catch(() => { this.homeTokens.delete(plexAccountId); });
    }
    return home;
  }

  // Plex ratingKey (a movie's own, or a show's) → its TMDB title, through the
  // library cache (37c: both key columns; one owner per key, 37b).
  async titlesFor(keys: readonly string[]): Promise<(key: string) => PlexTitle | null> {
    // In chunks; a row matched by several chunks is indexed more than once,
    // which the key index's total order absorbs.
    const rows = await readInChunks([...new Set(keys)], (chunk) => prisma.plexLibraryItem.findMany({
      where: { serverInstance: this.slug, OR: [{ plexRatingKey: { in: chunk } }, { plexRatingKeys: { hasSome: chunk } }] },
      select: { tmdbId: true, mediaType: true, plexRatingKey: true, plexRatingKeys: true },
    }));
    const index = indexPlexRowsByKey(rows);
    return (k) => {
      const row = index.get(k);
      return row ? { tmdbId: row.tmdbId, mediaType: row.mediaType } : null;
    };
  }

  private episodesOf(showKey: string): Promise<EpisodeIdRow[]> {
    let p = this.episodes.get(showKey);
    if (!p) {
      p = this.config().then((c) => {
        if (!c) throw new Error(PLEX_NOT_CONFIGURED);
        return getPlexEpisodeKeys(c.url, c.token, showKey);
      });
      p.catch(() => this.episodes.delete(showKey));
      this.episodes.set(showKey, p);
    }
    return p;
  }

  async targetsFor(plays: readonly WatchSyncPlay[]): Promise<MarkTargets> {
    const titles = playedTitlesWhere(plays);
    if (!titles) return NO_TARGETS();
    if (!(await this.config())) throw new Error(PLEX_NOT_CONFIGURED);
    const rows = await prisma.plexLibraryItem.findMany({
      where: { serverInstance: this.slug, OR: titles },
      select: { tmdbId: true, mediaType: true, plexRatingKey: true, plexRatingKeys: true },
    });
    return buildMarkTargets(rows, (r) => everyCopy(r.plexRatingKey, r.plexRatingKeys), (showKey) => this.episodesOf(showKey), this.signal);
  }
}

// Per-run Jellyfin lookups, shared across pairs: library rows per server and
// episode lists per series item, each read at most once.
class JellyfinLookups {
  private readonly signal: AbortSignal | undefined;
  private readonly configs = new Map<string, Promise<{ url: string; apiKey: string }>>();
  private readonly episodes = new Map<string, Promise<EpisodeIdRow[]>>();

  constructor(signal: AbortSignal | undefined) {
    this.signal = signal;
  }

  config(slug: string): Promise<{ url: string; apiKey: string }> {
    let p = this.configs.get(slug);
    if (!p) {
      const read = getJellyfinConfig(slug);
      // A failed READ is not cached (the next pair asks again); an unconfigured
      // server is an answer, kept for the run.
      read.catch(() => { if (this.configs.get(slug) === p) this.configs.delete(slug); });
      p = read.then((c) => {
        if (!c.url || !c.apiKey) throw new Error(JELLYFIN_NOT_CONFIGURED);
        return { url: c.url, apiKey: c.apiKey };
      });
      this.configs.set(slug, p);
    }
    return p;
  }

  private episodesOf(slug: string, seriesId: string): Promise<EpisodeIdRow[]> {
    const key = `${slug}\u0000${seriesId}`;
    let p = this.episodes.get(key);
    if (!p) {
      p = this.config(slug).then((c) => getJellyfinEpisodeIds(c.url, c.apiKey, seriesId));
      // A failure is not cached: the next pair (or run) may succeed.
      p.catch(() => this.episodes.delete(key));
      this.episodes.set(key, p);
    }
    return p;
  }

  // Jellyfin item id (a movie's own id, or a series id) → its TMDB title, via
  // the library cache (guardrail 37: both id columns). An id held by several
  // titles resolves to the lowest tmdbId, the same on every run.
  async titlesFor(slug: string, items: ReadonlyArray<Pick<JellyfinPlayedItem, "kind" | "itemKey" | "showKey">>): Promise<(id: string) => PlexTitle | null> {
    const ids = [...new Set(items.map((i) => (i.kind === "movie" ? i.itemKey : i.showKey)).filter((x): x is string => !!x))];
    const map = new Map<string, PlexTitle>();
    for (let i = 0; i < ids.length; i += WATCH_SYNC_KEY_CHUNK) {
      const chunk = ids.slice(i, i + WATCH_SYNC_KEY_CHUNK);
      const wanted = new Set(chunk);
      const rows = await prisma.jellyfinLibraryItem.findMany({
        where: { serverInstance: slug, OR: [{ jellyfinItemId: { in: chunk } }, { jellyfinItemIds: { hasSome: chunk } }] },
        select: { tmdbId: true, mediaType: true, jellyfinItemId: true, jellyfinItemIds: true },
        orderBy: { tmdbId: "asc" },
      });
      // Only this chunk's ids: every row holding one of them is in THIS answer,
      // in tmdbId order. A row's other ids are decided by their own chunk.
      for (const r of rows) {
        for (const id of [r.jellyfinItemId, ...(r.jellyfinItemIds ?? [])]) {
          if (id && wanted.has(id) && !map.has(id)) map.set(id, { tmdbId: r.tmdbId, mediaType: r.mediaType });
        }
      }
    }
    return (id) => map.get(id) ?? null;
  }

  async targetsFor(slug: string, plays: readonly WatchSyncPlay[]): Promise<MarkTargets> {
    const titles = playedTitlesWhere(plays);
    if (!titles) return NO_TARGETS();
    await this.config(slug);

    const rows = await prisma.jellyfinLibraryItem.findMany({
      where: { serverInstance: slug, OR: titles },
      select: { tmdbId: true, mediaType: true, jellyfinItemId: true, jellyfinItemIds: true },
    });
    return buildMarkTargets(rows, (r) => everyCopy(r.jellyfinItemId, r.jellyfinItemIds), (seriesId) => this.episodesOf(slug, seriesId), this.signal);
  }
}

// ── admin page reads ─────────────────────────────────────────────────────────

export interface WatchSyncMarkCounts {
  pending: number;
  marked: number;
  already: number;
  missing: number;
  failed: number;
}

export interface WatchSyncPairCounts {
  toJellyfin: WatchSyncMarkCounts;
  toPlex: WatchSyncMarkCounts;
}

function emptyCounts(): WatchSyncMarkCounts {
  return { pending: 0, marked: 0, already: 0, missing: 0, failed: 0 };
}

// `status` is the column as stored; an unknown value counts nowhere.
function addCount(c: WatchSyncMarkCounts, status: string, n: number): void {
  if (status === "pending") c.pending += n;
  else if (status === "marked") c.marked += n;
  else if (status === "already") c.already += n;
  else if (status === "missing") c.missing += n;
  else if (status === "failed") c.failed += n;
}

export async function markCountsByPair(pairIds: readonly string[]): Promise<Map<string, WatchSyncPairCounts>> {
  const out = new Map<string, WatchSyncPairCounts>();
  for (const id of pairIds) out.set(id, { toJellyfin: emptyCounts(), toPlex: emptyCounts() });
  if (pairIds.length === 0) return out;
  const [jf, px] = await Promise.all([
    prisma.watchSyncMark.groupBy({ by: ["pairId", "status"], where: { pairId: { in: [...pairIds] } }, _count: { _all: true } }),
    prisma.watchSyncPlexMark.groupBy({ by: ["pairId", "status"], where: { pairId: { in: [...pairIds] } }, _count: { _all: true } }),
  ]);
  for (const row of jf) { const c = out.get(row.pairId); if (c) addCount(c.toJellyfin, row.status, row._count._all); }
  for (const row of px) { const c = out.get(row.pairId); if (c) addCount(c.toPlex, row.status, row._count._all); }
  return out;
}
