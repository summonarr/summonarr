import { NextRequest, NextResponse } from "next/server";
import { requireAuth } from "@/lib/api-auth";
import { logAuditOrFail, auditContext } from "@/lib/audit";
import { prisma } from "@/lib/prisma";
import { wrapEncryptStream, BackupCryptoError } from "@/lib/backup-crypto";
import { BACKUP_TABLES, BACKUP_ENUMS, computeSchemaFingerprint } from "@/lib/backup-schema";

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
  const str = String(value).replace(/\0/g, "").replace(/'/g, "''");
  return `'${str}'`;
}

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
        write(`-- Exported at: ${new Date().toISOString()}\n`);
        write(`-- Exported by: admin (${exportedBy})\n\n`);

        // Export enum CREATE statements idempotently so the import is safe on an existing schema
        write("-- Enum types\n");
        for (const name of BACKUP_ENUMS) {
          const values = await prisma.$queryRawUnsafe<{ enumlabel: string }[]>(
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
          let totalRows = 0;
          let offset = 0;
          let columns: string[] | null = null;
          let colList = "";
          let tableExists = true;

          while (true) {
            let rows: Record<string, unknown>[];
            try {
              rows = await prisma.$queryRawUnsafe<Record<string, unknown>[]>(
                `SELECT * FROM "public"."${table}" LIMIT ${CHUNK_SIZE} OFFSET ${offset}`,
              );
            } catch {
              tableExists = false;
              break;
            }
            if (rows.length === 0) break;

            if (columns === null) {
              columns = Object.keys(rows[0]);
              colList = columns.map((c) => `"${c}"`).join(", ");
            }

            for (const row of rows) {
              const values = columns!.map((c) => escapeSQL(row[c])).join(", ");
              // Plain INSERTs — the import truncates every listed table inside the
              // restore transaction, so duplicate-key conflicts cannot occur and
              // ON CONFLICT DO NOTHING would silently mask a real corruption.
              write(`INSERT INTO "public"."${table}" (${colList}) VALUES (${values});\n`);
              totalRows++;
              counts.rows++;
            }

            if (rows.length < CHUNK_SIZE) break;
            offset += CHUNK_SIZE;
          }

          if (!tableExists) {
            write(`-- Skipped "${table}" (table does not exist)\n\n`);
            continue;
          }

          write(`-- Table: ${table} (${totalRows} rows)\n\n`);
          counts.tables++;
        }

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

export async function GET(req: NextRequest) {
  const session = await requireAuth({ role: "ADMIN" });
  if (session instanceof NextResponse) return session;

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

  try {
    await logAuditOrFail({
      userId: session.user.id,
      userName: session.user.name ?? session.user.email,
      action: "BACKUP_EXPORT",
      target: "backup:full-db",
      details: { format: "sql", tables: BACKUP_TABLES.length, encrypted: true },
      ...auditContext(req, session),
    });
  } catch (err) {
    console.error("[audit] Critical audit log failed:", err);
    return NextResponse.json({ error: "Audit logging failed" }, { status: 500 });
  }

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
}
