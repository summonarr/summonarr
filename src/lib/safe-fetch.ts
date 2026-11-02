import http from "node:http";
import https from "node:https";
import zlib from "node:zlib";
import { isIP } from "node:net";
import { PassThrough, Readable } from "node:stream";

import { resolveToSafeUrlWithAddrs, resolveSafeAddrsFresh, verifyResolvedHost } from "@/lib/ssrf";


export type SafeFetchErrorReason =
  | "ssrf-blocked"
  | "timeout"
  | "size"
  | "redirect"
  | "network";

// Strip the query string and any embedded credentials from a URL before it can
// reach a log line. Several upstreams carry secrets in the query string (Plex
// `?X-Plex-Token=`, OMDb `?apikey=`, MDBList/ipinfo `?token=`), and SafeFetchError
// is routinely logged — sometimes as the whole error object — so the raw URL must
// never travel inside `.message` or `.url`.
export function redactUrlForLog(raw: string): string {
  try {
    const u = new URL(raw);
    u.search = "";
    u.username = "";
    u.password = "";
    // Discord carries its secret in the PATH, not the query: webhook URLs and
    // interaction follow-ups are both /webhooks/{id}/{token}[/...]. Without
    // this, a thrown SafeFetchError (timeout/network) from editOriginal or a
    // follow-up POST would embed the interaction token — a ~15-min bearer
    // credential for posting as the bot — in .message/.url, breaking the
    // "safe to log verbatim" contract below for path-borne secrets.
    u.pathname = u.pathname.replace(/(\/webhooks\/\d+\/)[^/]+/, "$1<redacted>");
    return u.toString();
  } catch {
    return "[unparseable-url]";
  }
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
}

const DEFAULT_TIMEOUT_MS = 15_000;
const DEFAULT_MAX_RESPONSE_BYTES = 10 * 1024 * 1024;
const USER_AGENT = "Summonarr/0.1";

type FetchMode = "hardcoded" | "admin" | "user";

async function doFetch(
  rawUrl: string,
  opts: SafeFetchOptions,
  mode: FetchMode,
  allowedHosts?: ReadonlySet<string>,
): Promise<Response> {

  let parsedUrl: URL;
  try {
    parsedUrl = new URL(rawUrl);
    const proto = parsedUrl.protocol;
    if (proto !== "http:" && proto !== "https:") {
      throw new SafeFetchError("ssrf-blocked", rawUrl, `Protocol not allowed: ${proto}`);
    }
  } catch (e) {
    if (e instanceof SafeFetchError) throw e;
    throw new SafeFetchError("ssrf-blocked", rawUrl, `Invalid URL: ${rawUrl}`);
  }

  // DNS-rebind defence: the connection is PINNED to the validated addresses.
  //
  // fetch() hands the hostname to undici, which resolves it again at connect
  // time, so no amount of checking beforehand can bind the connect to what was
  // checked. (An undici Agent/dispatcher can't be used: undici is not a
  // dependency, and Node's bundled copy is not importable from userland — an
  // earlier attempt with the npm package broke on the Dispatcher handler shape.)
  // So every mode converges on: validate (cached resolve + policy check), then
  // resolve FRESH, require EVERY address to be safe under the mode's policy, and
  // send the request with node:http(s) whose `lookup` returns only those
  // addresses (see pinnedFetch). The TCP connect therefore goes to an address we
  // validated, while TLS SNI / certificate verification and the Host header keep
  // using the original hostname. Hardcoded mode resolves with allowPrivate=false:
  // a hostname like `api.themoviedb.org` is never legitimately backed by a
  // private IP.
  //
  // We deliberately do NOT require the fresh address SET to equal the first
  // lookup. CDN-fronted hosts (api.themoviedb.org, *.push.apple.com,
  // fcm.googleapis.com, …) return rotating answer sets, so two lookups seconds
  // apart routinely disagree on a healthy host. Per-address safety plus the pin
  // is what matters.
  //
  // Exception: with NODE_USE_ENV_PROXY and a proxy variable set, the PROXY
  // resolves and dials the target, so the connection cannot be pinned from here.
  // That path keeps the previous behaviour (fresh re-resolve check, then
  // fetch() by hostname) — see envProxyActive().

  // Created BEFORE any DNS work so resolution counts against the caller's
  // declared budget. dns.lookup (getaddrinfo) itself accepts no timeout and
  // cannot be cancelled — when the OS resolver is unreachable it blocks for the
  // resolver deadline (~5s × attempts × nameservers, up to ~40s) — so the race
  // below bounds the caller's WALL TIME to timeoutMs while the orphaned lookup
  // drains in the threadpool. Without this, the 5s poller and SSE reconnect
  // overran their per-tick budgets by an order of magnitude during DNS outages.
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const timeoutSignal = AbortSignal.timeout(timeoutMs);
  const signal = opts.signal
    ? AbortSignal.any([opts.signal, timeoutSignal])
    : timeoutSignal;
  const withDnsDeadline = async <T>(work: Promise<T>): Promise<T> => {
    if (signal.aborted) {
      throw new SafeFetchError("timeout", rawUrl, `Request to ${rawUrl} timed out after ${timeoutMs}ms (before DNS resolution)`);
    }
    return await new Promise<T>((resolve, reject) => {
      const onAbort = () =>
        reject(new SafeFetchError("timeout", rawUrl, `DNS resolution for ${rawUrl} exceeded the ${timeoutMs}ms budget`));
      signal.addEventListener("abort", onAbort, { once: true });
      work.then(
        (v) => { signal.removeEventListener("abort", onAbort); resolve(v); },
        (e) => { signal.removeEventListener("abort", onAbort); reject(e); },
      );
    });
  };

  const allowPrivate = mode === "admin";
  let targetUrl: string;

  if (mode === "user") {
    // User-supplied URL with no hostname allowlist — used by Web Push, whose
    // subscription endpoints span an unbounded set of vendor push services
    // (fcm.googleapis.com, *.push.apple.com, updates.push.services.mozilla.com,
    // *.notify.windows.com, …). allowPrivate=false blocks RFC1918/loopback/
    // link-local/CGNAT/multicast — push services must be public.
    const safe = await withDnsDeadline(resolveToSafeUrlWithAddrs(rawUrl, { allowPrivate: false }));
    if (!safe) {
      throw new SafeFetchError(
        "ssrf-blocked",
        rawUrl,
        `URL blocked by SSRF policy: ${rawUrl}`,
      );
    }
    targetUrl = safe.url;
  } else if (mode === "hardcoded") {
    if (!allowedHosts || allowedHosts.size === 0) {
      throw new SafeFetchError(
        "ssrf-blocked",
        rawUrl,
        "safeFetchTrusted requires a non-empty allowedHosts list",
      );
    }
    const host = parsedUrl.hostname.toLowerCase();
    if (!allowedHosts.has(host)) {
      throw new SafeFetchError(
        "ssrf-blocked",
        rawUrl,
        `URL blocked by trusted-host policy (host=${host}): ${rawUrl}`,
      );
    }
    // Hardcoded hosts (TMDB, plex.tv, …) must resolve to public addresses.
    // allowPrivate=false here blocks DNS-rebind to RFC1918/loopback.
    const safe = await withDnsDeadline(resolveToSafeUrlWithAddrs(rawUrl, { allowPrivate: false }));
    if (!safe) {
      throw new SafeFetchError(
        "ssrf-blocked",
        rawUrl,
        `URL blocked by SSRF policy (trusted host resolves to unsafe address): ${rawUrl}`,
      );
    }
    // Rebuild targetUrl from the URL we just validated. We keep the same
    // hostname as rawUrl (we deliberately don't switch to the resolved IP — TLS
    // SNI and virtual-hosted endpoints both need the hostname), but the outbound
    // request now derives from `parsedUrl`, whose hostname was checked against
    // the required `allowedHosts` allowlist above. Routing the fetch through the
    // already-validated value (rather than the raw, attacker-influenced input)
    // is what makes this request-forgery-safe: there is no untrusted-host path
    // from caller input to the network call.
    targetUrl = parsedUrl.toString();
  } else {
    // mode === "admin"
    const safe = await withDnsDeadline(resolveToSafeUrlWithAddrs(rawUrl, { allowPrivate: true }));
    if (!safe) {
      throw new SafeFetchError(
        "ssrf-blocked",
        rawUrl,
        `URL blocked by SSRF policy: ${rawUrl}`,
      );
    }
    targetUrl = safe.url;
  }

  const maxResponseBytes = opts.maxResponseBytes ?? DEFAULT_MAX_RESPONSE_BYTES;

  const headers = new Headers(opts.headers);
  if (!headers.has("user-agent")) headers.set("user-agent", USER_AGENT);

  const { timeoutMs: _t, maxResponseBytes: _m, ...rest } = opts;
  void _t; void _m;

  const init: RequestInit = {
    ...rest,
    headers,
    redirect: "error",
    signal,
  };

  const viaProxy = envProxyActive() || transportIsFetchSeam();
  let pinnedAddrs: string[] | null = null;
  if (viaProxy) {
    // Cannot pin behind a proxy (it dials the target); keep the fresh check.
    const verified = await withDnsDeadline(
      verifyResolvedHost(parsedUrl.hostname, { allowPrivate }),
    );
    if (!verified) pinnedAddrs = null;
    else pinnedAddrs = [];
  } else {
    // Resolve FRESH; every address must be safe under the policy. The request
    // below connects to exactly this list.
    pinnedAddrs = await withDnsDeadline(
      resolveSafeAddrsFresh(parsedUrl.hostname, { allowPrivate }),
    );
  }
  if (!pinnedAddrs) {
    throw new SafeFetchError(
      "ssrf-blocked",
      targetUrl,
      `Host ${parsedUrl.hostname} failed re-resolution check (DNS-rebind defence)`,
    );
  }

  let res: Response;
  try {
    res = viaProxy ? await fetch(targetUrl, init) : await pinnedFetch(targetUrl, init, pinnedAddrs, signal);
  } catch (err) {
      if (err instanceof Error) {

        const name = err.name;
        const causeName = (err as { cause?: { name?: string } }).cause?.name;
        if (name === "TimeoutError" || causeName === "TimeoutError") {
          throw new SafeFetchError(
            "timeout",
            targetUrl,
            `Request to ${targetUrl} timed out after ${timeoutMs}ms`,
          );
        }
        if (err instanceof TypeError && /redirect/i.test(err.message)) {
          throw new SafeFetchError(
            "redirect",
            targetUrl,
            `Request to ${targetUrl} attempted to redirect (blocked by safeFetch)`,
          );
        }
      }
      const e = err as Error & { cause?: { code?: string; message?: string; errno?: number } };
      const causeMsg = e.cause?.message ?? e.cause?.code ?? "";
      const detail = causeMsg ? `${e.message} (${causeMsg})` : e.message;
    throw new SafeFetchError(
      "network",
      targetUrl,
      `fetch failed for ${targetUrl}: ${detail}`,
    );
  }

  const contentLength = res.headers.get("content-length");
    if (contentLength) {
      const size = parseInt(contentLength, 10);
      if (!isNaN(size) && size > maxResponseBytes) {
        try {
          await res.body?.cancel();
        } catch {

        }
        throw new SafeFetchError(
          "size",
          targetUrl,
          `Response body declared ${size} bytes, exceeds cap ${maxResponseBytes}`,
        );
      }
    }

  if (res.body) {
    const limited = limitResponseBody(res.body, maxResponseBytes, targetUrl);
    // Node 22's fetch transparently decompresses gzip/deflate/br responses — `res.body` already
    // emits the decompressed bytes. But `res.headers` still carries the upstream Content-Encoding
    // and the original (compressed) Content-Length. If we copy those headers verbatim onto the
    // re-wrapped Response, downstream consumers can be misled into decompressing already-
    // decompressed bytes (Response.json() then JSON.parses the gzip magic header and throws
    // "Unexpected token '...' is not valid JSON"). Strip both headers so the new Response's
    // metadata accurately describes its own body.
    const sanitizedHeaders = new Headers(res.headers);
    sanitizedHeaders.delete("content-encoding");
    sanitizedHeaders.delete("content-length");
    return new Response(limited, {
      status: res.status,
      statusText: res.statusText,
      headers: sanitizedHeaders,
    });
  }

  return res;
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

function decoderFor(encoding: string): NodeJS.ReadWriteStream | null {
  switch (encoding) {
    case "gzip":
    case "x-gzip":
      return zlib.createGunzip();
    case "deflate":
      return zlib.createInflate();
    case "br":
      return zlib.createBrotliDecompress();
    default:
      return null;
  }
}

// A fetch() look-alike over node:http(s) that dials ONLY `addrs`. Preserves what
// the rest of doFetch relies on: redirect:"error" semantics, transparent
// gzip/deflate/br decoding (the size cap sees decoded bytes), abort/timeout via
// `signal` (rejecting with signal.reason, like fetch), and a standard Response.
async function pinnedFetch(
  targetUrl: string,
  init: RequestInit,
  addrs: readonly string[],
  signal: AbortSignal,
): Promise<Response> {
  // Request() normalises body/headers exactly as fetch would (and throws the same
  // TypeErrors, e.g. URL credentials, GET with a body).
  const request = new Request(targetUrl, init);
  const body = request.body ? Buffer.from(await request.arrayBuffer()) : undefined;
  const url = new URL(request.url);

  const headers: Record<string, string> = {};
  request.headers.forEach((v, k) => { headers[k] = v; });
  if (!("accept" in headers)) headers["accept"] = "*/*";
  if (!("accept-encoding" in headers)) headers["accept-encoding"] = "gzip, deflate, br";
  if (body && !("content-length" in headers)) headers["content-length"] = String(body.byteLength);

  const opts = buildPinnedRequestOptions(url, addrs, { method: request.method, headers, signal });
  const transport = url.protocol === "https:" ? https : http;

  return await new Promise<Response>((resolve, reject) => {
    const fail = (err: unknown) => {
      reject(signal.aborted ? signal.reason : new TypeError("fetch failed", { cause: err }));
    };
    const creq = transport.request(opts, (res) => {
      const status = res.statusCode ?? 0;
      if ([301, 302, 303, 307, 308].includes(status) && res.headers.location) {
        res.destroy();
        reject(new TypeError("fetch failed", { cause: new Error("unexpected redirect") }));
        return;
      }
      const respHeaders = new Headers();
      for (let i = 0; i + 1 < res.rawHeaders.length; i += 2) {
        try { respHeaders.append(res.rawHeaders[i], res.rawHeaders[i + 1]); } catch { /* skip an unrepresentable header */ }
      }
      if (status < 200 || status > 599) {
        res.destroy();
        reject(new TypeError("fetch failed", { cause: new Error(`unsupported status ${status}`) }));
        return;
      }
      if (request.method === "HEAD" || status === 204 || status === 205 || status === 304) {
        res.resume();
        resolve(new Response(null, { status, statusText: res.statusMessage ?? "", headers: respHeaders }));
        return;
      }

      const encodings = (res.headers["content-encoding"] ?? "")
        .split(",").map((s) => s.trim().toLowerCase()).filter((s) => s && s !== "identity").reverse();
      const stages: NodeJS.ReadableStream[] = [res];
      const out = new PassThrough();
      const destroyAll = (err?: unknown) => {
        const e = err === undefined ? undefined : (signal.aborted ? signal.reason : err);
        out.destroy(e as Error | undefined);
        for (const s of stages) (s as Readable).destroy();
      };
      let last: NodeJS.ReadableStream = res;
      for (const enc of encodings) {
        const d = decoderFor(enc);
        if (!d) continue;
        d.on("error", destroyAll);
        last = last.pipe(d);
        stages.push(d);
      }
      res.on("error", destroyAll);
      res.on("close", () => { if (!res.complete) destroyAll(new Error("terminated")); });
      last.pipe(out);
      out.on("close", () => { for (const s of stages) (s as Readable).destroy(); });

      resolve(new Response(Readable.toWeb(out) as ReadableStream<Uint8Array>, {
        status,
        statusText: res.statusMessage ?? "",
        headers: respHeaders,
      }));
    });
    creq.on("error", fail);
    creq.end(body);
  });
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
