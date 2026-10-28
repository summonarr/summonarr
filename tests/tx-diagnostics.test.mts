// Transaction failure diagnosis: postgresErrorCode / txFailureKind
// (prisma-errors.ts) and describeTxFailure / txTrace (tx-diagnostics.ts).
//
// The fixtures are the shapes Prisma 7.10.1 + adapter-pg threw against a live
// Postgres 17 (2026-10-28): a lock_timeout and a statement_timeout cancel on a
// model query arrive as P2039, the same cancel on a raw query as P2010, a
// deadlock as P2034, and each keeps the SQLSTATE on
// meta.driverAdapterError.cause.originalCode. Prisma's own deadline is P2028
// with no Postgres code at all.
import { test } from "node:test";
import assert from "node:assert/strict";

const { Prisma } = await import("../src/generated/prisma/index.js");
const { postgresErrorCode, txFailureKind } = await import("../src/lib/prisma-errors.ts");
const { describeTxFailure, txTrace, seconds } = await import("../src/lib/tx-diagnostics.ts");

function known(code: string, message: string, meta?: Record<string, unknown>) {
  return new Prisma.PrismaClientKnownRequestError(message, { code, clientVersion: "7.10.1", meta });
}
const adapter = (originalCode: string, kind = "postgres") => ({ driverAdapterError: { cause: { originalCode, kind } } });

const FIXTURES = {
  lockTimeout: known(
    "P2039",
    "\nInvalid `prisma.titleSuggestion.deleteMany()` invocation:\n\n\nDatabase error. Code: `55P03`. Message: `canceling statement due to lock timeout`",
    { modelName: "TitleSuggestion", ...adapter("55P03") },
  ),
  statementTimeout: known(
    "P2039",
    "\nInvalid `prisma.titleSuggestion.deleteMany()` invocation:\n\n\nDatabase error. Code: `57014`. Message: `canceling statement due to statement timeout`",
    { modelName: "TitleSuggestion", ...adapter("57014") },
  ),
  rawStatementTimeout: known(
    "P2010",
    "\nInvalid `prisma.$queryRaw()` invocation:\n\n\nRaw query failed. Code: `57014`. Message: `canceling statement due to statement timeout`",
    adapter("57014"),
  ),
  cancelled: known(
    "P2039",
    "Database error. Code: `57014`. Message: `canceling statement due to user request`",
    adapter("57014"),
  ),
  deadlock: known(
    "P2034",
    "Transaction failed due to a write conflict or a deadlock. Please retry your transaction",
    { modelName: "TitleSuggestion", ...adapter("40P01", "TransactionWriteConflict") },
  ),
  serialization: known(
    "P2034",
    "Transaction failed due to a write conflict or a deadlock. Please retry your transaction",
    adapter("40001", "TransactionWriteConflict"),
  ),
  expired: known(
    "P2028",
    "\nInvalid `prisma.recommendationTitle.createMany()` invocation:\n\n\nTransaction API error: A query cannot be executed on an expired transaction. The timeout for this transaction was 30000 ms, however 38989 ms passed since the start of the transaction. Consider increasing the interactive transaction timeout or doing less work in the transaction.",
    { modelName: "RecommendationTitle", operation: "query", timeout: 30000, timeTaken: 38989 },
  ),
  startTimeout: known("P2028", "Transaction API error: Unable to start a transaction in the given time."),
  unique: known("P2002", "Unique constraint failed on the fields: (`id`)", { modelName: "User", ...adapter("23505", "UniqueConstraintViolation") }),
};

test("txFailureKind reads every live shape", () => {
  assert.equal(txFailureKind(FIXTURES.lockTimeout), "lock-timeout");
  assert.equal(txFailureKind(FIXTURES.statementTimeout), "statement-timeout");
  assert.equal(txFailureKind(FIXTURES.rawStatementTimeout), "statement-timeout");
  assert.equal(txFailureKind(FIXTURES.cancelled), "cancelled");
  assert.equal(txFailureKind(FIXTURES.deadlock), "deadlock");
  assert.equal(txFailureKind(FIXTURES.serialization), "serialization");
  assert.equal(txFailureKind(FIXTURES.expired), "expired");
  assert.equal(txFailureKind(FIXTURES.startTimeout), "start-timeout");
  assert.equal(txFailureKind(FIXTURES.unique), "other");
});

test("postgresErrorCode: from the adapter's cause, else from Prisma's message, else null", () => {
  assert.equal(postgresErrorCode(FIXTURES.lockTimeout), "55P03");
  assert.equal(postgresErrorCode(FIXTURES.deadlock), "40P01");
  assert.equal(postgresErrorCode(FIXTURES.expired), null, "Prisma's own deadline has no Postgres code");
  // A copy whose meta lost the adapter error still names the code in its message.
  const noMeta = known("P2039", "Database error. Code: `55P03`. Message: `canceling statement due to lock timeout`");
  assert.equal(postgresErrorCode(noMeta), "55P03");
  assert.equal(txFailureKind(noMeta), "lock-timeout");
});

test("fail closed: only a Prisma known-request error is read", () => {
  const lookAlike = Object.assign(new Error("Code: `55P03`"), { meta: adapter("55P03") });
  for (const v of [null, undefined, "55P03", {}, { meta: adapter("55P03") }, lookAlike, new Error("canceling statement due to lock timeout")]) {
    assert.equal(postgresErrorCode(v), null, String(v));
    assert.equal(txFailureKind(v), "other", String(v));
  }
  // A P2028 with a message Prisma never writes is not guessed at.
  assert.equal(txFailureKind(known("P2028", "Transaction API error: Transaction not found.")), "other");
});

test("describeTxFailure: plain words, with the configured limits", () => {
  const limits = { txTimeoutMs: 30_000, statementTimeoutMs: 20_000, lockTimeoutMs: 10_000 };
  const text = (err: unknown) => describeTxFailure(err, limits).text;
  assert.equal(text(FIXTURES.lockTimeout), "waited past the 10.0s lock timeout for rows another transaction holds");
  assert.equal(text(FIXTURES.statementTimeout), "a statement ran past the 20.0s statement timeout and Postgres cancelled it");
  assert.equal(text(FIXTURES.expired), "ran past the 30.0s transaction limit");
  assert.equal(text(FIXTURES.deadlock), "deadlocked with another transaction, and Postgres aborted this one");
  assert.equal(text(FIXTURES.startTimeout), "got no database connection in time (the pool was busy)");
  assert.equal(describeTxFailure(FIXTURES.unique, limits).kind, "other");
  assert.equal(text(FIXTURES.unique), "Unique constraint failed on the fields: (`id`)", "an unknown cause is its own last line");
  // The "Invalid `prisma.x()` invocation:" header is skipped for the database's answer.
  const other = known("P2010", "\nInvalid `prisma.$queryRaw()` invocation:\n\n\nRaw query failed. Code: `42P01`. Message: `relation \"x\" does not exist`");
  assert.equal(text(other), "Raw query failed. Code: `42P01`. Message: `relation \"x\" does not exist`");
  // Without configured Postgres limits the sentence drops the number, not the meaning.
  assert.equal(describeTxFailure(FIXTURES.lockTimeout, { txTimeoutMs: 30_000 }).text, "waited past the lock timeout for rows another transaction holds");
  assert.ok(text("x".repeat(500)).endsWith("…"), "a huge message is clipped");
});

test("txTrace: each step runs until the next one starts; the last one runs to now", () => {
  let now = 1_000;
  const trace = txTrace(() => now);
  trace.step("start transaction");
  now += 20;
  trace.step("delete old edges");
  now += 150;
  trace.step("insert 2000 edges");
  now += 38_800;
  assert.equal(trace.summary(), "start transaction 0.0s, delete old edges 0.1s, insert 2000 edges 38.8s");
  assert.equal(trace.elapsedMs(), 38_970);
  assert.equal(txTrace(() => 0).summary(), "", "no steps, nothing to say");
  assert.equal(seconds(38_989), "39.0s");
});
