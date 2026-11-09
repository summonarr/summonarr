// Route-level pieces shared by the five backup routes: the admin export and
// restores (/api/admin/backup/*) and the first-run restores (/api/setup/import,
// /api/setup/import-chunk). The pipeline itself is backup-import.ts; this is
// the HTTP side around it, kept in one place so the copies can't drift.
import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { logAudit, auditContext } from "@/lib/audit";
import { getClientIp } from "@/lib/rate-limit";
import { localizeBackupMessage } from "@/lib/backup-messages";
import { backupPasswordStatus, MIN_BACKUP_PASSWORD_LEN } from "@/lib/backup-password";
import { setupClosedInTx, setupRestoreDisabled, type BackupImportResult } from "@/lib/backup-import";
import { lockSetupInTx } from "@/lib/setup-lock";
import type { Translator } from "@/lib/i18n/translate";
import type { SummonarrSession } from "@/lib/api-auth";

// BACKUP_DB_PASSWORD unset or too short: 503 before any work. The admin and
// setup routes answer from their own message areas.
export function backupPasswordOrResponse(
  t: Translator,
  area: "admin" | "setup",
): { password: string } | NextResponse {
  const status = backupPasswordStatus();
  if (status.ok) return { password: status.password };
  const missing = area === "admin" ? "apiAdmin.backup.notConfigured" : "apiAuth.setup.backupNotConfigured";
  const short = area === "admin" ? "apiAdmin.backup.passwordTooShort" : "apiAuth.setup.passwordTooShort";
  return NextResponse.json(
    { error: status.kind === "missing" ? t(missing) : t(short, { min: MIN_BACKUP_PASSWORD_LEN }) },
    { status: 503 },
  );
}

// The response for a finished processBackupImport. Validation failures are a
// 200 with ok:false and the errors list (the UI renders it); every other
// failure carries its status and a translated message. The chunked routes mark
// each answer `complete: true` so the uploader stops.
export function importResultResponse(
  result: BackupImportResult,
  t: Translator,
  opts: { chunked: boolean },
): NextResponse {
  const done = opts.chunked ? { complete: true as const } : {};
  if (!result.ok) {
    if (result.errors) {
      return NextResponse.json({ ok: false, ...done, summary: result.summary, errors: result.errors });
    }
    return NextResponse.json({ error: localizeBackupMessage(result.error, t), ...done }, { status: result.status });
  }
  return NextResponse.json({
    ok: true,
    ...done,
    summary: result.summary,
    ...(result.warning ? { warning: result.warning } : {}),
  });
}

export type BackupImportAuditMode = "admin" | "admin-chunked" | "setup" | "setup-chunked";

// BACKUP_IMPORT details for a restore that ran. A failed one records its status
// and counts only, never result.errors or result.error: validation errors quote
// up to 80 characters of the backup's SQL.
export function importAuditDetails(result: BackupImportResult, mode: BackupImportAuditMode): Record<string, unknown> {
  const counts = (s: { total: number; executed: number; skipped: number; errors: number }) => ({
    totalStatements: s.total,
    executed: s.executed,
    skipped: s.skipped,
    errors: s.errors,
  });
  if (result.ok) {
    return { format: "sql", encrypted: true, mode, outcome: "restored", after: counts(result.summary) };
  }
  return {
    format: "sql",
    encrypted: true,
    mode,
    outcome: "failed",
    status: result.status,
    errorCount: result.errors?.length ?? 0,
    ...(result.summary ? { after: counts(result.summary) } : {}),
  };
}

// Every admin restore attempt that reached the pipeline is audited, failed ones
// too: a wrong password or a refused dump is still an attempt to replace the
// database. Rejections before the import (headers, order, size) are not. After
// the restore, never inside it (guardrail 26): AuditLog is one of the restored
// tables, and a failed write must not fail a restore that already ran.
export function auditAdminImport(
  req: Request,
  session: SummonarrSession,
  result: BackupImportResult,
  mode: "admin" | "admin-chunked",
): void {
  void logAudit({
    userId: session.user.id,
    userName: session.user.name ?? session.user.email,
    action: "BACKUP_IMPORT",
    target: "backup:full-db",
    details: importAuditDetails(result, mode),
    ...auditContext(req, session),
  });
}

// An import that THREW instead of answering (a bug or a crashed pipeline): the
// attempt is still audited as a failed restore, then the error is rethrown.
export async function runAuditedAdminImport(
  req: Request,
  session: SummonarrSession,
  mode: "admin" | "admin-chunked",
  run: () => Promise<BackupImportResult>,
): Promise<BackupImportResult> {
  let result: BackupImportResult;
  try {
    result = await run();
  } catch (err) {
    auditAdminImport(req, session, { ok: false, status: 500, error: "Import failed unexpectedly." }, mode);
    throw err;
  }
  // Audited whether or not it succeeded — after the restore, never inside it
  // (guardrail 26).
  auditAdminImport(req, session, result, mode);
  return result;
}

// The first-run audit row, written after the restore committed (outside its
// transaction, so the TRUNCATE can't take it). No session exists yet: the
// restored users haven't signed in. A failed write must not fail the restore.
export async function auditSetupImport(
  req: Request,
  result: BackupImportResult,
  mode: "setup" | "setup-chunked",
): Promise<void> {
  await logAudit({
    userId: null,
    userName: "system (setup)",
    action: "BACKUP_IMPORT",
    target: "backup:full-db",
    details: importAuditDetails(result, mode),
    ipAddress: getClientIp(req.headers),
    userAgent: req.headers.get("user-agent")?.slice(0, 512) ?? null,
  });
}

// The first-run restore gate, shared by both setup transports. In order:
//   1. The internet-facing opt-in (403), before any DB work or upload byte.
//      processBackupImport re-checks it; this one stops an unauthenticated
//      caller streaming a whole ciphertext onto the temp disk first.
//   2. Freshness under advisory lock 43 (setup-lock.ts), shared with
//      /api/auth/register so a racing registration can't slip in. Returned as
//      `closed` so the chunked route can free its upload slot; both answer 409.
//      processBackupImport re-takes the lock and re-checks under it.
//   3. BACKUP_DB_PASSWORD (503).
export async function setupRestoreGate(
  t: Translator,
): Promise<NextResponse | { closed: true } | { password: string }> {
  if (setupRestoreDisabled()) {
    return NextResponse.json({ error: t("apiAuth.setup.restoreDisabled") }, { status: 403 });
  }
  const closed = await prisma.$transaction(async (tx) => {
    await lockSetupInTx(tx);
    return setupClosedInTx(tx);
  });
  if (closed) return { closed: true };
  return backupPasswordOrResponse(t, "setup");
}
