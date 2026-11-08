// The full-database SQL dump behind GET /api/admin/backup/db-export: enum
// types, then every BACKUP_TABLES row as a re-runnable INSERT, inside one
// REPEATABLE READ snapshot, streamed with backpressure. The output shape is
// pinned by backup-import's strict statement allowlist — change both or neither.
import { prisma } from "./prisma";
import { BACKUP_TABLES, BACKUP_ENUMS, computeNormalizedSchemaFingerprint, computeSchemaFingerprint } from "./backup-schema";
import { tokenEncryptionKeyFingerprint } from "./token-crypto";

const CHUNK_SIZE = 1000;
// A response nobody starts reading would hold the export (and its caller's
// slot) for the whole export timeout. Next runs GET for a HEAD request and
// never reads or cancels its body, so cut such a producer off well before
// that. A real download starts reading at once.
const FIRST_READ_TIMEOUT_MS = 60 * 1000;
const EXPORT_TIMEOUT_MS = 20 * 60 * 1000;

const SAFE_IDENT_RE = /^[A-Za-z0-9_]{1,63}$/;

export type ExportOutcome = { status: "completed" | "aborted" | "failed"; rows: number };

/** The raw-query surface the dump needs: the pool client or its snapshot transaction. */
export type RawQueryClient = {
  $queryRawUnsafe<T = unknown>(query: string, ...values: unknown[]): PromiseLike<T>;
};

type Write = (text: string) => Promise<void>;

export function escapeSQL(value: unknown): string {
  if (value === null || value === undefined) return "NULL";
  if (typeof value === "boolean") return value ? "TRUE" : "FALSE";
  if (typeof value === "number") {
    if (!Number.isFinite(value)) return "NULL";
    return String(value);
  }
  if (typeof value === "bigint") return String(value);
  if (value instanceof Date) return `'${value.toISOString()}'`;
  // A native Postgres ARRAY column (text[] etc) also arrives as a JS array, and
  // it needs an ARRAY literal, not a JSON one. Emitting `'["a","b"]'` for
  // JellyfinLibraryItem.jellyfinItemIds made Postgres reject the row with
  // `22P02 malformed array literal` — the EMPTY array too, so it was every row
  // in that table, not just guardrail-37's duplicate-copy rows. The importer
  // runs the whole dump in one transaction, so the first such row rolled back
  // the entire restore while the export itself returned 200 and looked perfect.
  //
  // The quoted `'{a,b}'` form is deliberate: it stays a plain single-quoted
  // string, so backup-import's SAFE_LITERAL_RE still accepts it. An ARRAY[...]
  // constructor would be rejected by that validator.
  //
  // Discriminating on the JS shape is only sound because NO Json column in this
  // schema holds a top-level array — one that did would arrive as an array too
  // and get an array literal written into a jsonb column, which is this same
  // bug in reverse. tests/schema-invariants.test.mts pins that assumption; if
  // it ever goes red, this needs the real column type rather than the shape.
  if (Array.isArray(value)) {
    const elements = value.map((el) => {
      if (el === null) return "NULL";
      // Per-element quoting, then the outer pass escapes the SQL quotes.
      return `"${String(el).replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
    });
    return `'${`{${elements.join(",")}}`.replace(/\0/g, "").replace(/'/g, "''")}'`;
  }
  // Prisma returns Json/Jsonb columns as parsed objects. String(value) would
  // produce "[object Object]" — re-serialize with JSON.stringify so the dump
  // contains a valid JSON literal that Postgres can re-parse on INSERT.
  const raw = typeof value === "object" ? JSON.stringify(value) : String(value);
  const str = raw.replace(/\0/g, "").replace(/'/g, "''");
  return `'${str}'`;
}

// Identifiers come from pg_attribute / the result's keys (DB-owner trusted),
// but pattern-match what could go wrong if that trust boundary ever loosens:
// reject anything that's not a sane Postgres identifier and double-quote-escape
// what remains. This closes any future SQL-injection regression at the source.
function quoteIdent(name: string, what: string): string {
  if (!SAFE_IDENT_RE.test(name)) {
    throw new Error(`[db-export] refusing unsafe ${what}: ${JSON.stringify(name)}`);
  }
  return `"${name.replace(/"/g, '""')}"`;
}

async function writeHeader(
  write: Write,
  header: { exportedBy: string; fingerprint: string; normalizedFingerprint: string },
  onFirstRead: () => void,
): Promise<void> {
  await write("-- Summonarr Full Database Backup\n");
  // The reader has started (this write waited for it).
  onFirstRead();
  // Schema-Fingerprint is parsed by the importer and matched against the
  // live server's fingerprint. Mismatch refuses the restore before any
  // mutation. Format must stay parseable by the importer's regex.
  await write(`-- Schema-Fingerprint: ${header.fingerprint}\n`);
  // The comment- and whitespace-insensitive twin (backup-schema.ts). A newer
  // importer prefers it; an older one ignores the line.
  await write(`-- Schema-Fingerprint-Normalized: ${header.normalizedFingerprint}\n`);
  const tekFingerprint = tokenEncryptionKeyFingerprint();
  if (tekFingerprint) {
    // Lets the importer warn when restoring onto a server with a DIFFERENT
    // TOKEN_ENCRYPTION_KEY — the encrypted secrets would otherwise restore as
    // undecryptable ciphertext with no signal. Non-secret domain-separated hash.
    await write(`-- Token-Encryption-Key-Fingerprint: ${tekFingerprint}\n`);
  }
  await write(`-- Exported at: ${new Date().toISOString()}\n`);
  await write(`-- Exported by: admin (${header.exportedBy})\n\n`);
}

/** CREATE TYPE … IF NOT EXISTS for every enum the backup covers. */
export async function writeEnumTypes(tx: RawQueryClient, write: Write): Promise<void> {
  await write("-- Enum types\n");
  for (const name of BACKUP_ENUMS) {
    const values = await tx.$queryRawUnsafe<{ enumlabel: string }[]>(
      `SELECT enumlabel FROM pg_enum JOIN pg_type ON pg_enum.enumtypid = pg_type.oid WHERE pg_type.typname = $1 ORDER BY enumsortorder`,
      name,
    );
    if (values.length > 0) {
      const labels = values.map((v) => `'${v.enumlabel.replace(/'/g, "''")}'`).join(", ");
      await write(`DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = '${name}') THEN CREATE TYPE "${name}" AS ENUM (${labels}); END IF; END $$;\n`);
    }
  }
  await write("\n");
}

type TableOrder = { orderClause: string; keyCols: string[] | null };

// The table's primary key as the page order and keyset cursor. No primary key
// (e.g. VerificationToken, DiscordMergeCode) → OFFSET pagination needs a stable
// total order or it can skip or duplicate rows across pages. ctid is a unique
// system column, stable within this REPEATABLE READ snapshot, and needs no
// schema knowledge. Only a PK gives a cursor: ctid would have to be SELECTed to
// be carried forward, and that extra column would pollute the INSERT column
// list, which is derived from the row's keys. Both PK-less tables are tiny and
// expiry-purged, so OFFSET's quadratic cost never materializes.
async function tableOrder(tx: RawQueryClient, table: string): Promise<TableOrder> {
  const pkRows = await tx.$queryRawUnsafe<{ attname: string }[]>(
    `SELECT a.attname FROM pg_index i JOIN pg_attribute a ON a.attrelid = i.indrelid AND a.attnum = ANY(i.indkey) WHERE i.indrelid = $1::regclass AND i.indisprimary ORDER BY array_position(i.indkey, a.attnum)`,
    `"public"."${table}"`,
  );
  const keyCols = pkRows.map((r) => quoteIdent(r.attname, "PK column name"));
  return keyCols.length > 0
    ? { orderClause: "ORDER BY " + keyCols.join(", "), keyCols }
    : { orderClause: "ORDER BY ctid", keyCols: null };
}

// One page of the table: keyset after `cursor`, not LIMIT/OFFSET. OFFSET
// re-walks and discards every preceding index+heap entry on each page, so a
// single table costs O(n^2/CHUNK): measured on a 300k-row PlayHistory, page 1
// ran in 1.2ms and the last page in 108ms, and the full walk took 14.0s versus
// 0.47s for the keyset form.
//
// The row-value comparison handles composite PKs uniformly — 10 of the 38
// exported tables have one — and degenerates to the single-column case for the
// rest. Postgres infers the parameter types from the row-comparison context,
// including an enum in the middle of the key (MediaType), so no per-table casts
// are needed and the plan stays an index condition rather than a filter.
function readPage(tx: RawQueryClient, table: string, order: TableOrder, cursor: unknown[] | null, offset: number) {
  const from = `SELECT * FROM "public"."${table}"`;
  if (order.keyCols && cursor) {
    const placeholders = cursor.map((_, i) => `$${i + 1}`).join(", ");
    return tx.$queryRawUnsafe<Record<string, unknown>[]>(
      `${from} WHERE (${order.keyCols.join(", ")}) > (${placeholders}) ${order.orderClause} LIMIT ${CHUNK_SIZE}`,
      ...cursor,
    );
  }
  if (order.keyCols) return tx.$queryRawUnsafe<Record<string, unknown>[]>(`${from} ${order.orderClause} LIMIT ${CHUNK_SIZE}`);
  return tx.$queryRawUnsafe<Record<string, unknown>[]>(`${from} ${order.orderClause} LIMIT ${CHUNK_SIZE} OFFSET ${offset}`);
}

/**
 * Every row of one table as an INSERT, in primary-key order; resolves to the
 * row count, and calls `onRow` as each one is written (so an export that stops
 * part-way can say how far it got). Output is byte-identical whichever page
 * shape reads it — backup-import is a strict allowlist that pins the statement
 * shape.
 */
export async function dumpTable(tx: RawQueryClient, table: string, write: Write, onRow: () => void = () => {}): Promise<number> {
  const order = await tableOrder(tx, table);
  let total = 0;
  let colList: string | null = null;
  let columns: string[] = [];
  // Keyset cursor: the previous page's last row, projected onto the key
  // columns. null on the first page.
  let cursor: unknown[] | null = null;
  for (;;) {
    const rows = await readPage(tx, table, order, cursor, total);
    if (rows.length === 0) break;
    if (colList === null) {
      columns = Object.keys(rows[0]);
      colList = columns.map((c) => quoteIdent(c, "column name")).join(", ");
    }
    for (const row of rows) {
      const values = columns.map((c) => escapeSQL(row[c])).join(", ");
      // ON CONFLICT DO NOTHING is defence-in-depth: the snapshot transaction
      // prevents duplicates in fresh dumps, but older dumps (taken before the
      // snapshot fix) may contain them. Skipping a duplicate is strictly better
      // than aborting the entire restore.
      await write(`INSERT INTO "public"."${table}" (${colList}) VALUES (${values}) ON CONFLICT DO NOTHING;\n`);
      total++;
      onRow();
    }
    if (rows.length < CHUNK_SIZE) break;
    if (order.keyCols) {
      // Advance the cursor to the last row's key. keyCols are quoted
      // identifiers, so strip the quotes to index the row.
      const last = rows[rows.length - 1];
      cursor = order.keyCols.map((c) => last[c.slice(1, -1).replace(/""/g, '"')]);
    }
  }
  await write(`-- Table: ${table} (${total} rows)\n\n`);
  return total;
}

// Every table inside ONE read-only REPEATABLE READ snapshot, so concurrent
// inserts can't shift rows across page boundaries and produce duplicate IDs.
async function dumpDatabase(write: Write, onRow: () => void): Promise<void> {
  // Which BACKUP_TABLES exist is resolved BEFORE the snapshot transaction. It
  // used to be discovered inside the tx by letting the per-table SELECT throw
  // and catching it. That silently truncated the backup: in Postgres ANY
  // statement error aborts the whole transaction, and a top-level interactive
  // Prisma tx emits no SAVEPOINT (guardrail 23), so every later statement
  // failed with 25P02 — ONE missing table (schema drift after a downgrade, or
  // a `db push` not yet run) marked EVERY remaining table "does not exist" and
  // exported it as zero rows, a 200 OK download whose restore TRUNCATEs and
  // then repopulates only the tables before the failure. Failing loudly beats
  // that, so nothing inside the tx swallows query errors any more.
  const existingRows = await prisma.$queryRawUnsafe<{ t: string }[]>(
    `SELECT tablename AS t FROM pg_tables WHERE schemaname = 'public'`,
  );
  const existing = new Set(existingRows.map((r) => r.t));
  await prisma.$transaction(
    async (tx) => {
      await tx.$executeRawUnsafe("SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY");
      await writeEnumTypes(tx, write);
      for (const table of BACKUP_TABLES) {
        if (!existing.has(table)) {
          await write(`-- Skipped "${table}" (table does not exist)\n\n`);
          continue;
        }
        await dumpTable(tx, table, write, onRow);
      }
    },
    { timeout: EXPORT_TIMEOUT_MS, isolationLevel: "RepeatableRead" },
  );
}

/**
 * The whole database as a re-runnable SQL dump. `onCancel` runs synchronously
 * when the reader cancels; `onSettled` once the producer has finished, however
 * it finished.
 *
 * Backpressure. Producing the dump inside a ReadableStream's start() cannot
 * honour it — pull() is not invoked until start() settles (WHATWG Streams), so
 * a drain promise there deadlocks — and every INSERT line instead piled up in
 * the stream's internal queue: the DB pages at local speed while a WAN client
 * drains at its own, so a multi-hundred-MB dump materialized in memory.
 * Writing through a TransformStream makes `await writer.write(...)` suspend the
 * row loop until the consumer reads. The REPEATABLE READ snapshot is then held
 * for the length of the download (as pg_dump does), which is what the 20-minute
 * transaction/export timeout bounds.
 */
export function buildSqlStream(
  exportedBy: string,
  hooks: { onCancel: () => void; onSettled: (outcome: ExportOutcome) => Promise<void> },
): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  // Read now, not in the producer: a schema file that can't be read fails the
  // request itself rather than a stream already answered 200.
  const header = {
    exportedBy,
    fingerprint: computeSchemaFingerprint(),
    normalizedFingerprint: computeNormalizedSchemaFingerprint(),
  };
  let cancelled = false;
  let neverRead = false;
  // `cancel` runs when the reader cancels (Streams spec; Node 21+), synchronously
  // with it, so the caller's slot frees at once. The TS lib doesn't declare it yet.
  const transformer: Transformer<Uint8Array, Uint8Array> & { cancel: (reason: unknown) => void } = {
    cancel() {
      cancelled = true;
      hooks.onCancel();
    },
  };
  const { readable, writable } = new TransformStream<Uint8Array, Uint8Array>(transformer);
  const writer = writable.getWriter();
  const write: Write = (s) => writer.write(encoder.encode(s));

  void (async () => {
    // .unref() because the producer SUSPENDS on the first write until a
    // consumer reads: a caller that neither reads nor cancels the stream leaves
    // this timer armed, and a ref'd 20-minute timer holds the whole event loop
    // open (it stalled `npm test` for 20 minutes). The server's HTTP listener
    // keeps the loop alive on its own, so the timeout still fires exactly as
    // before for a real export; `finally` still clears it on every exit path.
    const timeout = setTimeout(
      () => void writer.abort(new Error("Backup export timed out")).catch(() => {}),
      EXPORT_TIMEOUT_MS,
    ).unref();
    const firstRead = setTimeout(() => {
      neverRead = true;
      void writer.abort(new Error("Backup export was never read")).catch(() => {});
    }, FIRST_READ_TIMEOUT_MS).unref();
    let rows = 0;
    let status: ExportOutcome["status"] = "failed";
    try {
      await writeHeader(write, header, () => clearTimeout(firstRead));
      await dumpDatabase(write, () => { rows++; });
      await writer.close();
      status = "completed";
    } catch (err) {
      if (cancelled || neverRead) {
        status = "aborted";
      } else {
        console.error("[db-export] export failed:", err);
      }
      // Abort the stream with the error so the download fails loudly
      // instead of ending early and looking like a complete (but truncated) file.
      await writer.abort(err).catch(() => {});
    } finally {
      clearTimeout(timeout);
      clearTimeout(firstRead);
      await hooks.onSettled({ status, rows });
    }
  })();

  return readable;
}
