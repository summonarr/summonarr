// Unit tests for runWithSerializableRetry (src/lib/serializable-retry.ts) —
// the retry policy wrapped around Serializable transactions (POST /api/requests
// and the bulk request route). Under Serializable isolation two concurrent
// quota count+create transactions conflict and Postgres aborts one with P2034;
// retrying re-reads the committed state so the loser surfaces as the correct
// 429/409 instead of a 500. The policy is safety-critical in both directions:
// it must retry ONLY genuine P2034 write-conflicts (a retried unique-violation
// or app error would re-run non-idempotent work), and it must stop at the
// attempt cap (an unbounded loop on a persistent conflict would hang the
// request). The module is fully pure — no timers, no DB, no network — so
// everything here is exercised with in-memory fakes and real
// Prisma.PrismaClientKnownRequestError instances from the generated client.
import { test } from "node:test";
import assert from "node:assert/strict";
import { Prisma } from "@/generated/prisma";
import { runWithSerializableRetry } from "../src/lib/serializable-retry.ts";

function knownError(code: string, message = `prisma error ${code}`): Prisma.PrismaClientKnownRequestError {
  return new Prisma.PrismaClientKnownRequestError(message, {
    code,
    clientVersion: "0.0.0-test",
  });
}

// A distinct P2034 instance per call, so identity assertions can tell attempts apart.
const writeConflict = () => knownError("P2034", "write conflict");

test("first-attempt success returns the value and never re-invokes fn", async () => {
  let calls = 0;
  const result = await runWithSerializableRetry(async () => {
    calls++;
    return { requestId: 42 };
  });
  assert.deepEqual(result, { requestId: 42 });
  assert.equal(calls, 1);
});

test("P2034 on attempt 1 is retried; the retry's success value is returned", async () => {
  let calls = 0;
  const result = await runWithSerializableRetry(async () => {
    calls++;
    if (calls === 1) throw writeConflict();
    return `won-on-attempt-${calls}`;
  });
  assert.equal(result, "won-on-attempt-2");
  assert.equal(calls, 2);
});

test("DEFAULT CAP PIN: exactly 3 attempts — success on the 3rd (last) attempt is returned", async () => {
  let calls = 0;
  const result = await runWithSerializableRetry(async () => {
    calls++;
    if (calls < 3) throw writeConflict();
    return "third-time-lucky";
  });
  assert.equal(result, "third-time-lucky");
  assert.equal(calls, 3);
});

test("DEFAULT CAP PIN: persistent P2034 throws after exactly 3 attempts, rethrowing the LAST error instance", async () => {
  let calls = 0;
  const errors: Prisma.PrismaClientKnownRequestError[] = [];
  const started = Date.now();
  await assert.rejects(
    runWithSerializableRetry(async () => {
      calls++;
      const err = writeConflict();
      errors.push(err);
      throw err;
    }),
    (thrown: unknown) => thrown === errors[2], // the 3rd attempt's instance, not the 1st
  );
  assert.equal(calls, 3);
  // Retries are immediate — there is no backoff sleep in the policy. Three
  // attempts must complete near-instantly (generous bound to avoid flakes).
  assert.ok(Date.now() - started < 1_000);
});

test("a 4th conflict is NOT attempted under the default cap", async () => {
  // Success would have arrived on attempt 4 — the cap must throw before it.
  let calls = 0;
  await assert.rejects(
    runWithSerializableRetry(async () => {
      calls++;
      if (calls < 4) throw writeConflict();
      return "unreachable";
    }),
    (thrown: unknown) =>
      thrown instanceof Prisma.PrismaClientKnownRequestError && thrown.code === "P2034",
  );
  assert.equal(calls, 3);
});

test("P2002 (unique violation) is rethrown immediately — never retried", async () => {
  // The /api/requests pattern relies on the P2002 propagating so the outer
  // catch can map it to 409. Retrying it would just hit the same constraint
  // and, worse, re-run any non-idempotent work in the transaction callback.
  let calls = 0;
  const err = knownError("P2002", "unique constraint violation");
  await assert.rejects(
    runWithSerializableRetry(async () => {
      calls++;
      throw err;
    }),
    (thrown: unknown) => thrown === err, // exact instance, meta intact for the caller's mapping
  );
  assert.equal(calls, 1);
});

test("a plain Error is rethrown immediately — never retried", async () => {
  let calls = 0;
  const err = new Error("connection reset");
  await assert.rejects(
    runWithSerializableRetry(async () => {
      calls++;
      throw err;
    }),
    (thrown: unknown) => thrown === err,
  );
  assert.equal(calls, 1);
});

test("a non-Error thrown value propagates unchanged without a retry", async () => {
  let calls = 0;
  await assert.rejects(
    runWithSerializableRetry<never>(async () => {
      calls++;
      throw "string rejection";
    }),
    (thrown: unknown) => thrown === "string rejection",
  );
  assert.equal(calls, 1);
});

test("FAIL-CLOSED PIN: a duck-typed { code: 'P2034' } object is NOT retried (instanceof gate)", async () => {
  // Only the real Prisma error class qualifies. A look-alike (e.g. an error
  // from a different Prisma client instance's copy of the class, or a shaped
  // object from a wrapper) fails the instanceof check and propagates on
  // attempt 1. If Prisma is ever upgraded such that dual-package hazards make
  // real P2034s fail this gate, retries silently stop — this test documents
  // that the gate is instance-based, not shape-based.
  let calls = 0;
  const fake = Object.assign(new Error("write conflict"), { code: "P2034" });
  await assert.rejects(
    runWithSerializableRetry(async () => {
      calls++;
      throw fake;
    }),
    (thrown: unknown) => thrown === fake,
  );
  assert.equal(calls, 1);
});

test("code match is exact — lowercase 'p2034' is not retried", async () => {
  let calls = 0;
  const err = knownError("p2034");
  await assert.rejects(
    runWithSerializableRetry(async () => {
      calls++;
      throw err;
    }),
    (thrown: unknown) => thrown === err,
  );
  assert.equal(calls, 1);
});

test("P2034 then P2002: the retry's non-retryable error is thrown from attempt 2", async () => {
  let calls = 0;
  const second = knownError("P2002");
  await assert.rejects(
    runWithSerializableRetry(async () => {
      calls++;
      if (calls === 1) throw writeConflict();
      throw second;
    }),
    (thrown: unknown) => thrown === second,
  );
  assert.equal(calls, 2);
});

test("attempts=1 disables retries: a single P2034 propagates after one call", async () => {
  let calls = 0;
  await assert.rejects(
    runWithSerializableRetry(async () => {
      calls++;
      throw writeConflict();
    }, 1),
    (thrown: unknown) =>
      thrown instanceof Prisma.PrismaClientKnownRequestError && thrown.code === "P2034",
  );
  assert.equal(calls, 1);
});

test("PINS CURRENT BEHAVIOR: attempts=0 still runs fn once (never zero executions)", async () => {
  // The loop always executes fn before consulting the cap, so a nonsensical
  // attempts=0 (or negative) degrades to attempts=1 rather than silently
  // skipping the transaction and returning undefined.
  let calls = 0;
  await assert.rejects(
    runWithSerializableRetry(async () => {
      calls++;
      throw writeConflict();
    }, 0),
    (thrown: unknown) =>
      thrown instanceof Prisma.PrismaClientKnownRequestError && thrown.code === "P2034",
  );
  assert.equal(calls, 1);

  // ...and a success still returns normally.
  const value = await runWithSerializableRetry(async () => "ran", 0);
  assert.equal(value, "ran");
});

test("a custom attempts=5 cap is honored exactly on exhaustion", async () => {
  let calls = 0;
  await assert.rejects(
    runWithSerializableRetry(async () => {
      calls++;
      throw writeConflict();
    }, 5),
    (thrown: unknown) =>
      thrown instanceof Prisma.PrismaClientKnownRequestError && thrown.code === "P2034",
  );
  assert.equal(calls, 5);
});

test("a custom attempts=5 cap allows success on attempt 4 (beyond the default cap)", async () => {
  let calls = 0;
  const result = await runWithSerializableRetry(async () => {
    calls++;
    if (calls < 4) throw writeConflict();
    return calls;
  }, 5);
  assert.equal(result, 4);
  assert.equal(calls, 4);
});

test("a synchronously-throwing fn is caught by the same policy (retried on P2034)", async () => {
  // fn is typed () => Promise<T>, but a callback that throws before returning
  // its promise is still valid TS (never ⊆ Promise<T>) and must not escape the
  // retry loop — `await fn()` keeps the sync throw inside the try.
  let calls = 0;
  const result = await runWithSerializableRetry<string>(() => {
    calls++;
    if (calls === 1) throw writeConflict();
    return Promise.resolve("recovered");
  });
  assert.equal(result, "recovered");
  assert.equal(calls, 2);
});

test("resolved undefined is a success, not a retry trigger", async () => {
  let calls = 0;
  const result = await runWithSerializableRetry(async () => {
    calls++;
    return undefined;
  });
  assert.equal(result, undefined);
  assert.equal(calls, 1);
});
