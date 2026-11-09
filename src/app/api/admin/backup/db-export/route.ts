import { NextResponse } from "next/server";
import { withAdmin } from "@/lib/api-auth";
import { auditActor, finalizeAuditRow, logAuditReturningId } from "@/lib/audit";
import { wrapEncryptStream, BackupCryptoError } from "@/lib/backup-crypto";
import { buildSqlStream, type ExportOutcome } from "@/lib/backup-export";
import { BACKUP_TABLES } from "@/lib/backup-schema";
import { checkRateLimit } from "@/lib/rate-limit";
import { translatorForRequest } from "@/lib/i18n/server-locale";
import { localizeBackupMessage } from "@/lib/backup-messages";
import { backupPasswordOrResponse } from "@/lib/backup-routes";
import { processSingleton } from "@/lib/process-singleton";

export const dynamic = "force-dynamic";

// One export at a time, process-wide (guardrail 27a). Each export holds a
// REPEATABLE READ snapshot, and one of the pool's five connections, for as long
// as its client takes to download (the producer is paced by the reader —
// backup-export.ts), so a double-clicked Download or two slow pulls took most
// of the pool. The slot is freed when the stream ends, fails or times out, and
// at once when the client cancels.
const exportSlot = processSingleton("db-export:slot", () => ({ owner: null as symbol | null }));

function claimExportSlot(): (() => void) | null {
  if (exportSlot.owner) return null;
  const token = Symbol("db-export");
  exportSlot.owner = token;
  return () => {
    if (exportSlot.owner === token) exportSlot.owner = null;
  };
}

export const GET = withAdmin(async (req, _ctx, session) => {
  const t = translatorForRequest(req);
  // Per-admin rate limit on a full encrypted database export. Streams the ENTIRE
  // database (~20 min), the highest-value exfiltration target in the app — one pull
  // hands an attacker every user, session, encrypted secret, and play-history record.
  // 5/hour stops a compromised admin cookie from draining the box while covering
  // legitimate manual backups.
  if (!checkRateLimit(`admin-db-export:${session.user.id}`, 5, 60 * 60 * 1000)) {
    return NextResponse.json({ error: t("apiAdmin.backup.tooManyExports") }, { status: 429 });
  }
  const pw = backupPasswordOrResponse(t, "admin");
  if (pw instanceof NextResponse) return pw;
  const { password } = pw;

  const release = claimExportSlot();
  if (!release) {
    return NextResponse.json({ error: t("apiAdmin.backup.exportInProgress") }, { status: 409 });
  }

  // Written BEFORE the stream, so an export the client abandons at once is still
  // on record, then finalized with how it ended (the audit-log export's shape).
  // A failed audit write must not 500 the export (guardrail 26): it is swallowed,
  // and the row is then simply not finalized.
  const details = { format: "sql", tables: BACKUP_TABLES.length, encrypted: true };
  const auditId = logAuditReturningId({
    ...auditActor(req, session),
    action: "BACKUP_EXPORT",
    target: "backup:full-db",
    details: { ...details, status: "started" },
  });

  const onSettled = async ({ status, rows }: ExportOutcome) => {
    release();
    const id = await auditId;
    if (id) await finalizeAuditRow(id, { ...details, status, totalRows: rows }, "[db-export]");
  };

  let body: ReadableStream<Uint8Array>;
  try {
    body = wrapEncryptStream(buildSqlStream(session.user.id, { onCancel: release, onSettled }), password);
  } catch (err) {
    release();
    // The "started" row must not stay open when the stream never began.
    void auditId
      .then((id) => (id ? finalizeAuditRow(id, { ...details, status: "failed", totalRows: 0 }, "[db-export]") : undefined))
      .catch(() => {});
    if (err instanceof BackupCryptoError) {
      return NextResponse.json({ error: localizeBackupMessage(err.message, t) }, { status: err.status });
    }
    throw err;
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
});
