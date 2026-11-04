// Scoping and lock behaviour that in-memory stubs cannot prove: the filters are
// evaluated by a real Postgres, and a real backend is terminated under a held lock.
import { test, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { prisma, resetDb, makeUser, makeRequest, daysAgo, closeDb } from "./_harness.mts";
import { withAdvisoryLock } from "@/lib/advisory-lock.ts";
import { quotaUsageWhere } from "@/lib/quota.ts";

before(resetDb);
beforeEach(resetDb);
after(closeDb);

test("quota usage counts a user's own AND filed-on-behalf requests, and nothing of another user, type, window or DECLINED", async () => {
  const me = await makeUser();
  const other = await makeUser();
  const since = daysAgo(7);

  await makeRequest(me.id, { mediaType: "MOVIE" }); // counts
  await makeRequest(other.id, { mediaType: "MOVIE", filedBy: me.id }); // counts: I filed it
  await makeRequest(me.id, { mediaType: "MOVIE", status: "DECLINED" }); // declined never counts
  await makeRequest(me.id, { mediaType: "TV" }); // other type
  await makeRequest(other.id, { mediaType: "MOVIE" }); // other user
  await makeRequest(me.id, { mediaType: "MOVIE", createdAt: daysAgo(30) }); // outside the window

  const used = await prisma.mediaRequest.count({ where: quotaUsageWhere(me.id, "MOVIE", since) });
  assert.equal(used, 2);
});

test("a library row count scoped by serverInstance and mediaType sees only that server's rows (the sync hold's input)", async () => {
  const row = (tmdbId: number, serverInstance: string, mediaType: "MOVIE" | "TV") => ({ tmdbId, serverInstance, mediaType, title: `t${tmdbId}` });
  await prisma.jellyfinLibraryItem.createMany({
    data: [row(1, "", "MOVIE"), row(2, "", "MOVIE"), row(3, "", "TV"), row(4, "anime", "MOVIE")],
  });
  assert.equal(await prisma.jellyfinLibraryItem.count({ where: { serverInstance: "", mediaType: "MOVIE" } }), 2);
  assert.equal(await prisma.jellyfinLibraryItem.count({ where: { serverInstance: "", mediaType: "TV" } }), 1);
  assert.equal(await prisma.jellyfinLibraryItem.count({ where: { serverInstance: "anime", mediaType: "TV" } }), 0);
});

test("withAdvisoryLock: terminating the holder's backend aborts the work, and the freed lock can be taken again", async () => {
  const LOCK = 987_042;
  let entered!: () => void;
  const inside = new Promise<void>((r) => (entered = r));

  const run = withAdvisoryLock(
    LOCK,
    (signal: AbortSignal) =>
      new Promise<string>((resolve) => {
        entered();
        signal.addEventListener("abort", () => resolve("aborted"), { once: true });
        setTimeout(() => resolve("ran to completion"), 15_000).unref();
      }),
    () => "busy" as const,
  );
  await inside;

  const killed = await prisma.$queryRaw<Array<{ terminated: boolean }>>`
    SELECT pg_terminate_backend(pid) AS terminated
    FROM pg_locks
    WHERE locktype = 'advisory' AND objid = ${LOCK}::oid AND granted`;
  assert.equal(killed.length, 1, "exactly one backend holds the lock");

  assert.equal(await run, "aborted", "the work must stop when its lock's connection dies");

  const again = await withAdvisoryLock(LOCK, async () => "second", () => "busy" as const);
  assert.equal(again, "second", "Postgres freed the lock with the session");
});
