

import { isIP } from "node:net";
import { Agent } from "undici";

import { resolveToSafeUrlWithAddrs } from "@/lib/ssrf";


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

type FetchMode = "hardcoded" | "admin" | "untrusted";

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

  let targetUrl = rawUrl;
  let dispatcher: Agent | null = null;

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
    // Rebuild targetUrl from the URL we just validated. Same value as rawUrl,
    // but the data-flow now passes through `parsedUrl` whose hostname has been
    // checked against `allowedHosts` — that breaks CodeQL's request-forgery
    // taint flow (CodeQL js/request-forgery, alert #4).
    targetUrl = parsedUrl.toString();
  } else if (mode === "untrusted" || mode === "admin") {
    const safe = await resolveToSafeUrlWithAddrs(rawUrl, { allowPrivate: mode === "admin" });
    if (!safe) {
      throw new SafeFetchError(
        "ssrf-blocked",
        rawUrl,
        `URL blocked by SSRF policy: ${rawUrl}`,
      );
    }
    targetUrl = safe.url;
    if (mode === "untrusted") {
      // Pin the resolved IP in the dispatcher so a DNS rebind between resolve and connect can't
      // bypass the SSRF check. Only worthwhile for end-user-supplied URLs — for admin-set URLs
      // the rebind window is too narrow to matter and pinning breaks split-horizon resolvers.
      const pinnedIp = safe.addrs[0];
      const family = isIP(pinnedIp) === 6 ? 6 : 4;
      dispatcher = new Agent({
        connect: {
          lookup: (_hostname, _opts, cb) => cb(null, pinnedIp, family),
        },
      });
    }
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

  const init: RequestInit & { dispatcher?: unknown } = {
    ...rest,
    headers,
    redirect: "error",
    signal,
    ...(dispatcher ? { dispatcher } : {}),
  };

  let res: Response;
  try {
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
      return new Response(limited, {
        status: res.status,
        statusText: res.statusText,
        headers: res.headers,
      });
    }

    return res;
  } finally {
    // Always close the per-request dispatcher; undici sockets don't self-close otherwise
    if (dispatcher) dispatcher.close().catch(() => {});
  }
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

// safeFetch validates the URL against the SSRF policy — use for user-supplied URLs
export function safeFetch(
  url: string,
  opts: SafeFetchOptions = {},
): Promise<Response> {
  return doFetch(url, opts, "untrusted");
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
