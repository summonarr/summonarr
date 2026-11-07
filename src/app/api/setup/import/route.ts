import { NextRequest, NextResponse } from "next/server";
import { checkBodySize } from "@/lib/body-size";
import { checkRateLimit, getClientIpKey } from "@/lib/rate-limit";
import {
  processBackupImport,
  MAX_CIPHERTEXT_BYTES,
} from "@/lib/backup-import";
import { translatorForRequest } from "@/lib/i18n/server-locale";
import { auditSetupImport, importResultResponse, setupRestoreGate } from "@/lib/backup-routes";

export const dynamic = "force-dynamic";

// First-run-only restore. Refuses once any User row exists, so an attacker
// can't post a crafted dump to a live server. The admin route at
// /api/admin/backup/db-import handles every other case. The UI uploads through
// the chunked sibling; both share one gate (backup-routes.ts).
export async function POST(req: NextRequest) {
  const t = translatorForRequest(req);
  if (!checkRateLimit(`setup-import:${getClientIpKey(req.headers)}`, 5, 5 * 60 * 1000)) {
    return NextResponse.json({ error: t("apiAuth.setup.tooManyAttempts") }, { status: 429 });
  }

  // The internet-facing opt-in (403), freshness under advisory lock 43 (409),
  // then the password (503).
  const gate = await setupRestoreGate(t);
  if (gate instanceof NextResponse) return gate;
  if ("closed" in gate) {
    return NextResponse.json(
      { error: t("apiAuth.setup.notFresh") },
      { status: 409 },
    );
  }
  const { password } = gate;

  const sizeCheck = checkBodySize(req, MAX_CIPHERTEXT_BYTES);
  if (sizeCheck) return sizeCheck;

  if (!req.body) {
    return NextResponse.json({ error: t("apiAuth.setup.emptyBody") }, { status: 400 });
  }

  const result = await processBackupImport(req.body, password, "setup");
  if (result.ok) await auditSetupImport(req, result, "setup");
  return importResultResponse(result, t, { chunked: false });
}
