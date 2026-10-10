import { NextResponse } from "next/server";
import { withAdmin } from "@/lib/api-auth";
import { ArrResponseError, arrErrorMessage } from "@/lib/arr";
import { isDownloadId, isImportMode } from "@/lib/arr-queue";
import {
  importFromQueue,
  loadImportCandidates,
  NothingToImportError,
  parseQueueService,
  QueueInstanceError,
} from "@/lib/arr-queue-data";
import { auditContext, logAudit } from "@/lib/audit";
import { readJsonCapped } from "@/lib/body-size";
import { isFeatureEnabled } from "@/lib/features";
import { translatorForRequest } from "@/lib/i18n/server-locale";
import type { Translator } from "@/lib/i18n/translate";
import { sanitizeForLog } from "@/lib/sanitize";

// A whole-series pack can hold hundreds of files; paths are long.
const MAX_BODY_BYTES = 512 * 1024;
const MAX_FILES = 2_000;
const MAX_PATH = 4_096;
const SERVICE_LABEL = { radarr: "Radarr", sonarr: "Sonarr" } as const;

// Admin → Download Queue, "Import" on a download Radarr/Sonarr would not
// import on its own (ADMIN) — the arr's own Manual Import.
//
//   GET  ?service&instance&downloadId → { files }: what the arr found in the
//        download, what each file matched to, and why it was refused.
//   POST { service, instance, downloadId, paths, importMode? } → queues the
//        ManualImport command for the chosen files ("auto" | "move" | "copy",
//        default "auto"). The file list is re-read from the arr and only its
//        own mapped rows are sent — `paths` only SELECTS (guardrail 5d). 409
//        when none of them is importable any more. Audited ARR_QUEUE_IMPORT
//        after the arr accepted the command (guardrail 26).

type Target = { service: "radarr" | "sonarr"; instance: string; downloadId: string };

// The shared front door: a well-formed target on an enabled integration, or the response refusing it.
async function gate(rawService: unknown, rawInstance: unknown, rawDownloadId: unknown, t: Translator): Promise<Target | NextResponse> {
  const service = parseQueueService(rawService);
  const instance = rawInstance === undefined || rawInstance === null ? "" : rawInstance;
  if (!service || typeof instance !== "string" || instance.length > 100 || !isDownloadId(rawDownloadId)) {
    return NextResponse.json({ error: t("apiAdmin.queue.importParamsInvalid") }, { status: 400 });
  }
  if (!(await isFeatureEnabled(`feature.integration.${service}`))) {
    return NextResponse.json({ error: t("apiAdmin.missing.integrationDisabled", { service: SERVICE_LABEL[service] }) }, { status: 404 });
  }
  return { service, instance, downloadId: rawDownloadId };
}

function failure(err: unknown, service: "radarr" | "sonarr", instance: string, t: Translator, what: string): NextResponse {
  const label = SERVICE_LABEL[service];
  if (err instanceof QueueInstanceError) {
    return NextResponse.json({ error: t("apiAdmin.missing.instanceUnknown", { service: label }) }, { status: 404 });
  }
  if (err instanceof NothingToImportError) {
    return NextResponse.json({ error: t("apiAdmin.queue.nothingToImport") }, { status: 409 });
  }
  if (err instanceof ArrResponseError && err.status === 404) {
    return NextResponse.json({ error: t("apiAdmin.queue.gone") }, { status: 409 });
  }
  console.warn(`[queue] ${service} instance "${sanitizeForLog(instance)}" ${what} failed:`, arrErrorMessage(err));
  return NextResponse.json({ error: t("apiAdmin.queue.importFailed", { service: label }) }, { status: 502 });
}

export const GET = withAdmin(async (req) => {
  const t = translatorForRequest(req);
  const params = req.nextUrl.searchParams;
  const target = await gate(params.get("service"), params.get("instance"), params.get("downloadId"), t);
  if (target instanceof NextResponse) return target;
  try {
    return NextResponse.json({ files: await loadImportCandidates(target.service, target.instance, target.downloadId) });
  } catch (err) {
    return failure(err, target.service, target.instance, t, "import listing");
  }
});

export const POST = withAdmin(async (req, _ctx, session) => {
  const t = translatorForRequest(req);
  const parsed = await readJsonCapped<Record<string, unknown>>(req, MAX_BODY_BYTES);
  if (parsed instanceof NextResponse) return parsed;
  const body = parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
  const target = await gate(body.service, body.instance, body.downloadId, t);
  if (target instanceof NextResponse) return target;
  const { service, instance, downloadId } = target;
  const paths = body.paths;
  const importMode = body.importMode === undefined ? "auto" : body.importMode;
  if (
    !Array.isArray(paths) || paths.length === 0 || paths.length > MAX_FILES ||
    !paths.every((p) => typeof p === "string" && p.length > 0 && p.length <= MAX_PATH) ||
    !isImportMode(importMode)
  ) {
    return NextResponse.json({ error: t("apiAdmin.queue.importBodyInvalid") }, { status: 400 });
  }
  let result;
  try {
    result = await importFromQueue(service, instance, downloadId, paths as string[], importMode);
  } catch (err) {
    return failure(err, service, instance, t, "import");
  }
  // File paths are not recorded — the count, the mode and the download say what happened.
  void logAudit({
    userId: session.user.id,
    userName: session.user.name ?? session.user.email ?? null,
    action: "ARR_QUEUE_IMPORT",
    target: `${service}:${instance}`,
    details: { service, instance, downloadId, files: result.files, importMode },
    ...auditContext(req, session),
  });
  return NextResponse.json(result, { status: 202 });
});
