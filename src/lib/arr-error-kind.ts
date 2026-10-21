// Why a Radarr/Sonarr call failed, in terms an admin can act on — the API key,
// a timeout, the host, the arr itself. Pure and zero-import so a client
// component can turn a report's `kind` into translated text; the raw upstream
// detail stays in the server log (arrErrorMessage).

export type ArrErrorKind = "auth" | "timeout" | "unreachable" | "server" | "notFound" | "other";

// A literal map, never a key built from the kind: the i18n dead-key check can't
// see a built key.
export const ARR_ERROR_KIND_KEYS = {
  auth: "adminArr.error.auth",
  timeout: "adminArr.error.timeout",
  unreachable: "adminArr.error.unreachable",
  server: "adminArr.error.server",
  notFound: "adminArr.error.notFound",
  other: "adminArr.error.other",
} as const satisfies Record<ArrErrorKind, string>;

export function isArrErrorKind(v: unknown): v is ArrErrorKind {
  return typeof v === "string" && Object.prototype.hasOwnProperty.call(ARR_ERROR_KIND_KEYS, v);
}
