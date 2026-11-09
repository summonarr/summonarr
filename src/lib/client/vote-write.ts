import { withBasePath } from "@/lib/base-path";
import { timedFetch } from "@/lib/client/fetch-json";
import { rateLimitMessage } from "@/lib/client/rate-limit";
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
    if (res.ok || (opts.okOn404 && res.status === 404)) return { ok: true };
    return { ok: false, message: rateLimitMessage(res, opts.t) ?? opts.failed };
  } catch {
    return { ok: false, message: opts.failed };
  }
}
