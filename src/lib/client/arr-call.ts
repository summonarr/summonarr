// The admin Radarr/Sonarr pages' one way to call their routes
// (/api/admin/arr/**, /api/admin/arr-health/**): the Download History, the
// health panel, Arr System and the title manager all go through here.
//
// - fetchJson underneath (fetch-json.ts): a timeout, the caller's abort, and
//   the route's own refusal text read the shared way (api-error.ts) — else the
//   caller's fallback. A proxy's own error page is "no answer", never the
//   route's (guardrail 37a).
// - A shape check on every answer (validate.ts): a 2xx whose body is not what
//   the page drives on is a failure with the fallback text, never a render
//   crash. The default only asks for a JSON object.
// - A read gives up after ARR_READ_TIMEOUT_MS, a write after
//   ARR_WRITE_TIMEOUT_MS: a stuck proxy or a half-open connection can't hold a
//   spinner, and every control it disables, forever.
// - arrCallJob: a call the route runs as a BACKGROUND job (`async: true` →
//   202 { job }), its `?job=` polled through the shared counted loop
//   (job-poll.ts). No answer is `stillRunning`, never the change's failure.
//
// No server imports and no clock read, so the unit suite loads it as is
// (tests/arr-call.test.mts).
import { fetchJson, jsonInit } from "./fetch-json";
import { apiErrorText } from "./api-error";
import { jobIdOf, pollJob } from "./job-poll";
import { check, v, type Schema } from "../validate";

/** A read: the server's own arr reads give up well before this (30 s each, 10 s when polled). */
export const ARR_READ_TIMEOUT_MS = 90_000;
/**
 * A write: the server makes a few arr calls in a row (a read, the write, its
 * re-read), each bounded at 30 s. Past this the page stops waiting; it says the
 * call failed, as a reverse proxy cutting the request at ~60–100 s would.
 */
export const ARR_WRITE_TIMEOUT_MS = 120_000;

export type ArrCallResult<T> =
  | { ok: true; status: number; data: T }
  | {
      ok: false;
      /** The route's status; 0 when no answer came (aborted, timed out, a proxy's own page). */
      status: number;
      /** Display text: the route's own reason, else the caller's fallback ("" when aborted). */
      error: string;
      /** The refusal's JSON body, for routes that send more than a reason (409 warningsOnly, provider, detail). */
      body: Record<string, unknown> | null;
      /** The caller's signal ended it: show nothing. */
      aborted: boolean;
    };

export interface ArrCallOptions<T> {
  /** GET when absent. */
  method?: string;
  /** Sent as JSON. */
  body?: unknown;
  /** The error text when the route gave no reason of its own. */
  fallback: string;
  /** What the page drives on; a JSON object by default. */
  schema?: Schema<T>;
  signal?: AbortSignal;
  /** By default ARR_READ_TIMEOUT_MS for a GET, else ARR_WRITE_TIMEOUT_MS. */
  timeoutMs?: number;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** Any JSON object, every key kept. */
export const ANY_OBJECT: Schema<Record<string, unknown>> = v.record(v.unknown());

/**
 * An object one of our own routes built from its typed projection
 * (src/lib/arr-*.ts), checked by `test` on the fields the page keys, compares
 * or iterates on, and passed on whole. Not v.object: that keeps only the keys
 * it declares, so every display field would need declaring twice, and a field
 * the route adds later would silently vanish from the page.
 */
export function routeShape<T extends object>(expected: string, test: (value: Record<string, unknown>) => boolean): Schema<T> {
  return {
    expected,
    run: (value) =>
      isRecord(value) && test(value)
        ? { ok: true, value: value as T }
        : { ok: false, path: [], message: `expected ${expected}` },
  };
}

/** A JSON answer read as a call's result: the data when a 2xx carries what `schema` asks for, else the route's reason. */
export function arrAnswer<T>(status: number, body: unknown, fallback: string, schema: Schema<T>): ArrCallResult<T> {
  const refusal = isRecord(body) ? body : null;
  if (status >= 200 && status <= 299) {
    const checked = check(schema, body);
    if (checked.ok) return { ok: true, status, data: checked.value };
    return { ok: false, status, error: fallback, body: refusal, aborted: false };
  }
  return { ok: false, status, error: apiErrorText(refusal, fallback), body: refusal, aborted: false };
}

export function arrCall(url: string, opts: ArrCallOptions<Record<string, unknown>> & { schema?: undefined }): Promise<ArrCallResult<Record<string, unknown>>>;
export function arrCall<T>(url: string, opts: ArrCallOptions<T> & { schema: Schema<T> }): Promise<ArrCallResult<T>>;
/** One call to an admin arr route. `url` already carries the base path. Never throws. */
export async function arrCall<T>(url: string, opts: ArrCallOptions<T>): Promise<ArrCallResult<T>> {
  const method = opts.method ?? "GET";
  const schema = (opts.schema ?? ANY_OBJECT) as Schema<T>;
  const res = await fetchJson(url, {
    init: opts.body === undefined ? { method } : jsonInit(method, opts.body),
    schema,
    signal: opts.signal,
    timeoutMs: opts.timeoutMs ?? (method === "GET" ? ARR_READ_TIMEOUT_MS : ARR_WRITE_TIMEOUT_MS),
    fallbackError: opts.fallback,
  });
  if (res.ok) return { ok: true, status: res.status, data: res.data as T };
  return {
    ok: false,
    status: res.status,
    error: res.kind === "aborted" ? "" : res.error,
    body: isRecord(res.body) ? res.body : null,
    aborted: res.kind === "aborted",
  };
}

// ── background jobs ──────────────────────────────────────────────────────────

/** The body a "no answer yet" result carries: the job keeps running on the server and may still finish. */
export const STILL_RUNNING_BODY = Object.freeze({ stillRunning: true });

export interface ArrJobOptions<T> extends ArrCallOptions<T> {
  method: string;
  body: Record<string, unknown>;
  /** The text shown when the wait ended with no answer. */
  stillRunning: string;
  intervalMs: number;
  maxPolls: number;
  /** Failed polls in a row before giving up as "no answer" (job-poll.ts's default when absent). */
  failLimit?: number;
  /** For tests: an immediate wait. */
  sleep?: (ms: number) => Promise<void>;
}

/** A job's poll URL: the route's own URL (its query kept) with `job=<id>` added. */
export function jobUrl(url: string, job: string): string {
  return `${url}${url.includes("?") ? "&" : "?"}job=${encodeURIComponent(job)}`;
}

/**
 * `arrCall` as a background job: sent with `async: true`; a 202 { job } is
 * polled at `<url>?job=` (or `&job=` when `url` has a query) until the route's
 * own answer arrives. Any other first answer is returned as it came. Null when
 * the caller's signal ended the wait — the caller drops it.
 */
export async function arrCallJob<T>(url: string, opts: ArrJobOptions<T> & { schema: Schema<T> }): Promise<ArrCallResult<T> | null> {
  const { signal } = opts;
  // Any object first: a 202 names its job, anything else is checked as the answer below.
  const first = await arrCall(url, {
    method: opts.method,
    body: { ...opts.body, async: true },
    fallback: opts.fallback,
    signal,
    timeoutMs: opts.timeoutMs,
    schema: ANY_OBJECT,
  });
  if (signal?.aborted) return null;
  if (!first.ok) return first;
  if (first.status !== 202) return arrAnswer(first.status, first.data, opts.fallback, opts.schema);
  const job = jobIdOf(first.data);
  if (job === null) return { ok: false, status: 0, error: opts.fallback, body: null, aborted: false };
  const answer = await pollJob(globalThis.fetch, jobUrl(url, job), {
    isAlive: () => !signal?.aborted,
    intervalMs: opts.intervalMs,
    maxPolls: opts.maxPolls,
    failLimit: opts.failLimit,
    sleep: opts.sleep,
  });
  if (answer === null) return null;
  if (answer.status === 0) return { ok: false, status: 0, error: opts.stillRunning, body: { ...STILL_RUNNING_BODY }, aborted: false };
  return arrAnswer(answer.status, answer.data, opts.fallback, opts.schema);
}

/** A result that ended with no answer from the job: it may still finish on the server. */
export function isStillRunning(res: ArrCallResult<unknown>): boolean {
  return !res.ok && res.body?.stillRunning === true;
}
