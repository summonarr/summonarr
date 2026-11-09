// The browser's writes to the viewer's "not interested" list (/api/hidden):
// the detail page's HideButton and the For You card's NotInterestedButton both
// go through here, so the two read the route's answers the same way. Client-safe;
// tests/hidden-items-client.test.mts drives it with a scripted fetch.
import { withBasePath } from "@/lib/base-path";
import { fetchJson, jsonInit, type FetchJsonFailure } from "@/lib/client/fetch-json";
import type { Translator } from "@/lib/i18n/translate";

export interface HiddenTitleRef {
  tmdbId: number;
  mediaType: "MOVIE" | "TV";
}

export type HiddenWriteResult = { ok: true } | { ok: false; failure: FetchJsonFailure };

// A 2xx with a JSON (or empty) body is done whatever it says — the route answers
// the stored row or { ok: true }, and nothing here reads either. A 2xx that is
// not JSON never came from the route (a sign-in page behind a gate): not done.
function settle(res: Awaited<ReturnType<typeof fetchJson>>, alreadyDone?: number): HiddenWriteResult {
  if (res.ok) return { ok: true };
  if (res.kind === "http" && res.status === alreadyDone) return { ok: true };
  return { ok: false, failure: res };
}

/** Hides a title. A 409 means it is already hidden — the end state the caller wanted, so it counts as done. */
export async function hideTitle(
  item: HiddenTitleRef & { title: string; posterPath?: string | null },
  opts: { signal?: AbortSignal } = {},
): Promise<HiddenWriteResult> {
  const res = await fetchJson(withBasePath("/api/hidden"), {
    init: jsonInit("POST", { tmdbId: item.tmdbId, mediaType: item.mediaType, title: item.title, posterPath: item.posterPath }),
    signal: opts.signal,
  });
  return settle(res, 409);
}

/** Shows a hidden title again. */
export async function unhideTitle(item: HiddenTitleRef, opts: { signal?: AbortSignal } = {}): Promise<HiddenWriteResult> {
  const qs = new URLSearchParams({ tmdbId: String(item.tmdbId), mediaType: item.mediaType });
  const res = await fetchJson(withBasePath(`/api/hidden?${qs}`), { init: { method: "DELETE" }, signal: opts.signal });
  return settle(res);
}

/**
 * What to tell the viewer about a failed write: the rate-limit notice for a
 * 429 (the route sends no Retry-After, so no wait is named), the route's own
 * reason for any other refusal, `fallback` when it gave none, and
 * `networkText` when no answer came. Empty for an abort, which shows nothing.
 */
export function hiddenFailureText(failure: FetchJsonFailure, t: Translator, fallback: string, networkText: string): string {
  if (failure.kind === "aborted") return "";
  if (failure.kind !== "http") return networkText;
  if (failure.status === 429) return t("shared.rateLimited.generic");
  return failure.error || fallback;
}
