// The browser's one JSON fetch: a timeout, the caller's abort, the shared
// reading of a route's error (api-error.ts) and an optional shape check
// (validate.ts), with every outcome a value — it never throws.
//
//   const res = await fetchJson(withBasePath(`/api/requests/${id}`), {
//     init: jsonInit("PATCH", { status: "APPROVED" }),
//     schema: v.object({ arrError: v.optional(v.string()) }),
//     signal,
//     fallbackError: t("shared.thread.networkError"),
//   });
//   if (!res.ok) { if (res.kind !== "aborted") setError(res.error); return; }
//   res.data.arrError;   // string | undefined
//
// How an answer is read:
// - "aborted": the caller's signal fired (before or during the request).
// - "timeout": `timeoutMs` passed with no complete answer (default 30s).
// - "network": no answer came — the fetch threw, the body broke off, or a 5xx
//   whose body is not JSON: a reverse proxy's own error page (nginx's 502/504,
//   Cloudflare's 520–524) never reached a route of ours. Status 0, exactly
//   guardrail 37a's "no answer" (job-poll.ts): never read as the route's
//   failure.
// - "http": a non-2xx a route (or something in front of it) answered. `error`
//   is the route's `message`, else its `error`, else `fallbackError`
//   (apiErrorText); `body` is the parsed body for routes that send more
//   (arrError, secondFactorRequired), null when it wasn't JSON.
// - "invalid": a 2xx whose body is not JSON (a proxy's sign-in page) or fails
//   `schema`. `detail` names what was wrong; `error` is `fallbackError`.
// - ok: a 2xx with a JSON body that passes `schema`. An empty body (204) is
//   `data: null`, which a schema then has to accept.
//
// `error` is "" for "aborted", and for any kind when `fallbackError` is unset.
// `detail` is for logs and debugging, never for display.
//
// The URL is used as given: build it with withBasePath. No server imports,
// so this stays safe for client components (and loads in the unit suite:
// tests/fetch-json.test.mts).
import { apiErrorText } from "./api-error";
import { check, type Infer, type Schema } from "../validate";

export type FetchJsonFailureKind = "aborted" | "timeout" | "network" | "http" | "invalid";

export type FetchJsonResult<T> =
  | { ok: true; status: number; data: T }
  | {
      ok: false;
      kind: FetchJsonFailureKind;
      /** The HTTP status; 0 when no answer came (aborted, timeout, network). */
      status: number;
      /** Display text: the route's reason for "http", else `fallbackError` ("" for "aborted"). */
      error: string;
      /** The parsed JSON body of an "http" or "invalid" answer, unchecked; null otherwise. */
      body: unknown;
      /** Why, for logs: the schema's path message, the thrown error, the status. */
      detail: string;
    };

export type FetchJsonFailure = Extract<FetchJsonResult<unknown>, { ok: false }>;

export interface FetchJsonOptions {
  /** Method, headers, body… `jsonInit` builds the usual JSON one. The signal is `signal`, below. */
  init?: Omit<RequestInit, "signal">;
  /** Gives up with "timeout" after this long. Infinity (or 0) waits for as long as the browser does. */
  timeoutMs?: number;
  /** The caller's abort (an unmount, a newer request): the result is "aborted". */
  signal?: AbortSignal;
  /** The text `error` carries when the route gave no reason of its own. */
  fallbackError?: string;
}

export const DEFAULT_FETCH_TIMEOUT_MS = 30_000;
// setTimeout fires at once past this (a 32-bit delay).
const MAX_TIMER_MS = 2_147_483_647;

/** A JSON request: `method`, the Content-Type header and the serialized body. */
export function jsonInit(method: string, body: unknown): Omit<RequestInit, "signal"> {
  return { method, headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) };
}

type Parsed = { json: true; value: unknown } | { json: false };

function parseBody(text: string): Parsed {
  if (text.trim() === "") return { json: true, value: null };
  try {
    return { json: true, value: JSON.parse(text) as unknown };
  } catch {
    return { json: false };
  }
}

function messageOf(err: unknown): string {
  return err instanceof Error ? err.message || err.name : String(err);
}

export function fetchJson<S extends Schema<unknown>>(
  url: string,
  opts: FetchJsonOptions & { schema: S },
): Promise<FetchJsonResult<Infer<S>>>;
export function fetchJson(url: string, opts?: FetchJsonOptions): Promise<FetchJsonResult<unknown>>;
export async function fetchJson(
  url: string,
  opts: FetchJsonOptions & { schema?: Schema<unknown> } = {},
): Promise<FetchJsonResult<unknown>> {
  const fallback = opts.fallbackError ?? "";
  const failure = (
    kind: FetchJsonFailureKind,
    status: number,
    detail: string,
    body: unknown = null,
    error = fallback,
  ): FetchJsonFailure => ({ ok: false, kind, status, error, body, detail });

  const caller = opts.signal;
  if (caller?.aborted) return failure("aborted", 0, "aborted before the request", null, "");

  // One controller carries both reasons to fetch; `cause` records which came first.
  const controller = new AbortController();
  let cause: "aborted" | "timeout" | null = null;
  const stop = (why: "aborted" | "timeout") => {
    if (cause === null) cause = why;
    controller.abort();
  };
  const onCallerAbort = () => stop("aborted");
  caller?.addEventListener("abort", onCallerAbort, { once: true });
  const timeoutMs = opts.timeoutMs ?? DEFAULT_FETCH_TIMEOUT_MS;
  const timer = Number.isFinite(timeoutMs) && timeoutMs > 0
    ? setTimeout(() => stop("timeout"), Math.min(timeoutMs, MAX_TIMER_MS))
    : null;
  // Raced against every await, so the wait ends when the abort does even if a
  // fetch implementation (or a body stream) ignores its signal.
  const stopped = new Promise<never>((_, reject) => {
    controller.signal.addEventListener("abort", () => reject(new Error("stopped")), { once: true });
  });
  stopped.catch(() => {});

  try {
    let status: number;
    let parsed: Parsed;
    try {
      const res = await Promise.race([fetch(url, { ...opts.init, signal: controller.signal }), stopped]);
      status = res.status;
      parsed = parseBody(await Promise.race([res.text(), stopped]));
    } catch (err) {
      if (cause === "aborted") return failure("aborted", 0, "aborted", null, "");
      if (cause === "timeout") return failure("timeout", 0, `no answer within ${timeoutMs}ms`);
      return failure("network", 0, messageOf(err));
    }

    const body = parsed.json ? parsed.value : null;
    if (status < 200 || status > 299) {
      if (status >= 500 && !parsed.json) return failure("network", 0, `HTTP ${status} that is not JSON`);
      return failure("http", status, `HTTP ${status}`, body, apiErrorText(body, fallback));
    }
    if (!parsed.json) return failure("invalid", status, "the body is not JSON");
    if (!opts.schema) return { ok: true, status, data: body };
    const checked = check(opts.schema, body);
    if (!checked.ok) return failure("invalid", status, checked.error, body);
    return { ok: true, status, data: checked.value };
  } finally {
    if (timer !== null) clearTimeout(timer);
    caller?.removeEventListener("abort", onCallerAbort);
  }
}
