// Unit tests for replaceEpisodeCacheForSource (src/lib/episode-cache.ts) — the
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
//   - an empty row set still clears the table (unchanged from the old shape);
//   - an UNCHANGED set is not rewritten: when the table's own digest (computed
//     by Postgres) matches this call's rows, nothing is staged or swapped, and
//     every doubt (no answer, a different count or digest, a failed query) means
//     the full rewrite above. tests/db/episode-cache-digest.test.mts proves the
//     JS and SQL digests agree on a real Postgres.
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

// What the fake table "holds" for the unchanged-set check: a digest row, a
// throw, or (undefined) no answer — which must read as "changed".
let stored: { rows: number; digest: string | null } | "throw" | undefined;

const fakePrisma = {
  tVEpisodeCacheStaging: stagingModel,
  $queryRaw: async (query: { text?: string; values?: unknown[] }) => {
    rec("$queryRaw", { sql: String(query.text ?? "").replace(/\s+/g, " ").trim(), params: query.values });
    if (stored === "throw") throw new Error("function md5(text) does not exist");
    return stored === undefined ? [] : [stored];
  },
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

const {
  replaceEpisodeCacheForSource,
  episodeCacheDigest,
  earliestAddedPerEpisode,
  BATCH_TX_TIMEOUT,
  POSTGRES_MAX_BIND_PARAMS,
} = await import("../src/lib/cron-auth.ts");
const { resetLogDedup } = await import("../src/lib/log-dedup.ts");

function reset() {
  calls.length = 0;
  inTransaction = false;
  swapThrows = false;
  sweepThrows = false;
  txOptions = undefined;
  stored = undefined;
  resetLogDedup();
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
  stored = { rows: 5, digest: "0".repeat(32) };
  assert.equal(await replaceEpisodeCacheForSource("plex", []), "replaced");

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
  assert.ok(
    loads.every((c) => (c.args as CreateManyArgs).skipDuplicates === true),
    "skipDuplicates survives, so a duplicated episode row cannot fail the load",
  );
});

// ── The unchanged-set skip ──────────────────────────────────────────────────

const { readFileSync } = await import("node:fs");

type Row = Parameters<typeof episodeCacheDigest>[0][number];

/** What the table holds after a rewrite of `rows` — the digest Postgres would report. */
const tableHolding = (rows: Row[]) => episodeCacheDigest(earliestAddedPerEpisode(rows));

const richRows = (): Row[] => [
  { tmdbId: 7, seasonNumber: 1, episodeNumber: 1, episodeName: "Pilot", airDate: "2020-01-01", stillPath: "/a.jpg", runtime: 45, overview: "One.", addedAt: new Date("2024-03-01T10:00:00.123Z") },
  { tmdbId: 7, seasonNumber: 1, episodeNumber: 2, episodeName: "Two", airDate: null, stillPath: null, runtime: null, overview: null, addedAt: null },
  { tmdbId: 9, seasonNumber: 2, episodeNumber: 5, episodeName: "", airDate: "2021-06-30", stillPath: "/b.jpg", runtime: 0, overview: "Five.", addedAt: new Date("2023-12-31T23:59:59.999Z") },
];

test("an unchanged set is neither staged nor swapped — one read, outside any transaction", async () => {
  reset();
  const rows = richRows();
  stored = tableHolding(rows);
  assert.equal(await replaceEpisodeCacheForSource("plex", rows), "unchanged");

  assert.equal(opsOf("staging.createMany").length, 0, "nothing staged");
  assert.equal(opsOf("$transaction:enter").length, 0, "no swap transaction");
  assert.equal(opsOf("tx.tVEpisodeCache.deleteMany").length, 0, "nothing deleted");
  assert.equal(
    opsOf("staging.deleteMany").filter((c) => "createdAt" in (c.args as DeleteManyArgs).where).length, 1,
    "the crashed-run sweep still runs",
  );

  const reads = opsOf("$queryRaw");
  assert.equal(reads.length, 1, "one comparison read");
  assert.equal(reads[0].inTransaction, false);
  assert.deepEqual(reads[0].params, ["plex"], "the source is a bound parameter");
  assert.match(reads[0].sql ?? "", /FROM "TVEpisodeCache" WHERE "source" = \$1/);
  assert.doesNotMatch(reads[0].sql ?? "", /\b(INSERT|UPDATE|DELETE)\b/i, "the comparison never writes");
});

test("the order rows arrive in does not matter", async () => {
  reset();
  stored = tableHolding(richRows());
  assert.equal(await replaceEpisodeCacheForSource("jellyfin", richRows().reverse()), "unchanged");
});

test("a change in any single column rewrites", async () => {
  const changes: Array<[string, (r: Row) => Row]> = [
    ["tmdbId", (r) => ({ ...r, tmdbId: r.tmdbId + 1000 })],
    ["seasonNumber", (r) => ({ ...r, seasonNumber: r.seasonNumber + 1 })],
    ["episodeNumber", (r) => ({ ...r, episodeNumber: r.episodeNumber + 100 })],
    ["episodeName", (r) => ({ ...r, episodeName: "Renamed" })],
    ["airDate", (r) => ({ ...r, airDate: "1999-09-09" })],
    ["stillPath", (r) => ({ ...r, stillPath: "/other.jpg" })],
    ["runtime", (r) => ({ ...r, runtime: 46 })],
    ["overview", (r) => ({ ...r, overview: "Changed." })],
    ["addedAt", (r) => ({ ...r, addedAt: new Date("2024-03-01T10:00:00.124Z") })],
    ["episodeName → null", (r) => ({ ...r, episodeName: null })],
  ];
  for (const [label, change] of changes) {
    reset();
    stored = tableHolding(richRows());
    const rows = richRows();
    rows[0] = change(rows[0]);
    assert.equal(await replaceEpisodeCacheForSource("plex", rows), "replaced", label);
    assert.equal(opsOf("tx.tVEpisodeCache.deleteMany").length, 1, `${label}: the swap ran`);
  }
});

test("an added or removed episode rewrites", async () => {
  reset();
  stored = tableHolding(richRows());
  assert.equal(await replaceEpisodeCacheForSource("plex", richRows().slice(1)), "replaced");
  reset();
  stored = tableHolding(richRows());
  assert.equal(
    await replaceEpisodeCacheForSource("plex", [...richRows(), { tmdbId: 9, seasonNumber: 2, episodeNumber: 6 }]),
    "replaced",
  );
});

test("a matching digest with a different row count still rewrites", async () => {
  reset();
  const { digest } = tableHolding(richRows());
  stored = { rows: 4, digest };
  assert.equal(await replaceEpisodeCacheForSource("plex", richRows()), "replaced");
});

test("no answer, or a malformed one, means rewrite", async () => {
  reset();
  stored = undefined;
  assert.equal(await replaceEpisodeCacheForSource("plex", richRows()), "replaced");
  reset();
  stored = { rows: "3" as unknown as number, digest: tableHolding(richRows()).digest };
  assert.equal(await replaceEpisodeCacheForSource("plex", richRows()), "replaced");
});

test("a failed comparison rewrites, and warns once per change of error", async () => {
  reset();
  const warnings: string[] = [];
  const realWarn = console.warn;
  console.warn = (...args: unknown[]) => { warnings.push(args.map(String).join(" ")); };
  try {
    stored = "throw";
    assert.equal(await replaceEpisodeCacheForSource("plex", richRows()), "replaced");
    assert.equal(await replaceEpisodeCacheForSource("plex", richRows()), "replaced");
    assert.equal(warnings.length, 1, "an unchanged failure is not repeated every sync (guardrail 7b)");
    assert.match(warnings[0], /\[episode-cache\] could not compare the stored plex episodes/);

    stored = tableHolding(richRows());
    assert.equal(await replaceEpisodeCacheForSource("plex", richRows()), "unchanged", "a working check skips again");

    stored = "throw";
    await replaceEpisodeCacheForSource("plex", richRows());
    assert.equal(warnings.length, 2, "a failure that comes back after a success is reported again");
  } finally {
    console.warn = realWarn;
  }
});

test("an empty set against an empty table is a no-op", async () => {
  reset();
  stored = { rows: 0, digest: null };
  assert.equal(await replaceEpisodeCacheForSource("plex", []), "unchanged");
  assert.equal(opsOf("$transaction:enter").length, 0);
});

test("duplicates across servers compare as the set the swap would write", async () => {
  const base = { tmdbId: 7, seasonNumber: 1, episodeNumber: 1, episodeName: "Pilot" };
  const rows: Row[] = [
    { ...base, addedAt: new Date("2024-05-01T00:00:00Z") },
    { ...base, addedAt: new Date("2024-01-01T00:00:00Z") },
  ];
  reset();
  stored = episodeCacheDigest([{ ...base, addedAt: new Date("2024-01-01T00:00:00Z") }]);
  assert.equal(await replaceEpisodeCacheForSource("plex", rows), "unchanged", "the earliest arrival is what is stored");
  reset();
  stored = episodeCacheDigest([{ ...base, addedAt: new Date("2024-05-01T00:00:00Z") }]);
  assert.equal(await replaceEpisodeCacheForSource("plex", rows), "replaced");
});

test("the digest tells null from empty, and no value can shift into the next field", () => {
  const one = (r: Partial<Row>) => episodeCacheDigest([{ tmdbId: 1, seasonNumber: 1, episodeNumber: 1, ...r }]).digest;
  assert.notEqual(one({ overview: null }), one({ overview: "" }));
  assert.notEqual(one({ runtime: null }), one({ runtime: 0 }));
  assert.notEqual(one({ addedAt: null }), one({ addedAt: new Date(0) }));
  // A naive "|" join renders both of these as "x|y|z".
  assert.notEqual(one({ episodeName: "x|y", airDate: "z" }), one({ episodeName: "x", airDate: "y|z" }));
  assert.deepEqual(episodeCacheDigest([]), { rows: 0, digest: null });
});

test("the digest covers exactly the columns the swap writes, in JS and in SQL", () => {
  const src = readFileSync(new URL("../src/lib/episode-cache.ts", import.meta.url), "utf8");
  const schema = readFileSync(new URL("../prisma/schema.prisma", import.meta.url), "utf8");

  const insertCols = (src.match(/INSERT INTO "TVEpisodeCache" \(([^)]*)\)/)?.[1] ?? "")
    .split(",").map((c) => c.trim().replace(/"/g, "")).filter((c) => c && c !== "source");
  const sqlBlock = src.match(/const EPISODE_ROW_TEXT_SQL = Prisma\.sql`([\s\S]*?)`;/)?.[1] ?? "";
  const sqlCols = [...sqlBlock.matchAll(/"(\w+)"/g)].map((m) => m[1]);
  const jsBody = src.match(/function episodeRowText\([^)]*\)[^{]*\{([\s\S]*?)\n\}/)?.[1] ?? "";
  const jsCols = [...jsBody.matchAll(/\br\.(\w+)/g)].map((m) => m[1]);
  const modelBody = schema.match(/model TVEpisodeCache \{([\s\S]*?)\n\}/)?.[1] ?? "";
  const modelCols = [...modelBody.matchAll(/^\s+(\w+)\s+\w/gm)].map((m) => m[1]).filter((c) => c !== "source");

  const sorted = (xs: string[]) => [...new Set(xs)].sort();
  assert.ok(insertCols.length >= 9, "found the swap's INSERT column list");
  assert.deepEqual(sorted(sqlCols), sorted(insertCols), "the SQL digest reads every column the swap writes");
  assert.deepEqual(sorted(jsCols), sorted(insertCols), "the JS digest reads every column the swap writes");
  assert.deepEqual(sorted(modelCols), sorted(insertCols), "the swap writes every column of the model");
});
