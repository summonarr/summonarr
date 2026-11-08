// Shared request plumbing for the admin Radarr/Sonarr routes under
// /api/admin/arr/* (title manager, history, blocklist, calendar, system):
// parsing the target and ids, and ONE mapping from the data layers' errors to
// responses. Route files may only export handlers, so it lives here.
import { NextResponse } from "next/server";
import { ArrItemNotFoundError, ArrResponseError, arrErrorKind, arrErrorMessage } from "./arr";
import { ArrInstanceError, ARR_SERVICE_LABEL, parseArrService, type ArrService } from "./arr-admin";
import { TitleEditError } from "./arr-title";
import { AlreadyFailedError, MarkInProgressError, NotAGrabError, NotOnTitleError, TitleNotFoundError } from "./arr-title-data";
import { BlocklistGoneError } from "./arr-history-data";
import { CommandNotQueuedError, ProviderNotFoundError, ProviderRejectedError, UnknownTaskError } from "./arr-system-data";
import { validationMessagesFromBody } from "./arr-system";
import { isFeatureEnabled } from "./features";
import type { Translator } from "./i18n/translate";
import type { ArrErrorKind } from "./arr-error-kind";
import { warnOnChange } from "./log-dedup";
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

/** The warnOnChange key of a polled/snapshot-refreshed read: one per route and instance (guardrail 7b). */
export function readWarnKey(route: string, target: ArrTarget): string {
  return `arr-read:${route}:${target.service}:${target.instance}`;
}

type FailureBody = { error: string; messages?: string[] };
type KnownFailure = { status: number; body: FailureBody };
type FailureRule = (err: unknown, service: string, t: Translator) => KnownFailure | null;

// One rule per error class: `err instanceof cls` answers `status` with `message`.
function onError<E extends Error>(
  cls: abstract new (...args: never[]) => E,
  status: number,
  message: (err: E, service: string, t: Translator) => string,
): FailureRule {
  return (err, service, t) => (err instanceof cls ? { status, body: { error: message(err, service, t) } } : null);
}

// The arr refusing in its own words: its messages relayed (masked upstream by
// validationMessagesFromBody / the provider parse) under the shared sentence.
function rejected(messages: string[], status: number, service: string, t: Translator): KnownFailure {
  const reason = messages.join(" ") || t("apiAdmin.arr.noReason");
  return { status, body: { error: t("apiAdmin.arr.rejected", { service, reason }), messages } };
}

// Checked IN ORDER: a subclass's rule must come before its parent's.
const KNOWN_FAILURES: readonly FailureRule[] = [
  onError(ArrInstanceError, 404, (_e, service, t) => t("apiAdmin.missing.instanceUnknown", { service })),
  onError(TitleNotFoundError, 404, (_e, service, t) => t("apiAdmin.arr.titleNotFound", { service })),
  // The arr's library no longer holds the title (same answer as the request releases route).
  onError(ArrItemNotFoundError, 409, (_e, service, t) => t("apiUser.requests.releases.notInArr", { service })),
  onError(NotOnTitleError, 409, (e, _s, t) => t(`apiAdmin.arr.notOnTitle.${e.what}`)),
  onError(NotAGrabError, 409, (_e, _s, t) => t("apiAdmin.arr.notAGrab")),
  // Before AlreadyFailedError, its parent: a claim held by another mark (in
  // flight, or its outcome unknown for ~90 s) is not proof the download
  // failed — "already failed" there sent the admin away from a mark that may
  // never have reached the arr.
  onError(MarkInProgressError, 409, (_e, _s, t) => t("apiAdmin.arr.markInProgress")),
  onError(AlreadyFailedError, 409, (_e, _s, t) => t("apiAdmin.arr.alreadyFailed")),
  onError(BlocklistGoneError, 409, (_e, _s, t) => t("apiAdmin.arr.blocklistGone")),
  onError(TitleEditError, 400, (e, service, t) => t(`apiAdmin.arr.edit.${e.field}`, { service })),
  onError(UnknownTaskError, 400, (_e, service, t) => t("apiAdmin.arr.unknownTask", { service })),
  onError(CommandNotQueuedError, 409, (_e, _s, t) => t("apiAdmin.arr.commandNotQueued")),
  onError(ProviderNotFoundError, 404, (_e, service, t) => t("apiAdmin.arr.providerNotFound", { service })),
  (err, service, t) => (err instanceof ProviderRejectedError ? rejected(err.messages, 400, service, t) : null),
  (err, service, t) => {
    if (!(err instanceof ArrResponseError)) return null;
    // A 409 is the arr refusing in its own words ("Unable to cancel task",
    // "Getting release from indexer failed") — relayed masked, like a 400.
    if (err.status === 400 || err.status === 409) return rejected(validationMessagesFromBody(err.body), err.status, service, t);
    if (err.status === 404) return { status: 404, body: { error: t("apiAdmin.arr.goneUpstream", { service }) } };
    return null;
  },
];

// Anything unexpected, by kind: the translated generic and its gateway status.
const UNEXPECTED_FAILURE: Partial<Record<ArrErrorKind, { key: string; status: number }>> = {
  auth: { key: "apiAdmin.arr.failedAuth", status: 502 },
  timeout: { key: "apiAdmin.arr.failedTimeout", status: 504 },
  unreachable: { key: "apiAdmin.arr.failedUnreachable", status: 502 },
  server: { key: "apiAdmin.arr.failedServer", status: 502 },
};
const UNEXPECTED_DEFAULT = { key: "apiAdmin.arr.failed", status: 502 };

/**
 * Every data-layer error → its response. The arr's own refusal reason (a 400's
 * validation messages) is relayed masked; anything unexpected is logged with
 * the upstream detail and answered with the translated generic. A POLLED route
 * passes `warnKey`: the same failure on every poll is one unchanged condition,
 * logged once through warnOnChange (guardrail 7b) — the route forgets the key
 * when a read succeeds.
 */
export function arrFailure(err: unknown, target: ArrTarget, t: Translator, what: string, opts: { warnKey?: string } = {}): NextResponse {
  const service = ARR_SERVICE_LABEL[target.service];
  for (const rule of KNOWN_FAILURES) {
    const known = rule(err, service, t);
    if (known) return NextResponse.json(known.body, { status: known.status });
  }
  if (opts.warnKey) {
    const detail = arrErrorMessage(err);
    warnOnChange(opts.warnKey, detail, `[arr-admin] ${target.service} instance "${sanitizeForLog(target.instance)}" ${what} failed: ${detail}`);
  } else {
    console.warn(`[arr-admin] ${target.service} instance "${sanitizeForLog(target.instance)}" ${what} failed:`, arrErrorMessage(err));
  }
  const { key, status } = UNEXPECTED_FAILURE[arrErrorKind(err)] ?? UNEXPECTED_DEFAULT;
  return NextResponse.json({ error: t(key, { service }) }, { status });
}
