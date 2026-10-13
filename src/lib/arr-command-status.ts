// Following a Radarr/Sonarr command Summonarr started — the pure half, shared by
// the server (GET /api/admin/arr/commands projects each command through
// projectCommandState) and the browser (the watch in
// components/admin/arr-command-watch.tsx runs createCommandWatcher, reads the
// route's answer through parseCommandStates and decides what to say with
// summarizeCommands / commandLine). No I/O of its own — the watcher is handed
// fetch and timers by its host — and no clock: a watch ends on a COUNT of
// polls, never a time read (guardrail 16).
//
// The arr answers POST /api/v3/command with the command it queued (its `id`)
// and reports it at GET /api/v3/command/{id} while it remembers it:
// queued → started → completed / failed / aborted / cancelled / orphaned, with
// a progress or result line in `message` ("Searching 41 of 212"). It forgets a
// finished command after a while — a 404 there is "gone": over, outcome no
// longer known.
import { projectCommands, type ArrCommandRow, type CommandStatus } from "./arr-system";

/**
 * One command as the read route reports it: the explicit field list Arr System
 * shows for a command (projectCommands, `trigger` left out), the message
 * masked — NEVER the command body (it can hold paths, ids and import details;
 * guardrail 5e). An id the arr no longer has is `{ id, status: "gone" }`.
 */
export type ArrCommandState =
  | { id: number; status: "gone" }
  | Omit<ArrCommandRow, "trigger">;

export type WatchedStatus = CommandStatus | "gone";

/** The arr's GET /api/v3/command/{id} answer → the state for `id`. */
export function projectCommandState(raw: unknown, id: number): ArrCommandState {
  const row = projectCommands([raw], 1)[0];
  // An answer about ANOTHER command (or no command at all) says nothing about
  // this one: its status is not known, which ends the watch rather than
  // reporting someone else's outcome.
  if (!row || row.id !== id) {
    return { id, name: "", commandName: "", status: "unknown", queued: null, started: null, ended: null, durationSeconds: null, message: null };
  }
  return {
    id: row.id,
    name: row.name,
    commandName: row.commandName,
    status: row.status,
    queued: row.queued,
    started: row.started,
    ended: row.ended,
    durationSeconds: row.durationSeconds,
    message: row.message,
  };
}

/**
 * Only queued and started are still going. Everything else has ended —
 * including a status this version doesn't know ("unknown"): it would read the
 * same on every poll, so waiting longer could never learn more.
 */
export function isTerminalCommandStatus(status: WatchedStatus): boolean {
  return status !== "queued" && status !== "started";
}

const WATCHED_STATUSES: readonly WatchedStatus[] = ["queued", "started", "completed", "failed", "aborted", "cancelled", "orphaned", "unknown", "gone"];

/**
 * The read route's answer, in the order of `ids` — null unless it holds
 * exactly one well-formed state for every id asked about (a malformed answer
 * is a failed read, never "finished").
 */
export function parseCommandStates(raw: unknown, ids: readonly number[]): ArrCommandState[] | null {
  const list = raw && typeof raw === "object" && !Array.isArray(raw) ? (raw as { commands?: unknown }).commands : null;
  if (!Array.isArray(list)) return null;
  const byId = new Map<number, ArrCommandState>();
  for (const x of list) {
    const r = x && typeof x === "object" && !Array.isArray(x) ? (x as Record<string, unknown>) : null;
    const id = r?.id;
    const status = r?.status;
    if (!r || typeof id !== "number" || !(WATCHED_STATUSES as readonly unknown[]).includes(status)) return null;
    const str = (v: unknown) => (typeof v === "string" ? v : null);
    const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : null);
    byId.set(id, status === "gone" ? { id, status: "gone" } : {
      id,
      status: status as CommandStatus,
      name: str(r.name) ?? "",
      commandName: str(r.commandName) ?? "",
      queued: str(r.queued),
      started: str(r.started),
      ended: str(r.ended),
      durationSeconds: num(r.durationSeconds),
      message: str(r.message),
    });
  }
  const out: ArrCommandState[] = [];
  for (const id of ids) {
    const s = byId.get(id);
    if (!s) return null;
    out.push(s);
  }
  return out;
}

export interface CommandSummary {
  /** Every command has ended (or is no longer listed). */
  done: boolean;
  /**
   * Still going: "started" once any has started, else "queued". Done: the
   * status that decides the line — the worst one (failed > aborted > orphaned >
   * cancelled > unknown > gone > completed), so one failed season search of
   * three is never reported as completed.
   */
  status: WatchedStatus;
  /** The arr's own line for that status: progress while running, the result once done. */
  message: string | null;
  finished: number;
  total: number;
}

const OUTCOME_RANK: Record<WatchedStatus, number> = {
  failed: 7,
  aborted: 6,
  orphaned: 5,
  cancelled: 4,
  unknown: 3,
  gone: 2,
  completed: 1,
  // never an outcome
  queued: 0,
  started: 0,
};

const messageOf = (s: ArrCommandState): string | null => ("message" in s ? s.message : null);

/** Several commands (a Sonarr "search missing" queues one per season plus one) → one line's worth. */
export function summarizeCommands(states: readonly ArrCommandState[]): CommandSummary {
  const total = states.length;
  const finished = states.filter((s) => isTerminalCommandStatus(s.status)).length;
  if (finished < total) {
    const started = states.filter((s) => s.status === "started");
    const running = started.length > 0 ? started : states.filter((s) => s.status === "queued");
    const withMessage = running.find((s) => messageOf(s));
    return { done: false, status: started.length > 0 ? "started" : "queued", message: withMessage ? messageOf(withMessage) : null, finished, total };
  }
  if (total === 0) return { done: true, status: "unknown", message: null, finished, total };
  let worst: WatchedStatus = states[0].status;
  for (const s of states) if (OUTCOME_RANK[s.status] > OUTCOME_RANK[worst]) worst = s.status;
  const deciding = states.filter((s) => s.status === worst);
  const withMessage = deciding.find((s) => messageOf(s));
  return { done: true, status: worst, message: withMessage ? messageOf(withMessage) : null, finished, total };
}

/** How a watch stopped short of every command ending. */
export type WatchStop = "timeout" | "error";

/** What the status line shows. */
export type CommandLine =
  | { kind: "waiting" }
  | { kind: "running"; status: "queued" | "started"; message: string | null; finished: number; total: number }
  | { kind: "done"; status: WatchedStatus; message: string | null; total: number }
  | { kind: "timeout" }
  | { kind: "error"; error: string };

/**
 * The line for a watch: `states` is the newest read (null until the first
 * answer), `stopped` set when the watch gave up before every command ended.
 */
export function commandLine(states: readonly ArrCommandState[] | null, stopped: WatchStop | null, error = ""): CommandLine {
  const summary = states ? summarizeCommands(states) : null;
  if (summary?.done) return { kind: "done", status: summary.status, message: summary.message, total: summary.total };
  if (stopped === "timeout") return { kind: "timeout" };
  if (stopped === "error") return { kind: "error", error };
  if (!summary) return { kind: "waiting" };
  return { kind: "running", status: summary.status === "started" ? "started" : "queued", message: summary.message, finished: summary.finished, total: summary.total };
}

export type CommandTone = "progress" | "success" | "danger" | "warning" | "neutral";

export function commandLineTone(line: CommandLine): CommandTone {
  switch (line.kind) {
    case "waiting":
    case "running":
      return "progress";
    case "timeout":
      return "warning";
    case "error":
      return "danger";
    case "done":
      if (line.status === "completed") return "success";
      if (line.status === "failed" || line.status === "aborted" || line.status === "orphaned") return "danger";
      return "neutral";
  }
}

/** A line that still needs polling — the button that started it stays disabled. */
export function isLineActive(line: CommandLine): boolean {
  return line.kind === "waiting" || line.kind === "running";
}

// ── how many ids one read carries ───────────────────────────────────────────

/**
 * The most command ids one GET /api/admin/arr/commands takes — shared by the
 * route's cap and the watch's chunking, so the two can never disagree. A
 * Sonarr "search missing" queues one SeasonSearch per fully missing season
 * plus one EpisodeSearch, uncapped by design (a long-running soap can have
 * dozens of seasons); this sits far above any real series, and a watch with
 * more ids still reads them all, this many per request (readCommandsInChunks).
 */
export const COMMAND_READ_MAX_IDS = 200;

/**
 * One poll of a watch: `ids` read COMMAND_READ_MAX_IDS at a time, one request
 * after another (never several at once against the route's rate limit), the
 * states merged in the order asked. The first chunk that isn't an answer — a
 * refusal, a failure, a 429 — is the poll's outcome, and no later chunk is read.
 */
export async function readCommandsInChunks(
  ids: readonly number[],
  readChunk: (chunk: readonly number[]) => Promise<WatchRead>,
  size: number = COMMAND_READ_MAX_IDS,
): Promise<WatchRead> {
  const step = Math.max(1, Math.floor(size));
  const states: ArrCommandState[] = [];
  for (let i = 0; i < ids.length; i += step) {
    const read = await readChunk(ids.slice(i, i + step));
    if (read.kind !== "ok") return read;
    states.push(...read.states);
  }
  return { kind: "ok", states };
}

// ── the watch's pacing ───────────────────────────────────────────────────────

/** Between two reads of a watch — measured from the previous answer, so reads never overlap. */
export const WATCH_POLL_MS = 2_000;
/** The first read comes sooner: a refresh of one title often ends inside a second or two. */
export const WATCH_FIRST_POLL_MS = 1_000;
/** ~10 minutes of reads, then the watch gives up and says so (counted, never timed). */
export const WATCH_MAX_POLLS = 300;
/** Consecutive failed reads (network, a 5xx, an unreadable answer) before it gives up. */
export const WATCH_MAX_FAILED_READS = 5;
/** A 429 waits this many polls' worth before the next read, and counts as that many. */
export const WATCH_RATE_LIMITED_POLLS = 5;

/** One poll's outcome, as the browser saw it. */
export type WatchRead =
  | { kind: "ok"; states: ArrCommandState[] }
  /**
   * The tab is hidden: nothing was read, the poll still counts — but the cap
   * is only ever declared on an ANSWER, so a watch hidden past its budget
   * reads when the tab is shown again before it gives up.
   */
  | { kind: "skipped" }
  | { kind: "rateLimited" }
  /** A 4xx: asking again can't change the answer (not an admin any more, instance gone, …). */
  | { kind: "refused"; error: string }
  /** A network failure, a 5xx, or an answer that isn't the list asked for. */
  | { kind: "failed"; error: string };

export interface WatchCounters {
  polls: number;
  failures: number;
  /**
   * Reads past the poll cap that brought no answer (a failure, a 429). Past
   * the cap only an answer ends the watch as a timeout, so these get their
   * own small budget (WATCH_MAX_FAILED_READS) instead of polling forever.
   */
  overrun?: number;
}

export type WatchStep =
  | { next: "done"; states: ArrCommandState[] }
  | { next: "stop"; stopped: WatchStop; error: string }
  | { next: "poll"; delayMs: number; states: ArrCommandState[] | null };

/**
 * After each read: finished (every command ended or gone), give up (refused,
 * too many failures in a row, or the poll cap), or read again — and when.
 */
export function watchStep(read: WatchRead, counters: WatchCounters): { step: WatchStep; counters: WatchCounters } {
  const polls = counters.polls + (read.kind === "rateLimited" ? WATCH_RATE_LIMITED_POLLS : 1);
  const pastCap = polls >= WATCH_MAX_POLLS;
  const overrun = (counters.overrun ?? 0) + (pastCap && read.kind !== "ok" && read.kind !== "skipped" ? 1 : 0);
  let failures = counters.failures;
  let states: ArrCommandState[] | null = null;
  switch (read.kind) {
    case "ok":
      failures = 0;
      if (read.states.every((s) => isTerminalCommandStatus(s.status))) {
        return { step: { next: "done", states: read.states }, counters: { polls, failures, overrun } };
      }
      states = read.states;
      break;
    case "refused":
      return { step: { next: "stop", stopped: "error", error: read.error }, counters: { polls, failures, overrun } };
    case "failed":
      failures += 1;
      if (failures >= WATCH_MAX_FAILED_READS) {
        return { step: { next: "stop", stopped: "error", error: read.error }, counters: { polls, failures, overrun } };
      }
      break;
    case "skipped":
    case "rateLimited":
      break;
  }
  // Past the cap, only an ANSWER declares the timeout. A skipped poll read
  // nothing, and neither did a failed or rate-limited one: timing out on any of
  // them gives up on commands the watch never looked at (a tab hidden for the
  // whole budget, then one network blip or 429 on return), and the page never
  // re-reads what they changed. So the first answer past the cap decides —
  // done if every command ended, otherwise the timeout — and the reads that
  // bring none get WATCH_MAX_FAILED_READS of their own before it gives up
  // (consecutive failures still stop it as an error first).
  if (pastCap && (read.kind === "ok" || (read.kind !== "skipped" && overrun >= WATCH_MAX_FAILED_READS))) {
    return { step: { next: "stop", stopped: "timeout", error: "" }, counters: { polls, failures, overrun } };
  }
  const delayMs = read.kind === "rateLimited" ? WATCH_RATE_LIMITED_POLLS * WATCH_POLL_MS : WATCH_POLL_MS;
  return { step: { next: "poll", delayMs, states }, counters: { polls, failures, overrun } };
}

// ── the watcher ──────────────────────────────────────────────────────────────

export interface WatchTarget { service: "radarr" | "sonarr"; instance: string }

/** What the watcher needs from its host — the browser hook supplies fetch, timers and React state. */
export interface WatchDriver {
  read(target: WatchTarget, ids: readonly number[]): Promise<WatchRead>;
  schedule(fn: () => void, ms: number): unknown;
  cancel(handle: unknown): void;
  /** The page is not visible: the poll counts, nothing is read (and the cap waits for an answer). */
  hidden(): boolean;
  /** The newest read for a watch, or how it stopped. */
  update(key: string, change: { states?: ArrCommandState[]; stopped?: WatchStop; error?: string }): void;
}

export interface CommandWatcher {
  /**
   * Follow `ids` on one instance under `key`, replacing (and retiring) any
   * watch there. False, following nothing, for an empty list or after `dispose()`.
   */
  start(key: string, target: WatchTarget, ids: readonly number[], onDone?: (states: ArrCommandState[]) => void): boolean;
  /** Stop one watch, or every one: no read, no update and no onDone after this. */
  stop(key?: string): void;
  /**
   * The host is gone (an unmount): stop every watch AND refuse later starts —
   * a command POST that resolves after the unmount follows nothing, so it
   * never polls behind a dead page or calls its onDone. A plain `stop()`
   * doesn't do this: a dialog that closes but stays mounted can watch again.
   */
  dispose(): void;
  /** Undo `dispose()` — the host is mounted again (React StrictMode re-runs its effects). */
  resume(): void;
  isRunning(key: string): boolean;
}

/**
 * The polling loop. One read at a time per watch — the next is scheduled only
 * from the previous answer, so a slow arr is never asked twice at once — and
 * only the run that scheduled a read may act on its answer: a stop, or a newer
 * watch under the same key, drops it. Each poll reads only the ids still
 * queued or running: a command that ended keeps the state it ended with (an
 * arr command never leaves a terminal status), so a Sonarr "search missing"
 * with dozens of season searches doesn't re-read every finished one each poll.
 */
export function createCommandWatcher(driver: WatchDriver): CommandWatcher {
  interface Run {
    token: number;
    target: WatchTarget;
    ids: number[];
    /** The ids that have ended, with the state each ended with — never read again. */
    ended: Map<number, ArrCommandState>;
    handle: unknown;
    counters: WatchCounters;
    onDone?: (states: ArrCommandState[]) => void;
  }
  const runs = new Map<string, Run>();
  let seq = 0;
  let disposed = false;

  const retire = (key: string) => {
    const run = runs.get(key);
    if (run && run.handle !== null) driver.cancel(run.handle);
    runs.delete(key);
  };

  // The read's states (for `live`, in that order) folded into the whole watch:
  // every id in the order it was started with, an ended one keeping its stored
  // state — the progress count and the final line still cover all of them. A
  // read that doesn't answer for every id it was asked about is a failed read.
  const mergeEnded = (run: Run, live: readonly number[], states: readonly ArrCommandState[]): WatchRead => {
    const fresh = new Map(states.map((s) => [s.id, s]));
    if (live.some((id) => !fresh.has(id))) return { kind: "failed", error: "" };
    for (const id of live) {
      const s = fresh.get(id) as ArrCommandState;
      if (isTerminalCommandStatus(s.status)) run.ended.set(id, s);
    }
    return { kind: "ok", states: run.ids.map((id) => run.ended.get(id) ?? (fresh.get(id) as ArrCommandState)) };
  };

  const schedule = (key: string, run: Run, ms: number) => {
    run.handle = driver.schedule(() => {
      run.handle = null;
      void tick(key, run.token);
    }, ms);
  };

  async function tick(key: string, token: number): Promise<void> {
    const run = runs.get(key);
    if (!run || run.token !== token) return;
    let read: WatchRead;
    if (driver.hidden()) read = { kind: "skipped" };
    else {
      const live = run.ids.filter((id) => !run.ended.has(id));
      try {
        read = await driver.read(run.target, live);
      } catch (err) {
        read = { kind: "failed", error: err instanceof Error ? err.message : "" };
      }
      if (read.kind === "ok") read = mergeEnded(run, live, read.states);
    }
    if (runs.get(key)?.token !== token) return;
    const { step, counters } = watchStep(read, run.counters);
    run.counters = counters;
    if (step.next === "done") {
      runs.delete(key);
      driver.update(key, { states: step.states, error: "" });
      run.onDone?.(step.states);
      return;
    }
    if (step.next === "stop") {
      runs.delete(key);
      driver.update(key, { stopped: step.stopped, error: step.error });
      return;
    }
    if (step.states) driver.update(key, { states: step.states, error: "" });
    schedule(key, run, step.delayMs);
  }

  return {
    start(key, target, ids, onDone) {
      retire(key);
      if (disposed) return false;
      const list = [...new Set(ids)];
      if (list.length === 0) return false;
      const run: Run = { token: ++seq, target, ids: list, ended: new Map(), handle: null, counters: { polls: 0, failures: 0, overrun: 0 }, onDone };
      runs.set(key, run);
      schedule(key, run, WATCH_FIRST_POLL_MS);
      return true;
    },
    stop(key) {
      for (const k of key === undefined ? [...runs.keys()] : [key]) retire(k);
    },
    dispose() {
      disposed = true;
      for (const k of [...runs.keys()]) retire(k);
    },
    resume() {
      disposed = false;
    },
    isRunning(key) {
      return runs.has(key);
    },
  };
}
