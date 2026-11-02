// Notification retention against a REAL Postgres: the read/ceiling cutoffs and
// the batched delete are decided by the database, not by a stub's re-implementation
// of the where clause. (Unit twin: tests/purge-notifications.test.mts.)
import { test, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { prisma, resetDb, makeUser, closeDb } from "./_harness.mts";
import { purgeOldNotifications, NOTIFICATION_DELETE_BATCH } from "@/lib/notification-retention.ts";

before(resetDb);
beforeEach(resetDb);
after(closeDb);

const DAY = 86_400_000;
const now = new Date("2026-06-01T00:00:00Z");
const ago = (d: number) => new Date(now.getTime() - d * DAY);

async function seed(userId: string, key: string, createdDaysAgo: number, read: boolean) {
  return prisma.notification.create({
    data: {
      userId, type: "REQUEST_APPROVED", title: key, body: key,
      createdAt: ago(createdDaysAgo), readAt: read ? ago(Math.max(createdDaysAgo - 1, 0)) : null,
    },
  });
}

test("only read rows past 90 days and any row past 365 days are deleted", async () => {
  const u = await makeUser();
  await seed(u.id, "read-100", 100, true);        // delete
  await seed(u.id, "read-89", 89, true);          // keep
  await seed(u.id, "unread-200", 200, false);     // keep (unread, under 365)
  await seed(u.id, "unread-366", 366, false);     // delete
  await seed(u.id, "read-366", 366, true);        // delete
  await seed(u.id, "unread-364", 364, false);     // keep
  await seed(u.id, "unread-1", 1, false);         // keep

  const out = await purgeOldNotifications({ now });
  assert.equal(out.deleted, 3);
  assert.equal(out.aborted, false);

  const left = (await prisma.notification.findMany({ select: { title: true } })).map((r) => r.title).sort();
  assert.deepEqual(left, ["read-89", "unread-1", "unread-200", "unread-364"]);
});

test("env windows are honoured against the real table", async () => {
  const u = await makeUser();
  await seed(u.id, "read-40", 40, true);
  await seed(u.id, "unread-40", 40, false);
  const env = { NOTIFICATION_READ_RETENTION_DAYS: "30", NOTIFICATION_RETENTION_DAYS: "365" } as unknown as NodeJS.ProcessEnv;
  const out = await purgeOldNotifications({ now, env });
  assert.equal(out.deleted, 1);
  const left = await prisma.notification.findMany({ select: { title: true } });
  assert.deepEqual(left.map((r) => r.title), ["unread-40"]);
});

test("a purge larger than one batch deletes everything eligible and nothing else", async () => {
  const u = await makeUser();
  const n = NOTIFICATION_DELETE_BATCH + 50;
  await prisma.notification.createMany({
    data: Array.from({ length: n }, (_, i) => ({
      userId: u.id, type: "REQUEST_APPROVED", title: `old${i}`, body: "x", createdAt: ago(400),
    })),
  });
  await seed(u.id, "fresh", 2, false);
  const out = await purgeOldNotifications({ now });
  assert.equal(out.deleted, n);
  assert.equal(await prisma.notification.count(), 1);
});

test("an aborted signal deletes nothing", async () => {
  const u = await makeUser();
  await seed(u.id, "old", 400, false);
  const ac = new AbortController();
  ac.abort();
  const out = await purgeOldNotifications({ now, signal: ac.signal });
  assert.equal(out.aborted, true);
  assert.equal(await prisma.notification.count(), 1);
});
