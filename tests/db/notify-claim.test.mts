// The "now available" compare-and-swap against a REAL Postgres (guardrail 14).
// The unit suite models this UPDATE … RETURNING with an in-memory fake; here the
// database itself arbitrates, so a regression to a read-then-write shows up as a
// double notification instead of passing a stub.
import { test, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { prisma, resetDb, makeUser, makeRequests, closeDb } from "./_harness.mts";
import { claimAvailableNotifications } from "@/lib/notify-available.ts";

before(resetDb);
beforeEach(resetDb);
after(closeDb);

test("concurrent claimers over the SAME candidates: every request is won exactly once", async () => {
  const user = await makeUser();
  const candidates = await makeRequests(user.id, 25, "APPROVED");

  // Four callers (orchestrator, per-source route, webhook poller, …) race the same snapshot.
  const results = await Promise.all(
    [0, 1, 2, 3].map(() => claimAvailableNotifications(candidates, { markAvailable: true })),
  );

  const won = results.flatMap((r) => r.claimed.map((c) => c.id));
  assert.equal(won.length, candidates.length, "total winners must equal the request count — no row won twice, none lost");
  assert.equal(new Set(won).size, candidates.length, "no request id appears in two callers' winner sets");

  const rows = await prisma.mediaRequest.findMany({ where: { requestedBy: user.id } });
  assert.ok(rows.every((r) => r.status === "AVAILABLE" && r.notifiedAvailable && r.availableAt), "every row ends AVAILABLE with the flag burned");
});

test("a request DECLINED before the claim runs is never resurrected to AVAILABLE", async () => {
  const user = await makeUser();
  const [approved] = await makeRequests(user.id, 1, "APPROVED");
  const [declined] = await makeRequests(user.id, 1, "DECLINED");

  const res = await claimAvailableNotifications([approved, declined], { markAvailable: true });

  assert.deepEqual(res.claimed.map((c) => c.id), [approved.id]);
  const after = await prisma.mediaRequest.findUniqueOrThrow({ where: { id: declined.id } });
  assert.equal(after.status, "DECLINED", "DECLINED is not a source status for the flip");
  assert.equal(after.notifiedAvailable, false);
});

test("a DISABLED requester's claim is burned and the row flips, but nothing is deliverable", async () => {
  const active = await makeUser();
  const disabled = await makeUser({ deactivated: true });
  const [a] = await makeRequests(active.id, 1, "APPROVED");
  const [d] = await makeRequests(disabled.id, 1, "APPROVED");

  const res = await claimAvailableNotifications([a, d], { markAvailable: true });

  assert.deepEqual(res.claimed.map((c) => c.id).sort(), [a.id, d.id].sort());
  assert.deepEqual(res.deliverable.map((c) => c.id), [a.id], "only the active requester is notified");
  const row = await prisma.mediaRequest.findUniqueOrThrow({ where: { id: d.id } });
  assert.ok(row.notifiedAvailable && row.status === "AVAILABLE", "the transition still happened");
});

test("the requireStatusAvailable fallback flips only rows that are ALREADY available", async () => {
  const user = await makeUser();
  const [pending] = await makeRequests(user.id, 1, "APPROVED");
  const [avail] = await makeRequests(user.id, 1, "AVAILABLE");

  const res = await claimAvailableNotifications([pending, avail], { requireStatusAvailable: true });

  assert.deepEqual(res.claimed.map((c) => c.id), [avail.id]);
  const p = await prisma.mediaRequest.findUniqueOrThrow({ where: { id: pending.id } });
  assert.equal(p.status, "APPROVED", "the fallback never sets status itself");
  assert.equal(p.notifiedAvailable, false);
});

test("concurrent requireStatusAvailable claimers (the notify fallback) win each already-available row exactly once", async () => {
  // This path has no status flip to arbitrate the race, so the notifiedAvailable
  // predicate alone is the compare-and-swap (guardrail 14).
  const user = await makeUser();
  const candidates = await makeRequests(user.id, 25, "AVAILABLE");

  const results = await Promise.all(
    [0, 1, 2, 3].map(() => claimAvailableNotifications(candidates, { requireStatusAvailable: true })),
  );

  const won = results.flatMap((r) => r.claimed.map((c) => c.id));
  assert.equal(won.length, candidates.length, "no row is won twice");
  assert.equal(new Set(won).size, candidates.length);
});
