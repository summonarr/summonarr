import { NextResponse } from "next/server";
import { readJsonCapped } from "@/lib/body-size";
import { withAdmin } from "@/lib/api-auth";
import { logAudit, auditContext } from "@/lib/audit";
import { applySpecs } from "@/lib/trash";
import { isValidInstanceSlug } from "@/lib/arr-instances";
import type { ArrVariant } from "@/lib/arr";
import { withAdvisoryLock, TRASH_SYNC_LOCK_ID } from "@/lib/advisory-lock";
import { checkRateLimit } from "@/lib/rate-limit";
import { isFeatureEnabled } from "@/lib/features";
import { translatorForRequest } from "@/lib/i18n/server-locale";
import type { Translator } from "@/lib/i18n/translate";

function busyResponse(t: Translator) {
  return NextResponse.json(
    { ok: false, error: t("apiAdmin.trash.alreadyRunning"), retryAfter: 30 },
    { status: 409, headers: { "Retry-After": "30" } },
  );
}

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
    return NextResponse.json({ error: t("apiAdmin.trash.tooManyApply") }, { status: 429 });
  }
  const parsed = await readJsonCapped<{ specIds?: unknown; variant?: unknown }>(req, 32768);
  if (parsed instanceof NextResponse) return parsed;
  const body = parsed;

  if (!Array.isArray(body.specIds) || body.specIds.some((v) => typeof v !== "string")) {
    return NextResponse.json({ error: t("apiAdmin.trash.specIdsArray") }, { status: 400 });
  }
  const ids = body.specIds as string[];
  // body.variant is an instance slug ("" default, "4k", named); "hd" is the
  // legacy default spelling. An invalid slug is rejected rather than silently
  // routed to the default so a UI bug can't rewrite the wrong instance.
  const rawVariant = typeof body.variant === "string" ? body.variant.trim() : "";
  const variant: ArrVariant = rawVariant === "hd" ? "" : rawVariant;
  if (!isValidInstanceSlug(variant)) {
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
    async () => {
      const startTime = Date.now();
      const results = await applySpecs(ids, variant);
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
    () => busyResponse(t),
  );
});
