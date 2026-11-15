// The notification outbox against a REAL Postgres (outbox.ts, outbox-drain.ts).
// The claim and its outbox rows are one data-modifying CTE, and the drain takes
// rows with FOR UPDATE SKIP LOCKED — neither can be modelled by a stub.
import { test, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { prisma, resetDb, makeUser, makeRequests, closeDb } from "./_harness.mts";
import { claimAvailableNotifications } from "@/lib/notify-available.ts";
import { AVAILABLE_CHANNELS, OUTBOX_AVAILABLE_KIND, OUTBOX_MAX_ATTEMPTS, outboxKey, settleOutbox } from "@/lib/outbox.ts";
import { drainOutbox } from "@/lib/outbox-drain.ts";

async function reset(): Promise<void> {
  await resetDb();
  await prisma.$executeRawUnsafe(`TRUNCATE "Outbox", "Notification"`);
}
before(reset);
beforeEach(reset);
after(closeDb);

// What a restart leaves: the claimer's lock has lapsed and nobody settled.
const lapseLocks = () => prisma.$executeRawUnsafe(`UPDATE "Outbox" SET "lockedUntil" = NOW() - interval '1 minute'`);

test("the claim writes one LOCKED row per channel for each winner, in the claim's own statement", async () => {
  const user = await makeUser();
  const [a, b] = await makeRequests(user.id, 2, "APPROVED");

  const res = await claimAvailableNotifications([a, b], { markAvailable: true });
  assert.equal(res.claimed.length, 2);

  const rows = await prisma.outbox.findMany();
  assert.equal(rows.length, 2 * AVAILABLE_CHANNELS.length);
  assert.deepEqual(
    rows.map((r) => r.dedupeKey).sort(),
    [a, b].flatMap((r) => AVAILABLE_CHANNELS.map((c) => outboxKey(OUTBOX_AVAILABLE_KIND, r.id, c))).sort(),
  );
  const now = Date.now();
  for (const r of rows) {
    assert.equal(r.kind, OUTBOX_AVAILABLE_KIND);
    assert.equal(r.userId, user.id);
    assert.equal(r.attempts, 0);
    assert.ok(r.lockedUntil.getTime() > now + 60_000, "locked for the claimer: the drain must not see it yet");
    assert.ok(r.expiresAt.getTime() > r.lockedUntil.getTime());
    const p = r.payload as Record<string, unknown>;
    assert.equal(typeof p, "object");
    assert.ok(!Array.isArray(p), "a JSON object, never a top-level array");
    assert.deepEqual(Object.keys(p).sort(), ["arrInstance", "id", "mediaType", "posterPath", "requestedBy", "title", "tmdbId"]);
    assert.equal(p.requestedBy, user.id);
    assert.equal(p.mediaType, "MOVIE");
    assert.equal(p.arrInstance, "");
  }
});

test("racing claimers: each request gets its channel rows exactly once", async () => {
  const user = await makeUser();
  const candidates = await makeRequests(user.id, 20, "APPROVED");

  await Promise.all([0, 1, 2, 3].map(() => claimAvailableNotifications(candidates, { markAvailable: true })));

  assert.equal(await prisma.outbox.count(), candidates.length * AVAILABLE_CHANNELS.length);
});

test("a row that loses the claim, and a DISABLED requester's claim, owe nothing", async () => {
  const active = await makeUser();
  const disabled = await makeUser({ deactivated: true });
  const [declined] = await makeRequests(active.id, 1, "DECLINED");
  const [gone] = await makeRequests(disabled.id, 1, "APPROVED");

  const res = await claimAvailableNotifications([declined, gone], { markAvailable: true });
  assert.deepEqual(res.claimed.map((c) => c.id), [gone.id], "the disabled requester's row still flips");
  assert.deepEqual(res.deliverable, []);
  assert.equal(await prisma.outbox.count(), 0);
});

test("settling a channel deletes that channel's rows only", async () => {
  const user = await makeUser();
  const [a] = await makeRequests(user.id, 1, "APPROVED");
  await claimAvailableNotifications([a], { markAvailable: true });

  await settleOutbox(OUTBOX_AVAILABLE_KIND, "discord", [a.id]);

  const left = (await prisma.outbox.findMany()).map((r) => r.channel).sort();
  assert.deepEqual(left, AVAILABLE_CHANNELS.filter((c) => c !== "discord").sort());
});

test("the drain leaves a live claimer's rows alone", async () => {
  const user = await makeUser();
  const [a] = await makeRequests(user.id, 1, "APPROVED");
  await claimAvailableNotifications([a], { markAvailable: true });

  assert.deepEqual(await drainOutbox("test"), { delivered: 0, dropped: 0 });
  assert.equal(await prisma.outbox.count(), AVAILABLE_CHANNELS.length);
  assert.equal(await prisma.notification.count(), 0);
});

test("after a restart: the drain sends what was owed (the inbox row appears) and the outbox empties", async () => {
  const user = await makeUser();
  const [a] = await makeRequests(user.id, 1, "APPROVED");
  await claimAvailableNotifications([a], { markAvailable: true });
  await lapseLocks();

  const res = await drainOutbox("test");
  assert.deepEqual(res, { delivered: AVAILABLE_CHANNELS.length, dropped: 0 });

  const inbox = await prisma.notification.findMany({ where: { userId: user.id } });
  assert.equal(inbox.length, 1, "the in-app notification was written from the stored payload");
  assert.equal(inbox[0].type, "REQUEST_AVAILABLE");
  assert.equal(await prisma.outbox.count(), 0, "every channel settled");

  // Nothing left to send: a second pass is a no-op, not a second notification.
  assert.deepEqual(await drainOutbox("test"), { delivered: 0, dropped: 0 });
  assert.equal(await prisma.notification.count(), 1);
});

test("the drain drops an expired row, a row out of attempts and a since-disabled requester's row, unsent", async () => {
  const user = await makeUser();
  const [expired, tired] = await makeRequests(user.id, 2, "APPROVED");
  const leaving = await makeUser();
  const [left] = await makeRequests(leaving.id, 1, "APPROVED");
  await claimAvailableNotifications([expired, tired, left], { markAvailable: true });
  await lapseLocks();
  await prisma.$executeRawUnsafe(`UPDATE "Outbox" SET "expiresAt" = NOW() - interval '1 minute' WHERE "dedupeKey" LIKE '%:${expired.id}:%'`);
  await prisma.$executeRawUnsafe(`UPDATE "Outbox" SET attempts = ${OUTBOX_MAX_ATTEMPTS} WHERE "dedupeKey" LIKE '%:${tired.id}:%'`);
  await prisma.user.update({ where: { id: leaving.id }, data: { deactivatedAt: new Date() } });

  const res = await drainOutbox("test");
  assert.deepEqual(res, { delivered: 0, dropped: 3 * AVAILABLE_CHANNELS.length });
  assert.equal(await prisma.outbox.count(), 0);
  assert.equal(await prisma.notification.count(), 0);
});

test("two drain passes at once never take the same row (SKIP LOCKED): one inbox row, not two", async () => {
  const user = await makeUser();
  const reqs = await makeRequests(user.id, 10, "APPROVED");
  await claimAvailableNotifications(reqs, { markAvailable: true });
  await lapseLocks();

  const [x, y] = await Promise.all([drainOutbox("test"), drainOutbox("test")]);
  assert.equal(x.delivered + y.delivered, reqs.length * AVAILABLE_CHANNELS.length);
  assert.equal(await prisma.notification.count(), reqs.length);
  assert.equal(await prisma.outbox.count(), 0);
});

test("a drain pass RE-LOCKS what it takes: a row it could not settle is not sent again by the next pass", async () => {
  const user = await makeUser();
  const [a] = await makeRequests(user.id, 1, "APPROVED");
  await claimAvailableNotifications([a], { markAvailable: true });
  await lapseLocks();

  // The sends happen, the deletes fail (a busy pool): the rows stay behind.
  const outbox = prisma.outbox as unknown as { deleteMany: unknown };
  const realDelete = outbox.deleteMany;
  outbox.deleteMany = async () => { throw new Error("delete failed (db test)"); };
  try {
    await drainOutbox("test");
  } finally {
    outbox.deleteMany = realDelete;
  }
  assert.equal(await prisma.notification.count(), 1);
  const rows = await prisma.outbox.findMany();
  assert.equal(rows.length, AVAILABLE_CHANNELS.length);
  assert.ok(rows.every((r) => r.attempts === 1 && r.lockedUntil.getTime() > Date.now() + 60_000), "taken rows are locked again and the attempt is counted");

  assert.deepEqual(await drainOutbox("test"), { delivered: 0, dropped: 0 });
  assert.equal(await prisma.notification.count(), 1, "not sent a second time while the new lock holds");
});

// ═══ Approve / decline notices ══════════════════════════════════════════════
// The decision claim and the notices it owes commit in ONE transaction
// (request-transition.ts claimAndQueue + outbox.ts queueDecisionNotices).

const { claimApproval, claimDecline, claimPendingBatch, notifyDecided } = await import("@/lib/request-transition.ts");
const { OUTBOX_APPROVED_KIND, OUTBOX_DECLINED_KIND, cancelOutbox } = await import("@/lib/outbox.ts");

const rowsOfKind = (kind: string) => prisma.outbox.findMany({ where: { kind } });
async function waitForEmptyOutbox(): Promise<void> {
  for (let i = 0; i < 200; i++) {
    if ((await prisma.outbox.count()) === 0) return;
    await new Promise((r) => setTimeout(r, 10));
  }
  assert.fail("the outbox never emptied");
}

test("an approval by ANOTHER account queues one locked 'approved' row per channel; a lost claim queues nothing", async () => {
  const requester = await makeUser();
  const admin = await makeUser();
  const [r] = await makeRequests(requester.id, 1, "PENDING");

  assert.equal(await claimApproval(r.id, "DECLINED", { actorId: admin.id }), false, "the row is not DECLINED: the claim loses");
  assert.equal(await prisma.outbox.count(), 0);

  assert.equal(await claimApproval(r.id, "PENDING", { actorId: admin.id, adminNote: "enjoy" }), true);
  const rows = await rowsOfKind(OUTBOX_APPROVED_KIND);
  assert.deepEqual(rows.map((x) => x.channel).sort(), [...AVAILABLE_CHANNELS].sort());
  for (const x of rows) {
    assert.equal(x.userId, requester.id);
    assert.ok(x.lockedUntil.getTime() > Date.now() + 60_000);
    const p = x.payload as Record<string, unknown>;
    assert.equal(p.id, r.id);
    assert.equal(p.adminNote, "enjoy", "the note as the claim left it");
  }
  assert.equal(await prisma.outbox.count(), AVAILABLE_CHANNELS.length);
});

test("deciding your OWN request, or a disabled requester's, owes no notice", async () => {
  const self = await makeUser();
  const gone = await makeUser({ deactivated: true });
  const admin = await makeUser();
  const [mine] = await makeRequests(self.id, 1, "PENDING");
  const [theirs] = await makeRequests(gone.id, 1, "PENDING");

  assert.equal(await claimApproval(mine.id, "PENDING", { actorId: self.id }), true);
  assert.equal(await claimDecline(theirs.id, "PENDING", { actorId: admin.id }), true);
  assert.equal(await prisma.outbox.count(), 0);
});

test("the batch claim queues notices for exactly the rows IT moved", async () => {
  const requester = await makeUser();
  const admin = await makeUser();
  const [a, b] = await makeRequests(requester.id, 2, "PENDING");
  const [already] = await makeRequests(requester.id, 1, "APPROVED");

  const claimed = await claimPendingBatch([a.id, b.id, already.id], "DECLINED", { actorId: admin.id, adminNote: "not this one" });
  assert.deepEqual(claimed.map((c) => c.id).sort(), [a.id, b.id].sort());

  const rows = await rowsOfKind(OUTBOX_DECLINED_KIND);
  assert.equal(rows.length, 2 * AVAILABLE_CHANNELS.length);
  assert.ok(rows.every((x) => (x.payload as { adminNote?: string }).adminNote === "not this one"));
  assert.ok(!rows.some((x) => x.dedupeKey.includes(`:${already.id}:`)));
  assert.equal(await prisma.outbox.count(), rows.length, "no 'approved' rows from a decline");
});

test("ONE transaction: when the notices cannot be queued the decision does not commit", async () => {
  const requester = await makeUser();
  const admin = await makeUser();
  const [r] = await makeRequests(requester.id, 1, "PENDING");

  await prisma.$executeRawUnsafe(`ALTER TABLE "Outbox" RENAME TO "Outbox_away"`);
  try {
    await assert.rejects(claimApproval(r.id, "PENDING", { actorId: admin.id }));
  } finally {
    await prisma.$executeRawUnsafe(`ALTER TABLE "Outbox_away" RENAME TO "Outbox"`);
  }
  const after = await prisma.mediaRequest.findUniqueOrThrow({ where: { id: r.id } });
  assert.equal(after.status, "PENDING", "the claim rolled back with the failed insert");
  assert.equal(after.approvedAt, null);
});

test("the in-process send settles every channel of a decision", async () => {
  const requester = await makeUser();
  const admin = await makeUser();
  const [r] = await makeRequests(requester.id, 1, "PENDING");
  await claimDecline(r.id, "PENDING", { actorId: admin.id });
  const row = await prisma.mediaRequest.findUniqueOrThrow({ where: { id: r.id } });

  await notifyDecided("DECLINED", [row], admin.id, "test");
  await waitForEmptyOutbox();
  const inbox = await prisma.notification.findMany({ where: { userId: requester.id } });
  assert.deepEqual(inbox.map((n) => n.type), ["REQUEST_DECLINED"]);
});

test("after a restart the drain sends a decision that is STILL TRUE, and drops one that is not", async () => {
  const requester = await makeUser();
  const admin = await makeUser();
  const [stands, rolledBack, reopened] = await makeRequests(requester.id, 3, "PENDING");
  await claimApproval(stands.id, "PENDING", { actorId: admin.id });
  await claimApproval(rolledBack.id, "PENDING", { actorId: admin.id });
  await claimDecline(reopened.id, "PENDING", { actorId: admin.id });
  // The push failed and the row went back to PENDING; the decline was reopened.
  await prisma.mediaRequest.update({ where: { id: rolledBack.id }, data: { status: "PENDING" } });
  await prisma.mediaRequest.update({ where: { id: reopened.id }, data: { status: "PENDING" } });
  await lapseLocks();

  const res = await drainOutbox("test");
  assert.deepEqual(res, { delivered: AVAILABLE_CHANNELS.length, dropped: 2 * AVAILABLE_CHANNELS.length });
  const inbox = await prisma.notification.findMany();
  assert.deepEqual(inbox.map((n) => `${n.type}:${n.userId}`), [`REQUEST_APPROVED:${requester.id}`]);
  assert.equal(await prisma.outbox.count(), 0);
});

test("cancelOutbox takes back every channel of one kind for the given requests only", async () => {
  const requester = await makeUser();
  const admin = await makeUser();
  const [a, b] = await makeRequests(requester.id, 2, "PENDING");
  await claimApproval(a.id, "PENDING", { actorId: admin.id });
  await claimApproval(b.id, "PENDING", { actorId: admin.id });

  await cancelOutbox(OUTBOX_APPROVED_KIND, [a.id]);

  const left = await prisma.outbox.findMany();
  assert.equal(left.length, AVAILABLE_CHANNELS.length);
  assert.ok(left.every((x) => x.dedupeKey.includes(`:${b.id}:`)));
});
