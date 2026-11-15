// Shared request plumbing for the Download Queue's routes: the front doors
// (service, instance, download id, integration on), the file-selection body,
// and the error → response mappings for the import routes and for the queue
// actions (grab, remove). Route files may only export handlers, so it lives
// here.
import { NextResponse } from "next/server";
import { ArrResponseError, arrErrorMessage } from "./arr";
import { ImportOverrideError, isDownloadId, parseImportSelection, type ImportOverride } from "./arr-queue";
import { MAX_CATALOG_TITLES, NothingToImportError, parseQueueService, QueueGoneError, QueueInstanceError } from "./arr-queue-data";
import { isFeatureEnabled } from "./features";
import type { Translator } from "./i18n/translate";
import { sanitizeForLog } from "./sanitize";
import { QUEUE_IMPORT_MAX_FILES } from "./api-body-limits";

// A whole-series pack can hold hundreds of files; paths are long.
export const IMPORT_MAX_BODY_BYTES = 512 * 1024;
const MAX_FILES = QUEUE_IMPORT_MAX_FILES;
const SERVICE_LABEL = { radarr: "Radarr", sonarr: "Sonarr" } as const;

export type ServiceTarget = { service: "radarr" | "sonarr"; instance: string };
/** An import route's target. (arr-queue-data's ImportTarget is a re-match choice — a different thing.) */
export type ImportGateTarget = ServiceTarget & { downloadId: string };

// The service and instance, shape only (an absent or null instance is the
// default one); null when malformed.
function parseServiceTarget(rawService: unknown, rawInstance: unknown): ServiceTarget | null {
  const service = parseQueueService(rawService);
  const instance = rawInstance === undefined || rawInstance === null ? "" : rawInstance;
  return service && typeof instance === "string" && instance.length <= 100 ? { service, instance } : null;
}

async function integrationOff(service: ServiceTarget["service"], t: Translator): Promise<NextResponse | null> {
  if (await isFeatureEnabled(`feature.integration.${service}`)) return null;
  return NextResponse.json({ error: t("apiAdmin.missing.integrationDisabled", { service: SERVICE_LABEL[service] }) }, { status: 404 });
}

// The import routes' front door: a well-formed target on an enabled
// integration, or the response refusing it — malformed (400) before switched off (404).
export async function importGate(rawService: unknown, rawInstance: unknown, rawDownloadId: unknown, t: Translator): Promise<ImportGateTarget | NextResponse> {
  const target = parseServiceTarget(rawService, rawInstance);
  if (!target || !isDownloadId(rawDownloadId)) {
    return NextResponse.json({ error: t("apiAdmin.queue.importParamsInvalid") }, { status: 400 });
  }
  return (await integrationOff(target.service, t)) ?? { ...target, downloadId: rawDownloadId };
}

/**
 * The front door for the routes that need no download id (grab, remove, the
 * pickers). `invalidKey` is the route's own 400 message, so a route whose
 * body has more to it names the whole body.
 */
export async function serviceGate(
  rawService: unknown,
  rawInstance: unknown,
  t: Translator,
  invalidKey = "apiAdmin.queue.serviceParamsInvalid",
): Promise<ServiceTarget | NextResponse> {
  const target = parseServiceTarget(rawService, rawInstance);
  if (!target) return NextResponse.json({ error: t(invalidKey) }, { status: 400 });
  return (await integrationOff(target.service, t)) ?? target;
}

/**
 * The body's file selection: `files` (with corrections) or the older bare
 * `paths`. A Map from path to its corrections, or null when malformed.
 */
export function parseImportSelections(service: "radarr" | "sonarr", body: Record<string, unknown>): Map<string, ImportOverride> | null {
  const list = body.files !== undefined ? body.files : body.paths;
  if (!Array.isArray(list) || list.length === 0 || list.length > MAX_FILES) return null;
  const out = new Map<string, ImportOverride>();
  for (const item of list) {
    const parsed = parseImportSelection(service, typeof item === "string" ? { path: item } : item);
    if (!parsed || out.has(parsed.path)) return null;
    out.set(parsed.path, parsed.override);
  }
  return out;
}

export function importFailure(err: unknown, service: "radarr" | "sonarr", instance: string, t: Translator, what: string): NextResponse {
  const label = SERVICE_LABEL[service];
  if (err instanceof ImportOverrideError) {
    return NextResponse.json({ error: t(`apiAdmin.queue.override.${err.field}`, { service: label, max: MAX_CATALOG_TITLES }) }, { status: 400 });
  }
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

/**
 * A queue action's (grab, remove) failure: an unknown instance is 404, nothing
 * posted still live (or the arr's own 404) is 409 with the route's `goneKey`,
 * anything else is logged and 502 with its `failedKey`. Nothing is audited.
 */
export function queueActionFailure(
  err: unknown,
  target: ServiceTarget,
  t: Translator,
  opts: { goneKey: string; failedKey: string; what: string },
): NextResponse {
  const label = SERVICE_LABEL[target.service];
  if (err instanceof QueueInstanceError) {
    return NextResponse.json({ error: t("apiAdmin.missing.instanceUnknown", { service: label }) }, { status: 404 });
  }
  if (err instanceof QueueGoneError || (err instanceof ArrResponseError && err.status === 404)) {
    return NextResponse.json({ error: t(opts.goneKey) }, { status: 409 });
  }
  console.warn(`[queue] ${target.service} instance "${sanitizeForLog(target.instance)}" ${opts.what} failed:`, arrErrorMessage(err));
  return NextResponse.json({ error: t(opts.failedKey, { service: label }) }, { status: 502 });
}
