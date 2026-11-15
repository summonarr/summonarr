// The notification outbox against a REAL Postgres (outbox.ts, outbox-drain.ts).
// The claim and its outbox rows are one data-modifying CTE, and the drain takes
// rows with FOR UPDATE SKIP LOCKED — neither can be modelled by a stub.
import { test, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { prisma, resetDb, makeUser, makeRequests, closeDb } from "./_harness.mts";
import { claimAvailableNotifications } from "@/lib/notify-available.ts";
import { AVAILABLE_CHANNELS, OUTBOX_AVAILABLE_KIND, OUTBOX_MAX_ATTEMPTS, outboxKey, settleOutbox } from "@/lib/outbox.ts";
import { drainOutbox } from "@/lib/outbox-drain.ts";
import { OUTBOX_GRAB_KIND, OUTBOX_VOTE_THRESHOLD_KIND, dropLegacyRetryMarkers, queueVoteAlert, voteAlertSubject } from "@/lib/outbox.ts";
import { claimGrabAndQueuePush } from "@/lib/issue-grab-notify.ts";

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

// ═══ Comment / issue-reply announcements ════════════════════════════════════
// One outbox row per comment or message, written in ITS transaction
// (outbox.ts queueAnnouncement) and announced whole by the drain.

const { queueAnnouncement, OUTBOX_COMMENT_KIND, OUTBOX_ISSUE_REPLY_KIND } = await import("@/lib/outbox.ts");

async function resetThreads(): Promise<void> {
  await prisma.$executeRawUnsafe(`TRUNCATE "RequestComment", "IssueMessage" CASCADE`);
}
beforeEach(resetThreads);

async function inboxOf(userId: string, tries = 200): Promise<string[]> {
  for (let i = 0; i < tries; i++) {
    const rows = await prisma.notification.findMany({ where: { userId } });
    if (rows.length > 0) return rows.map((n) => n.type);
    await new Promise((r) => setTimeout(r, 10));
  }
  return [];
}

async function writeComment(requestId: string, requesterId: string, authorId: string): Promise<string> {
  return prisma.$transaction(async (tx) => {
    const c = await tx.requestComment.create({ data: { requestId, authorId, body: "which version?", fromAdmin: true } });
    await queueAnnouncement(tx, OUTBOX_COMMENT_KIND, c.id, authorId, {
      commentId: c.id,
      request: { id: requestId, title: "Dune", mediaType: "MOVIE", tmdbId: 438631, posterPath: null, requestedBy: requesterId, arrInstance: "" },
      authorId,
      authorName: "Manager",
      authorDisplayName: "Manager",
      text: "which version?",
      authorIsManager: true,
    });
    return c.id;
  });
}

test("a comment and its announcement commit together: one locked row; a failed insert leaves neither", async () => {
  const requester = await makeUser();
  const manager = await makeUser();
  const [r] = await makeRequests(requester.id, 1, "PENDING");

  const commentId = await writeComment(r.id, requester.id, manager.id);
  const rows = await prisma.outbox.findMany();
  assert.equal(rows.length, 1);
  assert.equal(rows[0].dedupeKey, `request.comment:${commentId}:all`);
  assert.equal(rows[0].userId, manager.id);
  assert.ok(rows[0].lockedUntil.getTime() > Date.now() + 60_000);

  // The request is gone: the comment's foreign key fails, and nothing is queued.
  await assert.rejects(writeComment("no-such-request", requester.id, manager.id));
  assert.equal(await prisma.outbox.count(), 1);
  assert.equal(await prisma.requestComment.count(), 1);
});

test("after a restart the drain announces the comment to the requester and the row is settled", async () => {
  const requester = await makeUser();
  const manager = await makeUser();
  const [r] = await makeRequests(requester.id, 1, "PENDING");
  await writeComment(r.id, requester.id, manager.id);

  assert.deepEqual(await drainOutbox("test"), { delivered: 0, dropped: 0 }, "still locked by the writer");
  await lapseLocks();
  assert.deepEqual(await drainOutbox("test"), { delivered: 1, dropped: 0 });

  assert.deepEqual(await inboxOf(requester.id), ["REQUEST_COMMENT"]);
  await waitForEmptyOutbox();
});

test("the drain drops the announcement of a comment deleted since (its request was removed)", async () => {
  const requester = await makeUser();
  const manager = await makeUser();
  const [r] = await makeRequests(requester.id, 1, "PENDING");
  await writeComment(r.id, requester.id, manager.id);
  await prisma.mediaRequest.delete({ where: { id: r.id } }); // cascades to the comment
  await lapseLocks();

  assert.deepEqual(await drainOutbox("test"), { delivered: 0, dropped: 1 });
  assert.equal(await prisma.notification.count(), 0);
  assert.equal(await prisma.outbox.count(), 0);
});

test("an issue reply: queued with the message, announced to the reporter by the drain, dropped once the message is gone", async () => {
  const reporter = await makeUser();
  const admin = await makeUser();
  const issue = await prisma.issue.create({
    data: { reportedBy: reporter.id, mediaType: "MOVIE", tmdbId: 146233, title: "Prisoners", issueType: "BAD_VIDEO" },
  });
  const write = () => prisma.$transaction(async (tx) => {
    const m = await tx.issueMessage.create({ data: { issueId: issue.id, authorId: admin.id, body: "fixed", fromAdmin: true } });
    await queueAnnouncement(tx, OUTBOX_ISSUE_REPLY_KIND, m.id, admin.id, {
      messageId: m.id,
      issue: { id: issue.id, title: issue.title, mediaType: "MOVIE", tmdbId: issue.tmdbId, posterPath: null, issueType: "BAD_VIDEO", reportedBy: reporter.id, claimedBy: null },
      authorId: admin.id,
      authorDisplayName: "Admin A",
      authorName: "Admin A",
      fromIssueAdmin: true,
      text: "fixed",
    });
    return m.id;
  });

  const first = await write();
  await lapseLocks();
  assert.deepEqual(await drainOutbox("test"), { delivered: 1, dropped: 0 });
  assert.deepEqual(await inboxOf(reporter.id), ["ISSUE_REPLY"]);
  await waitForEmptyOutbox();

  await write();
  await prisma.issueMessage.deleteMany({ where: { id: { not: first } } });
  await lapseLocks();
  assert.deepEqual(await drainOutbox("test"), { delivered: 0, dropped: 1 });
  assert.equal(await prisma.notification.count(), 1, "no second inbox row");
});


// ═══ The admin's manual "mark available" ════════════════════════════════════

test("actorId: the actor's OWN request is claimed but queues no notice; another requester's queues all five; a row not AVAILABLE is not claimed", async () => {
  const admin = await makeUser();
  const other = await makeUser();
  const [mine] = await makeRequests(admin.id, 1, "AVAILABLE");
  const [theirs] = await makeRequests(other.id, 1, "AVAILABLE");
  const [pending] = await makeRequests(other.id, 1, "APPROVED");

  const res = await claimAvailableNotifications([mine, theirs, pending], { requireStatusAvailable: true, actorId: admin.id });
  assert.deepEqual(res.claimed.map((c) => c.id).sort(), [mine.id, theirs.id].sort());

  const rows = await prisma.outbox.findMany();
  assert.equal(rows.length, AVAILABLE_CHANNELS.length);
  assert.ok(rows.every((r) => r.userId === other.id && r.dedupeKey.includes(`:${theirs.id}:`)));
  const after = await prisma.mediaRequest.findUniqueOrThrow({ where: { id: pending.id } });
  assert.equal(after.notifiedAvailable, false);
});

// ═══ A send that failed stays owed and is retried ═══════════════════════════

test("a channel whose send FAILED keeps its row; the drain retries it after the lock lapses and settles it once it lands", async () => {
  const { fanOutAvailableWinners } = await import("@/lib/request-notifications.ts");
  const user = await makeUser();
  const [a] = await makeRequests(user.id, 1, "APPROVED");
  const { deliverable } = await claimAvailableNotifications([a], { markAvailable: true });
  const row = await prisma.mediaRequest.findUniqueOrThrow({ where: { id: a.id } });
  const winner = { ...deliverable[0], title: row.title, mediaType: row.mediaType, tmdbId: row.tmdbId, posterPath: row.posterPath, arrInstance: row.arrInstance };

  // The inbox write fails once (a busy pool); every other channel returns.
  const notification = prisma.notification as unknown as { createMany: unknown };
  const realCreateMany = notification.createMany;
  notification.createMany = async () => { throw new Error("pool exhausted (db test)"); };
  try {
    await fanOutAvailableWinners([winner], "test");
    for (let i = 0; i < 200 && (await prisma.outbox.count()) > 1; i++) await new Promise((r) => setTimeout(r, 10));
  } finally {
    notification.createMany = realCreateMany;
  }
  const left = await prisma.outbox.findMany();
  assert.deepEqual(left.map((r) => r.channel), ["inbox"], "only the failed channel is still owed");
  assert.equal(await prisma.notification.count(), 0);

  assert.deepEqual(await drainOutbox("test"), { delivered: 0, dropped: 0 }, "not before its lock lapses");
  await lapseLocks();
  assert.deepEqual(await drainOutbox("test"), { delivered: 1, dropped: 0 });
  assert.equal(await prisma.notification.count(), 1);
  assert.equal(await prisma.outbox.count(), 0);
});


// ═══ The grab push and the vote-threshold alert ═════════════════════════════
// Two sends that used to keep their own retry state in Setting rows. Each is
// now queued in the transaction that makes its once-only claim.

async function makeGrab(): Promise<{ grab: Awaited<ReturnType<typeof prisma.issueGrab.create>>; adminId: string }> {
  const reporter = await makeUser();
  const admin = await makeUser();
  const issue = await prisma.issue.create({
    data: { reportedBy: reporter.id, mediaType: "MOVIE", tmdbId: 603, title: "The Matrix", issueType: "BAD_VIDEO" },
  });
  const grab = await prisma.issueGrab.create({
    data: { issueId: issue.id, triggeredById: admin.id, tmdbId: 603, mediaType: "MOVIE", title: "The Matrix", scope: "FULL" },
  });
  return { grab, adminId: admin.id };
}

test("a grab's claim and its push commit together: one winner, one locked row carrying the push", async () => {
  const { grab, adminId } = await makeGrab();
  const now = new Date();

  const wins = await Promise.all([0, 1, 2].map(() => claimGrabAndQueuePush(grab, now).catch(() => false)));
  assert.equal(wins.filter(Boolean).length, 1, "the claim is once-only");

  const rows = await prisma.outbox.findMany();
  assert.equal(rows.length, 1);
  assert.equal(rows[0].dedupeKey, outboxKey(OUTBOX_GRAB_KIND, grab.id, "push"));
  assert.equal(rows[0].userId, adminId);
  assert.ok(rows[0].lockedUntil.getTime() > Date.now() + 60_000, "locked for the claimer");
  assert.deepEqual(rows[0].payload, {
    userId: adminId, title: "The Matrix", tmdbId: 603, mediaType: "MOVIE", scope: "FULL", seasonNumber: null, episodeNumber: null, issueId: grab.issueId,
  });
  assert.ok((await prisma.issueGrab.findUniqueOrThrow({ where: { id: grab.id } })).notifiedAt);
});

test("ONE transaction: a grab whose push cannot be queued is not claimed", async () => {
  const { grab, adminId } = await makeGrab();
  // A row already holding the key makes the queue insert fail.
  await prisma.outbox.create({
    data: { kind: OUTBOX_GRAB_KIND, channel: "push", dedupeKey: outboxKey(OUTBOX_GRAB_KIND, grab.id, "push"), userId: adminId, payload: {}, lockedUntil: new Date(), expiresAt: new Date() },
  });

  await assert.rejects(() => claimGrabAndQueuePush(grab, new Date()));
  assert.equal((await prisma.issueGrab.findUniqueOrThrow({ where: { id: grab.id } })).notifiedAt, null, "the claim rolled back: a later delivery can still make it");
});

test("after a restart the drain sends a queued grab push and settles it; a grab deleted since is dropped", async () => {
  const kept = await makeGrab();
  const gone = await makeGrab();
  assert.equal(await claimGrabAndQueuePush(kept.grab, new Date()), true);
  assert.equal(await claimGrabAndQueuePush(gone.grab, new Date()), true);

  assert.deepEqual(await drainOutbox("test"), { delivered: 0, dropped: 0 }, "a live claimer's row is left alone");

  await prisma.issue.delete({ where: { id: gone.grab.issueId } }); // cascades to the grab
  await lapseLocks();
  assert.deepEqual(await drainOutbox("test"), { delivered: 1, dropped: 1 });
  assert.equal(await prisma.outbox.count(), 0, "the sent push (no device to reach here) is settled, the orphan deleted");
});

async function castVotes(n: number): Promise<void> {
  for (let i = 0; i < n; i++) {
    const voter = await makeUser();
    await prisma.deletionVote.create({ data: { tmdbId: 603, mediaType: "MOVIE", title: "The Matrix", userId: voter.id } });
  }
}
const voteAlert = { title: "The Matrix", mediaType: "MOVIE", voteCount: 2, posterPath: null, tmdbId: 603 };
const queueAlert = () => prisma.$transaction((tx) => queueVoteAlert(tx, voteAlertSubject(603, "MOVIE"), voteAlert));

test("a vote alert queued again (the title re-crossed the threshold) replaces the earlier row instead of failing", async () => {
  await queueAlert();
  await prisma.$executeRawUnsafe(`UPDATE "Outbox" SET attempts = 4, "lockedUntil" = NOW() - interval '1 hour'`);

  await queueAlert();

  const rows = await prisma.outbox.findMany();
  assert.equal(rows.length, 1);
  assert.equal(rows[0].kind, OUTBOX_VOTE_THRESHOLD_KIND);
  assert.equal(rows[0].channel, "all");
  assert.equal(rows[0].userId, null);
  assert.equal(rows[0].attempts, 0, "a new cycle starts its attempts again");
  assert.ok(rows[0].lockedUntil.getTime() > Date.now() + 60_000, "and is locked for its claimer again");
});

test("after a restart the drain sends a vote alert that is STILL owed, and drops one that is not", async () => {
  await prisma.setting.create({ data: { key: "deletionVoteThreshold", value: "2" } });
  await prisma.setting.create({ data: { key: "deletionVoteNotified:603:MOVIE", value: "1" } });
  await castVotes(2);

  await queueAlert();
  await lapseLocks();
  assert.deepEqual(await drainOutbox("test"), { delivered: 1, dropped: 0 });
  assert.equal(await prisma.outbox.count(), 0);

  // The claim was given back since (a dismiss wipes the marker with the votes).
  await queueAlert();
  await prisma.setting.delete({ where: { key: "deletionVoteNotified:603:MOVIE" } });
  await lapseLocks();
  assert.deepEqual(await drainOutbox("test"), { delivered: 0, dropped: 1 });
  assert.equal(await prisma.outbox.count(), 0);
  assert.equal(await prisma.setting.count({ where: { key: "deletionVoteNotified:603:MOVIE" } }), 0, "the drain never re-wins a claim");
});

test("the boot cleanup deletes the two retired retry schemes' Setting rows and nothing else", async () => {
  await prisma.setting.createMany({
    data: [
      { key: "grabPushRetry:abc", value: new Date().toISOString() },
      { key: "deletionVotePending:603:MOVIE", value: "{}" },
      { key: "deletionVoteNotified:603:MOVIE", value: "1" },
      { key: "deletionVoteThreshold", value: "5" },
    ],
  });

  assert.equal(await dropLegacyRetryMarkers(), 2);
  assert.deepEqual(
    (await prisma.setting.findMany({ where: { key: { in: ["deletionVoteNotified:603:MOVIE", "deletionVoteThreshold"] } } })).map((r) => r.key).sort(),
    ["deletionVoteNotified:603:MOVIE", "deletionVoteThreshold"],
  );
  assert.equal(await dropLegacyRetryMarkers(), 0);
});
