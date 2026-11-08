// What an admin panel says when one of its requests fails, read the same way
// everywhere (the Users table, the user modals, Watch Sync, the cache warm):
//
// - the route's own reason when it gave one (a refusal it explains: a 403 for
//   an admin target, a 429's wait, a quota of 0) — fetchJson's apiErrorText;
// - "failed (<status>)" when it answered without one, or with a body that
//   isn't JSON (a proxy page);
// - the network sentence when no answer came (offline, timeout, a proxy's own
//   5xx page — fetchJson reads those as "network");
// - nothing for a request the panel itself aborted (closed, superseded).
//
// The fetchJson call must NOT pass `fallbackError`: an empty `error` is how a
// reason-less refusal is told from one with a reason. Pure, type imports only
// (tests/request-failure-text.test.mts).
import type { FetchJsonFailure } from "@/lib/client/fetch-json";
import type { Translator } from "@/lib/i18n/translate";

export interface FailureKeys {
  /** Takes `{status}`. */
  status: string;
  network: string;
}

export function requestFailureText(res: FetchJsonFailure, t: Translator, keys: FailureKeys): string | null {
  if (res.kind === "aborted") return null;
  if (res.kind === "http" && res.error) return res.error;
  if (res.kind === "http" || res.kind === "invalid") return t(keys.status, { status: res.status });
  return t(keys.network);
}
