import { NextResponse } from "next/server";
import { withAdmin } from "@/lib/api-auth";
import { snapshotted } from "@/lib/arr-snapshot";
import { arrErrorMessage } from "@/lib/arr";
import { arrFailure, arrTitleGate, parseIdArray, readWarnKey } from "@/lib/arr-admin-http";
import { parseIdList } from "@/lib/arr-history";
import { MAX_TITLE_FILE_IDS, TITLE_FILE_IDS_BODY_BYTES } from "@/lib/arr-title";
import { deleteTitleFiles, loadTitleFiles } from "@/lib/arr-title-data";
import { auditContext, logAudit } from "@/lib/audit";
import { readJsonCapped } from "@/lib/body-size";
import { forgetWarnOnChange } from "@/lib/log-dedup";
import { translatorForRequest } from "@/lib/i18n/server-locale";
import { answerOf, jobResponse, startArrJob } from "@/lib/release-search-jobs";
import { sanitizeForLog } from "@/lib/sanitize";

// Admin title manager, the title's files (ADMIN).
//   GET ?service&instance&id → { files }: every file Radarr/Sonarr has for the
//       title — path, size, quality, languages, custom formats, media info,
//       and (Sonarr) the episodes each holds.
//   DELETE ?service&instance&id + { fileIds } (or &fileIds=1,2) — delete those
//       files from disk through the arr. Every id must be one of the title's
//       files as the arr lists them now (409 otherwise, nothing deleted).
//       → { deleted }. Audited ARR_FILE_DELETE after the arr accepted it
//       (guardrail 26) — when a delete stops part-way (Radarr per file,
//       Sonarr's bulk delete, or a timeout), the files it did delete are
//       audited and the answer is a 502 naming how many.
//       With `async: true` in the body (the browser) the delete runs as a
//       BACKGROUND job (the guardrail-37a pattern, release-search-jobs.ts):
//       202 { job } at once. Each delete waits up to 120 s (a recycle bin on
//       another disk is a copy), past a reverse proxy's hold — the admin saw
//       "delete failed" while the arr finished it. The same owner deleting the
//       same files of the same title while one runs joins it. Without `async`
//       the delete answers inline (API callers).
//   GET ?job=<id> → that delete's poll: 202 { job, running } while it runs,
//       then the DELETE's own status and body; 404 once it's gone (expired, or
//       a restart — reload the files, never re-run it blindly).
const jobKey = (service: string, instance: string, arrId: number, fileIds: readonly number[]) =>
  `title-files\u0000${service}\u0000${instance}\u0000${arrId}\u0000${[...fileIds].sort((a, b) => a - b).join(",")}`;

// GET with `cached=1` → the last answer kept for this exact read, for display only
// (src/lib/arr-snapshot.ts); a job poll is never kept.
export const GET = withAdmin(snapshotted(async (req, _ctx, session) => {
  const t = translatorForRequest(req);
  const q = req.nextUrl.searchParams;
  const job = q.get("job");
  if (job !== null) return jobResponse(session.user.id, job, t, "apiAdmin.arr.filesJobGone");
  const target = await arrTitleGate(q.get("service"), q.get("instance"), q.get("id"), t);
  if (target instanceof NextResponse) return target;
  const warnKey = readWarnKey("title-files", target);
  try {
    const files = await loadTitleFiles(target.service, target.instance, target.arrId);
    forgetWarnOnChange(warnKey);
    return NextResponse.json({ files });
  } catch (err) {
    return arrFailure(err, target, t, "file listing", { warnKey });
  }
}));

export const DELETE = withAdmin(async (req, _ctx, session) => {
  const t = translatorForRequest(req);
  const q = req.nextUrl.searchParams;
  const target = await arrTitleGate(q.get("service"), q.get("instance"), q.get("id"), t);
  if (target instanceof NextResponse) return target;
  // The ids ride in a JSON body ({ fileIds }) — "select all" on a long-running
  // series is well past what a query string holds; `?fileIds=1,2` still works
  // for a handful.
  let fileIds: number[] | null;
  let background = false;
  if (q.has("fileIds")) {
    fileIds = parseIdList(q.get("fileIds"), 1_000);
  } else {
    const parsed = await readJsonCapped<Record<string, unknown>>(req, TITLE_FILE_IDS_BODY_BYTES);
    if (parsed instanceof NextResponse) return parsed;
    const body = parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : null;
    fileIds = parseIdArray(body ? body.fileIds : null, MAX_TITLE_FILE_IDS);
    background = body?.async === true;
  }
  if (!fileIds) return NextResponse.json({ error: t("apiAdmin.arr.fileIdsInvalid") }, { status: 400 });
  const ids = fileIds;
  // Read off the request now: a job outlives it.
  const audit = auditContext(req, session);
  const remove = async (): Promise<NextResponse> => {
    let result;
    try {
      result = await deleteTitleFiles(target.service, target.instance, target.arrId, ids);
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
      ...audit,
    });
    if (error) {
      console.warn(`[arr-admin] ${target.service} instance "${sanitizeForLog(target.instance)}" file delete stopped part-way:`, arrErrorMessage(error));
      return NextResponse.json(
        { error: t("apiAdmin.arr.partialDelete", { done: deleted.length, total: ids.length }), deleted: deleted.length },
        { status: 502 },
      );
    }
    return NextResponse.json({ deleted: deleted.length });
  };
  if (!background) return remove();
  // A running job for the same files joins it (startArrJob): nothing is sent twice.
  const { jobId } = startArrJob(session.user.id, jobKey(target.service, target.instance, target.arrId, ids), async () => answerOf(await remove()));
  return NextResponse.json({ job: jobId }, { status: 202 });
});
