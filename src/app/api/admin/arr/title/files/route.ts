import { NextResponse } from "next/server";
import { withAdmin } from "@/lib/api-auth";
import { arrFailure, arrTitleGate } from "@/lib/arr-admin-http";
import { parseIdList } from "@/lib/arr-history";
import { deleteTitleFiles, loadTitleFiles } from "@/lib/arr-title-data";
import { auditContext, logAudit } from "@/lib/audit";
import { translatorForRequest } from "@/lib/i18n/server-locale";

// Admin title manager, the title's files (ADMIN).
//   GET ?service&instance&id → { files }: every file Radarr/Sonarr has for the
//       title — path, size, quality, languages, custom formats, media info,
//       and (Sonarr) the episodes each holds.
//   DELETE ?service&instance&id&fileIds=1,2 — delete those files from disk
//       through the arr. Every id must be one of the title's files as the arr
//       lists them now (409 otherwise, nothing deleted). Audited
//       ARR_FILE_DELETE after the arr accepted it (guardrail 26).
export const GET = withAdmin(async (req) => {
  const t = translatorForRequest(req);
  const q = req.nextUrl.searchParams;
  const target = await arrTitleGate(q.get("service"), q.get("instance"), q.get("id"), t);
  if (target instanceof NextResponse) return target;
  try {
    return NextResponse.json({ files: await loadTitleFiles(target.service, target.instance, target.arrId) });
  } catch (err) {
    return arrFailure(err, target, t, "file listing");
  }
});

export const DELETE = withAdmin(async (req, _ctx, session) => {
  const t = translatorForRequest(req);
  const q = req.nextUrl.searchParams;
  const target = await arrTitleGate(q.get("service"), q.get("instance"), q.get("id"), t);
  if (target instanceof NextResponse) return target;
  const fileIds = parseIdList(q.get("fileIds"), 1_000);
  if (!fileIds) return NextResponse.json({ error: t("apiAdmin.arr.fileIdsInvalid") }, { status: 400 });
  let deleted: number;
  try {
    deleted = await deleteTitleFiles(target.service, target.instance, target.arrId, fileIds);
  } catch (err) {
    return arrFailure(err, target, t, "file delete");
  }
  void logAudit({
    userId: session.user.id,
    userName: session.user.name ?? session.user.email ?? null,
    action: "ARR_FILE_DELETE",
    target: `${target.service}:${target.instance}:${target.arrId}`,
    details: { service: target.service, instance: target.instance, arrId: target.arrId, fileIds, count: deleted },
    ...auditContext(req, session),
  });
  return NextResponse.json({ deleted });
});
