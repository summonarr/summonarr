import { NextResponse } from "next/server";
import { withAdmin } from "@/lib/api-auth";
import { arrFailure, arrTitleGate, parseArrId } from "@/lib/arr-admin-http";
import { markHistoryFailed } from "@/lib/arr-title-data";
import { auditContext, logAudit } from "@/lib/audit";
import { readJsonCapped } from "@/lib/body-size";
import { translatorForRequest } from "@/lib/i18n/server-locale";

// Mark a grab failed (ADMIN) — Radarr/Sonarr's own "Mark as failed" on a
// history record: the release is blocklisted, its download handled as failed,
// and the arr searches again if its Redownload Failed setting is on.
//   POST { service, instance, arrId, historyId } — `arrId` is the record's
//   movie/series id. The record must be a GRAB of that title, as the arr's
//   history reads now (409 otherwise, nothing sent). Audited ARR_MARK_FAILED
//   after the arr accepted it (guardrail 26).
export const POST = withAdmin(async (req, _ctx, session) => {
  const t = translatorForRequest(req);
  const parsed = await readJsonCapped<Record<string, unknown>>(req, 16 * 1024);
  if (parsed instanceof NextResponse) return parsed;
  const body = parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
  const target = await arrTitleGate(body.service, body.instance, body.arrId, t);
  if (target instanceof NextResponse) return target;
  const historyId = parseArrId(body.historyId);
  if (historyId === null || typeof body.historyId !== "number") {
    return NextResponse.json({ error: t("apiAdmin.arr.idInvalid") }, { status: 400 });
  }
  let sourceTitle: string;
  try {
    sourceTitle = (await markHistoryFailed(target.service, target.instance, target.arrId, historyId)).sourceTitle;
  } catch (err) {
    return arrFailure(err, target, t, "mark failed");
  }
  void logAudit({
    userId: session.user.id,
    userName: session.user.name ?? session.user.email ?? null,
    action: "ARR_MARK_FAILED",
    target: `${target.service}:${target.instance}:${target.arrId}`,
    details: { service: target.service, instance: target.instance, arrId: target.arrId, historyId, release: sourceTitle },
    ...auditContext(req, session),
  });
  return NextResponse.json({ ok: true });
});
