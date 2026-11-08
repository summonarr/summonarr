import { isPrismaErrorCode } from "@/lib/prisma-errors";

const defaultSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/** The wait before retry `attempt` (1-based): 10–50 ms × attempt, jittered. */
export function serializableRetryDelayMs(attempt: number, random: () => number = Math.random): number {
  return Math.round((10 + random() * 40) * attempt);
}

// Retry a Serializable transaction on a write-conflict (P2034): concurrent
// read+insert transactions (e.g. the request quota count+create) conflict and
// Postgres aborts one; retrying re-reads the committed state. Without this a
// quota-boundary race surfaces as a 500 instead of the correct 429/409. Used by
// POST /api/requests and the bulk request route.
//
// Each retry waits a short jittered backoff first: the transaction that won the
// conflict is often still running, and an immediate retry tends to collide with
// it again and spend every attempt within a millisecond.
export async function runWithSerializableRetry<T>(
  fn: () => Promise<T>,
  attempts = 3,
  sleep: (ms: number) => Promise<void> = defaultSleep,
): Promise<T> {
  for (let attempt = 1; ; attempt++) {
    try {
      return await fn();
    } catch (err) {
      if (attempt < attempts && isPrismaErrorCode(err, "P2034")) {
        await sleep(serializableRetryDelayMs(attempt));
        continue;
      }
      throw err;
    }
  }
}
