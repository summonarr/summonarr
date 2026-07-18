

import { resolveToSafeUrlWithAddrs, verifyResolvedHost } from "@/lib/ssrf";


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

  // DNS-rebind mitigation strategy.
  //
  // We can't pin the resolved IP at the dispatcher layer: a previous undici
  // Agent dispatcher attempt broke at runtime because Node 22's bundled undici
  // and the npm `undici` package disagree on the Dispatcher handler shape
  // (assertRequestHandler throws "invalid onRequestStart method"). `node:undici`
  // is not exposed as a builtin module on Node 22 either, so we can't reach the
  // bundled copy from userland. The remaining viable option is to re-resolve the
  // hostname FRESH immediately before fetch() and reject if any currently-
  // resolving address is unsafe — shrinking the TOCTOU window between our SSRF
  // check and undici's connect-time getaddrinfo to sub-millisecond.
  //
  // All modes therefore converge: validate, resolve+SSRF-check (cached), then
  // immediately before fetch() re-resolve FRESH and require every address to
  // still be safe under the policy. A hostile DNS server that has flipped its
  // answer to an internal/private address is caught here. Note hardcoded mode
  // resolves with allowPrivate=false: a hostname like `api.themoviedb.org` is
  // never legitimately backed by a private IP, so this also stops DNS-rebind
  // attacks against trusted hosts.
  //
  // We deliberately do NOT require the re-resolved address SET to be identical to
  // the first lookup. CDN-fronted hosts (api.themoviedb.org, *.push.apple.com,
  // fcm.googleapis.com, …) return rotating/partial answer sets with low TTLs, so
  // two lookups seconds-to-minutes apart routinely disagree on a healthy host — a
  // set-equality check false-positives and hard-blocks TMDB search and all web
  // push. Set-equality only ever guarded a rebind from one PUBLIC ip to a DIFFERENT
  // PUBLIC ip, which under allowPrivate=false reaches no internal target and is not
  // an SSRF escalation; the per-address safety re-check is what stops rebind-to-
  // internal. (See verifyResolvedHost in ssrf.ts.)

  const allowPrivate = mode === "admin";
  let targetUrl: string;

  if (mode === "user") {
    // User-supplied URL with no hostname allowlist — used by Web Push, whose
    // subscription endpoints span an unbounded set of vendor push services
    // (fcm.googleapis.com, *.push.apple.com, updates.push.services.mozilla.com,
    // *.notify.windows.com, …). allowPrivate=false blocks RFC1918/loopback/
    // link-local/CGNAT/multicast — push services must be public.
    const safe = await resolveToSafeUrlWithAddrs(rawUrl, { allowPrivate: false });
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
    const safe = await resolveToSafeUrlWithAddrs(rawUrl, { allowPrivate: false });
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
    const safe = await resolveToSafeUrlWithAddrs(rawUrl, { allowPrivate: true });
    if (!safe) {
      throw new SafeFetchError(
        "ssrf-blocked",
        rawUrl,
        `URL blocked by SSRF policy: ${rawUrl}`,
      );
    }
    targetUrl = safe.url;
  }

  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const maxResponseBytes = opts.maxResponseBytes ?? DEFAULT_MAX_RESPONSE_BYTES;

  const timeoutSignal = AbortSignal.timeout(timeoutMs);
  const signal = opts.signal
    ? AbortSignal.any([opts.signal, timeoutSignal])
    : timeoutSignal;

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

  // Final TOCTOU check: re-resolve FRESH immediately before fetch. If any
  // currently-resolving address is unsafe under the policy, refuse. This shrinks
  // the rebind window from "however long until connect" to "the time between this
  // call and undici's own getaddrinfo" — typically <1ms. (We don't require the
  // set to be unchanged — see the doFetch header comment for why.)
  const verified = await verifyResolvedHost(parsedUrl.hostname, {
    allowPrivate,
  });
  if (!verified) {
    throw new SafeFetchError(
      "ssrf-blocked",
      targetUrl,
      `Host ${parsedUrl.hostname} failed re-resolution check (DNS-rebind defence)`,
    );
  }

  let res: Response;
  try {
    res = await fetch(targetUrl, init);
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
        controller.error(err);
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
