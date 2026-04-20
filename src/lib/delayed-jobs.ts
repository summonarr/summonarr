

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

export function scheduleDelayed(
  delayMs: number,
  fn: () => Promise<void>,
  opts: { name: string }
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
      console.warn(
        `[delayed-jobs] dropping "${opts.name}": queue cap reached (${MAX_QUEUE})`
      );
      return;
    }
    runQueue.push({ name: opts.name, fn });
    pump();
  }, delayMs).unref();
  return true;
}

export function __delayedJobsStats() {
  return { pendingTimers, queued: runQueue.length, activeWorkers, MAX_PENDING, MAX_QUEUE, MAX_CONCURRENCY };
}
