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

type RequestMediaType = "MOVIE" | "TV";

// A fresh token, or the Response explaining why there isn't one (a 200 that
// carries no token is reported as a 502 — it's a server fault, not the user's).
export async function fetchRequestToken(tmdbId: number, mediaType: RequestMediaType): Promise<string | Response> {
  const res = await fetch(withBasePath(`/api/requests/token?tmdbId=${tmdbId}&mediaType=${mediaType}`));
  if (!res.ok) return res;
  const data = (await res.json().catch(() => null)) as { token?: unknown } | null;
  if (typeof data?.token === "string" && data.token) return data.token;
  return new Response("{}", { status: 502, headers: { "Content-Type": "application/json" } });
}

function send(payload: Record<string, unknown>, token: string): Promise<Response> {
  return fetch(withBasePath("/api/requests"), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ ...payload, _token: token }),
  });
}

// The body is the caller's own ({ tmdbId, mediaType, note?, is4k?, … }) plus
// `_token`, exactly as before. Network errors from the POST propagate.
export async function postMediaRequest(
  payload: { tmdbId: number; mediaType: RequestMediaType } & Record<string, unknown>,
  pageToken?: string,
): Promise<Response> {
  let token = pageToken;
  if (!token) {
    const minted = await fetchRequestToken(payload.tmdbId, payload.mediaType);
    if (typeof minted !== "string") return minted;
    token = minted;
  }
  const res = await send(payload, token);
  // A freshly fetched token can't be stale, so only a page-minted one is retried.
  if (res.status !== 403 || !pageToken) return res;
  const fresh = await fetchRequestToken(payload.tmdbId, payload.mediaType).catch(() => null);
  if (typeof fresh !== "string") return res;
  return send(payload, fresh);
}
