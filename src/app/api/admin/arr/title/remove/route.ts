import { NextResponse, after } from "next/server";
import { withAdmin } from "@/lib/api-auth";
import { ARR_SERVICE_LABEL } from "@/lib/arr-admin";
import { arrFailure, arrTitleGate } from "@/lib/arr-admin-http";
import { RequestsActiveError, planTitleRemoval, removeTitle } from "@/lib/arr-title-lifecycle";
import { auditContext, logAudit } from "@/lib/audit";
import { readJsonCapped } from "@/lib/body-size";
import { translatorForRequest } from "@/lib/i18n/server-locale";
import { invalidateArrLibraryIndexCache } from "@/lib/library-cleanup-arr";
import { scheduleLibraryScan } from "@/lib/library-scan";
import { invalidateNeverWatchedReport } from "@/lib/never-watched-report";
import { checkRateLimit } from "@/lib/rate-limit";

const REMOVES_PER_MIN = 10;

// Admin title manager, "Remove from Radarr/Sonarr" (ADMIN) — one title off ONE
// instance (arr-title-lifecycle.ts has the rules; guardrail 14b's stamp).
//   POST { service, instance, id, deleteFiles, addImportExclusion } → DRY RUN:
//       { title, requests: { pending, approved, available } }. Nothing changes.
//   POST { …, execute: true, confirm: <id> } → removes it, both flags sent
//       explicitly. 409 { approved } while an APPROVED request on this instance
//       would make the sync put it straight back (nothing changed); 404 when
//       the instance doesn't have it. → { removed: true, alreadyGone,
//       requestsStamped }. Audited ARR_TITLE_DELETE after the arr accepted it.
export const POST = withAdmin(async (req, _ctx, session) => {
  const t = translatorForRequest(req);
  const parsed = await readJsonCapped<Record<string, unknown>>(req, 4 * 1024);
  if (parsed instanceof NextResponse) return parsed;
  const body = parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
  const target = await arrTitleGate(body.service, body.instance, body.id, t);
  if (target instanceof NextResponse) return target;
  if (typeof body.deleteFiles !== "boolean" || typeof body.addImportExclusion !== "boolean") {
    return NextResponse.json({ error: t("apiAdmin.arr.removeInvalid") }, { status: 400 });
  }
  const opts = { deleteFiles: body.deleteFiles, addImportExclusion: body.addImportExclusion };
  const service = ARR_SERVICE_LABEL[target.service];

  if (body.execute !== true) {
    try {
      const plan = await planTitleRemoval(target.service, target.instance, target.arrId);
      if (!plan) return NextResponse.json({ error: t("apiAdmin.arr.titleNotFound", { service }) }, { status: 404 });
      return NextResponse.json(plan);
    } catch (err) {
      return arrFailure(err, target, t, "removal plan");
    }
  }

  // The execute echoes the id it was shown — a removal is never one blind click.
  if (body.confirm !== target.arrId) return NextResponse.json({ error: t("apiAdmin.arr.removeConfirm") }, { status: 400 });
  if (!checkRateLimit(`arr-title-remove:${session.user.id}`, REMOVES_PER_MIN, 60_000)) {
    return NextResponse.json({ error: t("apiUser.common.tooManyRequestsLater") }, { status: 429 });
  }
  let result;
  try {
    result = await removeTitle(target.service, target.instance, target.arrId, opts);
  } catch (err) {
    if (err instanceof RequestsActiveError) {
      return NextResponse.json({ error: t("apiAdmin.arr.removeRequestsActive", { count: err.approved, service }), approved: err.approved }, { status: 409 });
    }
    return arrFailure(err, target, t, "title removal");
  }
  if (!result) return NextResponse.json({ error: t("apiAdmin.arr.titleNotFound", { service }) }, { status: 404 });
  invalidateArrLibraryIndexCache();
  invalidateNeverWatchedReport();
  // Deleted files leave the media servers only once they rescan.
  if (opts.deleteFiles && !result.alreadyGone) after(() => scheduleLibraryScan(target.service === "radarr" ? "movie" : "tv"));
  void logAudit({
    userId: session.user.id,
    userName: session.user.name ?? session.user.email ?? null,
    action: "ARR_TITLE_DELETE",
    target: `${target.service}:${target.instance}:${target.arrId}`,
    details: {
      service: target.service,
      instance: target.instance,
      arrId: target.arrId,
      tmdbId: result.title.tmdbId,
      title: result.title.title,
      deleteFiles: opts.deleteFiles,
      addImportExclusion: opts.addImportExclusion,
      sizeOnDisk: result.title.sizeOnDisk,
      alreadyGone: result.alreadyGone,
      requestsStamped: result.requestsStamped,
    },
    ...auditContext(req, session),
  });
  return NextResponse.json({ removed: true, alreadyGone: result.alreadyGone, requestsStamped: result.requestsStamped });
});
