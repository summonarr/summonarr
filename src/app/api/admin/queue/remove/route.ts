import { NextResponse } from "next/server";
import { withAdmin } from "@/lib/api-auth";
import { isQueueRemoveAction, isQueueRemoveMethod, type QueueRemoveMethod } from "@/lib/arr-queue";
import { removeFromQueue } from "@/lib/arr-queue-data";
import { queueActionFailure, serviceGate } from "@/lib/arr-queue-http";
import { auditContext, logAudit } from "@/lib/audit";
import { readJsonCapped } from "@/lib/body-size";
import { translatorForRequest } from "@/lib/i18n/server-locale";

const MAX_BODY_BYTES = 64 * 1024;
// The page sends ONE record id per download (`removalIds` — any record of a
// Sonarr pack resolves the whole download). An API caller may still send
// several; they name downloads, and a fresh queue read selects ONE live id
// per matched download in ONE bulk call (guardrail 5c / 5e). The bound only
// keeps a body from being absurd.
const MAX_IDS = 5_000;

// Admin → Download Queue, one row's Remove (ADMIN). Sends Radarr/Sonarr's own
// bulk queue DELETE for the record id(s) it is given, on that instance —
// both halves of the arr's own "Remove from queue" dialog:
//   action "remove"          — drop it from the queue (no blocklist)
//   action "blocklist"       — remove and blocklist the release
//   action "blocklistSearch" — remove, blocklist, and let the arr search for a
//                              replacement (its "redownload failed" behaviour)
//   method "removeFromClient" (default) — delete it from the download client
//   method "changeCategory"  — move it to the client's post-import category
//   method "ignore"          — leave it in the client; the arr stops tracking it
// The older `removeFromClient: boolean` body is still read when `method` is absent.
// An absent or null instance is the default one, as on grab (serviceGate).
// The instance must be a configured one. Audited after the arr accepted it
// (guardrail 26 — the swallowing logAudit, the DELETE has already happened).
export const POST = withAdmin(async (req, _ctx, session) => {
  const t = translatorForRequest(req);
  const body = await readJsonCapped<Record<string, unknown>>(req, MAX_BODY_BYTES);
  if (body instanceof NextResponse) return body;
  const target = await serviceGate(body.service, body.instance, t, "apiAdmin.queue.removeBodyInvalid");
  if (target instanceof NextResponse) return target;
  const { service, instance } = target;
  const ids = body.ids;
  const action = body.action;
  const legacy = body.removeFromClient;
  const method: unknown = body.method !== undefined
    ? body.method
    : legacy === undefined || legacy === true ? "removeFromClient" : legacy === false ? "ignore" : null;
  if (
    !Array.isArray(ids) || ids.length === 0 || ids.length > MAX_IDS ||
    !ids.every((id) => typeof id === "number" && Number.isSafeInteger(id) && id > 0) ||
    !isQueueRemoveAction(action) ||
    !isQueueRemoveMethod(method)
  ) {
    return NextResponse.json({ error: t("apiAdmin.queue.removeBodyInvalid") }, { status: 400 });
  }
  const uniqueIds = [...new Set(ids as number[])];
  let sentIds: number[];
  try {
    sentIds = await removeFromQueue(service, instance, uniqueIds, action, method as QueueRemoveMethod);
  } catch (err) {
    return queueActionFailure(err, target, t, { goneKey: "apiAdmin.queue.gone", failedKey: "apiAdmin.queue.removeFailed", what: "remove" });
  }
  void logAudit({
    userId: session.user.id,
    userName: session.user.name ?? session.user.email ?? null,
    action: "ARR_QUEUE_REMOVE",
    target: `${service}:${instance}`,
    details: { service, instance, ids: sentIds, action, method },
    ...auditContext(req, session),
  });
  return NextResponse.json({ ok: true });
});
