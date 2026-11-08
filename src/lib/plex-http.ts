// The Plex transport: who we say we are, how a request is sent, how a failed
// page is retried, and how a paged listing is walked. Everything else in the
// Plex client (plex-*.ts, re-exported by plex.ts) builds on this.
//
// plex.tv calls go through safeFetchTrusted (a fixed third-party host); calls
// to the Plex Media Server go through safeFetchAdminConfigured, because its
// address is an admin Setting (guardrail 5a).
import { safeFetchAdminConfigured, SafeFetchError } from "./safe-fetch";
import { trimServerBase } from "./server-url";
import { check, v } from "./validate";
import { plexClientHeaders, plexClientIdentity } from "./plex-client-headers";
import { loose, numberish, type PageControl, STOP_PAGING } from "./media-server-payload";

export const PLEX_TV_HOSTS = ["plex.tv"];

// Persisted in users' Plex device lists: changing it orphans those devices.
export const PLEX_CLIENT_ID = "summonarr-server";

// The identity every request carries; the header sets below are built from it.
const PLEX_CLIENT_IDENTITY = plexClientIdentity(PLEX_CLIENT_ID);

// plex.tv's JSON API (/api/v2/*) wants the full device description.
const PLEX_TV_JSON_HEADERS = plexClientHeaders(PLEX_CLIENT_ID);

/** Headers for a plex.tv JSON call; `clientId` overrides the shared client identifier. */
export function plexTvJsonHeaders(token: string, clientId?: string): Record<string, string> {
  return {
    ...PLEX_TV_JSON_HEADERS,
    ...(clientId ? { "X-Plex-Client-Identifier": clientId } : {}),
    "X-Plex-Token": token,
  };
}

/** Headers for plex.tv's XML endpoints (/api/users, shared_servers, the home switch). */
export function plexTvXmlHeaders(adminToken: string): Record<string, string> {
  return { "X-Plex-Client-Identifier": PLEX_CLIENT_ID, "X-Plex-Token": adminToken };
}

function plexServerHeaders(token: string): Record<string, string> {
  return {
    Accept: "application/json",
    "X-Plex-Token": token,
    ...PLEX_CLIENT_IDENTITY,
    "User-Agent": "Summonarr/1.0 (Node.js)",
  };
}

export const FETCH_TIMEOUT_MS = 60_000;
// Timeout for a small single-shot server probe (/identity). The 60s default is
// calibrated for the paged library walk, not a ~1 KB identity read: multi-server
// callers iterate instances SEQUENTIALLY (the sign-in membership loop in auth.ts,
// the settings connection test), so one dead-but-configured server would
// otherwise add a full minute of dead wait per instance before the next one is
// even tried.
export const PLEX_IDENTITY_TIMEOUT_MS = 10_000;
const PLEX_PAGE_SIZE = 1_000;
// Response cap per fetch. The safe-fetch default is 10 MB decompressed; a
// 1000-item page has ~10× headroom today, but match jellyfin.ts/arr.ts's 50 MB
// so a verbose Plex response (extra Guids/Media parts) can never abort a sync
// on the same undersized-cap failure arr.ts hit (guardrail 5).
const LIBRARY_FETCH_MAX_BYTES = 50 * 1024 * 1024;
const PAGE_RETRY_ATTEMPTS = 3;
const PAGE_RETRY_DELAY_MS = 2_000;

// Retry wrapper for page fetches — the Jellyfin twin's fetchPage shape (its
// per-page retry is test-pinned precedent). One transient blip used to abort an
// entire instance's sync arm and defer availability by a full SYNC_INTERVAL.
// Retries are safe here: these are idempotent GETs consumed before any DB
// write begins. Only failures that can pass on a second try are retried: a
// non-429 4xx (a revoked token), a page over the size cap and an answer of the
// wrong shape answer the same way every time (`isPermanentFailure`). Once
// `signal` aborts there is no further sleep or attempt (guardrail 41).
// Deliberately NOT inside plexFetch itself: the availability probe
// (hasPlexItemByTmdbId) and refreshPlexSection are single-shot best-effort by
// design.
export async function withPlexRetry<T>(label: string, attemptFn: () => Promise<T>, signal?: AbortSignal): Promise<T> {
  let lastErr: unknown;
  for (let attempt = 0; attempt <= PAGE_RETRY_ATTEMPTS; attempt++) {
    if (attempt > 0) {
      await sleepUnlessAborted(PAGE_RETRY_DELAY_MS * attempt, signal);
      if (signal?.aborted) break;
      console.warn(`[plex] retry ${attempt}/${PAGE_RETRY_ATTEMPTS} for ${label}`);
    }
    try {
      return await attemptFn();
    } catch (err) {
      lastErr = err;
      if (isPermanentFailure(err)) break;
    }
  }
  throw lastErr;
}

// Resolves after `ms`, or at once when `signal` aborts. Never rejects.
function sleepUnlessAborted(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal?.aborted) {
      resolve();
      return;
    }
    const done = () => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", done);
      resolve();
    };
    const timer = setTimeout(done, ms);
    signal?.addEventListener("abort", done, { once: true });
  });
}

function isPermanentFailure(err: unknown): boolean {
  if ((err as { noRetry?: boolean } | null)?.noRetry === true) return true;
  // A body over LIBRARY_FETCH_MAX_BYTES is over it on every download.
  return err instanceof SafeFetchError && err.reason === "size";
}

/** Marks a non-429 4xx as not worth retrying (a revoked token answers the same way again). */
export function tagNoRetryOn4xx(err: Error, status: number): Error {
  if (status >= 400 && status < 500 && status !== 429) return Object.assign(err, { noRetry: true });
  return err;
}

export function noRetry(err: Error): Error {
  return Object.assign(err, { noRetry: true });
}

// `path` on the configured server address. getPlexConfig hands the address
// back raw (plex-config.ts), so every request is built here: a trailing slash
// on the setting never doubles up.
export function plexUrl(serverUrl: string, path: string): string {
  return `${trimServerBase(serverUrl)}${path}`;
}

export function plexFetch(url: string, token: string, timeoutMs: number = FETCH_TIMEOUT_MS, signal?: AbortSignal): Promise<Response> {
  return safeFetchAdminConfigured(url, {
    headers: plexServerHeaders(token),
    timeoutMs,
    maxResponseBytes: LIBRARY_FETCH_MAX_BYTES,
    ...(signal ? { signal } : {}),
  });
}

// The MediaContainer envelope every Plex Media Server answer comes in. Strict:
// an answer without one (a proxy's page, another service on the port) is a
// failed read, never "no items". `Metadata` entries stay unknown here; each
// reader checks its own item shape. The counts are read leniently (a numeric
// string still counts).
const MediaContainerEnvelope = v.object({
  MediaContainer: v.object({
    Metadata: v.optional(v.array(v.unknown())),
    totalSize: loose(numberish),
    size: loose(numberish),
  }),
});

export interface PlexContainer {
  items: unknown[];
  totalSize: number | undefined;
  size: number | undefined;
}

/** The MediaContainer of a parsed Plex answer, or null when it has none of the expected shape. */
export function readPlexContainer(body: unknown): PlexContainer | null {
  const r = check(MediaContainerEnvelope, body);
  if (!r.ok) return null;
  const c = r.value.MediaContainer;
  return { items: c.Metadata ?? [], totalSize: c.totalSize, size: c.size };
}

// Hard ceiling on a paged walk. `total` comes from the SERVER's reported
// totalSize, so a hostile or buggy Plex answer that keeps reporting more (or
// always returns a full page) could spin the loop forever, streaming unbounded
// rows into the caller's accumulator. The URL is an admin Setting, so the host
// is mostly trusted, not infallible. 2M items is far beyond any real library
// and still bounds memory and wall-clock.
const MAX_PAGED_ITEMS = 2_000_000;
const MAX_PAGES = Math.ceil(MAX_PAGED_ITEMS / PLEX_PAGE_SIZE);

/**
 * Walks a paged listing by X-Plex-Container-Start. `onPage` gets each page's
 * raw entries (each caller checks its own item shape) and returns STOP_PAGING
 * to end the walk early — the recentOnly early stop, the history caps.
 * `signal` reaches the request and the retry sleeps: an abort mid-walk REJECTS
 * with the page's error, so a library walk never returns a silently partial
 * listing. A page with no MediaContainer is a failed read, not retried.
 */
export async function plexFetchAllPages(
  baseUrl: string,
  token: string,
  onPage: (items: unknown[]) => PageControl,
  signal?: AbortSignal,
): Promise<void> {
  let pages = 0;
  let start = 0;
  let total = Infinity;
  while (start < total) {
    if (++pages > MAX_PAGES) {
      console.warn(`[plex] paginated fetch hit the ${MAX_PAGED_ITEMS}-item ceiling at start=${start}; truncating.`);
      break;
    }
    const sep = baseUrl.includes("?") ? "&" : "?";
    const container = await withPlexRetry(`start=${start}`, async () => {
      const res = await plexFetch(
        `${baseUrl}${sep}X-Plex-Container-Start=${start}&X-Plex-Container-Size=${PLEX_PAGE_SIZE}`,
        token,
        FETCH_TIMEOUT_MS,
        signal,
      );
      if (!res.ok) {
        throw tagNoRetryOn4xx(new Error(`Plex paginated fetch failed: ${res.status} at start=${start}`), res.status);
      }
      // A JSON parse error stays retryable: a body can arrive truncated.
      const parsed = readPlexContainer(await res.json());
      if (!parsed) throw noRetry(new Error(`Plex paginated fetch returned no MediaContainer at start=${start}`));
      return parsed;
    }, signal);
    const items = container.items;
    // Use totalSize as the authoritative count. Do NOT fall back to the page's
    // `size` (≤ PLEX_PAGE_SIZE) — that makes `start < total` false after one
    // page and silently truncates any library larger than a page when a Plex
    // build omits totalSize. Infinity defers termination to the empty-page
    // break below, the correct terminator on that path.
    //
    // Refreshed on EVERY page that reports it, not fixed from page 0: the
    // watch history is read viewedAt-desc, so a view recorded mid-walk is
    // prepended, shifts every older record one offset down, and a total frozen
    // at page 0 ended the walk before the shifted tail — the OLDEST records,
    // the same ones every run on a busy server. A page that omits it keeps the
    // last known count; MAX_PAGES still bounds an ever-growing one.
    if (container.totalSize !== undefined) total = container.totalSize;
    const stop = onPage(items) === STOP_PAGING;
    start += items.length;
    if (stop || items.length === 0) break;
  }
}
