import { NextResponse } from "next/server";
import { withAdmin } from "@/lib/api-auth";
import { logAudit, auditContext } from "@/lib/audit";
import { checkBodySize } from "@/lib/body-size";
import { checkRateLimit } from "@/lib/rate-limit";
import {
  processBackupImport,
  MAX_CIPHERTEXT_BYTES,
} from "@/lib/backup-import";

export const dynamic = "force-dynamic";

const MIN_BACKUP_PASSWORD_LEN = 12;

export const POST = withAdmin(async (req, _ctx, session) => {
  // A full DB restore is a destructive TRUNCATE+INSERT and runs PBKDF2(600k) +
  // a long transaction per call. Cap it per admin so a stolen/compromised admin
  // cookie can't hammer the restore path (key-derivation CPU burn, repeated
  // destructive replaces) while still covering legitimate operator use.
  if (!checkRateLimit(`admin-db-import:${session.user.id}`, 5, 60 * 60 * 1000)) {
    return NextResponse.json({ error: "Too many restore attempts — try again later." }, { status: 429 });
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

  const sizeCheck = checkBodySize(req, MAX_CIPHERTEXT_BYTES);
  if (sizeCheck) return sizeCheck;

  if (!req.body) {
    return NextResponse.json({ error: "Empty request body" }, { status: 400 });
  }

  const result = await processBackupImport(req.body, password);

  if (!result.ok) {
    if (result.errors) {
      return NextResponse.json({
        ok: false,
        summary: result.summary,
        errors: result.errors,
      });
    }
    return NextResponse.json({ error: result.error }, { status: result.status });
  }

  // DB restore already executed; a failed audit write must not 500 a successful
  // import — the destructive replace already happened and a retry would re-run it.
  void logAudit({
    userId: session.user.id,
    userName: session.user.name ?? session.user.email,
    action: "BACKUP_IMPORT",
    target: "backup:full-db",
    details: {
      format: "sql",
      encrypted: true,
      after: {
        totalStatements: result.summary.total,
        executed: result.summary.executed,
        skipped: result.summary.skipped,
        errors: result.summary.errors,
      },
    },
    ...auditContext(req, session),
  });

  return NextResponse.json({
    ok: true,
    summary: result.summary,
    ...(result.warning ? { warning: result.warning } : {}),
  });
});
