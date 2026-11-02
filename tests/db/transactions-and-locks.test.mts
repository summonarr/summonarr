// Transaction and advisory-lock semantics against a REAL Postgres: the class of
// bug the stubbed unit suite structurally cannot see (guardrails 23, 41).
import { test, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { prisma, resetDb, makeUser, closeDb } from "./_harness.mts";
import { withAdvisoryLock } from "@/lib/advisory-lock.ts";

before(resetDb);
beforeEach(resetDb);
after(closeDb);

test("guardrail 23: a write error swallowed INSIDE an interactive $transaction still discards every earlier write", async () => {
  const dup = await makeUser();
  const newEmail = `rolled-back-${Date.now()}@db-suite.test`;

  let threw = false;
  try {
    await prisma.$transaction(async (tx) => {
      await tx.user.create({ data: { email: newEmail } });
      try {
        await tx.user.create({ data: { email: dup.email } }); // unique violation aborts the Postgres tx
      } catch {
        /* the swallowed error the guardrail forbids */
      }
    });
  } catch {
    threw = true; // either outcome (throw or silent rollback) is acceptable; persisting the first write is not
  }

  const persisted = await prisma.user.findUnique({ where: { email: newEmail } });
  assert.equal(persisted, null, `the earlier write must not survive (transaction ${threw ? "threw" : "silently rolled back"})`);
});

test("a tolerated unique violation done OUTSIDE the transaction via skipDuplicates leaves the transaction's writes intact", async () => {
  const existing = await makeUser();
  const newEmail = `kept-${Date.now()}@db-suite.test`;

  await prisma.$transaction(async (tx) => {
    await tx.user.create({ data: { email: newEmail } });
  });
  const gate = await prisma.user.createMany({ data: [{ email: existing.email }], skipDuplicates: true });

  assert.equal(gate.count, 0, "count === 0 tells the caller it lost the one-shot gate");
  assert.ok(await prisma.user.findUnique({ where: { email: newEmail } }), "the committed write is still there");
});

test("withAdvisoryLock: a second caller gets onBusy while the first holds the lock, and can take it after release", async () => {
  const LOCK = 987_001;
  let release!: () => void;
  const held = new Promise<void>((r) => (release = r));
  let entered!: () => void;
  const inside = new Promise<void>((r) => (entered = r));

  const first = withAdvisoryLock(
    LOCK,
    async () => {
      entered();
      await held;
      return "first";
    },
    () => "first-busy",
  );
  await inside;

  const second = await withAdvisoryLock(LOCK, async () => "second", () => "busy");
  assert.equal(second, "busy", "the lock is exclusive across connections");

  release();
  assert.equal(await first, "first");

  const third = await withAdvisoryLock(LOCK, async () => "third", () => "busy");
  assert.equal(third, "third", "released on completion, so the next caller acquires it");
});

test("withAdvisoryLock: the lock is released even when the work throws", async () => {
  const LOCK = 987_002;
  await assert.rejects(
    withAdvisoryLock(LOCK, async () => { throw new Error("boom"); }, () => "busy"),
    /boom/,
  );
  assert.equal(await withAdvisoryLock(LOCK, async () => "ok", () => "busy"), "ok");
});
