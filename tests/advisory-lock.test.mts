// Unit tests for the advisory-lock helper (src/lib/advisory-lock.ts).
// withAdvisoryLock makes sure only one cron/admin job that changes the same
// external state runs at a time. It does this by holding a Postgres advisory
// lock (a named lock Postgres keeps for us) on ONE dedicated pg connection.
// What these tests pin:
//   - the lock-id constants: jobs only exclude each other because racing routes
//     share the SAME id, so silently renumbering one changes behaviour;
//   - the busy path: onBusy() runs, the work does not, and we never unlock a
//     lock we never held;
//   - an empty try-lock result counts as "not acquired" (fail closed);
//   - the timeout: the AbortSignal fires with the timeout error and the caller
//     gets it at once, but the lock is HELD until the work settles (bounded by
//     settleGraceMs), so the next tick cannot start a second run beside it;
//   - the lock connection carries connect/query timeouts, and a failed connect
//     still closes the client;
//   - pg_advisory_unlock and client.end always run in the finally paths.
//
// There is no DB in the unit suite, so pg's Client prototype is replaced with
// an in-memory fake. withAdvisoryLock creates its own `new Client(...)`, and
// connect/query/end live on the prototype, so patching the prototype lets the
// REAL control flow run with no network or DB. Each test file runs in its own
// child process, so the patch cannot leak into other suites.
import { test } from "node:test";
import assert from "node:assert/strict";
import type { EventEmitter } from "node:events";
import { Client } from "pg";
import {
  WARM_OMDB_LOCK_ID,
  WARM_MDBLIST_LOCK_ID,
  TRASH_SYNC_LOCK_ID,
  AdvisoryLockTimeoutError,
  LOCK_CONNECT_TIMEOUT_MS,
  LOCK_QUERY_TIMEOUT_MS,
  lockClientConfig,
  withAdvisoryLock,
} from "../src/lib/advisory-lock.ts";

type Call =
  | { op: "connect" }
  | { op: "end" }
  | { op: "query"; text: string; values: unknown[] | undefined };

interface ClientProtoMock {
  connect: () => Promise<void>;
  query: (
    text: string,
    values?: unknown[],
  ) => Promise<{ rows: Array<{ acquired: boolean }> }>;
  end: () => Promise<void>;
}

const calls: Call[] = [];

// The module logs through console.error; captured so the grace-expiry line can
// be asserted on and kept out of the test output.
const loggedErrors: string[] = [];
console.error = (...args: unknown[]) => { loggedErrors.push(args.map(String).join(" ")); };
let tryLockRows: Array<{ acquired: boolean }> = [{ acquired: true }];

// The client withAdvisoryLock creates internally, captured at connect() so a test
// can drive its EventEmitter surface (pg's connection-level 'error' channel).
let lastClient: EventEmitter | null = null;
// Assigned via a call rather than `const self = this` — no-this-alias forbids the
// alias form, and passing the receiver as an argument reads the same.
function captureClient(client: EventEmitter): void {
  lastClient = client;
}
// When set, a query whose text contains this string rejects — used to simulate a
// dead connection at unlock/end time.
let failQueryContaining: string | null = null;
// When true, end() rejects, as it does on an already-broken socket.
let failEnd = false;

// When set, connect() rejects with it (an unreachable or refusing server).
let failConnect: Error | null = null;

const proto = Client.prototype as unknown as ClientProtoMock;
proto.connect = async function (this: EventEmitter) {
  calls.push({ op: "connect" });
  captureClient(this);
  if (failConnect) throw failConnect;
};
proto.query = async (text, values) => {
  calls.push({ op: "query", text, values });
  if (failQueryContaining && text.includes(failQueryContaining)) {
    throw new Error("Connection terminated unexpectedly");
  }
  if (text.includes("pg_try_advisory_lock")) return { rows: tryLockRows };
  return { rows: [] };
};
proto.end = async () => {
  calls.push({ op: "end" });
  if (failEnd) throw new Error("Client was closed and is not queryable");
};

function reset(rows: Array<{ acquired: boolean }>): void {
  calls.length = 0;
  tryLockRows = rows;
  lastClient = null;
  failQueryContaining = null;
  failEnd = false;
  failConnect = null;
}

const unlocked = () => queryTexts().some((t) => t.includes("pg_advisory_unlock"));

// Waits for an observable step instead of a fixed sleep; fails after `ms`.
async function waitFor(cond: () => boolean, what: string, ms = 2_000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > deadline) assert.fail(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 2));
  }
}

function queryTexts(): string[] {
  return calls.flatMap((c) => (c.op === "query" ? [c.text] : []));
}

test("lock ids are pinned, distinct, positive safe integers", () => {
  // Exact pins: the same id is deliberately reused across the cron route and
  // the admin routes mutating the same state — renumbering one silently
  // removes that mutual exclusion.
  assert.equal(WARM_OMDB_LOCK_ID, 2004);
  assert.equal(WARM_MDBLIST_LOCK_ID, 2005);
  assert.equal(TRASH_SYNC_LOCK_ID, 2010);
  const ids = [WARM_OMDB_LOCK_ID, WARM_MDBLIST_LOCK_ID, TRASH_SYNC_LOCK_ID];
  assert.equal(new Set(ids).size, ids.length);
  for (const id of ids) {
    assert.ok(Number.isSafeInteger(id) && id > 0, `bad lock id ${id}`);
  }
});

test("AdvisoryLockTimeoutError carries lock id + timeout in a stable message", () => {
  const err = new AdvisoryLockTimeoutError(2004, 5000);
  assert.ok(err instanceof Error);
  assert.equal(err.name, "AdvisoryLockTimeoutError");
  assert.equal(err.message, "Advisory lock 2004 work exceeded 5000ms");
});

test("acquired: runs work with a live AbortSignal, then unlocks and disconnects", async () => {
  reset([{ acquired: true }]);
  const seenSignals: AbortSignal[] = [];
  const result = await withAdvisoryLock(
    WARM_OMDB_LOCK_ID,
    async (signal: AbortSignal) => {
      seenSignals.push(signal);
      return 42;
    },
    () => "busy" as const,
  );
  assert.equal(result, 42);
  assert.equal(seenSignals.length, 1);
  assert.equal(seenSignals[0].aborted, false); // no timeout ⇒ never aborted
  // Exact statement order: connection first, try-lock, unlock — and the
  // unlock/end pair always closes the run. No session SETs: this connection
  // never runs a statement or transaction they could bound.
  assert.equal(calls[0]?.op, "connect");
  assert.deepEqual(queryTexts(), [
    "SELECT pg_try_advisory_lock($1::bigint) AS acquired",
    "SELECT pg_advisory_unlock($1::bigint)",
  ]);
  // Both lock statements target the SAME id the caller passed.
  const lockValues = calls.flatMap((c) => (c.op === "query" ? [c.values] : []));
  assert.deepEqual(lockValues, [[WARM_OMDB_LOCK_ID], [WARM_OMDB_LOCK_ID]]);
  assert.equal(calls.at(-1)?.op, "end");
  assert.equal(calls.filter((c) => c.op === "end").length, 1);
});

test("busy: returns onBusy() result, never runs work, never unlocks", async () => {
  reset([{ acquired: false }]);
  let workRan = false;
  const result = await withAdvisoryLock(
    WARM_MDBLIST_LOCK_ID,
    async () => {
      workRan = true;
      return 1;
    },
    () => "busy" as const,
  );
  assert.equal(result, "busy");
  assert.equal(workRan, false);
  const texts = queryTexts();
  assert.ok(texts.some((t) => t.includes("pg_try_advisory_lock")));
  // pg_advisory_unlock must NOT be issued for a lock this session never held.
  assert.equal(texts.some((t) => t.includes("pg_advisory_unlock")), false);
  // The connection is still closed on the busy path.
  assert.equal(calls.at(-1)?.op, "end");
});

test("an empty try-lock result fails closed to the busy path", async () => {
  // `rows[0]?.acquired ?? false` — a malformed/empty result must read as
  // "not acquired", never as holding the lock.
  reset([]);
  const result = await withAdvisoryLock(
    TRASH_SYNC_LOCK_ID,
    async () => "worked" as const,
    () => "busy" as const,
  );
  assert.equal(result, "busy");
  assert.equal(queryTexts().some((t) => t.includes("pg_advisory_unlock")), false);
  assert.equal(calls.at(-1)?.op, "end");
});

test("work() rejection propagates, but the lock is still released", async () => {
  reset([{ acquired: true }]);
  await assert.rejects(
    withAdvisoryLock(
      WARM_OMDB_LOCK_ID,
      async () => {
        throw new Error("upstream boom");
      },
      () => "busy" as const,
    ),
    /upstream boom/,
  );
  assert.ok(queryTexts().some((t) => t.includes("pg_advisory_unlock")));
  assert.equal(calls.at(-1)?.op, "end");
});

test("timeout: rejects AdvisoryLockTimeoutError at once and aborts the signal; work that never settles keeps the lock only for the grace", async () => {
  reset([{ acquired: true }]);
  const seenSignals: AbortSignal[] = [];
  const errorsBefore = loggedErrors.length;
  const pending = withAdvisoryLock(
    WARM_OMDB_LOCK_ID,
    (signal: AbortSignal) => {
      seenSignals.push(signal);
      // Never settles — simulates wedged work. A pending promise holds no
      // event-loop handle and the module clears its timers, so the process
      // still exits promptly.
      return new Promise<never>(() => {});
    },
    () => "busy" as const,
    { timeoutMs: 40, settleGraceMs: 30 },
  );
  await assert.rejects(pending, (err: unknown) => {
    assert.ok(err instanceof AdvisoryLockTimeoutError);
    assert.equal(err.name, "AdvisoryLockTimeoutError");
    assert.equal(err.message, `Advisory lock ${WARM_OMDB_LOCK_ID} work exceeded 40ms`);
    return true;
  });
  assert.equal(seenSignals.length, 1);
  // The signal fires (with the timeout error as reason) so signal-aware work
  // can stop issuing DB statements.
  assert.equal(seenSignals[0].aborted, true);
  assert.ok(seenSignals[0].reason instanceof AdvisoryLockTimeoutError);
  assert.equal(unlocked(), false, "the caller is answered before the lock is let go");
  // Work that never settles is not allowed to hold the lock for ever.
  await waitFor(() => calls.at(-1)?.op === "end", "the lock to be released after the grace");
  assert.ok(unlocked());
  assert.ok(
    loggedErrors.slice(errorsBefore).some((e) => e.includes("still running") && e.includes(String(WARM_OMDB_LOCK_ID))),
    "releasing a lock under running work is logged",
  );
});

test("timeout: the lock is held until signal-aware work actually returns, then released", async () => {
  // Signal-aware work still overshoots the abort by its in-flight batch (or the
  // orchestrator's current arm). Unlocking at the timeout let the next tick
  // start a second run beside it; the lock now outlives the overshoot.
  reset([{ acquired: true }]);
  let finishBatch: () => void = () => {};
  const batchDone = new Promise<void>((r) => { finishBatch = r; });
  let returned = false;
  const errorsBefore = loggedErrors.length;
  const pending = withAdvisoryLock(
    WARM_OMDB_LOCK_ID,
    async (signal: AbortSignal) => {
      await new Promise<void>((r) => signal.addEventListener("abort", () => r(), { once: true }));
      await batchDone; // the batch in flight when the abort landed
      returned = true;
      return "stopped";
    },
    () => "busy" as const,
    { timeoutMs: 20 },
  );
  await assert.rejects(pending, AdvisoryLockTimeoutError);
  assert.equal(unlocked(), false, "still held while the in-flight batch runs");
  // A second caller in this window is refused by Postgres — modelled here by
  // the lock still being held: no unlock has been issued.
  finishBatch();
  await waitFor(unlocked, "the unlock once the work returned");
  assert.equal(returned, true);
  assert.equal(calls.at(-1)?.op, "end");
  assert.equal(
    loggedErrors.slice(errorsBefore).filter((e) => e.includes("still running")).length,
    0,
    "work that settled inside the grace is released quietly",
  );
});

test("timeout: work that throws after the abort still releases the lock, with no unhandled rejection", async () => {
  reset([{ acquired: true }]);
  let fail: () => void = () => {};
  const pending = withAdvisoryLock(
    WARM_OMDB_LOCK_ID,
    (signal: AbortSignal) =>
      new Promise<never>((_, reject) => {
        signal.addEventListener("abort", () => { fail = () => reject(new Error("late failure")); }, { once: true });
      }),
    () => "busy" as const,
    { timeoutMs: 20 },
  );
  await assert.rejects(pending, AdvisoryLockTimeoutError);
  assert.equal(unlocked(), false);
  fail();
  await waitFor(unlocked, "the unlock once the work rejected");
});

test("the lock connection carries connect and query timeouts", async () => {
  // Without them a hung connect or try-lock waits out the OS TCP timeout, and
  // every cron tick waits with it.
  assert.deepEqual(lockClientConfig("postgres://x"), {
    connectionString: "postgres://x",
    connectionTimeoutMillis: LOCK_CONNECT_TIMEOUT_MS,
    query_timeout: LOCK_QUERY_TIMEOUT_MS,
  });
  assert.ok(LOCK_CONNECT_TIMEOUT_MS > 0 && LOCK_CONNECT_TIMEOUT_MS <= 30_000);
  assert.ok(LOCK_QUERY_TIMEOUT_MS > 0 && LOCK_QUERY_TIMEOUT_MS <= 30_000);
  // …and the client withAdvisoryLock builds is the one configured with them.
  reset([{ acquired: true }]);
  await withAdvisoryLock(WARM_OMDB_LOCK_ID, async () => 1, () => 0);
  const built = lastClient as unknown as { _connectionTimeoutMillis: number; connectionParameters: { query_timeout?: number } };
  assert.equal(built._connectionTimeoutMillis, LOCK_CONNECT_TIMEOUT_MS);
  assert.equal(built.connectionParameters.query_timeout, LOCK_QUERY_TIMEOUT_MS);
});

test("a failed connect rejects, never runs the work, and still closes the client", async () => {
  reset([{ acquired: true }]);
  failConnect = new Error("connect ECONNREFUSED (unit test)");
  let ran = false;
  await assert.rejects(
    withAdvisoryLock(WARM_OMDB_LOCK_ID, async () => { ran = true; return 1; }, () => 0),
    /ECONNREFUSED/,
  );
  assert.equal(ran, false);
  assert.equal(unlocked(), false, "nothing was locked, so nothing is unlocked");
  assert.equal(calls.at(-1)?.op, "end", "the client is closed on a failed connect too");
});

// ── connection-level failures while the lock is held ────────────────────────

test("a connection 'error' event while the lock is held does NOT take the process down", async () => {
  // withAdvisoryLock holds this raw pg client open and IDLE for the whole of
  // work() (up to 30 minutes) while the work itself runs on Prisma's pool. pg
  // signals a Postgres restart / reaped connection / pg_terminate_backend by
  // emitting 'error' on the Client — and an EventEmitter that emits 'error' with
  // no listener re-throws it, which as an async socket callback in production is
  // an uncaught exception that kills the whole app, not just this cron run.
  reset([{ acquired: true }]);
  const result = await withAdvisoryLock(
    WARM_OMDB_LOCK_ID,
    async () => {
      assert.ok(lastClient, "the client should have been captured at connect()");
      lastClient!.emit("error", new Error("terminating connection due to administrator command"));
      return "work-completed";
    },
    () => "busy",
  );
  assert.equal(result, "work-completed", "the run must survive a connection error");
  assert.ok(queryTexts().some((t) => t.includes("pg_advisory_unlock")));
});

test("a failing unlock does not REPLACE the error propagating out of work()", async () => {
  // The unlock sits in a finally, so an unhandled rejection there overwrites the
  // real failure with a confusing secondary one — and callers lose the actual
  // reason the job died. Postgres frees session-scoped locks when the session
  // ends, so there is nothing left to clean up in this case anyway.
  reset([{ acquired: true }]);
  failQueryContaining = "pg_advisory_unlock";
  failEnd = true;
  await assert.rejects(
    withAdvisoryLock(
      WARM_OMDB_LOCK_ID,
      async () => {
        throw new Error("the real failure");
      },
      () => "busy",
    ),
    /the real failure/,
  );
});

test("a failing unlock does not turn an otherwise-successful run into a failure", async () => {
  reset([{ acquired: true }]);
  failQueryContaining = "pg_advisory_unlock";
  failEnd = true;
  const result = await withAdvisoryLock(WARM_OMDB_LOCK_ID, async () => "ok", () => "busy");
  assert.equal(result, "ok");
});

test("a lost connection aborts the signal so the work stops while the lock is already free", async () => {
  reset([{ acquired: true }]);
  let seen: AbortSignal | null = null;
  let release: () => void = () => {};
  const pending = withAdvisoryLock(
    WARM_OMDB_LOCK_ID,
    (signal: AbortSignal) => {
      seen = signal;
      return new Promise<string>((resolve) => {
        signal.addEventListener("abort", () => resolve("stopped"), { once: true });
        release = () => resolve("finished");
      });
    },
    () => "busy" as const,
  );
  await new Promise((r) => setImmediate(r));
  assert.ok(lastClient, "client captured");
  (lastClient as EventEmitter).emit("error", new Error("Connection terminated unexpectedly"));
  assert.equal(await pending, "stopped");
  assert.equal((seen as AbortSignal | null)?.aborted, true);
  assert.equal(((seen as AbortSignal | null)?.reason as Error).name, "AdvisoryLockConnectionLostError");
  release();
});

test("our own unlock and end() do not read as a lost connection", async () => {
  reset([{ acquired: true }]);
  let seen: AbortSignal | null = null;
  await withAdvisoryLock(
    WARM_OMDB_LOCK_ID,
    async (signal: AbortSignal) => {
      seen = signal;
      return 1;
    },
    () => "busy" as const,
  );
  (lastClient as unknown as EventEmitter).emit("end");
  assert.equal((seen as AbortSignal | null)?.aborted, false);
});
