import { Client } from "pg";

// Lock IDs assigned to long-running cron / admin operations. The same id is reused across the cron
// route and admin routes that mutate the same external state, so admin actions cannot race a cron run.
// Every single-key session lock is named here — never pass a literal to withAdvisoryLock — so a new
// id is checked against the whole list (tests/cron-routes.test.mts pins them distinct). The two-key
// xact locks (2001,n library swap, 2002,n episode cache, 2101,n registry saves) live in Postgres's
// separate (int, int) key space and never meet these.
//
// The /api/sync orchestrator's run lock.
export const SYNC_ORCHESTRATOR_LOCK_ID = 2000;
export const PURGE_AUTH_SESSIONS_LOCK_ID = 2001;
export const SCRUB_AUDIT_PII_LOCK_ID = 2002;
export const WARM_ACTIVITY_LOCK_ID = 2003;
export const WARM_OMDB_LOCK_ID = 2004;
export const WARM_MDBLIST_LOCK_ID = 2005;
export const WARM_LIST_CACHE_LOCK_ID = 2006;
export const UPCOMING_CACHE_LOCK_ID = 2007;
export const RATINGS_SYNC_LOCK_ID = 2008;
// Shared ON PURPOSE by the orchestrator's download-policy pass and the
// standalone sync-download-policies cron: their read-then-reconcile prunes must
// not race, so whichever runs second skips.
export const DOWNLOAD_POLICIES_LOCK_ID = 2009;
export const TRASH_SYNC_LOCK_ID = 2010;
export const WARM_RECOMMENDATIONS_LOCK_ID = 2011;
export const WARM_LIBRARY_LOCK_ID = 2012;
// Deliberately not the next free id (2013): ids are claimed by parallel branches,
// and a clash makes two unrelated crons serialize against each other.
export const PLEX_WATCHLIST_LOCK_ID = 2021;
// Same reasoning: a parallel-branch-safe id, not the next free one.
export const TRAKT_SYNC_LOCK_ID = 2031;
// The media servers' own watch records (refresh-upstream-watch cron + the admin
// "Refresh" on the never-watched page share it). Same reasoning: a
// parallel-branch-safe id, not the next free one.
export const UPSTREAM_WATCH_LOCK_ID = 2041;
// The Radarr/Sonarr monitor (arr-watch cron): disk space, failed downloads,
// newly stuck downloads. Same reasoning: a parallel-branch-safe id.
export const ARR_WATCH_LOCK_ID = 2051;
// The admin arr pages' background re-reads (refresh-arr-snapshots cron,
// src/lib/arr-snapshot.ts). Same reasoning: a parallel-branch-safe id.
export const ARR_SNAPSHOT_LOCK_ID = 2061;
// The library match check's walk of every media server and Radarr/Sonarr
// (src/lib/library-match-data.ts). Its report row is written under the
// two-key xact lock (2071, 1), which this single-key session lock never meets.
export const LIBRARY_MATCH_CHECK_LOCK_ID = 2071;
// Watch sync, Plex → Jellyfin (watch-sync cron + the admin page's "Run now"
// share it, src/lib/watch-sync-data.ts). Same reasoning: a parallel-branch-safe id.
export const WATCH_SYNC_LOCK_ID = 2081;
// Notification inbox retention (purge-notifications cron). Same reasoning: a
// parallel-branch-safe id, not the next free one.
export const PURGE_NOTIFICATIONS_LOCK_ID = 2091;
// The per-source library resyncs (/api/sync/plex, /api/sync/jellyfin): one run
// per source at a time. Not the orchestrator's 2000 — that would make the hourly
// sync skip whenever an admin resync is running. Same reasoning as above for
// the ids: parallel-branch-safe, not the next free one.
export const PLEX_RESYNC_LOCK_ID = 2111;
export const JELLYFIN_RESYNC_LOCK_ID = 2112;

// 30 minutes — generous enough for legitimate full-library syncs but bounds the worst-case lock hold.
const DEFAULT_WORK_TIMEOUT_MS = 30 * 60 * 1000;

export class AdvisoryLockTimeoutError extends Error {
  constructor(lockId: number, timeoutMs: number) {
    super(`Advisory lock ${lockId} work exceeded ${timeoutMs}ms`);
    this.name = "AdvisoryLockTimeoutError";
  }
}

export class AdvisoryLockConnectionLostError extends Error {
  constructor(lockId: number, reason: unknown) {
    super(
      `Advisory lock ${lockId} connection lost: ${reason instanceof Error ? reason.message : String(reason)}`,
    );
    this.name = "AdvisoryLockConnectionLostError";
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
  // pg emits 'error' on the Client for CONNECTION-level failures that have no
  // in-flight query to reject — a Postgres restart, an idle-connection reaper, a
  // pg_terminate_backend, a network blip. This client is deliberately held open and
  // IDLE for the whole of work() (up to 30 minutes by default) while the work runs
  // on Prisma's own pool, which is precisely the window in which that happens.
  //
  // An EventEmitter that emits 'error' with NO listener re-throws it as an uncaught
  // exception, so an unhandled one here takes down the entire app process — not just
  // the cron run that opened it. Postgres releases session-scoped advisory locks when
  // the session dies, so by the time this fires the lock is already free.
  //
  // The lock being free is exactly why the work must STOP: the next cron tick can
  // take it and start a second run while this one is still going. So a connection
  // loss aborts the signal, and signal-aware work (the sync orchestrator's arm
  // boundaries, guardrail 41) returns instead of racing its successor.
  let releasing = false;
  const onConnectionLost = (reason: unknown) => {
    if (releasing) return;
    if (!controller.signal.aborted) {
      controller.abort(new AdvisoryLockConnectionLostError(lockId, reason));
    }
  };
  client.on("error", (err) => {
    console.error(
      `[advisory-lock] connection error while holding lock ${lockId}:`,
      err instanceof Error ? err.message : err,
    );
    onConnectionLost(err);
  });
  // A clean server-side close (pg_terminate_backend, a restart) emits 'end'
  // without 'error' on some paths.
  client.on("end", () => onConnectionLost(new Error("connection ended")));
  await client.connect();
  try {
    // No session timeouts here: this connection only runs the non-blocking
    // try-lock and the unlock and never opens a transaction, so
    // statement_timeout / idle_in_transaction_session_timeout would bound
    // nothing. The hold is bounded by the timeoutMs race below plus the unlock
    // in the finally — and by the session dying, which frees the lock.
    //
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
      // From here the disconnect is ours: the unlock and end() below must not
      // read as a lost connection.
      releasing = true;
      // On a dead connection this rejects, and because it sits in a finally it would
      // REPLACE the error already propagating out of work() with a confusing
      // secondary one. Postgres has already released the lock in that case, so
      // logging and moving on is the correct outcome, not a silent swallow.
      await client.query("SELECT pg_advisory_unlock($1::bigint)", [lockId]).catch((err) => {
        console.error(
          `[advisory-lock] failed to release lock ${lockId}:`,
          err instanceof Error ? err.message : err,
        );
      });
    }
  } finally {
    // Same reasoning: end() on an already-broken socket must not mask the real error.
    await client.end().catch(() => {});
  }
}
