import { NextResponse } from "next/server";
import { tooManyRequests } from "@/lib/http";
import { withAdmin } from "@/lib/api-auth";
import { arrFailure, arrTitleGate, parseIdArray } from "@/lib/arr-admin-http";
import { MAX_TITLE_FILE_IDS, TITLE_FILE_IDS_BODY_BYTES } from "@/lib/arr-title";
import { loadRenamePreview, renameTitleFiles } from "@/lib/arr-title-data";
import { auditActor, logAudit } from "@/lib/audit";
import { readJsonCapped } from "@/lib/body-size";
import { translatorForRequest } from "@/lib/i18n/server-locale";
import { checkRateLimit } from "@/lib/rate-limit";

// Each rename queues a RenameFiles command: the same budget as Arr System's
// task runs (10/min per admin, 429 with Retry-After past it).
const LIMIT_PER_MIN = 10;

// Admin title manager, renaming files to the arr's naming scheme (ADMIN).
//   GET ?service&instance&id → { files: [{ fileId, existingPath, newPath, … }] }
//       — the arr's own preview: only files whose name would change.
//   POST { service, instance, id, fileIds } → 202 { files, commandIds } —
//       queues the arr's RenameFiles for those files; `commandIds` is the
//       arr's id for it (the page follows it, then re-reads the files). The
//       preview is re-read first; an id it no longer lists is 409 and nothing
//       is renamed. Audited ARR_FILE_RENAME after the arr accepted it.
//       429 past LIMIT_PER_MIN (checked after the body, so a malformed one
//       spends nothing).
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
  // The preview pre-ticks every file it lists, so the cap is the delete's: a
  // long daily show after a naming-scheme change lists thousands.
  const body = await readJsonCapped<Record<string, unknown>>(req, TITLE_FILE_IDS_BODY_BYTES);
  if (body instanceof NextResponse) return body;
  const target = await arrTitleGate(body.service, body.instance, body.id, t);
  if (target instanceof NextResponse) return target;
  const fileIds = parseIdArray(body.fileIds, MAX_TITLE_FILE_IDS);
  if (!fileIds) return NextResponse.json({ error: t("apiAdmin.arr.fileIdsInvalid") }, { status: 400 });
  if (!checkRateLimit(`arr-title-rename:${session.user.id}`, LIMIT_PER_MIN, 60_000)) {
    return tooManyRequests(60, t("apiAdmin.common.tooManyRequestsLater"));
  }
  let renamed: { files: number; commandIds: number[] };
  try {
    renamed = await renameTitleFiles(target.service, target.instance, target.arrId, fileIds);
  } catch (err) {
    return arrFailure(err, target, t, "rename");
  }
  const { files, commandIds } = renamed;
  void logAudit({
    ...auditActor(req, session),
    action: "ARR_FILE_RENAME",
    target: `${target.service}:${target.instance}:${target.arrId}`,
    details: { service: target.service, instance: target.instance, arrId: target.arrId, count: files },
  });
  return NextResponse.json({ files, commandIds }, { status: 202 });
});
