import { NextResponse } from "next/server";
import { withAdmin } from "@/lib/api-auth";
import { arrFailure, arrGate, arrTitleGate, parseArrId } from "@/lib/arr-admin-http";
import { editedFields, parseTitleEdit } from "@/lib/arr-title";
import { editTitle, findTitleId, loadTitle } from "@/lib/arr-title-data";
import { ARR_SERVICE_LABEL } from "@/lib/arr-admin";
import { auditContext, logAudit } from "@/lib/audit";
import { readJsonCapped } from "@/lib/body-size";
import { translatorForRequest } from "@/lib/i18n/server-locale";

// Admin title manager (ADMIN) — one movie or series on one Radarr/Sonarr
// instance, read and edited live.
//
//   GET ?service&instance&id     — by the arr's own id, or
//   GET ?service&instance&tmdbId — resolved on the instance (the detail pages).
//       → { title, qualityProfiles, rootFolders, tags }: the title's settings,
//         its seasons (Sonarr), and the instance's own choices for each field.
//         404 when the instance doesn't have the title.
//   PATCH { service, instance, id, …fields } — change any of: monitored,
//       qualityProfileId, rootFolderPath (+ moveFiles), tags (replace),
//       minimumAvailability (Radarr), seriesType / seasonFolder /
//       monitorNewItems / seasons [{seasonNumber, monitored}] (Sonarr).
//       Every value must be one the instance offers (400 otherwise, nothing
//       written). → { title } as the arr now has it. Audited ARR_TITLE_EDIT
//       after the arr accepted it (guardrail 26).
export const GET = withAdmin(async (req) => {
  const t = translatorForRequest(req);
  const q = req.nextUrl.searchParams;
  const target = await arrGate(q.get("service"), q.get("instance"), t);
  if (target instanceof NextResponse) return target;
  const id = parseArrId(q.get("id"));
  const tmdbId = parseArrId(q.get("tmdbId"));
  if ((id === null) === (tmdbId === null)) return NextResponse.json({ error: t("apiAdmin.arr.idInvalid") }, { status: 400 });
  try {
    const arrId = id ?? (await findTitleId(target.service, target.instance, tmdbId as number));
    if (arrId === null) {
      return NextResponse.json({ error: t("apiAdmin.arr.titleNotFound", { service: ARR_SERVICE_LABEL[target.service] }) }, { status: 404 });
    }
    return NextResponse.json(await loadTitle(target.service, target.instance, arrId));
  } catch (err) {
    return arrFailure(err, target, t, "title read");
  }
});

export const PATCH = withAdmin(async (req, _ctx, session) => {
  const t = translatorForRequest(req);
  const parsed = await readJsonCapped<Record<string, unknown>>(req, 64 * 1024);
  if (parsed instanceof NextResponse) return parsed;
  const body = parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
  const target = await arrTitleGate(body.service, body.instance, body.id, t);
  if (target instanceof NextResponse) return target;
  const edit = parseTitleEdit(target.service, body);
  if (!edit) return NextResponse.json({ error: t("apiAdmin.arr.editInvalid") }, { status: 400 });
  const fields = editedFields(edit);
  if (fields.length === 0) return NextResponse.json({ error: t("apiAdmin.arr.editEmpty") }, { status: 400 });
  let result;
  try {
    result = await editTitle(target.service, target.instance, target.arrId, edit);
  } catch (err) {
    return arrFailure(err, target, t, "title edit");
  }
  const { title, fields: applied } = result;
  // Only what was written upstream is audited; an edit that changed nothing wrote nothing.
  if (applied.length === 0) return NextResponse.json({ title });
  void logAudit({
    userId: session.user.id,
    userName: session.user.name ?? session.user.email ?? null,
    action: "ARR_TITLE_EDIT",
    target: `${target.service}:${target.instance}:${target.arrId}`,
    details: {
      service: target.service,
      instance: target.instance,
      arrId: target.arrId,
      title: title.title,
      fields: applied,
      ...(applied.includes("rootFolderPath") ? { rootFolderPath: edit.rootFolderPath, moveFiles: edit.moveFiles === true } : {}),
      ...(edit.seasons ? { seasons: edit.seasons } : {}),
    },
    ...auditContext(req, session),
  });
  return NextResponse.json({ title });
});
