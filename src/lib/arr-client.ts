// The Radarr/Sonarr HTTP client: the ONE transport every Radarr/Sonarr call goes
// through (arrFetch — guardrails 5 and 5a), the read retry, the error classes,
// and how a failure is described to an admin or to a delegate (5e, 5g).
// Re-exported by arr.ts. Loads no other arr module at runtime, so every sibling
// can import it without a cycle.
import { SafeFetchError, safeFetchAdminConfigured } from "./safe-fetch";
import type { ArrErrorKind } from "./arr-error-kind";
import type { Translator } from "./i18n/translate";
import { sanitizeForLog } from "./sanitize";

export type ArrCfg = { url: string; apiKey: string };

export class ArrResponseError extends Error {
  // Explicit fields (not constructor parameter properties) so the module loads
  // under Node's strip-only TS mode — the unit suite imports it.
  public readonly status: number;
  public readonly body!: string;
  constructor(status: number, body: string) {
    super(`Arr service returned a non-200 response (${status})`);
    this.status = status;
    // NOT enumerable: console.error(err) prints an error's own enumerable
    // properties, and the arr's body can quote an indexer URL with its apikey
    // (guardrail 5e). Every reader names `err.body`, which still reads it.
    Object.defineProperty(this, "body", { value: body, enumerable: false, writable: false, configurable: false });
  }
}

// The title is not in that instance's library (never pushed, or removed there).
// A plain Error subclass, so every existing `catch` that treated these throws as
// a generic failure still does; a caller that can say something better (the
// request release search: "re-push it first") tests for it.
export class ArrItemNotFoundError extends Error {}

/**
 * Might a WRITE that threw have happened anyway? A timeout or a dropped
 * connection fails AFTER the request went out, and a gateway's 502/504 is a
 * proxy giving up on (or losing the answer to) a request the arr may still be
 * processing — Radarr's and Sonarr's handlers take no abort token, so the
 * arr carries on. A 503 (nothing behind the proxy took it) and every answer the
 * arr itself sent are definite. Guardrail 14b: a deliberate delete whose
 * outcome is unknown keeps its `cleanedUpAt` stamps.
 */
export function arrWriteOutcomeUnknown(err: unknown): boolean {
  if (err instanceof SafeFetchError) return err.reason === "timeout" || err.reason === "network";
  if (err instanceof ArrResponseError) return err.status === 502 || err.status === 504;
  return err instanceof Error && err.name === "TimeoutError";
}

const ARR_FETCH_TIMEOUT_MS = 30_000;

// Raised from 10 MB — libraries with >3k movies were being silently truncated at the old cap
const ARR_FETCH_MAX_BYTES = 50 * 1024 * 1024;

// `quietErrors`: skip arrRequest's per-response error line because the CALLER
// reports the failure itself — the Download Queue page re-reads every 20s, and
// a down instance is one unchanged condition it logs once (guardrail 7b). The
// error is still thrown, unchanged.
// `timeoutMs`: only for a call that is slow by nature — an interactive release
// search waits on every indexer the instance has.
export type ArrFetchOptions = RequestInit & { quietErrors?: boolean; timeoutMs?: number };

// `T` is the caller's claim about the body, never checked here: a caller whose
// logic depends on the shape reads `arrFetch<unknown>` and checks it.
export async function arrFetch<T>(cfg: ArrCfg, path: string, options: ArrFetchOptions = {}): Promise<T> {
  const res = await arrRequest(cfg, path, options);
  return res.json() as Promise<T>;
}

// arrFetch for a call whose success answer carries no JSON body — Radarr's and
// Sonarr's DELETE /movie|series/{id} answer 200 with an empty body, which
// res.json() would throw on. Same transport, timeout, body cap and error
// contract as arrFetch (ArrResponseError on non-2xx); the body is drained.
export async function arrFetchNoContent(cfg: ArrCfg, path: string, options: ArrFetchOptions = {}): Promise<void> {
  const res = await arrRequest(cfg, path, options);
  await res.text().catch(() => "");
}

// A reset or refused connection on a READ is usually a blip: the arr restarting,
// a Tailscale/VPN path re-keying or switching routes, or a pooled keep-alive
// socket the far end already closed. Two quick retries ride those out; anything
// longer is the next cron tick's job. Delays are short on purpose — arr-watch
// fires three reads at once and each waits out its own retries.
// An object so a unit suite that scripts a dead arr can set `delaysMs = []` and
// see ONE attempt instead of sleeping through the backoff.
export const arrReadRetry: { delaysMs: readonly number[] } = { delaysMs: [300, 1_000] };

function isRetryableRead(options: ArrFetchOptions): boolean {
  const method = (options.method ?? "GET").toUpperCase();
  return method === "GET" || method === "HEAD";
}

function sleepUnlessAborted(ms: number, signal?: AbortSignal | null): Promise<void> {
  return new Promise((resolve) => {
    if (signal?.aborted) return resolve();
    const t = setTimeout(done, ms);
    function done() {
      clearTimeout(t);
      signal?.removeEventListener("abort", done);
      resolve();
    }
    signal?.addEventListener("abort", done, { once: true });
  });
}

/**
 * Run an idempotent read, retrying ONLY a transport failure (`network`: reset,
 * refused, unreachable). Never a timeout (the caller already waited the full
 * budget), an SSRF/size/redirect refusal, an HTTP answer from the arr, or a
 * write — a write that threw may have landed (see arrWriteOutcomeUnknown), so
 * re-sending it could double-apply. A caller's abort stops the retries.
 */
export async function retryTransientRead<T>(
  run: () => Promise<T>,
  opts: { signal?: AbortSignal | null; delaysMs?: readonly number[]; sleep?: (ms: number) => Promise<void> } = {},
): Promise<T> {
  const delays = opts.delaysMs ?? arrReadRetry.delaysMs;
  const sleep = opts.sleep ?? ((ms: number) => sleepUnlessAborted(ms, opts.signal));
  for (let attempt = 0; ; attempt++) {
    try {
      return await run();
    } catch (err) {
      const retryable = err instanceof SafeFetchError && err.reason === "network";
      if (!retryable || attempt >= delays.length || opts.signal?.aborted) throw err;
      await sleep(delays[attempt]);
      if (opts.signal?.aborted) throw err;
    }
  }
}

async function arrRequest(cfg: ArrCfg, path: string, options: ArrFetchOptions): Promise<Response> {
  const { signal, method, body } = options;
  const send = () =>
    safeFetchAdminConfigured(`${cfg.url}${path}`, {
      method,
      body,
      ...(signal ? { signal } : {}),
      cache: "no-store",
      timeoutMs: options.timeoutMs ?? ARR_FETCH_TIMEOUT_MS,
      maxResponseBytes: ARR_FETCH_MAX_BYTES,
      headers: { "X-Api-Key": cfg.apiKey, "Content-Type": "application/json", ...(options.headers ?? {}) },
    });
  const res = isRetryableRead(options) ? await retryTransientRead(send, { signal }) : await send();
  if (!res.ok) {
    const text = await res.text().catch(() => res.statusText);
    if (!options.quietErrors) console.error(`[arr] ${sanitizeForLog(path)} → ${res.status}`);
    throw new ArrResponseError(res.status, text);
  }
  return res;
}

/**
 * What kind of failure this was, for the admin (arr-error-kind.ts). A gateway
 * in front of the arr answering 502/503 means the arr behind it is down; 504 and
 * 408 are timeouts wherever they were raised.
 */
export function arrErrorKind(err: unknown): ArrErrorKind {
  if (err instanceof ArrResponseError) {
    if (err.status === 401 || err.status === 403) return "auth";
    if (err.status === 404) return "notFound";
    if (err.status === 408 || err.status === 504) return "timeout";
    if (err.status === 502 || err.status === 503) return "unreachable";
    if (err.status >= 500) return "server";
    return "other";
  }
  if (err instanceof SafeFetchError) {
    if (err.reason === "timeout") return "timeout";
    if (err.reason === "network" || err.reason === "ssrf-blocked") return "unreachable";
    return "other";
  }
  if (err instanceof Error && err.name === "TimeoutError") return "timeout";
  return "other";
}

// Radarr and Sonarr never answer 502 or 504 themselves — those come from a
// reverse proxy in front of them, which is where the failure is recorded. The
// old "check the arr service logs" hint sent the admin to logs that had no
// trace of the request. 503 keeps that hint: Sonarr answers 503 itself under
// import load (guardrail 14a).
export function arrErrorMessage(err: unknown): string {
  if (err instanceof ArrResponseError) {
    if (err.status === 401 || err.status === 403) return `Arr authentication failed (${err.status}) — check the API key`;
    if (err.status === 404) return `Item not found in arr (${err.status})`;
    if (err.status === 502) return `Bad gateway (502) from a proxy in front of the arr — check the reverse proxy and the network path to the arr`;
    if (err.status === 504) return `Gateway timeout (504) from a proxy in front of the arr — the arr was slow or unreachable; check the proxy and the arr`;
    if (err.status >= 500) return `Arr server error (${err.status}) — check the arr service logs`;
    return `Arr request failed (${err.status})`;
  }
  if (err instanceof Error) return err.message;
  return "Arr request failed";
}

/**
 * arrErrorMessage for a caller who may be a non-ADMIN delegate (MANAGE_REQUESTS,
 * MANAGE_ISSUES), in the caller's language. An ArrResponseError gets
 * arrErrorMessage's status phrase, translated (English is byte-identical) and
 * never its body; any other error is named by its KIND only. A SafeFetchError's
 * message carries the arr's internal URL, host, IP and port ("fetch failed for
 * http://10.0.0.5:7878/api/v3/command: … ECONNREFUSED 10.0.0.5:7878"), which no
 * delegate-facing arr surface shows (guardrail 5g). Log arrErrorMessage beside it.
 */
export function arrErrorMessageForClient(err: unknown, t: Translator): string {
  if (err instanceof ArrResponseError) {
    const status = err.status;
    if (status === 401 || status === 403) return t("apiUser.common.arrStatusAuth", { status });
    if (status === 404) return t("apiUser.common.arrStatusNotFound", { status });
    if (status === 502) return t("apiUser.common.arrStatusBadGateway");
    if (status === 504) return t("apiUser.common.arrStatusGatewayTimeout");
    if (status >= 500) return t("apiUser.common.arrStatusServer", { status });
    return t("apiUser.common.arrStatusOther", { status });
  }
  switch (arrErrorKind(err)) {
    case "timeout":
      return t("apiUser.common.arrTimeout");
    case "unreachable":
      return t("apiUser.common.arrUnreachable");
    default:
      return t("apiUser.common.arrFailed");
  }
}

// ── reading an answer ────────────────────────────────────────────────────────
// `arrFetch<T>` is a compile-time claim. The readers below say what actually
// arrived; a caller turns "unusable" into the path it already had for a broken
// answer (a thrown Error, or its own "couldn't tell" null), never a new kind.

export type ArrRecord = Record<string, unknown>;

export function asRecord(value: unknown): ArrRecord | null {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? (value as ArrRecord) : null;
}

/**
 * A list answer whose EVERY element is an object, else null. For a list whose
 * length means something (a `series/lookup` picks a lone row only when it is
 * the only one), so a junk element can't change the count.
 */
export function strictRecordList(raw: unknown): ArrRecord[] | null {
  if (!Array.isArray(raw)) return null;
  for (const x of raw) if (asRecord(x) === null) return null;
  return raw as ArrRecord[];
}

/** An error for an answer that is not the shape the endpoint documents. */
export function unusableAnswer(service: "Radarr" | "Sonarr", what: string): Error {
  return new Error(`${service} sent an unusable ${what} answer`);
}

/**
 * The library row whose `key` is `id` in a filtered list read (`?tmdbId=`,
 * `?tvdbId=`), or null when the instance doesn't hold it. The id is matched
 * here too: an arr build that ignored the filter must not hand back another
 * title's row. An answer that isn't a list throws — "not in the library" is a
 * definite answer a broken payload must never give.
 */
export function findLibraryRow(raw: unknown, key: "tmdbId" | "tvdbId", id: number, service: "Radarr" | "Sonarr"): ArrRecord | null {
  if (!Array.isArray(raw)) throw unusableAnswer(service, "library");
  for (const x of raw) {
    const row = asRecord(x);
    if (row && row[key] === id) return row;
  }
  return null;
}

// A cache miss joins the read already in flight for its key, else starts one
// and forgets it once it settles (the cache then answers until it expires).
export function singleFlight<T>(inFlight: Map<string, Promise<T>>, key: string, read: () => Promise<T>): Promise<T> {
  const pending = inFlight.get(key);
  if (pending) return pending;
  const run = read().finally(() => {
    if (inFlight.get(key) === run) inFlight.delete(key);
  });
  inFlight.set(key, run);
  return run;
}
