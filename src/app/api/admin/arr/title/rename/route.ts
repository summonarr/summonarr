import { NextResponse } from "next/server";
import { withAdmin } from "@/lib/api-auth";
import { arrFailure, arrTitleGate, parseIdArray } from "@/lib/arr-admin-http";
import { loadRenamePreview, renameTitleFiles } from "@/lib/arr-title-data";
import { auditContext, logAudit } from "@/lib/audit";
import { readJsonCapped } from "@/lib/body-size";
import { translatorForRequest } from "@/lib/i18n/server-locale";

// Admin title manager, renaming files to the arr's naming scheme (ADMIN).
//   GET ?service&instance&id → { files: [{ fileId, existingPath, newPath, … }] }
//       — the arr's own preview: only files whose name would change.
//   POST { service, instance, id, fileIds } → 202 { files } — queues the
//       arr's RenameFiles for those files. The preview is re-read first; an
//       id it no longer lists is 409 and nothing is renamed. Audited
//       ARR_FILE_RENAME after the arr accepted it.
export const GET = withAdmin(async (req) => {
  const t = translatorForRequest(req);
  const q = req.nextUrl.searchParams;
  const target = await arrTitleGate(q.get("service"), q.get("instance"), q.get("id"), t);
  if (target instanceof NextResponse) return target;
  try {
    return NextResponse.json({ files: await loadRenamePreview(target.service, target.instance, target.arrId) });
  } catch (err) {
    return arrFailure(err, target, t, "rename preview");
  }
});

export const POST = withAdmin(async (req, _ctx, session) => {
  const t = translatorForRequest(req);
  const parsed = await readJsonCapped<Record<string, unknown>>(req, 64 * 1024);
  if (parsed instanceof NextResponse) return parsed;
  const body = parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
  const target = await arrTitleGate(body.service, body.instance, body.id, t);
  if (target instanceof NextResponse) return target;
  const fileIds = parseIdArray(body.fileIds, 2_000);
  if (!fileIds) return NextResponse.json({ error: t("apiAdmin.arr.fileIdsInvalid") }, { status: 400 });
  let files: number;
  try {
    files = await renameTitleFiles(target.service, target.instance, target.arrId, fileIds);
  } catch (err) {
    return arrFailure(err, target, t, "rename");
  }
  void logAudit({
    userId: session.user.id,
    userName: session.user.name ?? session.user.email ?? null,
    action: "ARR_FILE_RENAME",
    target: `${target.service}:${target.instance}:${target.arrId}`,
    details: { service: target.service, instance: target.instance, arrId: target.arrId, count: files },
    ...auditContext(req, session),
  });
  return NextResponse.json({ files }, { status: 202 });
});
