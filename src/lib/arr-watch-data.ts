// The Radarr/Sonarr monitor: the data half. One run (the arr-watch cron)
// reads every configured, enabled instance — its disks, its failed-download
// history since the last run, and its queue — judges them with the pure rules
// in arr-watch.ts, stores what the next run needs, and only THEN hands the
// events to the outbound notification channels (guardrail 14c). Every call
// goes through arrFetch (guardrail 5) on an instance enabledArrInstances lists
// (guardrail 32); a failed read is isolated to its instance and part, keeps
// that part's previous state, and is logged once per unchanged condition
// (guardrail 7b).
import { ArrResponseError, arrErrorMessage, arrFetch, getArrCfg, type ArrCfg } from "./arr";
import { enabledArrInstances } from "./arr-admin";
import { projectHistoryRecords } from "./arr-history";
import { foldQueueRecords } from "./arr-queue";
import { readQueueListing, type QueueListing } from "./arr-queue-data";
import { mapLimit } from "./concurrency";
import { projectDisks, projectRootFolders } from "./arr-system";
import {
  ARR_WATCH_DISK_LOW_PERCENT_KEY,
  arrWatchIntervalSeconds,
  attentionEvent,
  attentionReadGapMs,
  diffAttention,
  diskEvent,
  effectiveCursor,
  failureEvent,
  instanceStateKey,
  judgeDisks,
  MAX_ATTENTION_PER_RUN,
  MAX_FAILURES_PER_RUN,
  parseArrWatchState,
  parseArrWatchSummary,
  parseDiskLowPercent,
  queueBadgeCount,
  readDisks,
  recentFailureTimes,
  selectNewFailures,
  summarize,
  type ArrWatchCounts,
  type ArrWatchState,
  type ArrWatchSummary,
  type HistoryCursor,
  type InstanceWatchState,
  type WatchInstance,
} from "./arr-watch";
import { forgetWarnOnChange, warnOnChange } from "./log-dedup";
import { emitNotificationEvents } from "./notify-agents";
import type { NotifyEvent } from "./notify-events";
import { prisma } from "./prisma";
import { emitSSE } from "./sse-emitter";

export const ARR_WATCH_STATE_KEY = "arrWatch:state";
export const ARR_WATCH_SUMMARY_KEY = "arrWatch:summary";

// Polled reads: a dark instance is given up on well inside the run.
const READ_TIMEOUT_MS = 20_000;
// One instance's reads share this budget, well inside the run's (the cron's
// 10 minutes). A slow but answering instance — 40 queue pages at up to 20 s
// each — held the run past its lock, and an aborted run saves nothing (7c,
// guardrail 41), so no instance's state was ever saved again. When the budget,
// not the lock, ends an instance's reads, its unfinished parts fail like any
// failed read: they keep their previous state and are reported, and the run
// goes on to the next instance.
export const INSTANCE_READ_BUDGET_MS = 2 * 60_000;
// Failures since the cursor when the arr has no /history/since (it 404s): the
// newest pages, read back until one reaches the queried date, filtered to what
// the cursor has not seen. Past FALLBACK_MAX_PAGES the older failures can't be
// reached: the run says so instead of passing them by unannounced.
const FALLBACK_PAGE_SIZE = 200;
const FALLBACK_MAX_PAGES = 5;
// /history/since is asked from this far BEFORE the cursor. Radarr/Sonarr v3
// parse the date with DateTime.Parse, which turns a UTC "…Z" into the HOST's
// local time; were that ever compared as UTC, an arr east of Greenwich would
// skip the failures between the cursor and its offset. The widest offset is
// 14 hours. Everything the overlap returns twice is dropped by the cursor
// position (selectNewFailures), so it costs a few repeated records, never a
// repeated alert.
const HISTORY_QUERY_OVERLAP_MS = 14 * 60 * 60_000;

export type ArrWatchPart = "disk" | "history" | "queue";
const PARTS: readonly ArrWatchPart[] = ["disk", "history", "queue"];

export interface ArrWatchResult {
  /** Instances read this run. */
  checked: number;
  /** Instances not reached because the run was stopped (the lock's AbortSignal). */
  notReached: number;
  aborted: boolean;
  errors: Array<{ service: string; instance: string; part: ArrWatchPart; error: string }>;
  events: { diskLow: number; diskOk: number; downloadFailed: number; queueAttention: number };
  /**
   * History RECORDS left for the next run once the per-run cap was reached. A
   * Sonarr pack counts once per episode, so this is not a count of downloads.
   */
  deferredFailures: number;
  /** Downloads newly needing attention left for the next run (more than one run announces). */
  deferredAttention: number;
  summary: ArrWatchCounts;
}

/** Whether there is anything to watch: an enabled integration with at least one configured instance. */
export async function hasWatchableArrInstance(): Promise<boolean> {
  return (await enabledArrInstances()).length > 0;
}

export async function loadDiskLowPercent(): Promise<number> {
  const row = await prisma.setting.findUnique({ where: { key: ARR_WATCH_DISK_LOW_PERCENT_KEY }, select: { value: true } });
  return parseDiskLowPercent(row?.value);
}

/** The failures read; `truncated` when the fallback's page cap, not the queried date, ended the read. */
interface HistoryRead { records: unknown; truncated: boolean }

async function readHistory(cfg: ArrCfg, inst: WatchInstance, sinceIso: string, signal?: AbortSignal): Promise<HistoryRead> {
  const include = inst.service === "radarr" ? "includeMovie=true" : "includeSeries=true&includeEpisode=true";
  // DownloadFailed is 4 in both arrs' history enums (arr-history.ts EVENT_IDS).
  const opts = { quietErrors: true, timeoutMs: READ_TIMEOUT_MS, ...(signal ? { signal } : {}) };
  try {
    return { records: await arrFetch<unknown>(cfg, `/api/v3/history/since?date=${encodeURIComponent(sinceIso)}&eventType=4&${include}`, opts), truncated: false };
  } catch (err) {
    if (!(err instanceof ArrResponseError) || err.status !== 404) throw err;
  }
  const sinceMs = Date.parse(sinceIso);
  const records: unknown[] = [];
  for (let page = 1; page <= FALLBACK_MAX_PAGES; page++) {
    const res = await arrFetch<{ records?: unknown } | null>(
      cfg,
      `/api/v3/history?page=${page}&pageSize=${FALLBACK_PAGE_SIZE}&sortKey=date&sortDirection=descending&eventType=4&${include}`,
      opts,
    );
    const batch = res && Array.isArray(res.records) ? res.records.slice(0, FALLBACK_PAGE_SIZE) : [];
    for (const r of batch) records.push(r);
    // Newest first: a short page is the end, and a page reaching back to the
    // queried date holds everything the cursor has not seen.
    const oldest = batch.length > 0 ? (batch[batch.length - 1] as { date?: unknown } | null)?.date : undefined;
    const oldestMs = typeof oldest === "string" ? Date.parse(oldest) : Number.NaN;
    // A boundary record with no readable date proves nothing about the cursor:
    // read on (the page cap still bounds it) rather than call the read complete.
    if (batch.length < FALLBACK_PAGE_SIZE || (Number.isFinite(oldestMs) && oldestMs <= sinceMs)) return { records, truncated: false };
  }
  return { records, truncated: true };
}

interface InstanceOutcome {
  state: InstanceWatchState;
  events: NotifyEvent[];
  errors: Array<{ part: ArrWatchPart; error: string }>;
  deferred: number;
  deferredAttention: number;
}

// The parts an instance's reads were still on when its budget ran out.
const budgetMessage = (budgetMs: number) => `stopped by the instance's ${Math.round(budgetMs / 1000)}s read budget`;

// Nothing was read: every part keeps its previous state and reports `error`.
function unreadOutcome(prev: InstanceWatchState | undefined, error: string): InstanceOutcome {
  return { state: { ...prev }, events: [], errors: PARTS.map((part) => ({ part, error })), deferred: 0, deferredAttention: 0 };
}

type DiskRead = [rootFolders: unknown, diskSpace: unknown];
interface InstanceReads {
  disk: PromiseSettledResult<DiskRead>;
  /** null: a seeded cursor, nothing to read. */
  history: PromiseSettledResult<HistoryRead | null>;
  queue: PromiseSettledResult<QueueListing>;
}

/**
 * The three reads, in parallel. They stop at the lock's signal OR this
 * instance's budget, whichever fires first (a ref'd timer, cleared once the
 * reads settle).
 */
async function readInstance(
  cfg: ArrCfg,
  inst: WatchInstance,
  historyFrom: string | null,
  signal: AbortSignal | undefined,
  budgetMs: number,
): Promise<InstanceReads> {
  const budget = new AbortController();
  const timer = setTimeout(() => budget.abort(new Error(budgetMessage(budgetMs))), budgetMs);
  const readSignal = signal ? AbortSignal.any([signal, budget.signal]) : budget.signal;
  const opts = { quietErrors: true, timeoutMs: READ_TIMEOUT_MS, signal: readSignal };
  // A part that fails once the budget has run out failed BECAUSE of it; one
  // that failed before keeps its own reason.
  const inBudget = <T>(p: Promise<T>): Promise<T> =>
    p.catch((err: unknown) => {
      throw budget.signal.aborted ? new Error(budgetMessage(budgetMs)) : err;
    });
  const [disk, history, queue] = await Promise.allSettled([
    inBudget(Promise.all([
      arrFetch<unknown>(cfg, "/api/v3/rootfolder", opts),
      arrFetch<unknown>(cfg, "/api/v3/diskspace", opts),
    ])),
    historyFrom === null ? Promise.resolve(null) : inBudget(readHistory(cfg, inst, historyFrom, readSignal)),
    inBudget(readQueueListing(cfg, inst.service, readSignal)),
  ]).finally(() => clearTimeout(timer));
  return { disk, history, queue };
}

// Disks: state changes only — a disk missing from this read keeps its state for the grace period.
function judgeDiskPart(read: DiskRead, inst: WatchInstance, prev: InstanceWatchState | undefined, thresholdPercent: number, nowMs: number, out: InstanceOutcome): void {
  const disks = projectDisks(read[1]);
  const judged = judgeDisks(readDisks(projectRootFolders(read[0], disks), disks), thresholdPercent, prev?.disks ?? null, {
    gone: prev?.goneDisks ?? null,
    nowMs,
  });
  out.state.disks = judged.next;
  out.state.goneDisks = judged.gone;
  for (const t of judged.transitions) out.events.push(diskEvent(inst, t, thresholdPercent));
}

// Failed downloads: every new one, once. Returns when each announced one failed.
function judgeHistoryPart(read: HistoryRead | null, inst: WatchInstance, prev: InstanceWatchState | undefined, cursor: HistoryCursor, nowMs: number, out: InstanceOutcome): string[] {
  // A seeded cursor read nothing (null projects to no records): it is stored as is.
  // nowMs bounds the cursor from the future: a record dated past Summonarr's clock (+1 h) waits, unconsumed.
  const picked = selectNewFailures(
    projectHistoryRecords(inst.service, inst.slug, read?.records ?? null),
    cursor,
    prev?.history?.recent ?? [],
    MAX_FAILURES_PER_RUN,
    nowMs,
  );
  out.state.history = { cursor: picked.cursor, recent: picked.recent };
  const failedAt: string[] = [];
  for (const g of picked.groups) {
    out.events.push(failureEvent(inst, g));
    failedAt.push(g.at);
  }
  out.deferred = picked.deferred;
  // The failures older than the fallback's last page are passed by: said, not silent.
  if (read?.truncated) {
    out.errors.push({ part: "history", error: `no /history/since: only the newest ${FALLBACK_MAX_PAGES * FALLBACK_PAGE_SIZE} failures could be read, older ones since the last run were not announced` });
  }
  return failedAt;
}

// Downloads that newly need attention — remembered for the grace period, at most a capped few per run.
function judgeQueuePart(listing: QueueListing, inst: WatchInstance, prev: InstanceWatchState | undefined, nowMs: number, budgetMs: number, out: InstanceOutcome): void {
  // A walk the signal stopped is partial: folding it would read every download
  // past it as gone. Only the budget gets here (a lock abort discards the run).
  if (listing.stopped) {
    out.errors.push({ part: "queue", error: budgetMessage(budgetMs) });
    return;
  }
  // readAt alone is not memory (it never exists without the keys): no keys ⇒ a silent seed.
  const memory = prev?.attention !== undefined || prev?.attentionSeen !== undefined
    ? { keys: prev.attention, seen: prev.attentionSeen, readAt: prev.attentionReadAt }
    : null;
  // The read gap follows the configured cadence — a daily monitor's regular
  // 24 h gap is observed time, not an outage.
  const diff = diffAttention(
    foldQueueRecords(inst.service, inst.slug, listing.records),
    memory,
    nowMs,
    MAX_ATTENTION_PER_RUN,
    attentionReadGapMs(arrWatchIntervalSeconds(process.env.ARR_WATCH_INTERVAL)),
  );
  out.state.attention = diff.keys;
  out.state.attentionSeen = diff.seen;
  // Stamped on a SUCCESSFUL read only: a failed one keeps the previous stamp
  // (the spread of prev), so the time it couldn't see stays unobserved.
  out.state.attentionReadAt = new Date(nowMs).toISOString();
  for (const item of diff.newly) out.events.push(attentionEvent(inst, item));
  out.deferredAttention = diff.deferred;
}

async function watchInstance(
  inst: WatchInstance,
  prev: InstanceWatchState | undefined,
  thresholdPercent: number,
  nowMs: number,
  signal: AbortSignal | undefined,
  budgetMs: number,
): Promise<InstanceOutcome> {
  let cfg: ArrCfg | null;
  try {
    cfg = await getArrCfg(inst.service, inst.slug);
  } catch (err) {
    // A failed config read is this instance's failure, not the run's.
    return unreadOutcome(prev, `config read failed: ${err instanceof Error ? err.message : String(err)}`);
  }
  // De-configured between the instance list and here: nothing was read, so every part keeps its state.
  if (!cfg) return unreadOutcome(prev, "not configured");
  const { cursor, seeded } = effectiveCursor(prev?.history?.cursor ?? null, nowMs);
  const historyFrom = seeded ? null : new Date(Date.parse(cursor.at) - HISTORY_QUERY_OVERLAP_MS).toISOString();
  const reads = await readInstance(cfg, inst, historyFrom, signal, budgetMs);

  const out: InstanceOutcome = { state: { ...prev }, events: [], errors: [], deferred: 0, deferredAttention: 0 };
  if (reads.disk.status === "fulfilled") judgeDiskPart(reads.disk.value, inst, prev, thresholdPercent, nowMs, out);
  else out.errors.push({ part: "disk", error: arrErrorMessage(reads.disk.reason) });

  const failedAt = reads.history.status === "fulfilled" ? judgeHistoryPart(reads.history.value, inst, prev, cursor, nowMs, out) : [];
  if (reads.history.status === "rejected") out.errors.push({ part: "history", error: arrErrorMessage(reads.history.reason) });
  // The 24-hour count ages on every run, read or not.
  out.state.failures = recentFailureTimes(prev?.failures, failedAt, nowMs);

  if (reads.queue.status === "fulfilled") judgeQueuePart(reads.queue.value, inst, prev, nowMs, budgetMs, out);
  else out.errors.push({ part: "queue", error: arrErrorMessage(reads.queue.reason) });
  return out;
}

// Instances read at once. Each instance's reads are bounded by its own budget,
// so this bounds the run: a few slow instances no longer add up past the lock.
export const ARR_WATCH_INSTANCE_CONCURRENCY = 3;

function emptyResult(): ArrWatchResult {
  return {
    checked: 0,
    notReached: 0,
    aborted: false,
    errors: [],
    events: { diskLow: 0, diskOk: 0, downloadFailed: 0, queueAttention: 0 },
    deferredFailures: 0,
    deferredAttention: 0,
    summary: { attention: 0, lowDisks: 0, failed24h: 0 },
  };
}

// One instance's failed parts into the result, logged once per unchanged condition.
function recordInstanceErrors(inst: WatchInstance, outcome: InstanceOutcome, result: ArrWatchResult): void {
  for (const part of PARTS) {
    const logKey = `arr-watch:${part}:${inst.service}:${inst.slug}`;
    const failed = outcome.errors.find((e) => e.part === part);
    if (!failed) {
      forgetWarnOnChange(logKey);
      continue;
    }
    result.errors.push({ service: inst.service, instance: inst.slug, part, error: failed.error });
    // A dark instance fails every run: one line per unchanged condition.
    warnOnChange(logKey, failed.error, `[arr-watch] ${inst.service} instance "${inst.slug}" ${part} read failed: ${failed.error}`);
  }
}

function countEvents(events: readonly NotifyEvent[], result: ArrWatchResult): void {
  for (const ev of events) {
    if (ev.event === "arr.disk_low") result.events.diskLow++;
    else if (ev.event === "arr.disk_ok") result.events.diskOk++;
    else if (ev.event === "arr.download_failed") result.events.downloadFailed++;
    else if (ev.event === "arr.queue_attention") result.events.queueAttention++;
  }
}

async function saveArrWatchState(next: ArrWatchState, summary: ArrWatchSummary): Promise<void> {
  await prisma.$transaction([
    prisma.setting.upsert({
      where: { key: ARR_WATCH_STATE_KEY },
      create: { key: ARR_WATCH_STATE_KEY, value: JSON.stringify(next) },
      update: { value: JSON.stringify(next) },
    }),
    prisma.setting.upsert({
      where: { key: ARR_WATCH_SUMMARY_KEY },
      create: { key: ARR_WATCH_SUMMARY_KEY, value: JSON.stringify(summary) },
      update: { value: JSON.stringify(summary) },
    }),
  ]);
}

/**
 * One monitor run over every configured, enabled instance, at most
 * ARR_WATCH_INSTANCE_CONCURRENCY at a time. The AbortSignal (the advisory
 * lock's — guardrail 41) is observed before each instance starts and once more
 * before anything is written: a run the lock gave up on stores NOTHING and
 * sends nothing, because by then the lock is released and the next run may
 * already be reading the same state. Its work is simply redone by that run. So
 * that slow instances can't make every run end that way, each instance's reads
 * stop at `instanceBudgetMs` (INSTANCE_READ_BUDGET_MS): what they hadn't
 * finished keeps its state.
 */
export async function runArrWatch(opts: { signal?: AbortSignal; now?: number; instanceBudgetMs?: number } = {}): Promise<ArrWatchResult> {
  const { signal } = opts;
  const nowMs = opts.now ?? Date.now();
  const budgetMs = opts.instanceBudgetMs ?? INSTANCE_READ_BUDGET_MS;
  const [instances, thresholdPercent, stored] = await Promise.all([
    enabledArrInstances(),
    loadDiskLowPercent(),
    prisma.setting.findUnique({ where: { key: ARR_WATCH_STATE_KEY }, select: { value: true } }),
  ]);
  const prev = parseArrWatchState(stored?.value);
  const result = emptyResult();

  const watched: WatchInstance[] = instances.map((i) => ({ service: i.service, slug: i.slug, name: i.name }));
  // null: not started, because the signal had fired.
  const outcomes = await mapLimit(watched, ARR_WATCH_INSTANCE_CONCURRENCY, async (inst) =>
    signal?.aborted ? null : watchInstance(inst, prev.instances[instanceStateKey(inst.service, inst.slug)], thresholdPercent, nowMs, signal, budgetMs),
  );

  // Instances no longer configured (or switched off) are dropped, so one that
  // comes back re-seeds instead of replaying everything it missed.
  const next: ArrWatchState = { instances: {} };
  const events: NotifyEvent[] = [];
  watched.forEach((inst, i) => {
    const outcome = outcomes[i];
    if (!outcome) {
      result.notReached++;
      return;
    }
    next.instances[instanceStateKey(inst.service, inst.slug)] = outcome.state;
    for (const ev of outcome.events) events.push(ev);
    result.deferredFailures += outcome.deferred;
    result.deferredAttention += outcome.deferredAttention;
    result.checked++;
    recordInstanceErrors(inst, outcome, result);
  });
  if (signal?.aborted) {
    result.aborted = true;
    return result;
  }

  result.summary = summarize(next, nowMs);
  // State first, events second: a write that fails sends nothing, and the next
  // run — reading the old state — finds the same events again. The reverse
  // order would announce them twice.
  const summary: ArrWatchSummary = { at: new Date(nowMs).toISOString(), ...result.summary };
  await saveArrWatchState(next, summary);
  // After the write (guardrail 27): open admin tabs take the new badge now
  // instead of on their next poll. emitSSE never throws.
  emitSSE({ type: "nav:badges", badges: arrWatchNavBadgesFor(summary, nowMs) ?? {} });
  countEvents(events, result);
  // Fire-and-forget; never throws (guardrail 14c).
  emitNotificationEvents(events);
  return result;
}

/** The last run's counts, or null when there has been none. */
export async function readArrWatchSummary(): Promise<ArrWatchSummary | null> {
  const row = await prisma.setting.findUnique({ where: { key: ARR_WATCH_SUMMARY_KEY }, select: { value: true } });
  return parseArrWatchSummary(row?.value);
}

/**
 * The admin nav's badges from a summary already read: { "/admin/queue":
 * <downloads needing attention> }, or undefined — no snapshot, a zero count or
 * a snapshot older than three monitor intervals (at least an hour) is no
 * badge. The one rule both readers share: the (app) layout's first render and
 * GET /api/admin/arr-watch, which the browser re-reads (NavBadgesProvider).
 */
export function arrWatchNavBadgesFor(summary: ArrWatchSummary | null, nowMs: number): Record<string, number> | undefined {
  const maxAgeMs = Math.max(3 * arrWatchIntervalSeconds(process.env.ARR_WATCH_INTERVAL) * 1000, 60 * 60_000);
  const n = queueBadgeCount(summary, nowMs, maxAgeMs);
  return n === null ? undefined : { "/admin/queue": n };
}

/**
 * The admin nav's badges (arrWatchNavBadgesFor). ONE Setting read; fails OPEN —
 * any error is no badge, never a broken page.
 */
export async function readArrWatchNavBadges(): Promise<Record<string, number> | undefined> {
  try {
    return arrWatchNavBadgesFor(await readArrWatchSummary(), Date.now());
  } catch {
    return undefined;
  }
}
