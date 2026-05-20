

import { resolveToSafeUrlWithAddrs, verifyResolvedHost } from "@/lib/ssrf";


export type SafeFetchErrorReason =
  | "ssrf-blocked"
  | "timeout"
  | "size"
  | "redirect"
  | "network";

export class SafeFetchError extends Error {
  readonly reason: SafeFetchErrorReason;
  readonly url: string;
  constructor(reason: SafeFetchErrorReason, url: string, message: string) {
    super(message);
    this.name = "SafeFetchError";
    this.reason = reason;
    this.url = url;
  }
}

export interface SafeFetchOptions extends Omit<RequestInit, "redirect"> {
  timeoutMs?: number;
  maxResponseBytes?: number;
}

const DEFAULT_TIMEOUT_MS = 15_000;
const DEFAULT_MAX_RESPONSE_BYTES = 10 * 1024 * 1024;
const USER_AGENT = "Summonarr/0.1";

type FetchMode = "hardcoded" | "admin";

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
  // bundled copy from userland. The remaining viable option is to shrink the
  // TOCTOU window from minutes-to-hours (the original gap between SSRF resolve
  // and the actual connect) to milliseconds, and reject the request if DNS
  // disagrees between the two checks.
  //
  // Both modes therefore converge: validate, resolve+SSRF-check, capture the
  // expected address set, then immediately before fetch() re-resolve and
  // require the address set to be unchanged and still safe. A hostile DNS
  // server flipping its answer between the two lookups is detected and the
  // request is blocked. Note hardcoded mode resolves with allowPrivate=false:
  // a hostname like `api.themoviedb.org` is never legitimately backed by a
  // private IP, so this also stops DNS-rebind attacks against trusted hosts.

  const allowPrivate = mode === "admin";
  let targetUrl: string;
  let expectedAddrs: readonly string[];

  if (mode === "hardcoded") {
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
    // Rebuild targetUrl from the URL we just validated. Same hostname as
    // rawUrl (we deliberately don't switch to the resolved IP — TLS SNI and
    // virtual-hosted endpoints both need the hostname), but the data-flow now
    // passes through `parsedUrl` whose hostname has been checked against
    // `allowedHosts` — that breaks CodeQL's request-forgery taint flow
    // (CodeQL js/request-forgery, alert #4).
    targetUrl = parsedUrl.toString();
    expectedAddrs = safe.addrs;
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
    expectedAddrs = safe.addrs;
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

  // Final TOCTOU check: re-resolve immediately before fetch. If DNS now answers
  // with a different address set, or any address has become unsafe, refuse.
  // This shrinks the rebind window from "however long until connect" to "the
  // time between this call and undici's own getaddrinfo" — typically <1ms.
  const verified = await verifyResolvedHost(parsedUrl.hostname, expectedAddrs, {
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

// safeFetchTrusted skips DNS-based SSRF validation but enforces a hardcoded hostname
// allowlist — use for fixed third-party APIs (TMDB, plex.tv, discord.com, …). Pass the
// expected host(s) so a future code change can't accidentally fan out to user-controlled URLs.
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
