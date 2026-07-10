// Unit tests for the advisory-lock helper (src/lib/advisory-lock.ts).
// withAdvisoryLock serializes cron/admin operations that mutate the same
// external state, holding a Postgres advisory lock on ONE persistent pg
// connection. The properties pinned here: the lock-id constants (mutual
// exclusion only works because racing routes share the SAME id — a silent
// renumber is a behavioural change), the busy fast-path (onBusy, no work, no
// unlock for a lock never held), the fail-closed read of the try-lock result,
// the timeout (AbortSignal fires with the timeout error BEFORE the unlock),
// and that pg_advisory_unlock + client.end always run in the finally paths.
//
// There is no local DB in the unit suite, so pg's Client prototype is
// monkey-patched with an in-memory fake: withAdvisoryLock news up its own
// `new Client(...)` internally, and connect/query/end are prototype methods,
// so the patch is the one seam that exercises the REAL control flow with zero
// network/DB. Each test file runs in its own child process — the patch cannot
// leak into other suites.
import { test } from "node:test";
import assert from "node:assert/strict";
import { Client } from "pg";
import {
  WARM_OMDB_LOCK_ID,
  WARM_MDBLIST_LOCK_ID,
  TRASH_SYNC_LOCK_ID,
  AdvisoryLockTimeoutError,
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
let tryLockRows: Array<{ acquired: boolean }> = [{ acquired: true }];

const proto = Client.prototype as unknown as ClientProtoMock;
proto.connect = async () => {
  calls.push({ op: "connect" });
};
proto.query = async (text, values) => {
  calls.push({ op: "query", text, values });
  if (text.includes("pg_try_advisory_lock")) return { rows: tryLockRows };
  return { rows: [] };
};
proto.end = async () => {
  calls.push({ op: "end" });
};

function reset(rows: Array<{ acquired: boolean }>): void {
  calls.length = 0;
  tryLockRows = rows;
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
  // Exact statement order: connection first, session timeouts, try-lock,
  // unlock — and the unlock/end pair always closes the run.
  assert.equal(calls[0]?.op, "connect");
  assert.deepEqual(queryTexts(), [
    "SET statement_timeout = '30min'",
    "SET idle_in_transaction_session_timeout = '30min'",
    "SELECT pg_try_advisory_lock($1::bigint) AS acquired",
    "SELECT pg_advisory_unlock($1::bigint)",
  ]);
  // Both lock statements target the SAME id the caller passed.
  const lockValues = calls.flatMap((c) => (c.op === "query" ? [c.values] : []));
  assert.deepEqual(lockValues, [undefined, undefined, [WARM_OMDB_LOCK_ID], [WARM_OMDB_LOCK_ID]]);
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

test("timeout: rejects AdvisoryLockTimeoutError, aborts the signal, still unlocks", async () => {
  reset([{ acquired: true }]);
  const seenSignals: AbortSignal[] = [];
  const pending = withAdvisoryLock(
    WARM_OMDB_LOCK_ID,
    (signal: AbortSignal) => {
      seenSignals.push(signal);
      // Never settles — simulates wedged work. A pending promise holds no
      // event-loop handle and the module clears its timer, so the process
      // still exits promptly.
      return new Promise<never>(() => {});
    },
    () => "busy" as const,
    { timeoutMs: 40 },
  );
  await assert.rejects(pending, (err: unknown) => {
    assert.ok(err instanceof AdvisoryLockTimeoutError);
    assert.equal(err.name, "AdvisoryLockTimeoutError");
    assert.equal(err.message, `Advisory lock ${WARM_OMDB_LOCK_ID} work exceeded 40ms`);
    return true;
  });
  assert.equal(seenSignals.length, 1);
  // The signal fires (with the timeout error as reason) so signal-aware work
  // can stop issuing DB statements before pg_advisory_unlock runs.
  assert.equal(seenSignals[0].aborted, true);
  assert.ok(seenSignals[0].reason instanceof AdvisoryLockTimeoutError);
  assert.ok(queryTexts().some((t) => t.includes("pg_advisory_unlock")));
  assert.equal(calls.at(-1)?.op, "end");
});
