// In-process delayed follow-up jobs: a timer per job, then a small worker pool
// so a burst of jobs cannot all run at once. Limits are tunable via the
// DELAYED_JOBS_MAX_* env vars; a missing or invalid value uses the default.

const num = (v: string | undefined, d: number) => {
  const n = v ? parseInt(v, 10) : NaN;
  return Number.isFinite(n) && n > 0 ? n : d;
};

const MAX_PENDING     = num(process.env.DELAYED_JOBS_MAX_PENDING, 500);
const MAX_QUEUE       = num(process.env.DELAYED_JOBS_MAX_QUEUE, 100);
const MAX_CONCURRENCY = num(process.env.DELAYED_JOBS_MAX_CONCURRENCY, 4);

type Job = { name: string; fn: () => Promise<void> };

let pendingTimers = 0;
const runQueue: Job[] = [];
let activeWorkers = 0;

function pump(): void {
  while (activeWorkers < MAX_CONCURRENCY && runQueue.length > 0) {
    const job = runQueue.shift()!;
    activeWorkers++;
    Promise.resolve()
      .then(() => job.fn())
      .catch((err) => {
        console.error(`[delayed-jobs] job "${job.name}" failed:`, err);
      })
      .finally(() => {
        activeWorkers--;
        pump();
      });
  }
}

// Schedules a best-effort job to run after delayMs, then through a bounded worker
// pool. Returns false (dropped) when the pending-timer cap is already reached.
//
// Two drop points, two signals: a schedule-time refusal is the `false` return
// (the caller is still on the stack and can react); a FIRE-time drop happens
// long after the caller got `true`, so it is reported through `opts.onDrop`
// instead — the only way a caller that must record every lost job (the
// notify-agents retry chain) can learn about it. onDrop is best-effort too: it
// is never awaited and a throw inside it cannot poison the pool.
export function scheduleDelayed(
  delayMs: number,
  fn: () => Promise<void>,
  opts: { name: string; onDrop?: () => void }
): boolean {
  if (pendingTimers >= MAX_PENDING) {
    console.warn(
      `[delayed-jobs] dropping "${opts.name}": pending cap reached (${MAX_PENDING})`
    );
    return false;
  }
  pendingTimers++;
  // .unref() so pending delayed jobs don't prevent process shutdown
  setTimeout(() => {
    pendingTimers--;
    if (runQueue.length >= MAX_QUEUE) {
      // A job accepted earlier (caller already got `true`) is being dropped at
      // fire time under queue saturation. These follow-ups are best-effort and
      // self-heal on the next sync tick, but the loss is a real degradation, so
      // surface it at error level rather than as an informational warning.
      console.error(
        `[delayed-jobs] dropping "${opts.name}" at fire time: queue cap reached (${MAX_QUEUE})`
      );
      if (opts.onDrop) {
        try {
          opts.onDrop();
        } catch (err) {
          console.error(`[delayed-jobs] onDrop for "${opts.name}" failed:`, err);
        }
      }
      return;
    }
    runQueue.push({ name: opts.name, fn });
    pump();
  }, delayMs).unref();
  return true;
}
