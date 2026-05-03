import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { checkBodySize } from "@/lib/body-size";
import { sanitizeText } from "@/lib/sanitize";
import { getClientIp } from "@/lib/rate-limit";
import {
  processBackupImport,
  MAX_CIPHERTEXT_BYTES,
} from "@/lib/backup-import";

export const dynamic = "force-dynamic";

const MIN_BACKUP_PASSWORD_LEN = 12;

// First-run-only restore. Refuses once any User row exists, so an attacker
// can't post a crafted dump to a live server. The admin route at
// /api/admin/backup/db-import handles every other case.
export async function POST(req: NextRequest) {
  const userCount = await prisma.user.count();
  if (userCount > 0) {
    return NextResponse.json(
      { error: "Setup import is only available on a fresh server with no users." },
      { status: 409 },
    );
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

  // Audit row is written outside the import transaction, so it survives the
  // TRUNCATE inside processBackupImport. userId is null because no admin
  // session exists yet — the imported users haven't logged in.
  try {
    await prisma.auditLog.create({
      data: {
        userId: null,
        userName: "system (setup)",
        action: "BACKUP_IMPORT",
        target: "backup:full-db",
        details: JSON.stringify({
          format: "sql",
          encrypted: true,
          mode: "setup",
          after: {
            totalStatements: result.summary.total,
            executed: result.summary.executed,
            skipped: result.summary.skipped,
            errors: result.summary.errors,
          },
        }),
        ipAddress: getClientIp(req.headers),
        userAgent: sanitizeText(req.headers.get("user-agent")?.slice(0, 512) ?? ""),
      },
    });
  } catch (err) {
    console.error("[audit] Setup-import audit log failed:", err);
  }

  return NextResponse.json({
    ok: true,
    summary: result.summary,
    ...(result.warning ? { warning: result.warning } : {}),
  });
}
