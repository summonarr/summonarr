import { Client, type ClientConfig } from "pg";

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

// The lock connection only ever runs the non-blocking try-lock and the unlock,
// so these bound an unreachable or wedged server, never real work. Without them
// a connect or query that hangs waits out the OS TCP timeout on every cron tick.
export const LOCK_CONNECT_TIMEOUT_MS = 10_000;
export const LOCK_QUERY_TIMEOUT_MS = 10_000;

/** The dedicated lock connection's pg config. */
export function lockClientConfig(connectionString: string | undefined): ClientConfig {
  return {
    connectionString,
    connectionTimeoutMillis: LOCK_CONNECT_TIMEOUT_MS,
    query_timeout: LOCK_QUERY_TIMEOUT_MS,
  };
}

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
  /** How long work() may run before its signal is aborted and the caller gets AdvisoryLockTimeoutError. */
  timeoutMs?: number;
  /**
   * After a timeout, how much longer the lock stays held while the work winds
   * down (default: `timeoutMs`). The lock is released the moment the work
   * settles; this only bounds work that never does.
   */
  settleGraceMs?: number;
}

// Callers may opt into signal-aware work by accepting an AbortSignal argument. The signal fires
// on timeout and on a lost lock connection. Abortion is best-effort — the underlying work must
// explicitly observe the signal (check it at a batch boundary, pass it to fetch()) and RETURN
// (guardrail 41) for it to have any effect.
export type AdvisoryLockWork<T> = (() => Promise<T>) | ((signal: AbortSignal) => Promise<T>);

/** The dedicated connection one withAdvisoryLock call holds its lock on. */
interface LockConnection {
  client: Client;
  /** True once pg_try_advisory_lock granted the lock: only then is there anything to unlock. */
  held: boolean;
  /** Unlocks (when held) and closes the connection. Never rejects. */
  release(): Promise<void>;
}

function openLockConnection(lockId: number, controller: AbortController): LockConnection {
  const client = new Client(lockClientConfig(process.env.DATABASE_URL));
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
    if (releasing || controller.signal.aborted) return;
    controller.abort(new AdvisoryLockConnectionLostError(lockId, reason));
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

  const conn: LockConnection = {
    client,
    held: false,
    async release() {
      // From here the disconnect is ours: the unlock and end() below must not
      // read as a lost connection.
      releasing = true;
      if (conn.held) {
        // On a dead connection this rejects. Postgres has already released the
        // lock in that case, so logging and moving on is the correct outcome —
        // and it must never REPLACE the error propagating out of work().
        await client.query("SELECT pg_advisory_unlock($1::bigint)", [lockId]).catch((err) => {
          console.error(
            `[advisory-lock] failed to release lock ${lockId}:`,
            err instanceof Error ? err.message : err,
          );
        });
      }
      // Same reasoning: end() on an already-broken socket must not mask the real error.
      await client.end().catch(() => {});
    },
  };
  return conn;
}

// pg_try_advisory_lock is non-blocking — false at once if another session holds the lock.
// An empty or malformed result reads as "not acquired" (fail closed).
async function tryLock(client: Client, lockId: number): Promise<boolean> {
  const res = await client.query<{ acquired: boolean }>(
    "SELECT pg_try_advisory_lock($1::bigint) AS acquired",
    [lockId],
  );
  return res.rows[0]?.acquired ?? false;
}

// Starts work() synchronously, as a plain call would, with a synchronous throw
// turned into a rejection.
function startWork<T>(work: AdvisoryLockWork<T>, signal: AbortSignal): Promise<T> {
  try {
    return Promise.resolve((work as (signal: AbortSignal) => Promise<T>)(signal));
  } catch (err) {
    return Promise.reject(err);
  }
}

type Raced<T> = { timedOut: false; value: T } | { timedOut: true; error: Error };

// Resolves with the work's value, rejects with its error, or — once `timeoutMs`
// passes first — resolves `timedOut` with the error `onTimeout` returns.
async function raceTimeout<T>(running: Promise<T>, timeoutMs: number, onTimeout: () => Error): Promise<Raced<T>> {
  let timer: NodeJS.Timeout | undefined;
  const expired = new Promise<Raced<T>>((resolve) => {
    timer = setTimeout(() => resolve({ timedOut: true, error: onTimeout() }), timeoutMs);
  });
  try {
    return await Promise.race([running.then((value): Raced<T> => ({ timedOut: false, value })), expired]);
  } finally {
    clearTimeout(timer);
  }
}

// True once `running` settles (either way), false if `ms` passes first.
async function settlesWithin(running: Promise<unknown>, ms: number): Promise<boolean> {
  let timer: NodeJS.Timeout | undefined;
  const expired = new Promise<false>((resolve) => {
    timer = setTimeout(() => resolve(false), ms);
  });
  try {
    return await Promise.race([running.then(() => true, () => true), expired]);
  } finally {
    clearTimeout(timer);
  }
}

// After a timeout the caller already has its AdvisoryLockTimeoutError, but the
// work cannot be killed — only told to stop. Releasing the lock now would let the
// next tick start a second run beside it (the guardrail 41 orphan), even for
// signal-aware work, which overshoots by its in-flight batch or orchestrator arm.
// So the lock is held until the work settles, or `graceMs` passes for work that
// never does.
async function releaseWhenSettled(
  conn: LockConnection,
  lockId: number,
  running: Promise<unknown>,
  graceMs: number,
): Promise<void> {
  try {
    if (!(await settlesWithin(running, graceMs))) {
      console.error(
        `[advisory-lock] lock ${lockId}: work still running ${graceMs}ms after its timeout; releasing the lock anyway`,
      );
    }
  } finally {
    await conn.release();
  }
}

// Uses a raw pg Client (not Prisma) because advisory locks must be held on a single persistent connection;
// Prisma's pool can transparently switch connections between awaits, which would release the lock early
export async function withAdvisoryLock<T, U = T>(
  lockId: number,
  work: AdvisoryLockWork<T>,
  onBusy: () => U | Promise<U>,
  opts: AdvisoryLockOptions = {},
): Promise<T | U> {
  const timeoutMs = opts.timeoutMs ?? DEFAULT_WORK_TIMEOUT_MS;
  const settleGraceMs = opts.settleGraceMs ?? timeoutMs;
  const controller = new AbortController();
  const conn = openLockConnection(lockId, controller);
  // Set when a timed-out run hands its release to releaseWhenSettled.
  let releaseLater = false;
  try {
    // Inside the try, so a failed connect still closes the client.
    await conn.client.connect();
    // No session timeouts beyond the client's own: this connection only runs the
    // try-lock and the unlock and never opens a transaction, so statement_timeout /
    // idle_in_transaction_session_timeout would bound nothing. The hold is bounded
    // by timeoutMs + settleGraceMs — and by the session dying, which frees the lock.
    if (!(await tryLock(conn.client, lockId))) return await onBusy();
    conn.held = true;

    const running = startWork(work, controller.signal);
    const outcome = await raceTimeout(running, timeoutMs, () => {
      const err = new AdvisoryLockTimeoutError(lockId, timeoutMs);
      // Signal the work first, so signal-aware work stops issuing statements.
      controller.abort(err);
      return err;
    });
    if (!outcome.timedOut) return outcome.value;
    releaseLater = true;
    void releaseWhenSettled(conn, lockId, running, settleGraceMs).catch((err) => {
      console.error(`[advisory-lock] releasing lock ${lockId} failed:`, err instanceof Error ? err.message : err);
    });
    throw outcome.error;
  } finally {
    if (!releaseLater) await conn.release();
  }
}
