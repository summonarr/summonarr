import { withBasePath } from "@/lib/base-path";
import { timedFetch } from "@/lib/client/fetch-json";
import { rateLimitMessage } from "@/lib/client/rate-limit";
import { readApiError } from "@/lib/client/api-error";
import { fetchRequestToken } from "@/lib/client/media-request";
import type { Translator } from "@/lib/i18n/translate";

export type VoteWriteOutcome = { ok: true } | { ok: false; message: string };

// DELETE (take a vote back) or PATCH (an admin dismisses it) on one title's
// deletion vote, for the vote buttons. `okOn404` counts a vote that is already
// gone (another tab, an admin's dismissal) as done: rolling back to "Voted"
// left a control whose every retry 404'd again. Everything is read inside the
// call, so only a plain outcome crosses back.
export async function writeDeletionVote(opts: {
  method: "DELETE" | "PATCH";
  tmdbId: number;
  mediaType: "MOVIE" | "TV";
  okOn404: boolean;
  failed: string;
  signal: AbortSignal;
  t: Translator;
}): Promise<VoteWriteOutcome> {
  try {
    const res = await timedFetch(withBasePath(`/api/votes/${opts.tmdbId}?mediaType=${opts.mediaType}`), {
      method: opts.method,
      signal: opts.signal,
    });
    if (opts.okOn404 && res.status === 404) return { ok: true };
    // The route never redirects: a 2xx that came through one is a page in
    // front of the app (an auth proxy's sign-in), and the vote was not written.
    if (res.ok && !res.redirected) return { ok: true };
    if (res.ok) return { ok: false, message: opts.failed };
    return { ok: false, message: rateLimitMessage(res, opts.t) ?? opts.failed };
  } catch {
    return { ok: false, message: opts.failed };
  }
}

// POST a deletion vote with the token the PAGE minted. That token lives one to
// two hours (request-token.ts) and a detail page does not re-render on its own,
// so a tab left open got 403 "invalid request token" on every try. A 403 mints
// a fresh token and resends ONCE, as postMediaRequest does; any other 403 (the
// voter's own request, the feature off) fails again the same way. A failed
// mint keeps the first 403: it is already an answer.
async function postVote(
  body: { tmdbId: number; mediaType: "MOVIE" | "TV"; reason?: string },
  pageToken: string,
  signal: AbortSignal,
): Promise<Response> {
  const send = (token: string) =>
    timedFetch(withBasePath("/api/votes"), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ...body, _token: token }),
      signal,
    });
  const res = await send(pageToken);
  if (res.status !== 403) return res;
  const fresh = await fetchRequestToken(body.tmdbId, body.mediaType, signal).catch((err: unknown) => {
    if (signal.aborted) throw err;
    return null;
  });
  if (typeof fresh !== "string") return res;
  return send(fresh);
}

// Cast a deletion vote. A 409 is "already voted", which is what was asked for.
// A failure carries the route's own reason (your own request, not in the
// library…), or its wait for a 429.
export async function castDeletionVote(opts: {
  tmdbId: number;
  mediaType: "MOVIE" | "TV";
  reason: string | undefined;
  pageToken: string;
  failed: string;
  signal: AbortSignal;
  t: Translator;
}): Promise<VoteWriteOutcome> {
  try {
    const res = await postVote({ tmdbId: opts.tmdbId, mediaType: opts.mediaType, reason: opts.reason }, opts.pageToken, opts.signal);
    if (res.status === 409) return { ok: true };
    // The route never redirects: a 2xx that came through one is a page in
    // front of the app, and the vote was not written.
    if (res.ok) return res.redirected ? { ok: false, message: opts.failed } : { ok: true };
    return { ok: false, message: rateLimitMessage(res, opts.t) ?? (await readApiError(res, opts.failed)) };
  } catch {
    return { ok: false, message: opts.failed };
  }
}
