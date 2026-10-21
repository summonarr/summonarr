// The Library cleanup and Never-watched pages' upstream failures, in the
// viewer's language. A Radarr/Sonarr failure carries an `arrErrorKind` and is
// worded through the literal ARR_ERROR_KIND_KEYS (guardrail 5e — never the
// English `error`); a media server's watch-record check carries an
// UpstreamErrorCode worded through UPSTREAM_ERROR_KEYS below. Both maps are
// literal, never built from the code: the i18n dead-key check can't see a built
// key. Pure, type-only imports beyond the zero-import arr-error-kind, so the
// "use client" pages share one rendering.
import { ARR_ERROR_KIND_KEYS, isArrErrorKind } from "./arr-error-kind";
import type { Translator } from "./i18n/translate";
import type { UpstreamErrorCode } from "./upstream-watch";

// One Radarr/Sonarr failure as a sentence naming the instance. An entry with no
// recognised kind (a response from before kinds existed) keeps its stored text.
export function arrFailureText(t: Translator, name: string, e: { kind?: unknown; error: string }): string {
  return isArrErrorKind(e.kind) ? t(ARR_ERROR_KIND_KEYS[e.kind], { name }) : `${name} (${e.error})`;
}

export const UPSTREAM_ERROR_KEYS = {
  timeout: "adminManage.neverWatched.upstreamError.timeout",
  unreachable: "adminManage.neverWatched.upstreamError.unreachable",
  blocked: "adminManage.neverWatched.upstreamError.blocked",
  tooLarge: "adminManage.neverWatched.upstreamError.tooLarge",
  redirect: "adminManage.neverWatched.upstreamError.redirect",
  http: "adminManage.neverWatched.upstreamError.http",
  noUsers: "adminManage.neverWatched.upstreamError.noUsers",
  shape: "adminManage.neverWatched.upstreamError.shape",
  noRecords: "adminManage.neverWatched.upstreamError.noRecords",
  other: "adminManage.neverWatched.upstreamError.other",
} as const satisfies Record<UpstreamErrorCode, string>;

const isUpstreamErrorCode = (v: unknown): v is UpstreamErrorCode =>
  typeof v === "string" && Object.prototype.hasOwnProperty.call(UPSTREAM_ERROR_KEYS, v);

// Why a media server's own watch records couldn't be read, or null when there
// is nothing to say. A code the page doesn't know falls back to the stored text.
export function upstreamFailureText(
  t: Translator,
  u: { error: string | null; errorCode?: unknown; httpStatus?: number | null },
): string | null {
  if (isUpstreamErrorCode(u.errorCode)) {
    if (u.errorCode === "http" && typeof u.httpStatus !== "number") return t(UPSTREAM_ERROR_KEYS.other);
    return t(UPSTREAM_ERROR_KEYS[u.errorCode], u.errorCode === "http" ? { status: u.httpStatus as number } : undefined);
  }
  return u.error;
}
