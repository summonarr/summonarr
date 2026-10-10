import { NextResponse } from "next/server";
import { withAdmin } from "@/lib/api-auth";
import { isImportMode } from "@/lib/arr-queue";
import { importFromQueue, loadImportCandidates } from "@/lib/arr-queue-data";
import { IMPORT_MAX_BODY_BYTES, importFailure, importGate, parseImportSelections } from "@/lib/arr-queue-http";
import { auditContext, logAudit } from "@/lib/audit";
import { readJsonCapped } from "@/lib/body-size";
import { translatorForRequest } from "@/lib/i18n/server-locale";

// Admin → Download Queue, "Import" on a download Radarr/Sonarr would not
// import on its own (ADMIN) — the arr's own Manual Import.
//
//   GET  ?service&instance&downloadId → { files }: what the arr found in the
//        download, what each file matched to, and why it was refused.
//   GET also returns the instance's own qualities and languages, for the
//        dialog's per-file editor.
//   POST { service, instance, downloadId, files: [{ path, …corrections }],
//        importMode? } → queues the ManualImport command for the chosen files
//        ("auto" | "move" | "copy", default "auto"). Corrections: movieId
//        (Radarr), seriesId + episodeIds (Sonarr), qualityId, languageIds,
//        releaseGroup, releaseType (Sonarr) — ids only, each checked against
//        the instance's own catalogs (400 when it doesn't have one). The file
//        list is re-read from the arr and only its own rows are sent — a path
//        only SELECTS (guardrail 5d). The older `paths: string[]` body still
//        works (no corrections). 409 when none of the chosen files is
//        importable. Audited ARR_QUEUE_IMPORT after the arr accepted the
//        command (guardrail 26).

export const GET = withAdmin(async (req) => {
  const t = translatorForRequest(req);
  const params = req.nextUrl.searchParams;
  const target = await importGate(params.get("service"), params.get("instance"), params.get("downloadId"), t);
  if (target instanceof NextResponse) return target;
  try {
    return NextResponse.json(await loadImportCandidates(target.service, target.instance, target.downloadId));
  } catch (err) {
    return importFailure(err, target.service, target.instance, t, "import listing");
  }
});

export const POST = withAdmin(async (req, _ctx, session) => {
  const t = translatorForRequest(req);
  const parsed = await readJsonCapped<Record<string, unknown>>(req, IMPORT_MAX_BODY_BYTES);
  if (parsed instanceof NextResponse) return parsed;
  const body = parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
  const target = await importGate(body.service, body.instance, body.downloadId, t);
  if (target instanceof NextResponse) return target;
  const { service, instance, downloadId } = target;
  const selections = parseImportSelections(service, body);
  const importMode = body.importMode === undefined ? "auto" : body.importMode;
  if (!selections || !isImportMode(importMode)) {
    return NextResponse.json({ error: t("apiAdmin.queue.importBodyInvalid") }, { status: 400 });
  }
  let result;
  try {
    result = await importFromQueue(service, instance, downloadId, selections, importMode);
  } catch (err) {
    return importFailure(err, service, instance, t, "import");
  }
  // File paths are not recorded — the count, the mode and the download say
  // what happened; `corrected` counts files the admin re-matched or re-labelled.
  const corrected = [...selections.values()].filter((o) => Object.keys(o).length > 0).length;
  void logAudit({
    userId: session.user.id,
    userName: session.user.name ?? session.user.email ?? null,
    action: "ARR_QUEUE_IMPORT",
    target: `${service}:${instance}`,
    details: { service, instance, downloadId, files: result.files, importMode, ...(corrected > 0 ? { corrected } : {}) },
    ...auditContext(req, session),
  });
  return NextResponse.json(result, { status: 202 });
});
