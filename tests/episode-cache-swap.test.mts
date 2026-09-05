// Unit tests for replaceEpisodeCacheForSource (src/lib/cron-auth.ts) — the
// whole-table TVEpisodeCache rewrite shared by the orchestrator, the two
// per-source resync routes and /api/sync/tv-episodes.
//
// The shape it replaces was `deleteMany` + chunked `createMany` inside ONE
// interactive transaction. That pushes the entire episode set over the wire with
// the transaction open, so the cost grows with the library. In production it
// exceeded BATCH_TX_TIMEOUT (observed 35,689ms → Prisma P2028), the transaction
// rolled back, and the episode cache silently stopped updating for good — every
// later run failed at the same size. It also pinned one of the pool's 5
// connections for those 35s, starving the 5s play-history poller.
//
// What these pin, in order of what would silently regress:
//   - the bulk load lands in STAGING and runs OUTSIDE any transaction, so the
//     transaction never carries row data (the actual bug);
//   - the swap is DELETE + INSERT ... SELECT under the same advisory lock ids
//     the inline sites used (2002,1 plex / 2002,2 jellyfin);
//   - staged rows are scoped to this call's runId, so two concurrent rewrites of
//     one source cannot blend their rows (reachable: the orchestrator holds lock
//     2000, the admin Resync routes do not);
//   - the runId's staged rows are dropped even when the swap throws;
//   - an empty row set still clears the table (unchanged from the old shape).
//
// No DB: src/lib/prisma.ts caches its client on globalThis, so the fake below is
// seeded before the module graph loads.
import { test } from "node:test";
import assert from "node:assert/strict";

process.env.TOKEN_ENCRYPTION_KEY = "ab".repeat(32);
process.env.NEXTAUTH_SECRET = "unit-test-nextauth-secret-0123456789abcdef";

type CreateManyArgs = { data: Record<string, unknown>[]; skipDuplicates?: boolean };
type DeleteManyArgs = { where: Record<string, unknown> };

interface Recorded {
  op: string;
  args?: unknown;
  sql?: string;
  params?: unknown[];
  inTransaction: boolean;
}

const calls: Recorded[] = [];
let inTransaction = false;
let swapThrows = false;
let sweepThrows = false;
let txOptions: unknown = undefined;

const rec = (op: string, extra: Partial<Recorded> = {}) => {
  calls.push({ op, inTransaction, ...extra });
};

/** Collapses a tagged-template SQL fragment to single-spaced text for matching. */
const flatten = (strings: readonly string[]): string =>
  strings.join("?").replace(/\s+/g, " ").trim();

const stagingModel = {
  createMany: async (args: CreateManyArgs) => {
    rec("staging.createMany", { args });
    return { count: args.data.length };
  },
  deleteMany: async (args: DeleteManyArgs) => {
    rec("staging.deleteMany", { args });
    if (sweepThrows && "createdAt" in args.where) throw new Error("unit-test sweep failure");
    return { count: 0 };
  },
};

const txClient = {
  tVEpisodeCache: {
    deleteMany: async (args: DeleteManyArgs) => {
      rec("tx.tVEpisodeCache.deleteMany", { args });
      return { count: 0 };
    },
  },
  $executeRaw: async (strings: TemplateStringsArray, ...params: unknown[]) => {
    rec("tx.$executeRaw", { sql: flatten(strings), params });
    if (swapThrows && flatten(strings).startsWith("INSERT INTO")) {
      throw new Error("unit-test swap failure");
    }
    return 0;
  },
};

const fakePrisma = {
  tVEpisodeCacheStaging: stagingModel,
  $transaction: async (fn: (tx: typeof txClient) => Promise<unknown>, opts?: unknown) => {
    txOptions = opts;
    rec("$transaction:enter");
    inTransaction = true;
    try {
      return await fn(txClient);
    } finally {
      inTransaction = false;
      rec("$transaction:exit");
    }
  },
};

(globalThis as unknown as { prisma: unknown }).prisma = fakePrisma;

const { replaceEpisodeCacheForSource, BATCH_TX_TIMEOUT } = await import("../src/lib/cron-auth.ts");

function reset() {
  calls.length = 0;
  inTransaction = false;
  swapThrows = false;
  sweepThrows = false;
  txOptions = undefined;
}

const rowsOf = (n: number) =>
  Array.from({ length: n }, (_, i) => ({
    tmdbId: 100 + i,
    seasonNumber: 1,
    episodeNumber: i + 1,
    episodeName: `Episode ${i + 1}`,
    airDate: "2026-01-01",
    stillPath: null,
    runtime: 42,
    overview: "x",
  }));

const opsOf = (op: string) => calls.filter((c) => c.op === op);

test("the bulk load goes to STAGING and runs OUTSIDE the transaction", async () => {
  reset();
  await replaceEpisodeCacheForSource("plex", rowsOf(3));

  const loads = opsOf("staging.createMany");
  assert.equal(loads.length, 1, "one chunk for 3 rows");
  assert.equal(loads[0].inTransaction, false, "the row data must not cross the wire inside a transaction");

  // The regression this whole change exists to prevent: no row payload inside the tx.
  const insideTx = calls.filter((c) => c.inTransaction);
  assert.ok(insideTx.length > 0, "the swap still runs in a transaction");
  const allowedInTx = new Set(["tx.$executeRaw", "tx.tVEpisodeCache.deleteMany"]);
  assert.ok(
    insideTx.every((c) => allowedInTx.has(c.op)),
    `only the lock, the scoped delete and the INSERT ... SELECT may run inside the transaction, saw: ${insideTx.map((c) => c.op).join(", ")}`,
  );
});

test("staged rows carry this call's runId and the source column", async () => {
  reset();
  await replaceEpisodeCacheForSource("jellyfin", rowsOf(2));

  const data = (opsOf("staging.createMany")[0].args as CreateManyArgs).data;
  assert.equal(data.length, 2);
  const runIds = new Set(data.map((r) => r.runId));
  assert.equal(runIds.size, 1, "one runId for the whole call");
  assert.match(String([...runIds][0]), /^[0-9a-f-]{36}$/, "runId is a uuid");
  assert.ok(data.every((r) => r.source === "jellyfin"), "every staged row carries its source");
  assert.ok(data.every((r) => typeof r.tmdbId === "number"), "episode fields survive the spread");
});

test("the swap is DELETE + INSERT ... SELECT under the source's advisory lock", async () => {
  reset();
  await replaceEpisodeCacheForSource("plex", rowsOf(1));

  const sql = opsOf("tx.$executeRaw").map((c) => c.sql ?? "");
  assert.equal(sql.length, 2, "lock + insert (the delete is a Prisma model call)");
  assert.match(sql[0], /pg_advisory_xact_lock\(2002, 1\)/, "plex takes 2002,1");
  assert.match(sql[1], /^INSERT INTO "TVEpisodeCache"/);
  assert.match(sql[1], /SELECT .* FROM "TVEpisodeCacheStaging" WHERE "runId" = /);

  // The whole-namespace delete stays a Prisma call so the sync suites keep
  // observing it, and it must be scoped to the source being replaced.
  const deletes = opsOf("tx.tVEpisodeCache.deleteMany");
  assert.equal(deletes.length, 1, "exactly one whole-namespace replace");
  assert.deepEqual((deletes[0].args as DeleteManyArgs).where, { source: "plex" });
  assert.equal(deletes[0].inTransaction, true, "the delete must be inside the swap");

  // The insert reads back exactly the rows this call staged.
  const stagedRunId = (opsOf("staging.createMany")[0].args as CreateManyArgs).data[0].runId;
  assert.deepEqual(opsOf("tx.$executeRaw")[1].params, [stagedRunId]);

  assert.deepEqual(txOptions, { timeout: BATCH_TX_TIMEOUT });
});

test("jellyfin takes the sibling advisory lock 2002,2", async () => {
  reset();
  await replaceEpisodeCacheForSource("jellyfin", rowsOf(1));
  assert.match(opsOf("tx.$executeRaw")[0].sql ?? "", /pg_advisory_xact_lock\(2002, 2\)/);
});

test("this run's staged rows are dropped after a successful swap", async () => {
  reset();
  await replaceEpisodeCacheForSource("plex", rowsOf(1));

  const runId = (opsOf("staging.createMany")[0].args as CreateManyArgs).data[0].runId;
  const cleanup = opsOf("staging.deleteMany").filter(
    (c) => (c.args as DeleteManyArgs).where.runId === runId,
  );
  assert.equal(cleanup.length, 1, "exactly one runId-scoped cleanup");
  assert.equal(cleanup[0].inTransaction, false);
});

test("a failed swap still drops the staged rows and propagates", async () => {
  reset();
  swapThrows = true;
  await assert.rejects(
    () => replaceEpisodeCacheForSource("plex", rowsOf(1)),
    /unit-test swap failure/,
    "the caller must learn the rewrite failed — every call site logs it",
  );

  const runId = (opsOf("staging.createMany")[0].args as CreateManyArgs).data[0].runId;
  assert.equal(
    opsOf("staging.deleteMany").filter((c) => (c.args as DeleteManyArgs).where.runId === runId).length,
    1,
    "a failed rewrite must not leave a full copy of the library in staging",
  );
});

test("a crashed run's stale rows are swept first, and a sweep failure never blocks the rewrite", async () => {
  reset();
  const ok = opsOf("staging.deleteMany");
  assert.equal(ok.length, 0);

  sweepThrows = true;
  await replaceEpisodeCacheForSource("plex", rowsOf(1));

  const sweeps = opsOf("staging.deleteMany").filter((c) => "createdAt" in (c.args as DeleteManyArgs).where);
  assert.equal(sweeps.length, 1, "one age-scoped sweep");
  const cutoff = (sweeps[0].args as DeleteManyArgs).where.createdAt as { lt: Date };
  assert.ok(cutoff.lt instanceof Date, "the sweep is bounded by age, never unscoped");
  // The sweep threw, and the swap still happened.
  assert.equal(opsOf("tx.$executeRaw").length, 2);
});

test("the sweep runs BEFORE anything is staged", async () => {
  reset();
  await replaceEpisodeCacheForSource("plex", rowsOf(1));
  const sweepIdx = calls.findIndex((c) => c.op === "staging.deleteMany" && "createdAt" in (c.args as DeleteManyArgs).where);
  const loadIdx = calls.findIndex((c) => c.op === "staging.createMany");
  assert.ok(sweepIdx >= 0 && loadIdx >= 0);
  assert.ok(sweepIdx < loadIdx, "sweeping after staging would delete nothing useful");
});

test("an empty episode set still clears the table", async () => {
  reset();
  await replaceEpisodeCacheForSource("plex", []);

  assert.equal(opsOf("staging.createMany").length, 0, "nothing to stage");
  assert.equal(
    opsOf("tx.tVEpisodeCache.deleteMany").length, 1,
    "the swap still runs, so a now-empty library is reflected",
  );
});

test("a library-sized load is chunked, sequentially, still outside the transaction", async () => {
  reset();
  await replaceEpisodeCacheForSource("plex", rowsOf(12_001));

  const loads = opsOf("staging.createMany");
  assert.deepEqual(
    loads.map((c) => (c.args as CreateManyArgs).data.length),
    [5000, 5000, 2001],
    "CREATE_MANY_BATCH chunking (guardrail 4) is unchanged by the staging move",
  );
  assert.ok(loads.every((c) => c.inTransaction === false));
  assert.ok(
    loads.every((c) => (c.args as CreateManyArgs).skipDuplicates === true),
    "skipDuplicates survives, so a duplicated episode row cannot fail the load",
  );
});
