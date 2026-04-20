

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

async function doFetch(
  rawUrl: string,
  opts: SafeFetchOptions,
  validateUrl: boolean,
): Promise<Response> {

  try {
    const proto = new URL(rawUrl).protocol;
    if (proto !== "http:" && proto !== "https:") {
      throw new SafeFetchError("ssrf-blocked", rawUrl, `Protocol not allowed: ${proto}`);
    }
  } catch (e) {
    if (e instanceof SafeFetchError) throw e;
    throw new SafeFetchError("ssrf-blocked", rawUrl, `Invalid URL: ${rawUrl}`);
  }

  let targetUrl = rawUrl;
  let dispatcher: Agent | null = null;
  if (validateUrl) {
    const safe = await resolveToSafeUrlWithAddrs(rawUrl);
    if (!safe) {
      throw new SafeFetchError(
        "ssrf-blocked",
        rawUrl,
        `URL blocked by SSRF policy: ${rawUrl}`,
      );
    }
    targetUrl = safe.url;
    const pinnedIp = safe.addrs[0];
    const family = isIP(pinnedIp) === 6 ? 6 : 4;
    // Pin the resolved IP in the dispatcher so a DNS rebind between resolve and connect can't bypass the SSRF check
    dispatcher = new Agent({
      connect: {
        lookup: (_hostname, _opts, cb) => cb(null, pinnedIp, family),
      },
    });
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
      throw new SafeFetchError(
        "network",
        targetUrl,
        `fetch failed for ${targetUrl}: ${(err as Error).message}`,
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
  return doFetch(url, opts, true);
}

// safeFetchTrusted skips SSRF validation — only use for hardcoded URLs (TMDB, Plex.tv, Radarr, Sonarr)
export function safeFetchTrusted(
  url: string,
  opts: SafeFetchOptions = {},
): Promise<Response> {
  return doFetch(url, opts, false);
}
