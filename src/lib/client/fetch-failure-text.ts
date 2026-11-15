// What a panel says for a failed fetchJson whose call set `fallbackError`:
// the route's own reason for a refusal ("http", or the fallback for an
// "invalid" 2xx), the network sentence when no answer came (offline, timeout,
// a proxy's own 5xx page) and nothing for a request the panel itself aborted.
// One reading everywhere, so the same failure never reads two ways between
// screens (tests/fetch-failure-text.test.mts). Type imports only.
import type { FetchJsonFailure } from "./fetch-json";
import type { Translator } from "@/lib/i18n/translate";

export function fetchFailureText(res: FetchJsonFailure, t: Translator): string | null {
  if (res.kind === "aborted") return null;
  return res.kind === "http" || res.kind === "invalid" ? res.error : t("shared.thread.networkError");
}
