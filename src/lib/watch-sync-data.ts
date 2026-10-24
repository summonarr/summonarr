import "server-only";
// Watch sync, Plex ⇄ Jellyfin — the DATA half (prisma + the two servers). The
// rules live in watch-sync.ts; read its header first. Run by the watch-sync
// cron (/api/cron/watch-sync, lock WATCH_SYNC_LOCK_ID) and by the admin page's
// "Run now", always under that one lock.
//
// One run, in two phases, each direction gated by the pair's `direction`:
//   1. PLAN.
//      - Plex → Jellyfin: per Plex server, read Plex's history once — the whole
//        history when any pair on it is new, otherwise back to the oldest pair's
//        read point minus the overlap — and resolve each pair's plays to
//        Jellyfin item ids (WatchSyncMark, "pending").
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
  getPlexUser,
  getPlexUserStates,
  getPlexViewCounts,
  getPlexWatchHistory,
  scrobblePlexItem,
  setPlexProgress,
} from "./plex";
import {
  getJellyfinEpisodeIds,
  getJellyfinInProgress,
  getJellyfinPlayedSince,
  getJellyfinUserPlayedItems,
  getJellyfinUserStates,
  markJellyfinPlayed,
  setJellyfinPosition,
} from "./jellyfin";
import { indexPlexRowsByKey } from "./plex-dedupe";
import { processSingleton } from "./process-singleton";
import type { JellyfinPlayedItem, PlexHistoryEntry } from "./upstream-watch";
import {
  WATCH_SYNC_BATCH,
  WATCH_SYNC_MAX_ATTEMPTS,
  WATCH_SYNC_PLAN_CHUNK,
  WATCH_SYNC_RUN_BUDGET_MS,
  WATCH_SYNC_STOPPED_MESSAGE,
  chunkReadTo,
  oldestFirst,
  WATCH_SYNC_PROGRESS_MAX_UNITS,
  decideProgress,
  latestState,
  progressUnitKey,
  targetIdsFor,
  indexEpisodes,
  jellyfinStopBefore,
  newestPlayedAt,
  newestViewedAt,
  planMarks,
  playsForPair,
  playsFromJellyfin,
  safeWatchSyncError,
  seriesNeeded,
  syncsToward,
  type EpisodeIdRow,
  type MarkTargets,
  type PlannedMark,
  type PlexTitle,
  type ProgressState,
  type WatchSyncPairInput,
  type WatchSyncPlay,
} from "./watch-sync";

export const WATCH_SYNC_FEATURE_KEY = "feature.admin.watchSync";

// Ledger inserts are idempotent (skipDuplicates) and need no transaction, so
// they are chunked here directly rather than through batchCreateMany, whose
// void return can't report how many rows were new.
const LEDGER_INSERT_CHUNK = 5_000;
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

type PairRow = {
  id: string;
  direction: string;
  syncProgress: boolean;
  historyReadTo: Date | null;
  jellyfinReadTo: Date | null;
  plexUser: { source: string; serverInstance: string; sourceUserId: string; isServerAdmin: boolean };
  jellyfinUser: { source: string; serverInstance: string; sourceUserId: string; active: boolean };
};

type Dir = "toJellyfin" | "toPlex";

function emptyDirection(): WatchSyncDirectionResult {
  return { queued: 0, unresolved: 0, unmatched: 0, marked: 0, already: 0, missing: 0, failed: 0 };
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

// `budgetMs` is a test seam; production always runs on WATCH_SYNC_RUN_BUDGET_MS.
export async function runWatchSync(
  { signal: lockSignal, pairIds, budgetMs = WATCH_SYNC_RUN_BUDGET_MS }: { signal?: AbortSignal; pairIds?: readonly string[]; budgetMs?: number } = {},
): Promise<WatchSyncRunResult> {
  const out: WatchSyncRunResult = { pairs: [], aborted: false };
  if (lockSignal?.aborted) return { ...out, aborted: true };
  runState.running = true;
  runState.startedAt = Date.now();
  runState.pairId = null;
  try {
    return await runWatchSyncInner(lockSignal, pairIds, budgetMs);
  } finally {
    runState.running = false;
    runState.startedAt = null;
    runState.pairId = null;
  }
}

async function runWatchSyncInner(lockSignal: AbortSignal | undefined, pairIds: readonly string[] | undefined, budgetMs: number): Promise<WatchSyncRunResult> {
  const out: WatchSyncRunResult = { pairs: [], aborted: false };
  // The run's own budget, below the lock's timeout: on it the run stops between
  // steps, records what it did and says it will continue (never a silent stop).
  const budget = AbortSignal.timeout(budgetMs);
  const signal = lockSignal ? AbortSignal.any([lockSignal, budget]) : budget;

  const pairs: PairRow[] = await prisma.watchSyncPair.findMany({
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
  if (pairs.length === 0) return out;

  const results = new Map<string, WatchSyncPairResult>(pairs.map((p) => [p.id, {
    pairId: p.id,
    toJellyfin: syncsToward(p.direction, "toJellyfin") ? emptyDirection() : null,
    toPlex: syncsToward(p.direction, "toPlex") ? emptyDirection() : null,
    progress: p.syncProgress && (syncsToward(p.direction, "toJellyfin") || syncsToward(p.direction, "toPlex"))
      ? { toJellyfin: 0, toPlex: 0, failed: 0 }
      : null,
  }]));
  const failPair = (id: string, err: unknown) => {
    const r = results.get(id);
    if (r && r.error === undefined) r.error = typeof err === "string" ? err : safeWatchSyncError(err);
  };
  const fail = (id: string, dir: Dir, err: unknown) => {
    const d = results.get(id)?.[dir];
    if (d && d.error === undefined) d.error = typeof err === "string" ? err : safeWatchSyncError(err);
  };

  // A pair whose rows are not (plex, jellyfin) can't come from the admin route,
  // but a hand-edited row must not reach a server. Neither may a Jellyfin user
  // who has left the server.
  const valid = pairs.filter((p) => {
    if (p.plexUser.source !== "plex" || p.jellyfinUser.source !== "jellyfin") {
      failPair(p.id, "Pair does not link a Plex account to a Jellyfin user");
      return false;
    }
    if (!p.jellyfinUser.active) {
      failPair(p.id, "Jellyfin user is no longer on the server");
      return false;
    }
    return true;
  });

  const jellyfin = new JellyfinLookups(signal);
  const plexServers = new Map<string, PlexServer>();
  const plexServer = (slug: string) => {
    let s = plexServers.get(slug);
    if (!s) { s = new PlexServer(slug, signal); plexServers.set(slug, s); }
    return s;
  };

  // Per pair: plan and apply each direction, then resume points. A pair's
  // steps finish before the next pair starts, so a run that stops on its budget
  // leaves earlier pairs fully done and the rest continuing next run.
  const completed = new Set<string>();
  for (const p of valid) {
    if (signal.aborted) break;
    runState.pairId = p.id;
    const r = results.get(p.id)!;
    const plex = plexServer(p.plexUser.serverInstance);
    if (r.toJellyfin) {
      await planToJellyfin(p, plex, jellyfin, r.toJellyfin, (e) => fail(p.id, "toJellyfin", e), signal);
      if (!signal.aborted) await applyToJellyfin(p, r.toJellyfin, (e) => fail(p.id, "toJellyfin", e), signal);
      if (!signal.aborted) completed.add(`${p.id}:toJellyfin`);
    }
    if (r.toPlex && !signal.aborted) {
      await planToPlex(p, plex, jellyfin, r.toPlex, (e) => fail(p.id, "toPlex", e), signal);
      if (!signal.aborted) await applyToPlex(p, plex, r.toPlex, (e) => fail(p.id, "toPlex", e), signal);
      if (!signal.aborted) completed.add(`${p.id}:toPlex`);
    }
    // After the played-state apply, so a title just marked watched reads as
    // watched here (watched beats in-progress).
    if (r.progress && !signal.aborted) {
      await syncProgress(p, plex, jellyfin, r.progress, signal);
      if (!signal.aborted) completed.add(`${p.id}:progress`);
    }
  }

  // Whatever didn't finish says so — on the pair, in the result and (by the
  // route) in the log. What did finish was queued and recorded as it went.
  if (signal.aborted) {
    for (const r of results.values()) {
      if (r.error !== undefined) continue;
      if (r.toJellyfin && !completed.has(`${r.pairId}:toJellyfin`)) r.toJellyfin.error ??= WATCH_SYNC_STOPPED_MESSAGE;
      if (r.toPlex && !completed.has(`${r.pairId}:toPlex`)) r.toPlex.error ??= WATCH_SYNC_STOPPED_MESSAGE;
      if (r.progress && !completed.has(`${r.pairId}:progress`)) r.progress.error ??= WATCH_SYNC_STOPPED_MESSAGE;
    }
  }

  const done = finish(results, signal.aborted);
  // Recorded per pair for the admin page. Best-effort: a failed write must not
  // turn a run that marked items into an error.
  const now = new Date();
  for (const r of done.pairs) {
    await prisma.watchSyncPair
      .update({ where: { id: r.pairId }, data: { lastRunAt: now, lastResult: JSON.parse(JSON.stringify(r)) } })
      .catch((err) => console.error("[watch-sync] could not record a pair's result:", safeWatchSyncError(err)));
  }
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

// ── Plex → Jellyfin ──────────────────────────────────────────────────────────

async function planToJellyfin(
  pair: PairRow,
  plex: PlexServer,
  jellyfin: JellyfinLookups,
  r: WatchSyncDirectionResult,
  fail: (err: unknown) => void,
  signal: AbortSignal,
): Promise<void> {
  const cfg = await plex.config();
  if (!cfg) { fail("Plex server is not configured"); return; }

  let entries: PlexHistoryEntry[];
  let owner: string | null;
  try {
    owner = await plex.ownerId();
    // The owner's plays are recorded under the local account id "1"
    // (normalizePlexAccountId). Unknown owner ⇒ the owner's pair waits rather
    // than reading past those plays.
    if (owner === null && pair.plexUser.isServerAdmin) {
      fail("Couldn't identify the Plex server owner this run; will retry");
      return;
    }
    const accountId = pair.plexUser.sourceUserId === owner ? "1" : pair.plexUser.sourceUserId;
    const since = jellyfinStopBefore(pair.historyReadTo);
    // Only this account's history, only after the read point (Plex-side
    // filters; playsForPair filters again).
    entries = (await getPlexWatchHistory(cfg.url, cfg.token, since ? { signal, stopBefore: since, accountId } : { signal, accountId })).entries;
  } catch (err) {
    fail(err);
    return;
  }
  if (signal.aborted) return;

  const input: WatchSyncPairInput = { id: pair.id, plexAccountId: pair.plexUser.sourceUserId, historyReadTo: pair.historyReadTo };
  const keys = new Set<string>();
  for (const e of entries) {
    if (e.kind === "movie") keys.add(e.itemKey);
    else if (e.showKey) keys.add(e.showKey);
  }
  const plexTitleForKey = await plex.titlesFor([...keys]);
  const itemKeys = [...new Set(entries.map((e) => e.itemKey))];
  // Plex items this sync marked for the account: their history is our echo.
  const echo = itemKeys.length === 0
    ? new Set<string>()
    : new Set((await prisma.watchSyncPlexMark.findMany({
        where: { pairId: pair.id, status: "marked", plexRatingKey: { in: itemKeys } },
        select: { plexRatingKey: true },
      })).map((m) => m.plexRatingKey));
  const { plays, unresolved } = playsForPair(entries, input, owner, plexTitleForKey, echo);
  r.unresolved = unresolved;

  const queued = await planInChunks(plays, signal, r,
    (chunk) => jellyfin.targetsFor(pair.jellyfinUser.serverInstance, chunk),
    async (marks) => (await prisma.watchSyncMark.createMany({
      data: marks.map((m) => ({ pairId: pair.id, jellyfinItemId: m.targetId, datePlayed: m.datePlayed })),
      skipDuplicates: true,
    })).count,
    (readTo) => advance(pair, "historyReadTo", readTo),
    fail);
  if (!queued || signal.aborted) return;
  // Everything read was planned: the read point is the newest record read,
  // unresolved and echo records included.
  await advance(pair, "historyReadTo", newestViewedAt(entries));
}

// Plan plays oldest first, a chunk at a time: resolve the chunk's targets,
// queue its marks, then move the read point to the chunk's newest play. A
// failed lookup or insert stops planning with the read point where the last
// finished chunk left it. true = every chunk was planned.
async function planInChunks(
  plays: readonly WatchSyncPlay[],
  signal: AbortSignal,
  r: WatchSyncDirectionResult,
  resolve: (chunk: readonly WatchSyncPlay[]) => Promise<MarkTargets>,
  insert: (marks: readonly PlannedMark[]) => Promise<number>,
  checkpoint: (readTo: Date | null) => Promise<void>,
  fail: (err: unknown) => void,
): Promise<boolean> {
  const ordered = oldestFirst(plays);
  for (let i = 0; i < ordered.length; i += WATCH_SYNC_PLAN_CHUNK) {
    if (signal.aborted) return false;
    const chunk = ordered.slice(i, i + WATCH_SYNC_PLAN_CHUNK);
    try {
      const targets = await resolve(chunk);
      if (signal.aborted) return false;
      const plan = planMarks(chunk, targets);
      r.unmatched += plan.unmatched;
      r.queued += await queueMarks(plan.marks, insert);
    } catch (err) {
      fail(err);
      return false;
    }
    await checkpoint(chunkReadTo(chunk));
  }
  return true;
}

async function advance(pair: PairRow, column: "historyReadTo" | "jellyfinReadTo", readTo: Date | null): Promise<void> {
  const current = pair[column];
  if (!readTo || (current && readTo <= current)) return;
  await prisma.watchSyncPair.update({ where: { id: pair.id }, data: { [column]: readTo } });
  pair[column] = readTo;
}

async function applyToJellyfin(
  pair: PairRow,
  r: WatchSyncDirectionResult,
  fail: (err: unknown) => void,
  signal: AbortSignal | undefined,
): Promise<void> {
  const batch = await prisma.watchSyncMark.findMany({
    where: {
      pairId: pair.id,
      OR: [{ status: "pending" }, { status: "failed", attempts: { lt: WATCH_SYNC_MAX_ATTEMPTS } }],
    },
    select: { jellyfinItemId: true, datePlayed: true },
    orderBy: { createdAt: "asc" },
    take: WATCH_SYNC_BATCH,
  });
  if (batch.length === 0) return;

  const cfg = await getJellyfinConfig(pair.jellyfinUser.serverInstance);
  if (!cfg.url || !cfg.apiKey) { fail("Jellyfin server is not configured"); return; }
  const { url, apiKey } = cfg;
  const userId = pair.jellyfinUser.sourceUserId;

  let played: Set<string>;
  try {
    const list = await getJellyfinUserPlayedItems(url, apiKey, userId, "IsPlayed", { signal });
    played = new Set(list.items.map((i) => i.itemKey));
  } catch (err) {
    // Without the played list a mark could double a PlayCount; try next run.
    fail(err);
    return;
  }
  if (signal?.aborted) return;

  const outcome = await applyBatch(batch.map((m) => ({ id: m.jellyfinItemId, datePlayed: m.datePlayed })), signal, (id) => played.has(id),
    (m) => markJellyfinPlayed(url, apiKey, userId, m.id, m.datePlayed));
  await recordOutcome(outcome, r,
    (ids, status) => prisma.watchSyncMark.updateMany({ where: { pairId: pair.id, jellyfinItemId: { in: ids } }, data: { status, lastError: null } }),
    (id, error) => prisma.watchSyncMark.update({
      where: { pairId_jellyfinItemId: { pairId: pair.id, jellyfinItemId: id } },
      data: { status: "failed", attempts: { increment: 1 }, lastError: error },
    }));
}

// ── Jellyfin → Plex ──────────────────────────────────────────────────────────

async function planToPlex(
  pair: PairRow,
  plex: PlexServer,
  jellyfin: JellyfinLookups,
  r: WatchSyncDirectionResult,
  fail: (err: unknown) => void,
  signal: AbortSignal,
): Promise<void> {
  let items: JellyfinPlayedItem[];
  try {
    const cfg = await jellyfin.config(pair.jellyfinUser.serverInstance);
    const since = jellyfinStopBefore(pair.jellyfinReadTo);
    items = await getJellyfinPlayedSince(cfg.url, cfg.apiKey, pair.jellyfinUser.sourceUserId, since ? { since, signal } : { signal });
  } catch (err) {
    fail(err);
    return;
  }
  if (signal.aborted) return;
  if (items.length > 0) {
    const ids = [...new Set(items.map((i) => i.itemKey))];
    // Jellyfin items this sync marked for the user: our own echo.
    const echo = new Set((await prisma.watchSyncMark.findMany({
      where: { pairId: pair.id, status: "marked", jellyfinItemId: { in: ids } },
      select: { jellyfinItemId: true },
    })).map((m) => m.jellyfinItemId));
    const titleForId = await jellyfin.titlesFor(pair.jellyfinUser.serverInstance, items);
    const { plays, unresolved } = playsFromJellyfin(items, titleForId, echo);
    r.unresolved = unresolved;
    const planned = await planInChunks(plays, signal, r,
      (chunk) => plex.targetsFor(chunk),
      async (marks) => (await prisma.watchSyncPlexMark.createMany({
        data: marks.map((m) => ({ pairId: pair.id, plexRatingKey: m.targetId, datePlayed: m.datePlayed })),
        skipDuplicates: true,
      })).count,
      (readTo) => advance(pair, "jellyfinReadTo", readTo),
      fail);
    if (!planned || signal.aborted) return;
  }
  await advance(pair, "jellyfinReadTo", newestPlayedAt(items));
}

async function applyToPlex(
  pair: PairRow,
  plex: PlexServer,
  r: WatchSyncDirectionResult,
  fail: (err: unknown) => void,
  signal: AbortSignal | undefined,
): Promise<void> {
  const batch = await prisma.watchSyncPlexMark.findMany({
    where: {
      pairId: pair.id,
      OR: [{ status: "pending" }, { status: "failed", attempts: { lt: WATCH_SYNC_MAX_ATTEMPTS } }],
    },
    select: { plexRatingKey: true, datePlayed: true },
    orderBy: { createdAt: "asc" },
    take: WATCH_SYNC_BATCH,
  });
  if (batch.length === 0) return;

  const cfg = await plex.config();
  if (!cfg) { fail("Plex server is not configured"); return; }
  let token: string | null;
  let viewCounts: Map<string, number>;
  try {
    token = await plex.userToken(pair.plexUser.sourceUserId, pair.plexUser.isServerAdmin);
    if (!token) { fail("No Plex access for this account — is this Plex server shared with it (or is it a PIN-protected home user)?"); return; }
    // The account's OWN played state: already watched → "already", no scrobble.
    viewCounts = await getPlexViewCounts(cfg.url, token, batch.map((m) => m.plexRatingKey));
  } catch (err) {
    fail(err);
    return;
  }
  if (signal?.aborted) return;
  const userToken = token;
  const outcome = await applyBatch(
    batch.map((m) => ({ id: m.plexRatingKey, datePlayed: m.datePlayed })),
    signal,
    (id) => (viewCounts.get(id) ?? 0) > 0,
    (m) => (viewCounts.has(m.id) ? scrobblePlexItem(cfg.url, userToken, m.id) : Promise.resolve("missing" as const)),
  );
  await recordOutcome(outcome, r,
    (ids, status) => prisma.watchSyncPlexMark.updateMany({ where: { pairId: pair.id, plexRatingKey: { in: ids } }, data: { status, lastError: null } }),
    (id, error) => prisma.watchSyncPlexMark.update({
      where: { pairId_plexRatingKey: { pairId: pair.id, plexRatingKey: id } },
      data: { status: "failed", attempts: { increment: 1 }, lastError: error },
    }));
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
): Promise<void> {
  const fail = (err: unknown) => { if (r.error === undefined) r.error = typeof err === "string" ? err : safeWatchSyncError(err); };
  const jfSlug = pair.jellyfinUser.serverInstance;
  const jfUser = pair.jellyfinUser.sourceUserId;
  let jfCfg: { url: string; apiKey: string };
  let plexCfg: { url: string; token: string } | null;
  let token: string | null;
  try {
    jfCfg = await jellyfin.config(jfSlug);
    plexCfg = await plex.config();
    if (!plexCfg) { fail("Plex server is not configured"); return; }
    // Reading the Plex side needs the account's own token too, in either direction.
    token = await plex.userToken(pair.plexUser.sourceUserId, pair.plexUser.isServerAdmin);
    if (!token) { fail("No Plex access for this account — is this Plex server shared with it (or is it a PIN-protected home user)?"); return; }
  } catch (err) {
    fail(err);
    return;
  }
  const plexUrl = plexCfg.url;
  const userToken = token;

  try {
    const [jfItems, plexItems] = await Promise.all([
      getJellyfinInProgress(jfCfg.url, jfCfg.apiKey, jfUser),
      getPlexInProgress(plexUrl, userToken),
    ]);
    if (signal?.aborted) return;

    const jfTitle = await jellyfin.titlesFor(jfSlug, jfItems.map((i) => ({ kind: i.kind, itemKey: i.itemId, showKey: i.showKey })));
    const plexTitle = await plex.titlesFor(plexItems.map((i) => (i.kind === "movie" ? i.ratingKey : i.showKey)).filter((k): k is string => !!k));

    // Titles in progress anywhere, newest Jellyfin play first, then On Deck order.
    const units = new Map<string, WatchSyncPlay>();
    const add = (title: PlexTitle | null, kind: "movie" | "episode", season: number | null, episode: number | null) => {
      if (!title || units.size >= WATCH_SYNC_PROGRESS_MAX_UNITS) return;
      if ((kind === "movie") !== (title.mediaType === "MOVIE")) return;
      const play: WatchSyncPlay = { tmdbId: title.tmdbId, mediaType: title.mediaType, seasonNumber: season, episodeNumber: episode, viewedAt: null };
      const key = progressUnitKey(play);
      if (key && !units.has(key)) units.set(key, play);
    };
    for (const i of jfItems) add(jfTitle(i.kind === "movie" ? i.itemId : i.showKey ?? ""), i.kind, i.seasonNumber, i.episodeNumber);
    for (const i of plexItems) add(plexTitle(i.kind === "movie" ? i.ratingKey : i.showKey ?? ""), i.kind, i.seasonNumber, i.episodeNumber);
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
      const pk = targetIdsFor(p, plexTargets).filter((k) => plexStates.has(k));
      const ji = targetIdsFor(p, jfTargets).filter((id) => jfStates.has(id));
      const plexState = latestState(pk.map((k): ProgressState => {
        const s = plexStates.get(k)!;
        return { positionMs: s.viewOffset, durationMs: s.durationMs, lastActivity: s.lastViewedAt, played: s.viewCount > 0 };
      }));
      const jfState = latestState(ji.map((id): ProgressState => {
        const s = jfStates.get(id)!;
        return { positionMs: s.positionMs, durationMs: s.durationMs, lastActivity: s.lastPlayedAt, played: s.played };
      }));
      const d = decideProgress(plexState, jfState, pair.direction);
      if (d) writes.push({ target: d.target, ids: d.target === "toPlex" ? pk : ji, positionMs: d.positionMs });
    }

    await mapLimit(writes, APPLY_CONCURRENCY, async (w) => {
      if (signal?.aborted) return;
      let ok = false;
      for (const id of w.ids) {
        try {
          const res = w.target === "toPlex"
            ? await setPlexProgress(plexUrl, userToken, id, w.positionMs)
            : await setJellyfinPosition(jfCfg.url, jfCfg.apiKey, jfUser, id, w.positionMs);
          if (res === "marked") ok = true;
        } catch (err) {
          r.failed++;
          fail(err);
        }
      }
      if (ok) r[w.target]++;
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

// Recorded even on abort: what was applied must not be re-applied.
async function recordOutcome(
  o: BatchOutcome,
  r: WatchSyncDirectionResult,
  setStatus: (ids: string[], status: string) => Promise<unknown>,
  setFailed: (id: string, error: string) => Promise<unknown>,
): Promise<void> {
  if (o.marked.length > 0) await setStatus(o.marked, "marked");
  if (o.already.length > 0) await setStatus(o.already, "already");
  if (o.missing.length > 0) await setStatus(o.missing, "missing");
  for (const f of o.failed) await setFailed(f.id, f.error);
  r.marked += o.marked.length;
  r.already += o.already.length;
  r.missing += o.missing.length;
  r.failed += o.failed.length;
}

// ── per-run upstream lookups ─────────────────────────────────────────────────

// One Plex server for one run: config, owner, episode lists and the paired
// accounts' own tokens, each read at most once. The tokens never leave this
// object (no store, no log, no response).
class PlexServer {
  readonly slug: string;
  private readonly signal: AbortSignal | undefined;
  private cfgP: Promise<{ url: string; token: string } | null> | null = null;
  private ownerP: Promise<string | null> | null = null;
  private sharedP: Promise<Map<string, string>> | null = null;
  private readonly homeTokens = new Map<string, Promise<string | null>>();
  private readonly episodes = new Map<string, Promise<EpisodeIdRow[]>>();

  constructor(slug: string, signal: AbortSignal | undefined) {
    this.slug = slug;
    this.signal = signal;
  }

  config(): Promise<{ url: string; token: string } | null> {
    // getPlexConfig's findUnique reads (guardrail 35's Plex note).
    this.cfgP ??= getPlexConfig(this.slug).then((c) => (c.url && c.token ? { url: c.url, token: c.token } : null));
    return this.cfgP;
  }

  ownerId(): Promise<string | null> {
    this.ownerP ??= this.config().then((c) => (c ? getPlexUser(c.token).then((u) => u.id, () => null) : null));
    return this.ownerP;
  }

  // The account's own token for this server: the owner's is the admin token;
  // a shared user's comes from shared_servers; a managed home user's from the
  // home switch. null = no access we can obtain.
  async userToken(plexAccountId: string, isServerAdmin: boolean): Promise<string | null> {
    const cfg = await this.config();
    if (!cfg) return null;
    const owner = await this.ownerId();
    if (plexAccountId === owner || (owner === null && isServerAdmin)) return cfg.token;
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
    }
    return home;
  }

  // Plex ratingKey (a movie's own, or a show's) → its TMDB title, through the
  // library cache (37c: both key columns; one owner per key, 37b).
  async titlesFor(keys: readonly string[]): Promise<(key: string) => PlexTitle | null> {
    const list = [...new Set(keys)];
    const rows = list.length === 0
      ? []
      : await prisma.plexLibraryItem.findMany({
          where: { serverInstance: this.slug, OR: [{ plexRatingKey: { in: list } }, { plexRatingKeys: { hasSome: list } }] },
          select: { tmdbId: true, mediaType: true, plexRatingKey: true, plexRatingKeys: true },
        });
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
        if (!c) throw new Error("Plex server is not configured");
        return getPlexEpisodeKeys(c.url, c.token, showKey);
      });
      p.catch(() => this.episodes.delete(showKey));
      this.episodes.set(showKey, p);
    }
    return p;
  }

  async targetsFor(plays: readonly WatchSyncPlay[]): Promise<MarkTargets> {
    const movieIds = [...new Set(plays.filter((p) => p.mediaType === "MOVIE").map((p) => p.tmdbId))];
    const tvIds = seriesNeeded(plays);
    const movies = new Map<number, string[]>();
    const episodes = new Map<number, Map<string, string[]>>();
    if (movieIds.length === 0 && tvIds.length === 0) return { movies, episodes };
    if (!(await this.config())) throw new Error("Plex server is not configured");
    const rows = await prisma.plexLibraryItem.findMany({
      where: {
        serverInstance: this.slug,
        OR: [
          ...(movieIds.length > 0 ? [{ mediaType: "MOVIE" as const, tmdbId: { in: movieIds } }] : []),
          ...(tvIds.length > 0 ? [{ mediaType: "TV" as const, tmdbId: { in: tvIds } }] : []),
        ],
      },
      select: { tmdbId: true, mediaType: true, plexRatingKey: true, plexRatingKeys: true },
    });
    // Every copy of a title (guardrail 37c: OR the two columns).
    const keysOf = (r: { plexRatingKey: string | null; plexRatingKeys: string[] }) =>
      [...new Set([...(r.plexRatingKey ? [r.plexRatingKey] : []), ...(r.plexRatingKeys ?? []).filter(Boolean)])];
    for (const r of rows) if (r.mediaType === "MOVIE") movies.set(r.tmdbId, keysOf(r));
    for (const r of rows) {
      if (r.mediaType !== "TV") continue;
      if (this.signal?.aborted) break;
      const all: EpisodeIdRow[] = [];
      for (const showKey of keysOf(r)) for (const ep of await this.episodesOf(showKey)) all.push(ep);
      episodes.set(r.tmdbId, indexEpisodes(all));
    }
    return { movies, episodes };
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
      p = getJellyfinConfig(slug).then((c) => {
        if (!c.url || !c.apiKey) throw new Error("Jellyfin server is not configured");
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
    if (ids.length > 0) {
      const rows = await prisma.jellyfinLibraryItem.findMany({
        where: { serverInstance: slug, OR: [{ jellyfinItemId: { in: ids } }, { jellyfinItemIds: { hasSome: ids } }] },
        select: { tmdbId: true, mediaType: true, jellyfinItemId: true, jellyfinItemIds: true },
        orderBy: { tmdbId: "asc" },
      });
      for (const r of rows) {
        for (const id of [r.jellyfinItemId, ...(r.jellyfinItemIds ?? [])]) {
          if (id && !map.has(id)) map.set(id, { tmdbId: r.tmdbId, mediaType: r.mediaType });
        }
      }
    }
    return (id) => map.get(id) ?? null;
  }

  async targetsFor(slug: string, plays: readonly WatchSyncPlay[]): Promise<MarkTargets> {
    const movieIds = [...new Set(plays.filter((p) => p.mediaType === "MOVIE").map((p) => p.tmdbId))];
    const tvIds = seriesNeeded(plays);
    const movies = new Map<number, string[]>();
    const episodes = new Map<number, Map<string, string[]>>();
    if (movieIds.length === 0 && tvIds.length === 0) return { movies, episodes };
    await this.config(slug);

    const rows = await prisma.jellyfinLibraryItem.findMany({
      where: {
        serverInstance: slug,
        OR: [
          ...(movieIds.length > 0 ? [{ mediaType: "MOVIE" as const, tmdbId: { in: movieIds } }] : []),
          ...(tvIds.length > 0 ? [{ mediaType: "TV" as const, tmdbId: { in: tvIds } }] : []),
        ],
      },
      select: { tmdbId: true, mediaType: true, jellyfinItemId: true, jellyfinItemIds: true },
    });
    // Every copy of a title (guardrail 37: OR the two columns).
    const idsOf = (r: { jellyfinItemId: string | null; jellyfinItemIds: string[] }) =>
      [...new Set([...(r.jellyfinItemId ? [r.jellyfinItemId] : []), ...(r.jellyfinItemIds ?? []).filter(Boolean)])];

    for (const r of rows) {
      if (r.mediaType === "MOVIE") movies.set(r.tmdbId, idsOf(r));
    }
    // Series one at a time: each is a paged Jellyfin walk.
    for (const r of rows) {
      if (r.mediaType !== "TV") continue;
      if (this.signal?.aborted) break;
      const all: EpisodeIdRow[] = [];
      for (const seriesId of idsOf(r)) {
        for (const ep of await this.episodesOf(slug, seriesId)) all.push(ep);
      }
      episodes.set(r.tmdbId, indexEpisodes(all));
    }
    return { movies, episodes };
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
