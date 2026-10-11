import { NextResponse } from "next/server";
import { withAdmin } from "@/lib/api-auth";
import { arrErrorMessage } from "@/lib/arr";
import { arrFailure, arrTitleGate, parseIdArray } from "@/lib/arr-admin-http";
import { parseIdList } from "@/lib/arr-history";
import { deleteTitleFiles, loadTitleFiles } from "@/lib/arr-title-data";
import { auditContext, logAudit } from "@/lib/audit";
import { readJsonCapped } from "@/lib/body-size";
import { translatorForRequest } from "@/lib/i18n/server-locale";
import { sanitizeForLog } from "@/lib/sanitize";

const MAX_FILES = 10_000;

// Admin title manager, the title's files (ADMIN).
//   GET ?service&instance&id → { files }: every file Radarr/Sonarr has for the
//       title — path, size, quality, languages, custom formats, media info,
//       and (Sonarr) the episodes each holds.
//   DELETE ?service&instance&id + { fileIds } (or &fileIds=1,2) — delete those
//       files from disk through the arr. Every id must be one of the title's
//       files as the arr lists them now (409 otherwise, nothing deleted).
//       → { deleted }. Audited ARR_FILE_DELETE after the arr accepted it
//       (guardrail 26) — when Radarr stops part-way, the files it did delete
//       are audited and the answer is a 502 naming how many.
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
  // The ids ride in a JSON body ({ fileIds }) — "select all" on a long-running
  // series is well past what a query string holds; `?fileIds=1,2` still works
  // for a handful.
  let fileIds: number[] | null;
  if (q.has("fileIds")) {
    fileIds = parseIdList(q.get("fileIds"), 1_000);
  } else {
    const parsed = await readJsonCapped<Record<string, unknown>>(req, 256 * 1024);
    if (parsed instanceof NextResponse) return parsed;
    fileIds = parseIdArray(parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed.fileIds : null, MAX_FILES);
  }
  if (!fileIds) return NextResponse.json({ error: t("apiAdmin.arr.fileIdsInvalid") }, { status: 400 });
  let result;
  try {
    result = await deleteTitleFiles(target.service, target.instance, target.arrId, fileIds);
  } catch (err) {
    return arrFailure(err, target, t, "file delete");
  }
  const { deleted, error } = result;
  // What was deleted is audited even when a later delete failed (guardrail 26).
  void logAudit({
    userId: session.user.id,
    userName: session.user.name ?? session.user.email ?? null,
    action: "ARR_FILE_DELETE",
    target: `${target.service}:${target.instance}:${target.arrId}`,
    details: { service: target.service, instance: target.instance, arrId: target.arrId, fileIds: deleted, count: deleted.length },
    ...auditContext(req, session),
  });
  if (error) {
    console.warn(`[arr-admin] ${target.service} instance "${sanitizeForLog(target.instance)}" file delete stopped part-way:`, arrErrorMessage(error));
    return NextResponse.json(
      { error: t("apiAdmin.arr.partialDelete", { done: deleted.length, total: fileIds.length }), deleted: deleted.length },
      { status: 502 },
    );
  }
  return NextResponse.json({ deleted: deleted.length });
});
