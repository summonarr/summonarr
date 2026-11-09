import { NextResponse } from "next/server";
import { readJsonCapped } from "@/lib/body-size";
import { withAdmin } from "@/lib/api-auth";
import { logAudit, auditContext } from "@/lib/audit";
import { applySpecs } from "@/lib/trash";
import { parseTrashVariant } from "@/lib/trash-variant";
import { withAdvisoryLock, TRASH_SYNC_LOCK_ID } from "@/lib/advisory-lock";
import { checkRateLimit } from "@/lib/rate-limit";
import { tooManyRequests } from "@/lib/http";
import { isFeatureEnabled } from "@/lib/features";
import { translatorForRequest } from "@/lib/i18n/server-locale";
import { lockBusyResponse } from "@/lib/lock-http";

// Spec ids are short catalog keys; this bounds a pasted blob stored whole in the audit row.
const SPEC_ID_MAX_LEN = 200;

export const POST = withAdmin(async (req, _ctx, session) => {
  const t = translatorForRequest(req);
  // Kill-switch parity with the nightly cron: a disabled TRaSH integration must not
  // still rewrite Radarr/Sonarr custom formats and quality profiles.
  if (!(await isFeatureEnabled("trashGuidesEnabled"))) {
    return NextResponse.json({ error: t("apiAdmin.trash.disabled") }, { status: 403 });
  }
  // Per-admin rate limit. Applying specs bursts writes (custom formats + quality
  // profiles) at Radarr/Sonarr; 10 per 5-minute window caps a compromised session
  // while leaving headroom for an operator iterating on their profiles.
  if (!checkRateLimit(`admin-trash-apply:${session.user.id}`, 10, 5 * 60 * 1000)) {
    return tooManyRequests(5 * 60, t("apiAdmin.trash.tooManyApply"));
  }
  const parsed = await readJsonCapped<{ specIds?: unknown; variant?: unknown }>(req, 32768);
  if (parsed instanceof NextResponse) return parsed;
  const body = parsed;

  if (!Array.isArray(body.specIds) || body.specIds.some((v) => typeof v !== "string" || v.length > SPEC_ID_MAX_LEN)) {
    return NextResponse.json({ error: t("apiAdmin.trash.specIdsArray") }, { status: 400 });
  }
  // A repeated id would apply (and audit) the same spec twice in one run.
  const ids = [...new Set(body.specIds as string[])];
  const variant = parseTrashVariant(body.variant);
  if (variant === null) {
    return NextResponse.json({ error: t("apiAdmin.common.invalidInstance") }, { status: 400 });
  }
  if (ids.length === 0) {
    return NextResponse.json({ ok: true, results: [] });
  }
  if (ids.length > 500) {
    return NextResponse.json({ error: t("apiAdmin.trash.tooManySpecs") }, { status: 400 });
  }

  return withAdvisoryLock(
    TRASH_SYNC_LOCK_ID,
    // The lock's signal stops the apply between specs (guardrail 41).
    async (signal: AbortSignal) => {
      const startTime = Date.now();
      const results = await applySpecs(ids, variant, { signal });
      const durationMs = Date.now() - startTime;

      const failures = results.filter((r) => !r.ok);
      const recreated = results.filter((r) => r.recreated).length;
      await logAudit({
        userId: session.user.id,
        userName: session.user.name ?? session.user.email,
        ...auditContext(req, session),
        action: "SETTINGS_CHANGE",
        target: "trash:apply",
        details: {
          variant,
          count: results.length,
          failures: failures.length,
          ...(recreated > 0 ? { recreated } : {}),
          durationMs,
          specIds: ids,
        },
      });

      return NextResponse.json({
        ok: failures.length === 0,
        results,
        durationMs,
      });
    },
    () => lockBusyResponse(t("apiAdmin.trash.alreadyRunning")),
  );
});
