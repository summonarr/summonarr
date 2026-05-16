import { NextResponse } from "next/server";
import { withAdmin } from "@/lib/api-auth";
import { logAuditOrFail, auditContext } from "@/lib/audit";
import { checkBodySize } from "@/lib/body-size";
import {
  processBackupImport,
  MAX_CIPHERTEXT_BYTES,
} from "@/lib/backup-import";

export const dynamic = "force-dynamic";

const MIN_BACKUP_PASSWORD_LEN = 12;

export const POST = withAdmin(async (req, _ctx, session) => {
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

  try {
    await logAuditOrFail({
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
  } catch (err) {
    console.error("[audit] Critical audit log failed:", err);
    return NextResponse.json({ error: "Audit logging failed" }, { status: 500 });
  }

  return NextResponse.json({
    ok: true,
    summary: result.summary,
    ...(result.warning ? { warning: result.warning } : {}),
  });
});
