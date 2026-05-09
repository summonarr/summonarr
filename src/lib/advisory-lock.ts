

import { Client } from "pg";

// Lock IDs assigned to long-running cron / admin operations. The same id is reused across the cron
// route and admin routes that mutate the same external state, so admin actions cannot race a cron run.
export const TRASH_SYNC_LOCK_ID = 2010;

// 30 minutes — generous enough for legitimate full-library syncs but bounds the worst-case lock hold.
const DEFAULT_WORK_TIMEOUT_MS = 30 * 60 * 1000;

export class AdvisoryLockTimeoutError extends Error {
  constructor(lockId: number, timeoutMs: number) {
    super(`Advisory lock ${lockId} work exceeded ${timeoutMs}ms`);
    this.name = "AdvisoryLockTimeoutError";
  }
}

export interface AdvisoryLockOptions {
  /** Hard cap on `work()` runtime; lock is released by the finally even if the timer wins. */
  timeoutMs?: number;
}

// Uses a raw pg Client (not Prisma) because advisory locks must be held on a single persistent connection;
// Prisma's pool can transparently switch connections between awaits, which would release the lock early
export async function withAdvisoryLock<T, U = T>(
  lockId: number,
  work: () => Promise<T>,
  onBusy: () => U | Promise<U>,
  opts: AdvisoryLockOptions = {},
): Promise<T | U> {
  const timeoutMs = opts.timeoutMs ?? DEFAULT_WORK_TIMEOUT_MS;
  const client = new Client({ connectionString: process.env.DATABASE_URL });
  await client.connect();
  try {
    // Bound any single statement (and any transaction left idle) so a wedged query
    // can't keep the advisory lock held forever.
    await client.query("SET statement_timeout = '30min'");
    await client.query("SET idle_in_transaction_session_timeout = '30min'");

    // pg_try_advisory_lock is non-blocking — returns false immediately if another session holds the lock
    const res = await client.query<{ acquired: boolean }>(
      "SELECT pg_try_advisory_lock($1::bigint) AS acquired",
      [lockId],
    );
    const acquired = res.rows[0]?.acquired ?? false;
    if (!acquired) {
      return await onBusy();
    }
    try {
      let timer: NodeJS.Timeout | null = null;
      const timeoutPromise = new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new AdvisoryLockTimeoutError(lockId, timeoutMs)), timeoutMs);
      });
      try {
        return await Promise.race([work(), timeoutPromise]);
      } finally {
        if (timer) clearTimeout(timer);
      }
    } finally {
      await client.query("SELECT pg_advisory_unlock($1::bigint)", [lockId]);
    }
  } finally {
    await client.end();
  }
}
