import http from "node:http";
import https from "node:https";
import zlib from "node:zlib";
import { isIP } from "node:net";
import { PassThrough, Readable, Transform } from "node:stream";

import { canonicalSafeUrl, resolveSafeAddrsFresh, verifyResolvedHost } from "@/lib/ssrf";


export type SafeFetchErrorReason =
  | "ssrf-blocked"
  | "timeout"
  | "size"
  | "redirect"
  | "network";

// Strip the query string, any embedded credentials, the fragment and path-borne
// tokens from a URL before it can reach a log line. Several upstreams carry
// secrets in the query string (Plex `?X-Plex-Token=`, OMDb `?apikey=`,
// MDBList/ipinfo `?token=`), and SafeFetchError is routinely logged — sometimes
// as the whole error object — so the raw URL must never travel inside
// `.message` or `.url`.
export function redactUrlForLog(raw: string): string {
  try {
    const u = new URL(raw);
    u.search = "";
    u.username = "";
    u.password = "";
    // A fragment is never sent to the server, so it has no diagnostic value,
    // and a URL pasted into a notification agent may carry a token there.
    u.hash = "";
    // Discord carries its secret in the PATH, not the query: webhook URLs and
    // interaction follow-ups are both /webhooks/{id}/{token}[/...]. Without
    // this, a thrown SafeFetchError (timeout/network) from editOriginal or a
    // follow-up POST would embed the interaction token — a ~15-min bearer
    // credential for posting as the bot — in .message/.url, breaking the
    // "safe to log verbatim" contract below for path-borne secrets.
    u.pathname = u.pathname
      .replace(/(\/webhooks\/\d+\/)[^/]+/, "$1<redacted>")
      .split("/")
      .map((seg) => (isOpaqueToken(seg) ? "<redacted>" : seg))
      .join("/");
    return u.toString();
  } catch {
    return "[unparseable-url]";
  }
}

// A path segment that looks like a credential rather than a name or an id: 20+
// URL-safe characters that are random-looking — mixed case with digits, or
// digits and letters alternating often (a Slack-style hook token, an
// ntfy/Apprise key). A number, a slug ("the-matrix-1999") and a hex id
// (Jellyfin's 32-hex item ids) stay, so a logged path still says what was
// asked for.
function isOpaqueToken(seg: string): boolean {
  if (seg.length < 20 || !/^[A-Za-z0-9_-]+$/.test(seg)) return false;
  if (/^[0-9a-f]+$/i.test(seg)) return false;
  if (/[a-z]/.test(seg) && /[A-Z]/.test(seg) && /[0-9]/.test(seg)) return true;
  let transitions = 0;
  for (let i = 1; i < seg.length; i++) {
    const a = /[0-9]/.test(seg[i - 1]) ? 1 : /[A-Za-z]/.test(seg[i - 1]) ? 2 : 0;
    const b = /[0-9]/.test(seg[i]) ? 1 : /[A-Za-z]/.test(seg[i]) ? 2 : 0;
    if (a && b && a !== b) transitions++;
  }
  return transitions >= 4;
}

export class SafeFetchError extends Error {
  readonly reason: SafeFetchErrorReason;
  readonly url: string;
  constructor(reason: SafeFetchErrorReason, url: string, message: string) {
    // Redact both the `.url` field and any occurrence of the raw URL the caller
    // interpolated into `message`. Call sites pass the same `url` value they
    // interpolated, so a literal split/join scrubs it regardless of how
    // redaction reformats the URL. This makes EVERY SafeFetchError safe to log
    // verbatim — including future call sites — rather than relying on each
    // logger to reduce to `.reason`.
    const safeUrl = redactUrlForLog(url);
    super(url && safeUrl !== url ? message.split(url).join(safeUrl) : message);
    this.name = "SafeFetchError";
    this.reason = reason;
    this.url = safeUrl;
  }
}

export interface SafeFetchOptions extends Omit<RequestInit, "redirect"> {
  timeoutMs?: number;
  maxResponseBytes?: number;
  /** Give up connecting (TCP + TLS handshake) after this. Default: fetch's 10s. */
  connectTimeoutMs?: number;
  /** Drop a connection that receives nothing for this long while waiting for
   *  headers or reading the body. Default: fetch's 300s. */
  idleTimeoutMs?: number;
}

// Node's fetch (undici) defaults, kept by the pinned transport so a dead or
// silent host fails the way it did under fetch: a host that never answers is
// "network" after 10s, not a "timeout" after the caller's whole budget, and a
// long-lived stream (the Plex SSE feed) whose peer vanished is dropped after 5
// minutes of silence instead of hanging until its own recycle. The env-proxy
// path still uses fetch(), where undici applies the same values itself.
export const PINNED_CONNECT_TIMEOUT_MS = 10_000;
export const PINNED_IDLE_TIMEOUT_MS = 300_000;
// fetch refuses a response that stacks more content-codings than this: each one
// is another decompressor, so an unbounded chain is a memory/CPU sink.
export const MAX_CONTENT_ENCODINGS = 5;

const DEFAULT_TIMEOUT_MS = 15_000;
const DEFAULT_MAX_RESPONSE_BYTES = 10 * 1024 * 1024;
const USER_AGENT = "Summonarr/0.1";

type FetchMode = "hardcoded" | "admin" | "user";

// The DNS-rebind defence: the connection is PINNED to the validated addresses.
//
// fetch() hands the hostname to undici, which resolves it again at connect
// time, so no amount of checking beforehand can bind the connect to what was
// checked. (An undici Agent/dispatcher can't be used: undici is not a
// dependency, and Node's bundled copy is not importable from userland — an
// earlier attempt with the npm package broke on the Dispatcher handler shape.)
// So every mode converges on: check the URL against the mode's policy, resolve
// the host FRESH, require EVERY address to be safe under the mode's policy, and
// send the request with node:http(s) whose `lookup` returns only those
// addresses (see pinnedFetch). The TCP connect therefore goes to an address we
// validated, while TLS SNI / certificate verification and the Host header keep
// using the original hostname. Hardcoded mode resolves with allowPrivate=false:
// a hostname like `api.themoviedb.org` is never legitimately backed by a
// private IP.
//
// ONE lookup per request decides: the addresses checked are the addresses
// dialled, so there is no window between a check and a connect to rebind in.
// (An earlier shape validated a cached lookup and then pinned a second, fresh
// one; the first only added latency.) CDN-fronted hosts (api.themoviedb.org,
// *.push.apple.com, fcm.googleapis.com, …) return rotating answer sets, so no
// answer is compared with an earlier one: per-address safety plus the pin is
// what matters.
//
// Exception: with NODE_USE_ENV_PROXY and a proxy variable set, the PROXY
// resolves and dials the target, so the connection cannot be pinned from here.
// That path keeps a fresh resolve check, then fetch() by hostname — see
// envProxyActive().
async function doFetch(
  rawUrl: string,
  opts: SafeFetchOptions,
  mode: FetchMode,
  allowedHosts?: ReadonlySet<string>,
): Promise<Response> {
  const parsedUrl = parseHttpUrl(rawUrl);
  const target = resolveTargetForMode(parsedUrl, rawUrl, mode, allowedHosts);
  const deadline = createDeadline(rawUrl, opts);
  const allowPrivate = mode === "admin";

  const viaProxy = envProxyActive() || transportIsFetchSeam();
  // Behind a proxy (it dials the target) only the check is possible; otherwise
  // the request below connects to exactly this list.
  const pinnedAddrs = viaProxy
    ? (await deadline.withDnsDeadline(verifyResolvedHost(parsedUrl.hostname, { allowPrivate }))) ? [] : null
    : await deadline.withDnsDeadline(resolveSafeAddrsFresh(parsedUrl.hostname, { allowPrivate }));
  if (!pinnedAddrs) throw new SafeFetchError("ssrf-blocked", rawUrl, target.blockedMessage);

  const headers = new Headers(opts.headers);
  if (!headers.has("user-agent")) headers.set("user-agent", USER_AGENT);
  const { timeoutMs: _t, maxResponseBytes: _m, connectTimeoutMs, idleTimeoutMs, ...rest } = opts;
  void _t; void _m;
  const init: RequestInit = { ...rest, headers, redirect: "error", signal: deadline.signal };

  let res: Response;
  try {
    res = viaProxy
      ? await fetch(target.url, init)
      : await pinnedFetch(target.url, init, pinnedAddrs, deadline.signal, {
          connectTimeoutMs: connectTimeoutMs ?? PINNED_CONNECT_TIMEOUT_MS,
          idleTimeoutMs: idleTimeoutMs ?? PINNED_IDLE_TIMEOUT_MS,
        });
  } catch (err) {
    throw mapTransportError(err, target.url, deadline.timeoutMs);
  }
  return await wrapResponseBody(res, opts.maxResponseBytes ?? DEFAULT_MAX_RESPONSE_BYTES, target.url);
}

function parseHttpUrl(rawUrl: string): URL {
  let parsedUrl: URL;
  try {
    parsedUrl = new URL(rawUrl);
  } catch {
    throw new SafeFetchError("ssrf-blocked", rawUrl, `Invalid URL: ${rawUrl}`);
  }
  if (parsedUrl.protocol !== "http:" && parsedUrl.protocol !== "https:") {
    throw new SafeFetchError("ssrf-blocked", rawUrl, `Protocol not allowed: ${parsedUrl.protocol}`);
  }
  return parsedUrl;
}

/**
 * The URL a mode sends and the message its address check refuses with. Throws
 * for a trusted host that isn't on the allowlist; the address policy itself
 * runs on the one lookup in doFetch.
 */
function resolveTargetForMode(
  parsedUrl: URL,
  rawUrl: string,
  mode: FetchMode,
  allowedHosts: ReadonlySet<string> | undefined,
): { url: string; blockedMessage: string } {
  if (mode === "hardcoded") {
    if (!allowedHosts || allowedHosts.size === 0) {
      throw new SafeFetchError("ssrf-blocked", rawUrl, "safeFetchTrusted requires a non-empty allowedHosts list");
    }
    const host = parsedUrl.hostname.toLowerCase();
    if (!allowedHosts.has(host)) {
      throw new SafeFetchError("ssrf-blocked", rawUrl, `URL blocked by trusted-host policy (host=${host}): ${rawUrl}`);
    }
    // The outbound request derives from `parsedUrl`, whose hostname was just
    // checked against the required allowlist — not from the raw input — so
    // there is no untrusted-host path from caller input to the network call.
    // The hostname is kept (never the resolved IP): TLS SNI and
    // virtual-hosted endpoints both need it.
    return {
      url: parsedUrl.toString(),
      // Hardcoded hosts (TMDB, plex.tv, …) must resolve to public addresses.
      blockedMessage: `URL blocked by SSRF policy (trusted host resolves to unsafe address): ${rawUrl}`,
    };
  }
  // "user": a URL with no hostname allowlist — Web Push, whose subscription
  // endpoints span an unbounded set of vendor push services — under the full
  // policy. "admin": a URL from Settings, where LAN/loopback is allowed.
  return { url: canonicalSafeUrl(parsedUrl), blockedMessage: `URL blocked by SSRF policy: ${rawUrl}` };
}

// Created BEFORE any DNS work so resolution counts against the caller's
// declared budget. dns.lookup (getaddrinfo) itself accepts no timeout and
// cannot be cancelled — when the OS resolver is unreachable it blocks for the
// resolver deadline (~5s × attempts × nameservers, up to ~40s) — so the race in
// withDnsDeadline bounds the caller's WALL TIME to timeoutMs while the orphaned
// lookup drains in the threadpool. Without this, the 5s poller and SSE
// reconnect overran their per-tick budgets by an order of magnitude during DNS
// outages.
function createDeadline(rawUrl: string, opts: SafeFetchOptions) {
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const timeoutSignal = AbortSignal.timeout(timeoutMs);
  const signal = opts.signal ? AbortSignal.any([opts.signal, timeoutSignal]) : timeoutSignal;
  // Only OUR budget is a timeout. The caller's own abort is classified the way
  // the request phase classifies it (mapTransportError): its own TimeoutError
  // is a timeout, anything else is "network" carrying the caller's reason —
  // never "timed out" for a request the caller cancelled.
  const dnsAbortError = (timeoutMessage: string): SafeFetchError => {
    const reason: unknown = timeoutSignal.aborted ? undefined : opts.signal?.reason;
    if (reason === undefined || (reason instanceof Error && reason.name === "TimeoutError")) {
      return new SafeFetchError("timeout", rawUrl, timeoutMessage);
    }
    const why = reason instanceof Error ? reason.message : String(reason);
    return new SafeFetchError("network", rawUrl, `Request to ${rawUrl} was aborted by the caller during DNS resolution: ${why}`);
  };
  const withDnsDeadline = async <T>(work: Promise<T>): Promise<T> => {
    if (signal.aborted) {
      throw dnsAbortError(`Request to ${rawUrl} timed out after ${timeoutMs}ms (before DNS resolution)`);
    }
    return await new Promise<T>((resolve, reject) => {
      const onAbort = () => reject(dnsAbortError(`DNS resolution for ${rawUrl} exceeded the ${timeoutMs}ms budget`));
      signal.addEventListener("abort", onAbort, { once: true });
      work.then(
        (v) => { signal.removeEventListener("abort", onAbort); resolve(v); },
        (e) => { signal.removeEventListener("abort", onAbort); reject(e); },
      );
    });
  };
  return { timeoutMs, signal, withDnsDeadline };
}

// A transport failure as the SafeFetchError callers branch on. The transport's
// own connect/idle timeouts are "network" on purpose, as they were under
// fetch (see PINNED_CONNECT_TIMEOUT_MS); only the caller's budget is "timeout".
function mapTransportError(err: unknown, targetUrl: string, timeoutMs: number): SafeFetchError {
  if (err instanceof Error) {
    const cause = (err as { cause?: { name?: string; message?: unknown } }).cause;
    if (err.name === "TimeoutError" || cause?.name === "TimeoutError") {
      return new SafeFetchError("timeout", targetUrl, `Request to ${targetUrl} timed out after ${timeoutMs}ms`);
    }
    // Both transports refuse a redirect as TypeError("fetch failed") whose
    // CAUSE says why — pinnedFetch's refuse() and undici's redirect:"error"
    // alike — so the message alone never matched and a deterministic 3xx
    // surfaced as a retryable "network" failure.
    if (err instanceof TypeError && (/redirect/i.test(err.message) || cause?.message === "unexpected redirect")) {
      return new SafeFetchError(
        "redirect",
        targetUrl,
        `Request to ${targetUrl} attempted to redirect (unexpected redirect, blocked by safeFetch)`,
      );
    }
  }
  const e = err as Error & { cause?: { code?: string; message?: string } };
  const causeMsg = e?.cause?.message ?? e?.cause?.code ?? "";
  const message = e instanceof Error ? e.message : String(err);
  const detail = causeMsg ? `${message} (${causeMsg})` : message;
  return new SafeFetchError("network", targetUrl, `fetch failed for ${targetUrl}: ${detail}`);
}

// The size cap, declared and streamed, and headers that describe the body the
// caller actually reads.
async function wrapResponseBody(res: Response, maxResponseBytes: number, targetUrl: string): Promise<Response> {
  const contentLength = res.headers.get("content-length");
  if (contentLength) {
    const size = parseInt(contentLength, 10);
    if (!isNaN(size) && size > maxResponseBytes) {
      try {
        await res.body?.cancel();
      } catch {
        // The refusal below is the answer either way.
      }
      throw new SafeFetchError("size", targetUrl, `Response body declared ${size} bytes, exceeds cap ${maxResponseBytes}`);
    }
  }
  if (!res.body) return res;
  // Both transports hand back DECODED bytes, but `res.headers` still carries
  // the upstream Content-Encoding and the original (compressed)
  // Content-Length. Copied verbatim onto the re-wrapped Response they could
  // make a consumer decompress already-decompressed bytes (Response.json()
  // then parses the gzip magic header and throws), so both are dropped.
  const sanitizedHeaders = new Headers(res.headers);
  sanitizedHeaders.delete("content-encoding");
  sanitizedHeaders.delete("content-length");
  return new Response(limitResponseBody(res.body, maxResponseBytes, targetUrl), {
    status: res.status,
    statusText: res.statusText,
    headers: sanitizedHeaders,
  });
}

// True when Node's env-proxy support is on AND a proxy variable is set: http(s)
// traffic is then dialled by the proxy, which resolves the target itself, so a
// pinned connect is impossible. Mirrors how Node 24+ opts fetch in
// (NODE_USE_ENV_PROXY=1); the app never sets it, and the image doesn't either.
// Test seam: the unit suite stubs outbound HTTP by replacing globalThis.fetch.
// When (and only when) the harness flag is set (tests/_loader.mjs, which also
// records the native fetch), NODE_ENV is not production, and fetch has actually
// been replaced, use that fetch instead of the pinned
// transport. Production bundles constant-fold NODE_ENV, so the branch is absent
// there; a stray global fetch replacement can never switch off the pin in prod.
function transportIsFetchSeam(): boolean {
  return (
    process.env.NODE_ENV !== "production" &&
    process.env.SUMMONARR_TEST_FETCH_SEAM === "1" &&
    globalThis.fetch !== (globalThis as { __summonarrNativeFetch?: typeof fetch }).__summonarrNativeFetch
  );
}

function envProxyActive(): boolean {
  const flag = process.env.NODE_USE_ENV_PROXY;
  if (!flag || flag === "0" || flag.toLowerCase() === "false") return false;
  const e = process.env;
  return Boolean(
    e.HTTP_PROXY || e.http_proxy || e.HTTPS_PROXY || e.https_proxy || e.ALL_PROXY || e.all_proxy,
  );
}

interface PinnedLookupOptions { family?: number | string; all?: boolean }
type PinnedLookupCb = (
  err: Error | null,
  address?: string | { address: string; family: number }[],
  family?: number,
) => void;

// The pinned resolver: whatever hostname the socket layer asks about, answer
// ONLY with the validated addresses. This is the whole defence — there is no
// second DNS query to rebind.
export function makePinnedLookup(addrs: readonly string[]) {
  const pinned = addrs.map((address) => ({ address, family: isIP(address) || 4 }));
  return (_host: string, optionsOrCb: PinnedLookupOptions | PinnedLookupCb, maybeCb?: PinnedLookupCb): void => {
    const cb = (typeof optionsOrCb === "function" ? optionsOrCb : maybeCb) as PinnedLookupCb;
    const options: PinnedLookupOptions = typeof optionsOrCb === "function" ? {} : optionsOrCb;
    const want = options.family === 4 || options.family === "IPv4" ? 4
      : options.family === 6 || options.family === "IPv6" ? 6 : 0;
    const list = want ? pinned.filter((p) => p.family === want) : pinned;
    if (list.length === 0) {
      cb(Object.assign(new Error("no pinned address for requested family"), { code: "ENOTFOUND" }));
      return;
    }
    if (options.all) cb(null, list);
    else cb(null, list[0].address, list[0].family);
  };
}

// Connection options for a pinned request. `hostname` stays the ORIGINAL host so
// the Host header and (via the default servername) TLS SNI + certificate
// verification use it; only the address lookup is pinned. agent:false = a fresh
// single-use agent per request, so no socket (and thus no pinned address) is ever
// reused across requests or hosts.
export function buildPinnedRequestOptions(
  url: URL,
  addrs: readonly string[],
  extra: { method: string; headers: Record<string, string>; signal: AbortSignal },
): https.RequestOptions {
  const hostname = url.hostname.startsWith("[") ? url.hostname.slice(1, -1) : url.hostname;
  const isHttps = url.protocol === "https:";
  return {
    protocol: url.protocol,
    hostname,
    port: url.port || undefined,
    path: `${url.pathname}${url.search}`,
    method: extra.method,
    headers: extra.headers,
    agent: false,
    lookup: makePinnedLookup(addrs) as unknown as https.RequestOptions["lookup"],
    signal: extra.signal,
    ...(isHttps && !isIP(hostname) ? { servername: hostname } : {}),
  };
}

// Decoders are as lenient as fetch's (and curl's): sync-flush, so a body with a
// missing or short trailer still yields what it decoded instead of erroring.
const ZLIB_LENIENT = { flush: zlib.constants.Z_SYNC_FLUSH, finishFlush: zlib.constants.Z_SYNC_FLUSH };
const BROTLI_LENIENT = {
  flush: zlib.constants.BROTLI_OPERATION_FLUSH,
  finishFlush: zlib.constants.BROTLI_OPERATION_FLUSH,
};

// "deflate" should be zlib-wrapped, but some servers send raw DEFLATE under it.
// Like fetch, pick the decoder from the first byte: a zlib header's low nibble
// is 8 (CM=deflate).
//
// Backpressure, as pipe() gives the gzip/br decoders: the inflater is paused
// whenever this stream's readable side is full and resumed when it is read.
// Without that, its 'data' listener kept it flowing and ONE input chunk was
// inflated completely into this buffer (deflate reaches ~1000:1) before the byte
// cap downstream (limitResponseBody) could see any of it. Paused, zlib itself
// stops inflating once its own buffer is full and holds the write callback, so
// no further input is taken either. Exported for the unit suite.
export function createDeflateDecoder(): Transform {
  let inner: zlib.Inflate | zlib.InflateRaw | null = null;
  const t: Transform = new Transform({
    transform(chunk: Buffer, _enc, cb) {
      if (!inner) {
        if (chunk.length === 0) { cb(); return; }
        const created = (chunk[0] & 0x0f) === 0x08 ? zlib.createInflate(ZLIB_LENIENT) : zlib.createInflateRaw(ZLIB_LENIENT);
        created.on("data", (d: Buffer) => { if (!t.push(d)) created.pause(); });
        created.on("error", (err) => t.destroy(err));
        inner = created;
      }
      inner.write(chunk, () => cb());
    },
    read(size) {
      inner?.resume();
      Transform.prototype._read.call(this, size);
    },
    flush(cb) {
      if (!inner) { cb(); return; }
      inner.once("end", () => cb());
      inner.end();
    },
    destroy(err, cb) {
      inner?.destroy();
      cb(err);
    },
  });
  return t;
}

function decoderFor(encoding: string): Transform | null {
  switch (encoding) {
    case "gzip":
    case "x-gzip":
      return zlib.createGunzip(ZLIB_LENIENT);
    case "deflate":
      return createDeflateDecoder();
    case "br":
      return zlib.createBrotliDecompress(BROTLI_LENIENT);
    default:
      return null;
  }
}

// Readable.toWeb replaces an error that carries a `code` (every zlib and socket
// error does) with a TypeError whose message is EMPTY, so a failed decode read
// as "Response body read failed for …: " with no reason. Hand the stream a
// plain Error with the message and keep the original as its cause.
function streamError(err: unknown): Error {
  if (err instanceof Error && !("code" in err)) return err;
  const message = err instanceof Error ? err.message : String(err);
  return new Error(message || "response body failed", { cause: err });
}

function transportTimeout(message: string, code: string): Error {
  return Object.assign(new Error(message), { code });
}

// A fetch() look-alike over node:http(s) that dials ONLY `addrs`. Preserves what
// the rest of doFetch relies on: redirect:"error" semantics, transparent
// gzip/deflate/br decoding (the size cap sees decoded bytes), abort/timeout via
// `signal` (rejecting with signal.reason, like fetch), fetch's connect and idle
// timeouts, and a standard Response.
async function pinnedFetch(
  targetUrl: string,
  init: RequestInit,
  addrs: readonly string[],
  signal: AbortSignal,
  limits: { connectTimeoutMs: number; idleTimeoutMs: number },
): Promise<Response> {
  // Request() normalises body/headers exactly as fetch would (and throws the same
  // TypeErrors, e.g. URL credentials, GET with a body).
  const request = new Request(targetUrl, init);
  const body = request.body ? Buffer.from(await request.arrayBuffer()) : undefined;
  const url = new URL(request.url);
  const opts = buildPinnedRequestOptions(url, addrs, { method: request.method, headers: pinnedRequestHeaders(request, body), signal });
  const isHttps = url.protocol === "https:";
  const transport = isHttps ? https : http;

  return await new Promise<Response>((resolve, reject) => {
    // Set when this transport ends the connection itself (a connect or idle
    // timeout), so THAT is the error callers see, not the socket reset it causes.
    let ownError: Error | null = null;
    let gotHeaders = false;
    // This promise must settle on EVERY path: doFetch awaits it with nothing
    // else racing it, so a path that never settles hangs the caller forever.
    let settled = false;
    const onAbort = () => {
      settle(() => reject(signal.reason));
      creq.destroy();
    };
    const settle = (fn: () => void) => {
      if (settled) return;
      settled = true;
      signal.removeEventListener("abort", onAbort);
      fn();
    };
    const refuse = (cause: unknown) => settle(() => reject(new TypeError("fetch failed", { cause })));
    const fail = (err: unknown) => settle(() => {
      reject(signal.aborted ? signal.reason : new TypeError("fetch failed", { cause: ownError ?? err }));
    });
    const creq = transport.request(opts, (res) => {
      gotHeaders = true;
      const answer = responseFromIncoming(res, request.method, signal, () => ownError);
      if (answer.ok) settle(() => resolve(answer.response));
      else refuse(answer.cause);
    });
    // A 101. Without this listener Node drops the socket and emits neither
    // 'response' nor 'error'. fetch refuses an upgrade too.
    creq.on("upgrade", (res, socket) => {
      socket.destroy();
      refuse(new Error(`unexpected upgrade (status ${res.statusCode})`));
    });
    armTransportTimeouts(creq, limits, isHttps, () => gotHeaders, (err) => {
      ownError ??= err;
      creq.destroy(err);
    });
    creq.on("error", fail);
    // Backstop: a request that closes before anything settled it fails now
    // instead of hanging.
    creq.on("close", () => fail(new Error("connection closed before a response")));
    // Node's own `signal` listener is removed once the request closes, so the
    // signal is watched here too: timeoutMs and the caller's signal always
    // bound the wait for headers, as they did under fetch().
    if (signal.aborted) onAbort();
    else signal.addEventListener("abort", onAbort, { once: true });
    creq.end(body);
  });
}

function pinnedRequestHeaders(request: Request, body: Buffer | undefined): Record<string, string> {
  const headers: Record<string, string> = {};
  request.headers.forEach((v, k) => { headers[k] = v; });
  if (!("accept" in headers)) headers["accept"] = "*/*";
  if (!("accept-encoding" in headers)) headers["accept-encoding"] = "gzip, deflate, br";
  if (body && !("content-length" in headers)) headers["content-length"] = String(body.byteLength);
  return headers;
}

// Connect timeout: TCP connect plus, for https, the TLS handshake. The socket
// is always fresh (agent:false), so it is still connecting when it arrives.
// Idle timeout: socket inactivity, armed once connected — covers waiting for
// the headers and every gap between body chunks. Each ends the request through
// `kill` with undici's error code, so the caller sees the timeout, not the
// reset it causes.
function armTransportTimeouts(
  creq: http.ClientRequest,
  limits: { connectTimeoutMs: number; idleTimeoutMs: number },
  isHttps: boolean,
  gotHeaders: () => boolean,
  kill: (err: Error) => void,
): void {
  creq.once("socket", (socket) => {
    const timer = setTimeout(() => {
      kill(transportTimeout(`Connect Timeout Error (timeout: ${limits.connectTimeoutMs}ms)`, "UND_ERR_CONNECT_TIMEOUT"));
    }, limits.connectTimeoutMs);
    const clear = () => clearTimeout(timer);
    socket.once(isHttps ? "secureConnect" : "connect", clear);
    socket.once("close", clear);
  });
  creq.setTimeout(limits.idleTimeoutMs, () => {
    kill(gotHeaders()
      ? transportTimeout(`Body Timeout Error (no data for ${limits.idleTimeoutMs}ms)`, "UND_ERR_BODY_TIMEOUT")
      : transportTimeout(`Headers Timeout Error (no response for ${limits.idleTimeoutMs}ms)`, "UND_ERR_HEADERS_TIMEOUT"));
  });
}

type IncomingAnswer = { ok: true; response: Response } | { ok: false; cause: unknown };

// The Response for an answer that arrived, or why it is refused. Never throws:
// a throw in the 'response' handler would escape as an uncaughtException and
// leave pinnedFetch's promise pending (new Response() throws on a reason phrase
// holding a control character, which Node's HTTP parser accepts), so whatever
// was built is torn down and the throw becomes a refusal.
function responseFromIncoming(
  res: http.IncomingMessage,
  method: string,
  signal: AbortSignal,
  ownError: () => Error | null,
): IncomingAnswer {
  let teardown = () => { res.destroy(); };
  try {
    const status = res.statusCode ?? 0;
    if ([301, 302, 303, 307, 308].includes(status) && res.headers.location) {
      res.destroy();
      return { ok: false, cause: new Error("unexpected redirect") };
    }
    const respHeaders = new Headers();
    for (let i = 0; i + 1 < res.rawHeaders.length; i += 2) {
      try { respHeaders.append(res.rawHeaders[i], res.rawHeaders[i + 1]); } catch { /* skip an unrepresentable header */ }
    }
    if (status < 200 || status > 599) {
      res.destroy();
      return { ok: false, cause: new Error(`unsupported status ${status}`) };
    }
    if (method === "HEAD" || status === 204 || status === 205 || status === 304) {
      res.resume();
      return { ok: true, response: new Response(null, { status, statusText: res.statusMessage ?? "", headers: respHeaders }) };
    }
    const decoders = decodersForContentEncoding(res.headers["content-encoding"]);
    if (!Array.isArray(decoders)) {
      res.destroy();
      return { ok: false, cause: decoders.tooMany };
    }
    const piped = pipeDecoded(res, decoders, signal, ownError);
    teardown = piped.destroyAll;
    return {
      ok: true,
      response: new Response(Readable.toWeb(piped.out) as ReadableStream<Uint8Array>, {
        status,
        statusText: res.statusMessage ?? "",
        headers: respHeaders,
      }),
    };
  } catch (err) {
    teardown();
    return { ok: false, cause: err };
  }
}

// Codings are listed in the order they were applied, so they are undone last to
// first. Like fetch: more than MAX_CONTENT_ENCODINGS is refused, and an unknown
// coding anywhere means none can be undone, so the body is passed through raw
// (no decoders).
function decodersForContentEncoding(header: string | undefined): Transform[] | { tooMany: Error } {
  const encodings = (header ?? "")
    .split(",").map((s) => s.trim().toLowerCase()).filter((s) => s && s !== "identity").reverse();
  if (encodings.length > MAX_CONTENT_ENCODINGS) {
    return { tooMany: new Error(`too many content-encodings in response: ${encodings.length}, maximum allowed is ${MAX_CONTENT_ENCODINGS}`) };
  }
  const decoders: Transform[] = [];
  for (const enc of encodings) {
    const d = decoderFor(enc);
    if (!d) {
      for (const x of decoders) x.destroy();
      return [];
    }
    decoders.push(d);
  }
  return decoders;
}

// res → each decoder → out, with one teardown for every stage: an error
// anywhere (or a connection that closes before the body completed) errors
// `out` with the transport's own timeout if it caused it, else the caller's
// abort reason, else the failure itself.
function pipeDecoded(
  res: http.IncomingMessage,
  decoders: readonly Transform[],
  signal: AbortSignal,
  ownError: () => Error | null,
): { out: PassThrough; destroyAll: (err?: unknown) => void } {
  const stages: NodeJS.ReadableStream[] = [res];
  const out = new PassThrough();
  const destroyAll = (err?: unknown) => {
    const e = err === undefined ? undefined : (signal.aborted ? signal.reason : streamError(ownError() ?? err));
    out.destroy(e as Error | undefined);
    for (const s of stages) (s as Readable).destroy();
  };
  let last: NodeJS.ReadableStream = res;
  for (const d of decoders) {
    d.on("error", destroyAll);
    last = last.pipe(d);
    stages.push(d);
  }
  res.on("error", destroyAll);
  res.on("close", () => { if (!res.complete) destroyAll(new Error("terminated")); });
  last.pipe(out);
  out.on("close", () => { for (const s of stages) (s as Readable).destroy(); });
  return { out, destroyAll };
}

function limitResponseBody(
  source: ReadableStream<Uint8Array>,
  maxBytes: number,
  url: string,
): ReadableStream<Uint8Array> {
  let total = 0;
  const reader = source.getReader();
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        const { value, done } = await reader.read();
        if (done) {
          controller.close();
          return;
        }
        if (value) {
          total += value.byteLength;
          if (total > maxBytes) {
            controller.error(
              new SafeFetchError(
                "size",
                url,
                `Response body exceeded cap ${maxBytes} bytes`,
              ),
            );
            reader.cancel().catch(() => {});
            return;
          }
          controller.enqueue(value);
        }
      } catch (err) {
        // A failure that lands MID-BODY (the timeout firing while streaming, a
        // torn-down connection) must keep the SafeFetchError contract callers
        // branch on — undici's raw "TimeoutError"/"terminated" would otherwise
        // escape it via res.json()/text() and defeat `err.reason` checks like
        // arrFetch's tolerant timeout branch.
        if (err instanceof SafeFetchError) {
          controller.error(err);
        } else if (err instanceof Error && (err.name === "TimeoutError" || (err as { cause?: { name?: string } }).cause?.name === "TimeoutError")) {
          controller.error(new SafeFetchError("timeout", url, `Response body read from ${url} timed out mid-stream`));
        } else {
          const msg = err instanceof Error ? err.message : String(err);
          controller.error(new SafeFetchError("network", url, `Response body read failed for ${url}: ${msg}`));
        }
      }
    },
    cancel(reason) {
      reader.cancel(reason).catch(() => {});
    },
  });
}

export interface TrustedFetchOptions extends SafeFetchOptions {
  /** Hostname allowlist — request is rejected if URL hostname isn't in this set. Required. */
  allowedHosts: readonly string[];
}

// safeFetchTrusted enforces a hardcoded hostname allowlist AND still runs DNS-based SSRF
// validation (resolve + per-address public-IP check, allowPrivate=false, so DNS-rebind to
// a private address is blocked) — use for fixed third-party APIs (TMDB, plex.tv, discord.com,
// …). Pass the expected host(s) so a future code change can't accidentally fan out to
// user-controlled URLs.
export function safeFetchTrusted(
  url: string,
  opts: TrustedFetchOptions,
): Promise<Response> {
  const set = new Set(opts.allowedHosts.map((h) => h.toLowerCase()));
  const { allowedHosts: _ignored, ...rest } = opts;
  void _ignored;
  return doFetch(url, rest, "hardcoded", set);
}

// safeFetchAdminConfigured runs the SSRF policy with allowPrivate=true — use for
// URLs persisted in the Setting table (Radarr/Sonarr/Jellyfin/Plex server). Admins
// legitimately point these at LAN/loopback, so RFC1918 is permitted; link-local
// (cloud metadata) and unspecified addresses stay blocked.
export function safeFetchAdminConfigured(
  url: string,
  opts: SafeFetchOptions = {},
): Promise<Response> {
  return doFetch(url, opts, "admin");
}

// safeFetch runs the full SSRF policy (allowPrivate=false) with no hostname
// allowlist — use for genuinely user-supplied URLs whose host set is unbounded
// (e.g. Web Push subscription endpoints, which fan out across every vendor push
// service). RFC1918/loopback/link-local/CGNAT/multicast are all blocked.
export function safeFetch(
  url: string,
  opts: SafeFetchOptions = {},
): Promise<Response> {
  return doFetch(url, opts, "user");
}
