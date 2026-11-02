// The staged library swap and the Setting encryption extension against a REAL
// Postgres. The unit suite pins the call sequence; this pins the outcome.
import { test, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { prisma, resetDb, closeDb } from "./_harness.mts";
import { replacePlexLibraryForInstances, type PlexLibraryRow } from "@/lib/cron-auth.ts";

before(resetDb);
beforeEach(resetDb);
after(closeDb);

function row(tmdbId: number, over: Partial<PlexLibraryRow> = {}): PlexLibraryRow {
  return {
    tmdbId,
    mediaType: "MOVIE",
    filePath: `/media/${tmdbId}.mkv`,
    plexRatingKey: `rk${tmdbId}`,
    plexRatingKeys: [`rk${tmdbId}`],
    title: `Movie ${tmdbId}`,
    year: "2020",
    overview: null,
    contentRating: null,
    addedAt: null,
    ...over,
  } as PlexLibraryRow;
}

async function ids(slug: string): Promise<number[]> {
  const rows = await prisma.plexLibraryItem.findMany({ where: { serverInstance: slug }, select: { tmdbId: true } });
  return rows.map((r) => r.tmdbId).sort((a, b) => a - b);
}

test("swap replaces ONLY the named instance, round-trips array columns, and leaves staging empty", async () => {
  await replacePlexLibraryForInstances([
    { slug: "", rows: [row(1), row(2), row(3)] },
    { slug: "remote", rows: [row(10), row(11)] },
  ]);
  assert.deepEqual(await ids(""), [1, 2, 3]);
  assert.deepEqual(await ids("remote"), [10, 11]);

  await replacePlexLibraryForInstances([{ slug: "", rows: [row(2, { plexRatingKeys: ["rk2", "rk2b"] }), row(4)] }]);

  assert.deepEqual(await ids(""), [2, 4], "the default instance is replaced wholesale");
  assert.deepEqual(await ids("remote"), [10, 11], "another instance's rows are never touched");
  const two = await prisma.plexLibraryItem.findUniqueOrThrow({
    where: { tmdbId_mediaType_serverInstance: { tmdbId: 2, mediaType: "MOVIE", serverInstance: "" } },
  });
  assert.deepEqual(two.plexRatingKeys, ["rk2", "rk2b"], "plexRatingKeys survives the INSERT … SELECT (guardrail 37c)");
  assert.equal(await prisma.plexLibraryItemStaging.count(), 0, "staged rows are cleaned up");
});

test("concurrent swaps of one instance serialize: the result is exactly one run's rows, never a blend", async () => {
  const setA = Array.from({ length: 300 }, (_, i) => row(1000 + i));
  const setB = Array.from({ length: 300 }, (_, i) => row(2000 + i));
  // Pre-seed so the two scoped DELETEs contend for the same row locks. On an empty
  // table neither transaction has anything to wait on and an unlocked swap passes by luck.
  await replacePlexLibraryForInstances([{ slug: "", rows: Array.from({ length: 300 }, (_, i) => row(i + 1)) }]);

  await Promise.all([
    replacePlexLibraryForInstances([{ slug: "", rows: setA }]),
    replacePlexLibraryForInstances([{ slug: "", rows: setB }]),
  ]);

  const got = await ids("");
  const isA = got.length === 300 && got.every((id) => id >= 1000 && id < 1300);
  const isB = got.length === 300 && got.every((id) => id >= 2000 && id < 2300);
  assert.ok(isA || isB, `expected one run's 300 rows, got ${got.length} rows spanning both sets`);
  assert.equal(await prisma.plexLibraryItemStaging.count(), 0);
});

test("Setting.value is encrypted at rest for sensitive keys and decrypted on read (guardrail 7a)", async () => {
  await prisma.setting.create({ data: { key: "plexAdminToken", value: "super-secret-token" } });
  await prisma.setting.create({ data: { key: "siteTitle", value: "plain-value" } });

  const raw = await prisma.$queryRaw<Array<{ key: string; value: string }>>`SELECT "key", "value" FROM "Setting" ORDER BY "key"`;
  const byKey = Object.fromEntries(raw.map((r) => [r.key, r.value]));
  assert.ok(byKey.plexAdminToken.startsWith("enc:v1:"), "stored ciphertext");
  assert.ok(!byKey.plexAdminToken.includes("super-secret-token"));
  assert.equal(byKey.siteTitle, "plain-value", "non-sensitive keys stay plaintext");

  const read = await prisma.setting.findUniqueOrThrow({ where: { key: "plexAdminToken" } });
  assert.equal(read.value, "super-secret-token", "the extension decrypts on read");
});

test("the swap waits on advisory lock 2001,1 (shared with the admin Resync route) instead of racing it", async () => {
  await replacePlexLibraryForInstances([{ slug: "", rows: [row(1), row(2)] }]);

  let release!: () => void;
  const gate = new Promise<void>((r) => (release = r));
  let held!: () => void;
  const holding = new Promise<void>((r) => (held = r));
  // Another writer (the per-source Resync route) already holds the lock.
  const holder = prisma.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(2001, 1)`;
    held();
    await gate;
  });
  await holding;

  let done = false;
  const swap = replacePlexLibraryForInstances([{ slug: "", rows: [row(7), row(8), row(9)] }]).then(() => { done = true; });
  await new Promise((r) => setTimeout(r, 600));
  assert.equal(done, false, "the swap must block while the lock is held elsewhere");
  assert.deepEqual(await ids(""), [1, 2], "and must not have touched the table");

  release();
  await holder;
  await swap;
  assert.deepEqual(await ids(""), [7, 8, 9]);
});
