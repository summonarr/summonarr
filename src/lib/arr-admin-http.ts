// Shared request plumbing for the admin Radarr/Sonarr routes under
// /api/admin/arr/* (title manager, history, blocklist, calendar, system):
// parsing the target and ids, and ONE mapping from the data layers' errors to
// responses. Route files may only export handlers, so it lives here.
import { NextResponse } from "next/server";
import { ArrResponseError, arrErrorMessage } from "./arr";
import { ArrInstanceError, ARR_SERVICE_LABEL, parseArrService, type ArrService } from "./arr-admin";
import { TitleEditError } from "./arr-title";
import { AlreadyFailedError, NotAGrabError, NotOnTitleError, TitleNotFoundError } from "./arr-title-data";
import { BlocklistGoneError } from "./arr-history-data";
import { CommandNotQueuedError, ProviderNotFoundError, ProviderRejectedError, UnknownTaskError } from "./arr-system-data";
import { validationMessagesFromBody } from "./arr-system";
import { isFeatureEnabled } from "./features";
import type { Translator } from "./i18n/translate";
import { sanitizeForLog } from "./sanitize";

export type ArrTarget = { service: ArrService; instance: string };
export type ArrTitleTarget = ArrTarget & { arrId: number };

/** A positive integer id from a JSON body value or a query-string value, else null. */
export function parseArrId(v: unknown): number | null {
  if (typeof v === "number") return Number.isSafeInteger(v) && v > 0 ? v : null;
  if (typeof v === "string" && /^\d{1,12}$/.test(v)) {
    const n = Number(v);
    return Number.isSafeInteger(n) && n > 0 ? n : null;
  }
  return null;
}

/** A season number (0 is specials) from a body or query value, else null. */
export function parseSeasonNumber(v: unknown): number | null {
  const n = typeof v === "number" ? v : typeof v === "string" && /^\d{1,4}$/.test(v) ? Number(v) : NaN;
  return Number.isInteger(n) && n >= 0 && n <= 9_999 ? n : null;
}

/** An array of positive integer ids from a body, deduplicated, or null when malformed. */
export function parseIdArray(v: unknown, max: number): number[] | null {
  if (!Array.isArray(v) || v.length === 0 || v.length > max) return null;
  const out = new Set<number>();
  for (const x of v) {
    const id = parseArrId(x);
    if (id === null || typeof x !== "number") return null;
    out.add(id);
  }
  return [...out];
}

/** The front door: a service and instance on an enabled integration, or the response refusing them. */
export async function arrGate(rawService: unknown, rawInstance: unknown, t: Translator): Promise<ArrTarget | NextResponse> {
  const service = parseArrService(rawService);
  const instance = rawInstance === undefined || rawInstance === null ? "" : rawInstance;
  if (!service || typeof instance !== "string" || instance.length > 100) {
    return NextResponse.json({ error: t("apiAdmin.queue.serviceParamsInvalid") }, { status: 400 });
  }
  if (!(await isFeatureEnabled(`feature.integration.${service}`))) {
    return NextResponse.json({ error: t("apiAdmin.missing.integrationDisabled", { service: ARR_SERVICE_LABEL[service] }) }, { status: 404 });
  }
  return { service, instance };
}

/** arrGate plus the title's arr id (Radarr movie id / Sonarr series id). */
export async function arrTitleGate(rawService: unknown, rawInstance: unknown, rawId: unknown, t: Translator): Promise<ArrTitleTarget | NextResponse> {
  const target = await arrGate(rawService, rawInstance, t);
  if (target instanceof NextResponse) return target;
  const arrId = parseArrId(rawId);
  if (arrId === null) return NextResponse.json({ error: t("apiAdmin.arr.idInvalid") }, { status: 400 });
  return { ...target, arrId };
}

/**
 * Every data-layer error → its response. The arr's own refusal reason (a 400's
 * validation messages) is relayed masked; anything unexpected is logged with
 * the upstream detail and answered with the translated generic.
 */
export function arrFailure(err: unknown, target: ArrTarget, t: Translator, what: string): NextResponse {
  const service = ARR_SERVICE_LABEL[target.service];
  if (err instanceof ArrInstanceError) {
    return NextResponse.json({ error: t("apiAdmin.missing.instanceUnknown", { service }) }, { status: 404 });
  }
  if (err instanceof TitleNotFoundError) {
    return NextResponse.json({ error: t("apiAdmin.arr.titleNotFound", { service }) }, { status: 404 });
  }
  if (err instanceof NotOnTitleError) {
    return NextResponse.json({ error: t(`apiAdmin.arr.notOnTitle.${err.what}`) }, { status: 409 });
  }
  if (err instanceof NotAGrabError) {
    return NextResponse.json({ error: t("apiAdmin.arr.notAGrab") }, { status: 409 });
  }
  if (err instanceof AlreadyFailedError) {
    return NextResponse.json({ error: t("apiAdmin.arr.alreadyFailed") }, { status: 409 });
  }
  if (err instanceof BlocklistGoneError) {
    return NextResponse.json({ error: t("apiAdmin.arr.blocklistGone") }, { status: 409 });
  }
  if (err instanceof TitleEditError) {
    return NextResponse.json({ error: t(`apiAdmin.arr.edit.${err.field}`, { service }) }, { status: 400 });
  }
  if (err instanceof UnknownTaskError) {
    return NextResponse.json({ error: t("apiAdmin.arr.unknownTask", { service }) }, { status: 400 });
  }
  if (err instanceof CommandNotQueuedError) {
    return NextResponse.json({ error: t("apiAdmin.arr.commandNotQueued") }, { status: 409 });
  }
  if (err instanceof ProviderNotFoundError) {
    return NextResponse.json({ error: t("apiAdmin.arr.providerNotFound", { service }) }, { status: 404 });
  }
  if (err instanceof ProviderRejectedError) {
    const reason = err.messages.join(" ") || t("apiAdmin.arr.noReason");
    return NextResponse.json({ error: t("apiAdmin.arr.rejected", { service, reason }), messages: err.messages }, { status: 400 });
  }
  if (err instanceof ArrResponseError && err.status === 400) {
    const messages = validationMessagesFromBody(err.body);
    const reason = messages.join(" ") || t("apiAdmin.arr.noReason");
    return NextResponse.json({ error: t("apiAdmin.arr.rejected", { service, reason }), messages }, { status: 400 });
  }
  if (err instanceof ArrResponseError && err.status === 404) {
    return NextResponse.json({ error: t("apiAdmin.arr.goneUpstream", { service }) }, { status: 404 });
  }
  console.warn(`[arr-admin] ${target.service} instance "${sanitizeForLog(target.instance)}" ${what} failed:`, arrErrorMessage(err));
  return NextResponse.json({ error: t("apiAdmin.arr.failed", { service }) }, { status: 502 });
}
