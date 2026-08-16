import { NextResponse } from "next/server";
import { withAdmin } from "@/lib/api-auth";
import { logAudit, auditContext } from "@/lib/audit";
import { prisma } from "@/lib/prisma";
import { wrapEncryptStream, BackupCryptoError } from "@/lib/backup-crypto";
import { BACKUP_TABLES, BACKUP_ENUMS, computeSchemaFingerprint } from "@/lib/backup-schema";
import { tokenEncryptionKeyFingerprint } from "@/lib/token-crypto";
import { checkRateLimit } from "@/lib/rate-limit";

export const dynamic = "force-dynamic";

const CHUNK_SIZE = 1000;

function escapeSQL(value: unknown): string {
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

// Streams the whole database as a re-runnable SQL dump (enum types + paginated
// INSERTs) inside one REPEATABLE READ snapshot; `counts` is mutated in place.
function buildSqlStream(
  exportedBy: string,
  counts: { tables: number; rows: number },
): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();

  const EXPORT_TIMEOUT_MS = 20 * 60 * 1000;
  const fingerprint = computeSchemaFingerprint();

  return new ReadableStream<Uint8Array>({
    async start(controller) {
      const timeout = setTimeout(() => controller.error(new Error("Backup export timed out")), EXPORT_TIMEOUT_MS);
      try {
        const write = (s: string) => controller.enqueue(encoder.encode(s));

        write("-- Summonarr Full Database Backup\n");
        // Schema-Fingerprint is parsed by the importer and matched against the
        // live server's fingerprint. Mismatch refuses the restore before any
        // mutation. Format must stay parseable by the importer's regex.
        write(`-- Schema-Fingerprint: ${fingerprint}\n`);
        const tekFingerprint = tokenEncryptionKeyFingerprint();
        if (tekFingerprint) {
          // Lets the importer warn when restoring onto a server with a DIFFERENT
          // TOKEN_ENCRYPTION_KEY — the encrypted secrets would otherwise restore as
          // undecryptable ciphertext with no signal. Non-secret domain-separated hash.
          write(`-- Token-Encryption-Key-Fingerprint: ${tekFingerprint}\n`);
        }
        write(`-- Exported at: ${new Date().toISOString()}\n`);
        write(`-- Exported by: admin (${exportedBy})\n\n`);

        // Resolve which BACKUP_TABLES actually exist BEFORE the snapshot transaction.
        //
        // This used to be discovered inside the tx by letting the per-table SELECT
        // throw and catching it ("table does not exist"). That silently truncated the
        // backup: in Postgres ANY statement error — including a failed SELECT — aborts
        // the whole transaction, and a top-level interactive Prisma tx emits no
        // SAVEPOINT (guardrail 23), so every subsequent statement fails with 25P02
        // "current transaction is aborted". Those errors hit the same catch, so ONE
        // missing table (schema drift after a downgrade, or a `db push` not yet run)
        // marked EVERY remaining table "does not exist" and exported it as zero rows —
        // a 200 OK download containing partial data, whose restore TRUNCATEs and then
        // repopulates only the tables before the failure. Failing loudly beats that, so
        // nothing inside the tx swallows query errors any more.
        const existingRows = await prisma.$queryRawUnsafe<{ t: string }[]>(
          `SELECT tablename AS t FROM pg_tables WHERE schemaname = 'public'`,
        );
        const existingTables = new Set(existingRows.map((r) => r.t));

        await prisma.$transaction(
          async (tx) => {
            // REPEATABLE READ pins every paginated SELECT to the same MVCC
            // snapshot so concurrent inserts can't shift rows across page
            // boundaries and produce duplicate IDs in the dump.
            await tx.$executeRawUnsafe("SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY");

            write("-- Enum types\n");
            for (const name of BACKUP_ENUMS) {
              const values = await tx.$queryRawUnsafe<{ enumlabel: string }[]>(
                `SELECT enumlabel FROM pg_enum JOIN pg_type ON pg_enum.enumtypid = pg_type.oid WHERE pg_type.typname = $1 ORDER BY enumsortorder`,
                name,
              );
              if (values.length > 0) {
                const labels = values.map((v) => `'${v.enumlabel.replace(/'/g, "''")}'`).join(", ");
                write(`DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = '${name}') THEN CREATE TYPE "${name}" AS ENUM (${labels}); END IF; END $$;\n`);
              }
            }
            write("\n");

            for (const table of BACKUP_TABLES) {
              // Pre-resolved above, outside the tx — see the note there.
              if (!existingTables.has(table)) {
                write(`-- Skipped "${table}" (table does not exist)\n\n`);
                continue;
              }

              let totalRows = 0;
              let offset = 0;
              let columns: string[] | null = null;
              let colList = "";
              let orderClause: string | null = null;

              while (true) {
                if (orderClause === null) {
                  const pkRows = await tx.$queryRawUnsafe<{ attname: string }[]>(
                    `SELECT a.attname FROM pg_index i JOIN pg_attribute a ON a.attrelid = i.indrelid AND a.attnum = ANY(i.indkey) WHERE i.indrelid = $1::regclass AND i.indisprimary ORDER BY array_position(i.indkey, a.attnum)`,
                    `"public"."${table}"`,
                  );
                  // Identifiers come from pg_attribute (DB-owner trusted), but
                  // pattern-match what could go wrong if that trust boundary
                  // ever loosens: reject anything that's not a sane Postgres
                  // identifier and double-quote-escape what remains. This
                  // closes any future SQL-injection regression at the source.
                  const safeIdents: string[] = [];
                  for (const r of pkRows) {
                    if (!/^[A-Za-z0-9_]{1,63}$/.test(r.attname)) {
                      throw new Error(`[db-export] refusing unsafe PK column name: ${JSON.stringify(r.attname)}`);
                    }
                    safeIdents.push(`"${r.attname.replace(/"/g, '""')}"`);
                  }
                  // No primary key (e.g. VerificationToken, DiscordMergeCode) →
                  // OFFSET pagination needs a stable total order or it can skip or
                  // duplicate rows across pages. ctid is a unique system column,
                  // stable within this REPEATABLE READ snapshot, and needs no
                  // schema knowledge.
                  orderClause = safeIdents.length > 0
                    ? "ORDER BY " + safeIdents.join(", ")
                    : "ORDER BY ctid";
                }
                const rows = await tx.$queryRawUnsafe<Record<string, unknown>[]>(
                  `SELECT * FROM "public"."${table}" ${orderClause} LIMIT ${CHUNK_SIZE} OFFSET ${offset}`,
                );
                if (rows.length === 0) break;

                if (columns === null) {
                  columns = Object.keys(rows[0]);
                  // Column names come from Prisma query-result keys (DB-owner
                  // trusted), but validate and double-quote-escape them with the
                  // same rule as the PK identifiers above so the INSERT column
                  // list can't become an injection vector if that trust boundary
                  // ever loosens.
                  for (const c of columns) {
                    if (!/^[A-Za-z0-9_]{1,63}$/.test(c)) {
                      throw new Error(`[db-export] refusing unsafe column name: ${JSON.stringify(c)}`);
                    }
                  }
                  colList = columns.map((c) => `"${c.replace(/"/g, '""')}"`).join(", ");
                }

                for (const row of rows) {
                  const values = columns!.map((c) => escapeSQL(row[c])).join(", ");
                  // ON CONFLICT DO NOTHING is defence-in-depth: the snapshot
                  // transaction above prevents duplicates in fresh dumps, but
                  // older dumps (taken before the snapshot fix) may contain
                  // them. Skipping a duplicate is strictly better than
                  // aborting the entire restore.
                  write(`INSERT INTO "public"."${table}" (${colList}) VALUES (${values}) ON CONFLICT DO NOTHING;\n`);
                  totalRows++;
                  counts.rows++;
                }

                if (rows.length < CHUNK_SIZE) break;
                offset += CHUNK_SIZE;
              }

              write(`-- Table: ${table} (${totalRows} rows)\n\n`);
              counts.tables++;
            }
          },
          { timeout: EXPORT_TIMEOUT_MS, isolationLevel: "RepeatableRead" },
        );

        controller.close();
      } catch (err) {
        controller.error(err);
      } finally {
        clearTimeout(timeout);
      }
    },
  });
}

const MIN_BACKUP_PASSWORD_LEN = 12;

export const GET = withAdmin(async (req, _ctx, session) => {
  // Per-admin rate limit on a full encrypted database export. Streams the ENTIRE
  // database (~20 min), the highest-value exfiltration target in the app — one pull
  // hands an attacker every user, session, encrypted secret, and play-history record.
  // 5/hour stops a compromised admin cookie from draining the box while covering
  // legitimate manual backups.
  if (!checkRateLimit(`admin-db-export:${session.user.id}`, 5, 60 * 60 * 1000)) {
    return NextResponse.json({ error: "Too many backup exports — try again later." }, { status: 429 });
  }
  const password = process.env.BACKUP_DB_PASSWORD ?? "";
  if (password.length === 0) {
    return NextResponse.json(
      { error: "Backup is not configured. Set the BACKUP_DB_PASSWORD environment variable on the server." },
      { status: 503 },
    );
  }
  if (password.length < MIN_BACKUP_PASSWORD_LEN) {
    return NextResponse.json(
      { error: `BACKUP_DB_PASSWORD is too short (minimum ${MIN_BACKUP_PASSWORD_LEN} characters).` },
      { status: 503 },
    );
  }

  const counts = { tables: 0, rows: 0 };
  let body: ReadableStream<Uint8Array>;
  try {
    body = wrapEncryptStream(buildSqlStream(session.user.id, counts), password);
  } catch (err) {
    if (err instanceof BackupCryptoError) {
      return NextResponse.json({ error: err.message }, { status: err.status });
    }
    throw err;
  }

  // The backup stream is already built; a failed audit write must not 500 a
  // successful export (GR26). logAudit swallows write failures internally.
  void logAudit({
    userId: session.user.id,
    userName: session.user.name ?? session.user.email,
    action: "BACKUP_EXPORT",
    target: "backup:full-db",
    details: { format: "sql", tables: BACKUP_TABLES.length, encrypted: true },
    ...auditContext(req, session),
  });

  const date = new Date().toISOString().slice(0, 10);
  const filename = `summonarr-full-backup-${date}.sql.enc`;
  const contentType = "application/octet-stream";

  return new NextResponse(body, {
    headers: {
      "Content-Type": contentType,
      "Content-Disposition": `attachment; filename="${filename}"`,
      "X-Content-Type-Options": "nosniff",
      "Cache-Control": "no-store",
    },
  });
});
