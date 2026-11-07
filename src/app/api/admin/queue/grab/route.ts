import { NextResponse } from "next/server";
import { withAdmin } from "@/lib/api-auth";
import { grabPending } from "@/lib/arr-queue-data";
import { queueActionFailure, serviceGate } from "@/lib/arr-queue-http";
import { auditContext, logAudit } from "@/lib/audit";
import { readJsonCapped } from "@/lib/body-size";
import { translatorForRequest } from "@/lib/i18n/server-locale";

const MAX_IDS = 500;

// Admin → Download Queue, "Grab now" on a release Radarr/Sonarr are HOLDING
// (a delay profile, an unavailable client, a fallback) — the arr's own Grab on
// a pending queue item, one bulk call. Posted ids NAME live pending records
// (guardrail 5e); a downloading or vanished id is dropped. 409 when nothing
// posted is still pending. Audited ARR_RELEASE_GRAB after the arr accepted it
// (guardrail 26), with the ids SENT.
export const POST = withAdmin(async (req, _ctx, session) => {
  const t = translatorForRequest(req);
  const body = await readJsonCapped<Record<string, unknown>>(req, 16 * 1024);
  if (body instanceof NextResponse) return body;
  const target = await serviceGate(body.service, body.instance, t);
  if (target instanceof NextResponse) return target;
  const ids = body.ids;
  if (!Array.isArray(ids) || ids.length === 0 || ids.length > MAX_IDS || !ids.every((id) => typeof id === "number" && Number.isSafeInteger(id) && id > 0)) {
    return NextResponse.json({ error: t("apiAdmin.queue.grabBodyInvalid") }, { status: 400 });
  }
  const uniqueIds = [...new Set(ids as number[])];
  let sentIds: number[];
  try {
    sentIds = await grabPending(target.service, target.instance, uniqueIds);
  } catch (err) {
    return queueActionFailure(err, target, t, { goneKey: "apiAdmin.queue.notPending", failedKey: "apiAdmin.queue.grabFailed", what: "grab" });
  }
  void logAudit({
    userId: session.user.id,
    userName: session.user.name ?? session.user.email ?? null,
    action: "ARR_RELEASE_GRAB",
    target: `${target.service}:${target.instance}`,
    details: { service: target.service, instance: target.instance, ids: sentIds, source: "queue" },
    ...auditContext(req, session),
  });
  return NextResponse.json({ ok: true });
});
