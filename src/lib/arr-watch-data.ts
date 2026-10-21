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
import { readQueuePages } from "./arr-queue-data";
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
  type InstanceWatchState,
  type WatchInstance,
} from "./arr-watch";
import { forgetWarnOnChange, warnOnChange } from "./log-dedup";
import { emitNotificationEvents } from "./notify-agents";
import type { NotifyEvent } from "./notify-events";
import { prisma } from "./prisma";

export const ARR_WATCH_STATE_KEY = "arrWatch:state";
export const ARR_WATCH_SUMMARY_KEY = "arrWatch:summary";

// Polled reads: a dark instance is given up on well inside the run.
const READ_TIMEOUT_MS = 20_000;
// Failures since the cursor when the arr has no /history/since (it 404s): the
// newest page, filtered to what the cursor has not seen.
const FALLBACK_PAGE_SIZE = 200;
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

async function readHistory(cfg: ArrCfg, inst: WatchInstance, sinceIso: string, signal?: AbortSignal): Promise<unknown> {
  const include = inst.service === "radarr" ? "includeMovie=true" : "includeSeries=true&includeEpisode=true";
  // DownloadFailed is 4 in both arrs' history enums (arr-history.ts EVENT_IDS).
  const opts = { quietErrors: true, timeoutMs: READ_TIMEOUT_MS, ...(signal ? { signal } : {}) };
  try {
    return await arrFetch<unknown>(cfg, `/api/v3/history/since?date=${encodeURIComponent(sinceIso)}&eventType=4&${include}`, opts);
  } catch (err) {
    if (!(err instanceof ArrResponseError) || err.status !== 404) throw err;
    const page = await arrFetch<{ records?: unknown } | null>(
      cfg,
      `/api/v3/history?page=1&pageSize=${FALLBACK_PAGE_SIZE}&sortKey=date&sortDirection=descending&eventType=4&${include}`,
      opts,
    );
    return page && Array.isArray(page.records) ? page.records : [];
  }
}

interface InstanceOutcome {
  state: InstanceWatchState;
  events: NotifyEvent[];
  errors: Array<{ part: ArrWatchPart; error: string }>;
  deferred: number;
  deferredAttention: number;
}

async function watchInstance(
  inst: WatchInstance,
  prev: InstanceWatchState | undefined,
  thresholdPercent: number,
  nowMs: number,
  signal?: AbortSignal,
): Promise<InstanceOutcome> {
  const state: InstanceWatchState = { ...prev };
  const events: NotifyEvent[] = [];
  const errors: InstanceOutcome["errors"] = [];
  const cfg = await getArrCfg(inst.service, inst.slug);
  // De-configured between the instance list and here: nothing was read, so every part keeps its state.
  if (!cfg) return { state, events, errors: PARTS.map((part) => ({ part, error: "not configured" })), deferred: 0, deferredAttention: 0 };
  const opts = { quietErrors: true, timeoutMs: READ_TIMEOUT_MS, ...(signal ? { signal } : {}) };
  const { cursor, seeded } = effectiveCursor(prev?.history?.cursor ?? null, nowMs);

  const [disk, history, queue] = await Promise.allSettled([
    Promise.all([
      arrFetch<unknown>(cfg, "/api/v3/rootfolder", opts),
      arrFetch<unknown>(cfg, "/api/v3/diskspace", opts),
    ]),
    seeded ? Promise.resolve(null) : readHistory(cfg, inst, new Date(Date.parse(cursor.at) - HISTORY_QUERY_OVERLAP_MS).toISOString(), signal),
    readQueuePages(inst.service, inst.slug, signal),
  ]);

  // Disks: state changes only — a disk missing from this read keeps its state for the grace period.
  if (disk.status === "fulfilled") {
    const disks = projectDisks(disk.value[1]);
    const judged = judgeDisks(readDisks(projectRootFolders(disk.value[0], disks), disks), thresholdPercent, prev?.disks ?? null, {
      gone: prev?.goneDisks ?? null,
      nowMs,
    });
    state.disks = judged.next;
    state.goneDisks = judged.gone;
    for (const t of judged.transitions) events.push(diskEvent(inst, t, thresholdPercent));
  } else {
    errors.push({ part: "disk", error: arrErrorMessage(disk.reason) });
  }

  // Failed downloads: every new one, once.
  let deferred = 0;
  const failedAt: string[] = [];
  if (history.status === "fulfilled") {
    // A seeded cursor read nothing (null projects to no records): it is stored as is.
    // nowMs bounds the cursor from the future: a record dated past Summonarr's clock (+1 h) waits, unconsumed.
    const picked = selectNewFailures(
      projectHistoryRecords(inst.service, inst.slug, history.value),
      cursor,
      prev?.history?.recent ?? [],
      MAX_FAILURES_PER_RUN,
      nowMs,
    );
    state.history = { cursor: picked.cursor, recent: picked.recent };
    for (const g of picked.groups) {
      events.push(failureEvent(inst, g));
      failedAt.push(g.at);
    }
    deferred = picked.deferred;
  } else {
    errors.push({ part: "history", error: arrErrorMessage(history.reason) });
  }
  // The 24-hour count ages on every run, read or not.
  state.failures = recentFailureTimes(prev?.failures, failedAt, nowMs);

  // Downloads that newly need attention — remembered for the grace period, at most a capped few per run.
  let deferredAttention = 0;
  if (queue.status === "fulfilled") {
    // readAt alone is not memory (it never exists without the keys): no keys ⇒ a silent seed.
    const memory = prev?.attention !== undefined || prev?.attentionSeen !== undefined
      ? { keys: prev.attention, seen: prev.attentionSeen, readAt: prev.attentionReadAt }
      : null;
    // The read gap follows the configured cadence — a daily monitor's regular
    // 24 h gap is observed time, not an outage.
    const diff = diffAttention(
      foldQueueRecords(inst.service, inst.slug, queue.value),
      memory,
      nowMs,
      MAX_ATTENTION_PER_RUN,
      attentionReadGapMs(arrWatchIntervalSeconds(process.env.ARR_WATCH_INTERVAL)),
    );
    state.attention = diff.keys;
    state.attentionSeen = diff.seen;
    // Stamped on a SUCCESSFUL read only: a failed one keeps the previous stamp
    // (the spread of prev above), so the time it couldn't see stays unobserved.
    state.attentionReadAt = new Date(nowMs).toISOString();
    for (const item of diff.newly) events.push(attentionEvent(inst, item));
    deferredAttention = diff.deferred;
  } else {
    errors.push({ part: "queue", error: arrErrorMessage(queue.reason) });
  }

  return { state, events, errors, deferred, deferredAttention };
}

/**
 * One monitor run over every configured, enabled instance, one instance at a
 * time. The AbortSignal (the advisory lock's — guardrail 41) is observed at
 * every instance boundary and once more before anything is written: a run the
 * lock gave up on stores NOTHING and sends nothing, because by then the lock is
 * released and the next run may already be reading the same state. Its work is
 * simply redone by that run.
 */
export async function runArrWatch(opts: { signal?: AbortSignal; now?: number } = {}): Promise<ArrWatchResult> {
  const { signal } = opts;
  const nowMs = opts.now ?? Date.now();
  const [instances, thresholdPercent, stored] = await Promise.all([
    enabledArrInstances(),
    loadDiskLowPercent(),
    prisma.setting.findUnique({ where: { key: ARR_WATCH_STATE_KEY }, select: { value: true } }),
  ]);
  const prev = parseArrWatchState(stored?.value);

  // Instances no longer configured (or switched off) are dropped, so one that
  // comes back re-seeds instead of replaying everything it missed.
  const next: ArrWatchState = { instances: {} };
  const events: NotifyEvent[] = [];
  const result: ArrWatchResult = {
    checked: 0,
    notReached: 0,
    aborted: false,
    errors: [],
    events: { diskLow: 0, diskOk: 0, downloadFailed: 0, queueAttention: 0 },
    deferredFailures: 0,
    deferredAttention: 0,
    summary: { attention: 0, lowDisks: 0, failed24h: 0 },
  };

  for (let i = 0; i < instances.length; i++) {
    if (signal?.aborted) {
      result.aborted = true;
      result.notReached = instances.length - i;
      return result;
    }
    const inst: WatchInstance = { service: instances[i].service, slug: instances[i].slug, name: instances[i].name };
    const key = instanceStateKey(inst.service, inst.slug);
    const outcome = await watchInstance(inst, prev.instances[key], thresholdPercent, nowMs, signal);
    next.instances[key] = outcome.state;
    events.push(...outcome.events);
    result.deferredFailures += outcome.deferred;
    result.deferredAttention += outcome.deferredAttention;
    result.checked++;
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
  if (signal?.aborted) {
    result.aborted = true;
    return result;
  }

  result.summary = summarize(next, nowMs);
  const summary: ArrWatchSummary = { at: new Date(nowMs).toISOString(), ...result.summary };
  // State first, events second: a write that fails sends nothing, and the next
  // run — reading the old state — finds the same events again. The reverse
  // order would announce them twice.
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

  for (const ev of events) {
    if (ev.event === "arr.disk_low") result.events.diskLow++;
    else if (ev.event === "arr.disk_ok") result.events.diskOk++;
    else if (ev.event === "arr.download_failed") result.events.downloadFailed++;
    else if (ev.event === "arr.queue_attention") result.events.queueAttention++;
  }
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
