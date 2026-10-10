import { NextResponse } from "next/server";
import { withAdmin } from "@/lib/api-auth";
import { ArrResponseError, arrErrorMessage } from "@/lib/arr";
import { isQueueRemoveAction } from "@/lib/arr-queue";
import { parseQueueService, QueueInstanceError, removeFromQueue } from "@/lib/arr-queue-data";
import { auditContext, logAudit } from "@/lib/audit";
import { readJsonCapped } from "@/lib/body-size";
import { isFeatureEnabled } from "@/lib/features";
import { translatorForRequest } from "@/lib/i18n/server-locale";
import { sanitizeForLog } from "@/lib/sanitize";

const MAX_BODY_BYTES = 64 * 1024;
// A Sonarr pack is one queue record per episode, and a complete-series pack of
// a long-running anime or daily show runs into the thousands. It all goes in
// ONE bulk call (guardrail 5c); the bound only keeps a body from being absurd.
const MAX_IDS = 5_000;
const SERVICE_LABEL = { radarr: "Radarr", sonarr: "Sonarr" } as const;

// Admin → Download Queue, one row's Remove (ADMIN). Sends Radarr/Sonarr's own
// bulk queue DELETE for every record id of the download, on that instance:
//   action "remove"          — drop it from the queue (no blocklist)
//   action "blocklist"       — remove and blocklist the release
//   action "blocklistSearch" — remove, blocklist, and let the arr search for a
//                              replacement (its "redownload failed" behaviour)
// `removeFromClient` (default true) also deletes it from the download client.
// The instance must be a configured one. Audited after the arr accepted it
// (guardrail 26 — the swallowing logAudit, the DELETE has already happened).
export const POST = withAdmin(async (req, _ctx, session) => {
  const t = translatorForRequest(req);
  const parsed = await readJsonCapped<Record<string, unknown>>(req, MAX_BODY_BYTES);
  if (parsed instanceof NextResponse) return parsed;
  const body = parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
  const service = parseQueueService(body.service);
  const instance = body.instance === undefined ? "" : body.instance;
  const ids = body.ids;
  const action = body.action;
  const removeFromClient = body.removeFromClient === undefined ? true : body.removeFromClient;
  if (
    !service ||
    typeof instance !== "string" || instance.length > 100 ||
    !Array.isArray(ids) || ids.length === 0 || ids.length > MAX_IDS ||
    !ids.every((id) => typeof id === "number" && Number.isSafeInteger(id) && id > 0) ||
    !isQueueRemoveAction(action) ||
    typeof removeFromClient !== "boolean"
  ) {
    return NextResponse.json({ error: t("apiAdmin.queue.removeBodyInvalid") }, { status: 400 });
  }
  const label = SERVICE_LABEL[service];
  if (!(await isFeatureEnabled(`feature.integration.${service}`))) {
    return NextResponse.json({ error: t("apiAdmin.missing.integrationDisabled", { service: label }) }, { status: 404 });
  }
  const uniqueIds = [...new Set(ids as number[])];
  try {
    await removeFromQueue(service, instance, uniqueIds, action, removeFromClient);
  } catch (err) {
    if (err instanceof QueueInstanceError) {
      return NextResponse.json({ error: t("apiAdmin.missing.instanceUnknown", { service: label }) }, { status: 404 });
    }
    if (err instanceof ArrResponseError && err.status === 404) {
      return NextResponse.json({ error: t("apiAdmin.queue.gone") }, { status: 409 });
    }
    console.warn(`[queue] ${service} instance "${sanitizeForLog(instance)}" remove failed:`, arrErrorMessage(err));
    return NextResponse.json({ error: t("apiAdmin.queue.removeFailed", { service: label }) }, { status: 502 });
  }
  void logAudit({
    userId: session.user.id,
    userName: session.user.name ?? session.user.email ?? null,
    action: "ARR_QUEUE_REMOVE",
    target: `${service}:${instance}`,
    details: { service, instance, ids: uniqueIds, action, removeFromClient },
    ...auditContext(req, session),
  });
  return NextResponse.json({ ok: true });
});
