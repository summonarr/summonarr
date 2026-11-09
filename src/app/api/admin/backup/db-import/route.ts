import { NextResponse } from "next/server";
import { withAdmin } from "@/lib/api-auth";
import { checkBodySize } from "@/lib/body-size";
import { checkRateLimit } from "@/lib/rate-limit";
import {
  processBackupImport,
  MAX_CIPHERTEXT_BYTES,
} from "@/lib/backup-import";
import { translatorForRequest } from "@/lib/i18n/server-locale";
import { runAuditedAdminImport, backupPasswordOrResponse, importResultResponse } from "@/lib/backup-routes";

export const dynamic = "force-dynamic";

export const POST = withAdmin(async (req, _ctx, session) => {
  const t = translatorForRequest(req);
  // A full DB restore is a destructive TRUNCATE+INSERT and runs PBKDF2(600k) +
  // a long transaction per call. Cap it per admin so a stolen/compromised admin
  // cookie can't hammer the restore path (key-derivation CPU burn, repeated
  // destructive replaces) while still covering legitimate operator use.
  if (!checkRateLimit(`admin-db-import:${session.user.id}`, 5, 60 * 60 * 1000)) {
    return NextResponse.json({ error: t("apiAdmin.backup.tooManyRestores") }, { status: 429 });
  }

  const pw = backupPasswordOrResponse(t, "admin");
  if (pw instanceof NextResponse) return pw;
  const { password } = pw;

  const sizeCheck = checkBodySize(req, MAX_CIPHERTEXT_BYTES);
  if (sizeCheck) return sizeCheck;

  if (!req.body) {
    return NextResponse.json({ error: t("apiAdmin.backup.emptyBody") }, { status: 400 });
  }

  const body = req.body;
  // Audited whether or not it succeeded or threw — after the restore, never
  // inside it (guardrail 26: the destructive replace already happened, and a
  // retry would re-run it).
  const result = await runAuditedAdminImport(req, session, "admin", () => processBackupImport(body, password));
  return importResultResponse(result, t, { chunked: false });
});
