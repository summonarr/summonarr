// The webhook-driven monitor run: a Radarr/Sonarr webhook delivery (a grab, an
// import, a manual-interaction notice, a delete) is the moment the download
// queue changed, so it asks for a monitor run right away instead of leaving
// the admin nav's Download Queue count to the next scheduled tick (15 minutes
// by default). The run pushes the new count to open tabs itself (`nav:badges`).
//
// It is the SAME job as the cron — runCronRoute over ARR_WATCH_CRON — so the
// advisory lock, the run ledger, the abort signal and the announce-once state
// (guardrail 7c) are identical, and it can never run beside a scheduled run.
//
// Bounded however many webhooks arrive (a season pack fires one per episode):
//   • a request while one is already scheduled is absorbed;
//   • a request while a run is in flight asks for ONE more after it;
//   • runs start at least RECOUNT_MIN_SPACING_MS apart.
// So the cost is at most one monitor run per spacing window, and none while no
// webhook arrives.
//
// In-process, like the activity backfill (guardrail 17): safe because the app
// is one long-lived Node server. Nothing is scheduled until the server's boot
// arms it (instrumentation.ts), so a build or a unit test that drives a
// webhook handler starts no background work.
import { ARR_WATCH_CRON } from "./arr-watch-cron";
import { CRON_SYSTEM_ACTOR } from "./cron-auth";
import { CRON_SKIPPED_HEADER } from "./cron-history";
import { runCronRoute } from "./cron-route";
import { processSingleton } from "./process-singleton";

/** How long after a webhook the run starts — the arr's queue settles a moment after it fires the event. */
export const RECOUNT_SETTLE_MS = 5_000;
/** Runs start at least this far apart, whatever the webhook rate. */
export const RECOUNT_MIN_SPACING_MS = 30_000;
/** A run that found the lock busy (the scheduled run mid-flight) is asked again at most this many times in a row. */
export const RECOUNT_MAX_BUSY_RETRIES = 3;

/** "busy": another monitor run held the lock, so this one read nothing. */
export type RecountOutcome = "ran" | "busy" | "skipped";

interface RecountState {
  armed: boolean;
  timer: ReturnType<typeof setTimeout> | null;
  running: boolean;
  /** A request arrived during the run in flight. */
  again: boolean;
  busyStreak: number;
  /** When the last run started (0 = never). */
  lastStartedAt: number;
  run: () => Promise<RecountOutcome>;
}

async function runMonitor(): Promise<RecountOutcome> {
  const res = await runCronRoute(ARR_WATCH_CRON, CRON_SYSTEM_ACTOR);
  if (res.headers.get(CRON_SKIPPED_HEADER) !== "1") return "ran";
  // Two skips: the lock was busy (cronSkippedResponse's default reason), or
  // there is nothing to watch. Only the first is worth asking again.
  const body: unknown = await res.json().catch(() => null);
  const reason = body !== null && typeof body === "object" ? (body as { reason?: unknown }).reason : undefined;
  return reason === "already running" ? "busy" : "skipped";
}

// Process-wide (guardrail 27a): the webhook routes and the boot hook live in
// different server chunks and must share one schedule.
const state = processSingleton<RecountState>("arr-watch-trigger:state", () => ({
  armed: false,
  timer: null,
  running: false,
  again: false,
  busyStreak: 0,
  lastStartedAt: 0,
  run: runMonitor,
}));

/** How long to wait before the next run may start: the settle time, or what is left of the spacing. */
export function recountDelayMs(nowMs: number, lastStartedAt: number): number {
  const spacingLeft = lastStartedAt === 0 ? 0 : lastStartedAt + RECOUNT_MIN_SPACING_MS - nowMs;
  return Math.max(RECOUNT_SETTLE_MS, spacingLeft);
}

function schedule(): void {
  const timer = setTimeout(() => void fire(), recountDelayMs(Date.now(), state.lastStartedAt));
  // Never keeps the process alive on its own.
  timer.unref?.();
  state.timer = timer;
}

async function fire(): Promise<void> {
  state.timer = null;
  state.running = true;
  state.again = false;
  state.lastStartedAt = Date.now();
  let outcome: RecountOutcome = "skipped";
  try {
    outcome = await state.run();
  } catch (err) {
    // Best-effort: the scheduled run still comes. Never thrown at a webhook.
    console.warn(`[arr-watch] webhook-triggered run failed: ${err instanceof Error ? err.message : String(err)}`);
  } finally {
    state.running = false;
  }
  state.busyStreak = outcome === "busy" ? state.busyStreak + 1 : 0;
  const retryBusy = outcome === "busy" && state.busyStreak <= RECOUNT_MAX_BUSY_RETRIES;
  if ((state.again || retryBusy) && state.armed && state.timer === null) schedule();
}

/**
 * Ask for a monitor run soon. Synchronous, never throws, never awaited by the
 * caller; a no-op until the server's boot has armed it.
 */
export function requestArrWatchRecount(): void {
  if (!state.armed) return;
  if (state.running) {
    state.again = true;
    return;
  }
  if (state.timer !== null) return;
  schedule();
}

/** Called once at server boot (instrumentation.ts): from here on webhooks may schedule runs. */
export function armArrWatchRecount(): void {
  state.armed = true;
}

/** Test seam: a clean, armed schedule over a stubbed run. */
export function __resetArrWatchRecountForTests(run?: () => Promise<RecountOutcome>): void {
  if (state.timer !== null) clearTimeout(state.timer);
  state.timer = null;
  state.running = false;
  state.again = false;
  state.busyStreak = 0;
  state.lastStartedAt = 0;
  state.armed = run !== undefined;
  state.run = run ?? runMonitor;
}
