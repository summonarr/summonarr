import { NextResponse } from "next/server";
import { withAdmin } from "@/lib/api-auth";
import { ArrResponseError, arrErrorMessage } from "@/lib/arr";
import { grabPending, QueueInstanceError } from "@/lib/arr-queue-data";
import { serviceGate } from "@/lib/arr-queue-http";
import { auditContext, logAudit } from "@/lib/audit";
import { readJsonCapped } from "@/lib/body-size";
import { translatorForRequest } from "@/lib/i18n/server-locale";
import { sanitizeForLog } from "@/lib/sanitize";

const MAX_IDS = 500;

// Admin → Download Queue, "Grab now" on a release Radarr/Sonarr are HOLDING
// (a delay profile, an unavailable client, a fallback) — the arr's own Grab on
// a pending queue item, one bulk call. 409 when the release is no longer
// pending (grabbed or dropped meanwhile). Audited ARR_RELEASE_GRAB after the
// arr accepted it (guardrail 26).
export const POST = withAdmin(async (req, _ctx, session) => {
  const t = translatorForRequest(req);
  const parsed = await readJsonCapped<Record<string, unknown>>(req, 16 * 1024);
  if (parsed instanceof NextResponse) return parsed;
  const body = parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
  const target = await serviceGate(body.service, body.instance, t);
  if (target instanceof NextResponse) return target;
  const ids = body.ids;
  if (!Array.isArray(ids) || ids.length === 0 || ids.length > MAX_IDS || !ids.every((id) => typeof id === "number" && Number.isSafeInteger(id) && id > 0)) {
    return NextResponse.json({ error: t("apiAdmin.queue.grabBodyInvalid") }, { status: 400 });
  }
  const uniqueIds = [...new Set(ids as number[])];
  const label = target.service === "radarr" ? "Radarr" : "Sonarr";
  try {
    await grabPending(target.service, target.instance, uniqueIds);
  } catch (err) {
    if (err instanceof QueueInstanceError) {
      return NextResponse.json({ error: t("apiAdmin.missing.instanceUnknown", { service: label }) }, { status: 404 });
    }
    if (err instanceof ArrResponseError && err.status === 404) {
      return NextResponse.json({ error: t("apiAdmin.queue.notPending") }, { status: 409 });
    }
    console.warn(`[queue] ${target.service} instance "${sanitizeForLog(target.instance)}" grab failed:`, arrErrorMessage(err));
    return NextResponse.json({ error: t("apiAdmin.queue.grabFailed", { service: label }) }, { status: 502 });
  }
  void logAudit({
    userId: session.user.id,
    userName: session.user.name ?? session.user.email ?? null,
    action: "ARR_RELEASE_GRAB",
    target: `${target.service}:${target.instance}`,
    details: { service: target.service, instance: target.instance, ids: uniqueIds, source: "queue" },
    ...auditContext(req, session),
  });
  return NextResponse.json({ ok: true });
});
