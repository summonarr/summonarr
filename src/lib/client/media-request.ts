// POST /api/requests from the browser, with the request token it needs.
//
// Two failure modes this exists for:
//   - A token the PAGE minted (detail pages, person pages) lives one to two
//     hours (request-token.ts). A tab left open longer got 403 "invalid request
//     token" on every retry until it was reloaded. So a 403 on a page-minted
//     token mints a fresh one and resends ONCE. Any other 403 (permission, a
//     required Discord link) just fails again the same way, which is harmless.
//   - A token the caller has to fetch first: when that fetch fails, nothing is
//     posted and the token route's own answer is returned, so the caller shows
//     the real cause instead of the request route's "invalid request token".
import { withBasePath } from "@/lib/base-path";
import { timedFetch } from "@/lib/client/fetch-json";
import { readApiError } from "@/lib/client/api-error";
import { rateLimitMessage } from "@/lib/client/rate-limit";
import type { Translator } from "@/lib/i18n/translate";

type RequestMediaType = "MOVIE" | "TV";

// A fresh token, or the Response explaining why there isn't one (a 200 that
// carries no token is reported as a 502 — it's a server fault, not the user's).
export async function fetchRequestToken(
  tmdbId: number,
  mediaType: RequestMediaType,
  signal?: AbortSignal,
): Promise<string | Response> {
  const res = await timedFetch(withBasePath(`/api/requests/token?tmdbId=${tmdbId}&mediaType=${mediaType}`), { signal });
  if (!res.ok) return res;
  const data = (await res.json().catch(() => null)) as { token?: unknown } | null;
  if (typeof data?.token === "string" && data.token) return data.token;
  return new Response("{}", { status: 502, headers: { "Content-Type": "application/json" } });
}

function send(payload: Record<string, unknown>, token: string, signal?: AbortSignal): Promise<Response> {
  return timedFetch(withBasePath("/api/requests"), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ ...payload, _token: token }),
    signal,
  });
}

// The body is the caller's own ({ tmdbId, mediaType, note?, is4k?, … }) plus
// `_token`, exactly as before. Network errors propagate — from the token fetch
// and the POST alike — and so does an abort of `signal` (a caller's unmount or
// timeout), which reaches every request this sends. The one exception is the
// stale-token retry: the 403 it is retrying is already an answer, so a network
// failure minting the fresh token returns that 403 rather than a new error.
export async function postMediaRequest(
  payload: { tmdbId: number; mediaType: RequestMediaType } & Record<string, unknown>,
  pageToken?: string,
  opts: { signal?: AbortSignal } = {},
): Promise<Response> {
  const { signal } = opts;
  let token = pageToken;
  if (!token) {
    const minted = await fetchRequestToken(payload.tmdbId, payload.mediaType, signal);
    if (typeof minted !== "string") return minted;
    token = minted;
  }
  const res = await send(payload, token, signal);
  // A freshly fetched token can't be stale, so only a page-minted one is retried.
  if (res.status !== 403 || !pageToken) return res;
  const fresh = await fetchRequestToken(payload.tmdbId, payload.mediaType, signal).catch((err: unknown) => {
    if (signal?.aborted) throw err;
    return null;
  });
  if (typeof fresh !== "string") return res;
  return send(payload, fresh, signal);
}

// What a request attempt came to. `duplicate` is the 409 (this viewer already
// asked); `alreadyAvailable` is the route's 200 that creates NOTHING because
// the title is already in a library this viewer can see.
export type MediaRequestOutcome = "duplicate" | "alreadyAvailable" | "created" | { error: string };

// One request attempt read into an outcome; the failure text is already
// translated. An abort of `signal` propagates (the caller was unmounted).
export async function submitMediaRequest(
  payload: { tmdbId: number; mediaType: RequestMediaType } & Record<string, unknown>,
  pageToken: string | undefined,
  t: Translator,
  signal?: AbortSignal,
): Promise<MediaRequestOutcome> {
  try {
    const res = await postMediaRequest(payload, pageToken, { signal });
    if (res.status === 409) return "duplicate";
    if (!res.ok) {
      return { error: rateLimitMessage(res, t) ?? (await readApiError(res, t("request.somethingWrong"))) };
    }
    // The route never redirects. A 2xx that arrived through one came from
    // something in front of the app (an auth proxy's sign-in page after the
    // proxy session lapsed): nothing was requested. A 2xx with an unreadable
    // body that was NOT redirected is still the route's own answer: created.
    if (res.redirected) return { error: t("request.networkError") };
    const body: unknown = await res.json().catch(() => null);
    const available = typeof body === "object" && body !== null && "alreadyAvailable" in body && body.alreadyAvailable === true;
    return available ? "alreadyAvailable" : "created";
  } catch (err) {
    if (signal?.aborted) throw err;
    return { error: t("request.networkError") };
  }
}
