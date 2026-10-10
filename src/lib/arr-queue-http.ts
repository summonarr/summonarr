// Shared request plumbing for the Download Queue's import routes
// (/api/admin/queue/import, …/preview, …/targets, …/episodes): the front door
// (service, instance, download id, integration on), the file-selection body,
// and the error → response mapping. Route files may only export handlers, so
// it lives here.
import { NextResponse } from "next/server";
import { ArrResponseError, arrErrorMessage } from "./arr";
import { ImportOverrideError, isDownloadId, parseImportSelection, type ImportOverride } from "./arr-queue";
import { NothingToImportError, parseQueueService, QueueInstanceError } from "./arr-queue-data";
import { isFeatureEnabled } from "./features";
import type { Translator } from "./i18n/translate";
import { sanitizeForLog } from "./sanitize";

// A whole-series pack can hold hundreds of files; paths are long.
export const IMPORT_MAX_BODY_BYTES = 512 * 1024;
const MAX_FILES = 2_000;
const SERVICE_LABEL = { radarr: "Radarr", sonarr: "Sonarr" } as const;

export type ImportTarget = { service: "radarr" | "sonarr"; instance: string; downloadId: string };

// The shared front door: a well-formed target on an enabled integration, or the response refusing it.
export async function importGate(rawService: unknown, rawInstance: unknown, rawDownloadId: unknown, t: Translator): Promise<ImportTarget | NextResponse> {
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
    if (!parsed) return null;
    out.set(parsed.path, parsed.override);
  }
  return out;
}

export function importFailure(err: unknown, service: "radarr" | "sonarr", instance: string, t: Translator, what: string): NextResponse {
  const label = SERVICE_LABEL[service];
  if (err instanceof ImportOverrideError) {
    return NextResponse.json({ error: t(`apiAdmin.queue.override.${err.field}`, { service: label }) }, { status: 400 });
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


export type ServiceTarget = { service: "radarr" | "sonarr"; instance: string };

/** The front door for the routes that need no download id (grab, the pickers). */
export async function serviceGate(rawService: unknown, rawInstance: unknown, t: Translator): Promise<ServiceTarget | NextResponse> {
  const service = parseQueueService(rawService);
  const instance = rawInstance === undefined || rawInstance === null ? "" : rawInstance;
  if (!service || typeof instance !== "string" || instance.length > 100) {
    return NextResponse.json({ error: t("apiAdmin.queue.serviceParamsInvalid") }, { status: 400 });
  }
  if (!(await isFeatureEnabled(`feature.integration.${service}`))) {
    return NextResponse.json({ error: t("apiAdmin.missing.integrationDisabled", { service: SERVICE_LABEL[service] }) }, { status: 404 });
  }
  return { service, instance };
}
