

import { Client } from "pg";

// Lock IDs assigned to long-running cron / admin operations. The same id is reused across the cron
// route and admin routes that mutate the same external state, so admin actions cannot race a cron run.
export const WARM_OMDB_LOCK_ID = 2004;
export const WARM_MDBLIST_LOCK_ID = 2005;
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

// Callers may opt into signal-aware work by accepting an AbortSignal argument. The signal fires
// on timeout (before pg_advisory_unlock releases the lock) so callers can stop hitting the DB
// rather than letting the racing work() continue in the background. Abortion is best-effort —
// the underlying work must explicitly observe the signal (e.g. pass it to fetch() / forward to
// Prisma where supported) for it to have any effect.
export type AdvisoryLockWork<T> = (() => Promise<T>) | ((signal: AbortSignal) => Promise<T>);

// Uses a raw pg Client (not Prisma) because advisory locks must be held on a single persistent connection;
// Prisma's pool can transparently switch connections between awaits, which would release the lock early
export async function withAdvisoryLock<T, U = T>(
  lockId: number,
  work: AdvisoryLockWork<T>,
  onBusy: () => U | Promise<U>,
  opts: AdvisoryLockOptions = {},
): Promise<T | U> {
  const timeoutMs = opts.timeoutMs ?? DEFAULT_WORK_TIMEOUT_MS;
  const controller = new AbortController();
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
        timer = setTimeout(() => {
          const err = new AdvisoryLockTimeoutError(lockId, timeoutMs);
          // Signal the work BEFORE the finally releases pg_advisory_unlock so the
          // inner work() can observe the abort and stop issuing DB statements.
          controller.abort(err);
          reject(err);
        }, timeoutMs);
      });
      try {
        return await Promise.race([
          (work as (signal: AbortSignal) => Promise<T>)(controller.signal),
          timeoutPromise,
        ]);
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
