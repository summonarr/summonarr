// Unit tests for replacePlexLibraryForInstances / replaceJellyfinLibraryForInstances
// (src/lib/cron-auth.ts) — the whole-library PlexLibraryItem / JellyfinLibraryItem
// rewrite shared by the orchestrator's two library arms and the admin Resync
// routes' full mode. The library twin of tests/episode-cache-swap.test.mts.
//
// The shape it replaces was the per-instance `deleteMany` + chunked `createMany`
// inside ONE interactive transaction. On a ~9k-title library, with both arms
// writing at once and the 5s poller and the crons sharing the pool's 5
// connections, the data transfer alone exceeded BATCH_TX_TIMEOUT (observed
// 32–43s → Prisma P2028) and the write rolled back on EVERY run; each failing
// write also pinned a pooled connection for its whole 30s budget, which is what
// starved the arr-wanted refresh, the arr-watch monitor and the play-history
// poller ("Unable to start a transaction in the given time").
//
// What these pin, in order of what would silently regress:
//   - the bulk load lands in STAGING and runs OUTSIDE any transaction, so the
//     transaction never carries row data (the actual bug);
//   - the swap is one scoped DELETE per instance + ONE INSERT ... SELECT under
//     the same advisory lock ids the inline sites used (2001,1 plex / 2001,2
//     jellyfin) — never an unconditional wipe (guardrail 13 / 35);
//   - every staged row carries ITS batch's slug and this call's runId, so a row
//     can never escape its instance and two concurrent rewrites (the Resync
//     routes hold no lock 2000) cannot blend in staging;
//   - the runId's staged rows are dropped even when the swap throws;
//   - a batch with no rows still clears its instance; a call with no batches
//     touches nothing.
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

function stagingModel(name: string) {
  return {
    createMany: async (args: CreateManyArgs) => {
      rec(`${name}.createMany`, { args });
      return { count: args.data.length };
    },
    deleteMany: async (args: DeleteManyArgs) => {
      rec(`${name}.deleteMany`, { args });
      if (sweepThrows && "createdAt" in args.where) throw new Error("unit-test sweep failure");
      return { count: 0 };
    },
  };
}

function liveModel(name: string) {
  return {
    deleteMany: async (args: DeleteManyArgs) => {
      rec(`tx.${name}.deleteMany`, { args });
      return { count: 0 };
    },
  };
}

const txClient = {
  plexLibraryItem: liveModel("plexLibraryItem"),
  jellyfinLibraryItem: liveModel("jellyfinLibraryItem"),
  $executeRaw: async (strings: TemplateStringsArray, ...params: unknown[]) => {
    rec("tx.$executeRaw", { sql: flatten(strings), params });
    if (swapThrows && flatten(strings).startsWith("INSERT INTO")) {
      throw new Error("unit-test swap failure");
    }
    return 0;
  },
};

const fakePrisma = {
  plexLibraryItemStaging: stagingModel("plexStaging"),
  jellyfinLibraryItemStaging: stagingModel("jellyfinStaging"),
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

const { replacePlexLibraryForInstances, replaceJellyfinLibraryForInstances, BATCH_TX_TIMEOUT, POSTGRES_MAX_BIND_PARAMS } =
  await import("../src/lib/cron-auth.ts");

function reset() {
  calls.length = 0;
  inTransaction = false;
  swapThrows = false;
  sweepThrows = false;
  txOptions = undefined;
}

const plexRows = (n: number, slug = "") =>
  Array.from({ length: n }, (_, i) => ({
    tmdbId: 100 + i,
    mediaType: (i % 2 === 0 ? "MOVIE" : "TV") as "MOVIE" | "TV",
    serverInstance: slug,
    filePath: `/media/${i}.mkv`,
    plexRatingKey: `rk${i}`,
    plexRatingKeys: [`rk${i}`],
    title: `Title ${i}`,
    year: "2026",
    overview: null,
    contentRating: null,
    addedAt: null,
  }));

const jfRows = (n: number, slug = "") =>
  Array.from({ length: n }, (_, i) => ({
    tmdbId: 200 + i,
    mediaType: "MOVIE" as const,
    serverInstance: slug,
    filePath: null,
    jellyfinItemId: `jf${i}`,
    jellyfinItemIds: [`jf${i}`],
    title: `Title ${i}`,
    year: null,
    overview: null,
    contentRating: null,
    communityRating: 7.5,
    addedAt: null,
  }));

const opsOf = (op: string) => calls.filter((c) => c.op === op);
const stagedRows = (op: string) => opsOf(op).flatMap((c) => (c.args as CreateManyArgs).data);

test("the bulk load goes to STAGING and runs OUTSIDE the transaction", async () => {
  reset();
  await replacePlexLibraryForInstances([{ slug: "", rows: plexRows(3) }]);

  const loads = opsOf("plexStaging.createMany");
  assert.equal(loads.length, 1, "one chunk for 3 rows");
  assert.equal(loads[0].inTransaction, false, "the row data must not cross the wire inside a transaction");

  // The regression this whole change exists to prevent: no row payload inside the tx.
  const insideTx = calls.filter((c) => c.inTransaction);
  assert.ok(insideTx.length > 0, "the swap still runs in a transaction");
  const allowedInTx = new Set(["tx.$executeRaw", "tx.plexLibraryItem.deleteMany"]);
  assert.ok(
    insideTx.every((c) => allowedInTx.has(c.op)),
    `only the lock, the scoped deletes and the INSERT ... SELECT may run inside the transaction, saw: ${insideTx.map((c) => c.op).join(", ")}`,
  );
  assert.deepEqual(txOptions, { timeout: BATCH_TX_TIMEOUT });
});

test("the swap is one scoped DELETE per instance + ONE INSERT ... SELECT under lock 2001,1", async () => {
  reset();
  await replacePlexLibraryForInstances([
    { slug: "", rows: plexRows(2) },
    { slug: "remote", rows: plexRows(1, "remote") },
  ]);

  const sql = opsOf("tx.$executeRaw").map((c) => c.sql ?? "");
  assert.equal(sql.length, 2, "lock + insert (the deletes are Prisma model calls)");
  assert.match(sql[0], /pg_advisory_xact_lock\(2001, 1\)/, "plex takes 2001,1 — the id the per-source route shares");
  assert.match(sql[1], /^INSERT INTO "PlexLibraryItem" \(/);
  assert.match(sql[1], /SELECT .* FROM "PlexLibraryItemStaging" WHERE "runId" = \?$/);
  // Every live column is carried, in the same order on both sides of the SELECT.
  const cols = '"tmdbId", "mediaType", "serverInstance", "filePath", "plexRatingKey", "plexRatingKeys", "title", "year", "overview", "contentRating", "addedAt"';
  assert.ok(sql[1].includes(`(${cols}) SELECT ${cols} FROM`), `column list drifted: ${sql[1]}`);

  // Scoped to EACH instance in the call — never an unconditional wipe, never a
  // mediaType split (one delete per instance is the whole-instance replace).
  const deletes = opsOf("tx.plexLibraryItem.deleteMany");
  assert.deepEqual(
    deletes.map((d) => (d.args as DeleteManyArgs).where),
    [{ serverInstance: "" }, { serverInstance: "remote" }],
  );
  assert.ok(deletes.every((d) => d.inTransaction), "every delete must be inside the swap");

  // The lock precedes the first delete; the insert follows the last delete.
  const order = calls.filter((c) => c.inTransaction).map((c) => c.op);
  assert.deepEqual(order, ["tx.$executeRaw", "tx.plexLibraryItem.deleteMany", "tx.plexLibraryItem.deleteMany", "tx.$executeRaw"]);

  // The insert reads back exactly the rows this call staged.
  const runIds = new Set(stagedRows("plexStaging.createMany").map((r) => r.runId));
  assert.equal(runIds.size, 1, "one runId for the whole call, across instances");
  assert.deepEqual(opsOf("tx.$executeRaw")[1].params, [[...runIds][0]]);
});

test("jellyfin takes the sibling lock 2001,2 and carries its own column set", async () => {
  reset();
  await replaceJellyfinLibraryForInstances([{ slug: "", rows: jfRows(1) }]);

  const sql = opsOf("tx.$executeRaw").map((c) => c.sql ?? "");
  assert.match(sql[0], /pg_advisory_xact_lock\(2001, 2\)/);
  const cols = '"tmdbId", "mediaType", "serverInstance", "filePath", "jellyfinItemId", "jellyfinItemIds", "title", "year", "overview", "contentRating", "communityRating", "addedAt"';
  assert.ok(sql[1].includes(`INSERT INTO "JellyfinLibraryItem" (${cols}) SELECT ${cols} FROM "JellyfinLibraryItemStaging" WHERE "runId" = ?`), sql[1]);
  assert.deepEqual(
    opsOf("tx.jellyfinLibraryItem.deleteMany").map((d) => (d.args as DeleteManyArgs).where),
    [{ serverInstance: "" }],
  );
  assert.equal(opsOf("plexStaging.createMany").length, 0, "the Jellyfin helper never touches Plex staging");
  assert.equal(opsOf("tx.plexLibraryItem.deleteMany").length, 0);
});

test("every staged row is stamped with ITS batch's slug — a row can never escape its instance", async () => {
  reset();
  // The rows arrive carrying a WRONG slug on purpose: the helper's contract is
  // that the delete and the insert agree on the scope, so it stamps the batch's
  // slug rather than trusting each caller to have set it (a row that escaped its
  // slug used to relocate a named server's library onto the default — see the
  // per-source routes' comments).
  await replacePlexLibraryForInstances([
    { slug: "remote", rows: plexRows(2, "") },
    { slug: "", rows: plexRows(1, "remote") },
  ]);

  const loads = opsOf("plexStaging.createMany");
  assert.equal(loads.length, 2, "one staged load per instance batch");
  const [remote, dflt] = loads.map((c) => (c.args as CreateManyArgs).data);
  assert.deepEqual(remote.map((r) => r.serverInstance), ["remote", "remote"]);
  assert.deepEqual(dflt.map((r) => r.serverInstance), [""]);
  assert.ok(loads.every((c) => (c.args as CreateManyArgs).skipDuplicates === true), "skipDuplicates survives the staging move (guardrail 4)");
  // Library fields survive the spread.
  assert.equal(remote[0].plexRatingKey, "rk0");
  assert.deepEqual(remote[0].plexRatingKeys, ["rk0"]);
  assert.match(String(remote[0].runId), /^[0-9a-f-]{36}$/, "runId is a uuid");
});

test("this run's staged rows are dropped after a successful swap", async () => {
  reset();
  await replacePlexLibraryForInstances([{ slug: "", rows: plexRows(1) }]);

  const runId = stagedRows("plexStaging.createMany")[0].runId;
  const cleanup = opsOf("plexStaging.deleteMany").filter((c) => (c.args as DeleteManyArgs).where.runId === runId);
  assert.equal(cleanup.length, 1, "exactly one runId-scoped cleanup");
  assert.equal(cleanup[0].inTransaction, false);
});

test("a failed swap still drops the staged rows and propagates", async () => {
  reset();
  swapThrows = true;
  await assert.rejects(
    () => replaceJellyfinLibraryForInstances([{ slug: "", rows: jfRows(1) }]),
    /unit-test swap failure/,
    "the caller must learn the rewrite failed — the orchestrator drops its in-memory maps on it",
  );

  const runId = stagedRows("jellyfinStaging.createMany")[0].runId;
  assert.equal(
    opsOf("jellyfinStaging.deleteMany").filter((c) => (c.args as DeleteManyArgs).where.runId === runId).length,
    1,
    "a failed rewrite must not leave a full copy of the library in staging",
  );
  // The delete and the failing insert shared one transaction callback, so the
  // real Postgres rollback discards the delete (guardrail 13's atomicity leg).
  assert.deepEqual(
    calls.filter((c) => c.inTransaction).map((c) => c.op),
    ["tx.$executeRaw", "tx.jellyfinLibraryItem.deleteMany", "tx.$executeRaw"],
  );
});

test("a crashed run's stale rows are swept first, and a sweep failure never blocks the rewrite", async () => {
  reset();
  sweepThrows = true;
  await replacePlexLibraryForInstances([{ slug: "", rows: plexRows(1) }]);

  const sweeps = opsOf("plexStaging.deleteMany").filter((c) => "createdAt" in (c.args as DeleteManyArgs).where);
  assert.equal(sweeps.length, 1, "one age-scoped sweep");
  const cutoff = (sweeps[0].args as DeleteManyArgs).where.createdAt as { lt: Date };
  assert.ok(cutoff.lt instanceof Date, "the sweep is bounded by age, never unscoped");
  const sweepIdx = calls.indexOf(sweeps[0]);
  const loadIdx = calls.findIndex((c) => c.op === "plexStaging.createMany");
  assert.ok(sweepIdx < loadIdx, "sweeping after staging would delete nothing useful");
  // The sweep threw, and the swap still happened.
  assert.equal(opsOf("tx.$executeRaw").length, 2);
});

test("a batch with no rows still clears its instance; a call with no batches touches nothing", async () => {
  reset();
  await replacePlexLibraryForInstances([{ slug: "remote", rows: [] }]);
  assert.equal(opsOf("plexStaging.createMany").length, 0, "nothing to stage");
  assert.deepEqual(
    opsOf("tx.plexLibraryItem.deleteMany").map((d) => (d.args as DeleteManyArgs).where),
    [{ serverInstance: "remote" }],
    "a now-empty library is reflected — the old shape deleted unconditionally too",
  );
  assert.equal(opsOf("tx.$executeRaw").length, 2, "lock + (empty) insert still run");

  reset();
  await replacePlexLibraryForInstances([]);
  assert.equal(calls.length, 0, "no instance to replace ⇒ no sweep, no lock, no transaction");
});

test("a library-sized load is chunked, sequentially, still outside the transaction", async () => {
  reset();
  await replaceJellyfinLibraryForInstances([{ slug: "", rows: jfRows(12_001) }]);

  const loads = opsOf("jellyfinStaging.createMany");
  // Chunked under Postgres's bind-parameter limit, so each call is ONE INSERT:
  // past it Prisma splits a createMany into parallel INSERTs on one connection
  // (guardrail 23c). Every row is loaded exactly once, in order.
  const loaded = loads.flatMap((c) => (c.args as CreateManyArgs).data as object[]);
  assert.equal(loaded.length, 12_001);
  assert.ok(loads.length > 1, "a library-sized load is chunked");
  const perRow = Object.keys(loaded[0]).length + 1; // + createdAt, which Prisma sends itself
  for (const c of loads) {
    const n = (c.args as CreateManyArgs).data.length;
    assert.ok(n * perRow <= POSTGRES_MAX_BIND_PARAMS, `${n} rows × ${perRow} params is past the bind limit`);
  }
  assert.ok(loads.every((c) => c.inTransaction === false));
});
