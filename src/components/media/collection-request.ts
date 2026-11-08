// "Request All" for a TMDB collection: which titles go, the chunked POSTs to
// the bulk route, and what the outcome line says. No React, so the unit suite
// drives it with a scripted fetch (tests/collection-request-all.test.mts).
import type { TmdbMedia } from "@/lib/tmdb-types";
import type { Translator } from "@/lib/i18n/translate";
import { withBasePath } from "@/lib/base-path";
import { fetchJson, jsonInit } from "@/lib/client/fetch-json";
import { v } from "@/lib/validate";
import { BULK_REQUEST_MAX_ITEMS } from "@/lib/request-limits";

// The bulk route rejects a batch larger than BULK_REQUEST_MAX_ITEMS outright
// (400 "Too many items"), so the list goes in chunks of that size, one after
// another. The route's limit of 10 calls per minute per user still allows 500
// items per click — far more than any TMDB collection has.

// Bulk outcomes (bulk/route.ts ItemResult) for a title this user can't request.
// They are counted in the result line; the already-* outcomes are not failures
// (there was nothing to do), and created/auto-approved are the `created` count.
const UNREQUESTABLE = new Set(["skipped-declined", "no-permission", "blacklisted", "rating-blocked"]);

// A chunk looks up and may push up to 50 titles to Radarr/Sonarr before it
// answers, so its wait is generous; past it the outcome is unknown, not failed.
export const BULK_CHUNK_TIMEOUT_MS = 120_000;

export type BulkItem = { tmdbId: number; mediaType: "MOVIE" | "TV" };

/**
 * The titles "Request All" sends. Skips titles already in the library, ones
 * THIS user already requested, blacklisted ones and ones permanently declined
 * for this user (`${mediaType}:${id}`; the route skips them on every click).
 * Titles other users requested are included on purpose: the bulk route copies
 * their status, so this user also gets the "now available" notification. The
 * server checks every one again when the request arrives.
 */
export function missingFromCollection(items: readonly TmdbMedia[], declinedKeys: readonly string[]): TmdbMedia[] {
  const declined = new Set(declinedKeys);
  return items.filter(
    (m) =>
      !m.plexAvailable &&
      !m.jellyfinAvailable &&
      !m.requestedByMe &&
      !m.blacklisted &&
      !declined.has(`${m.mediaType}:${m.id}`),
  );
}

export function toBulkItem(m: Pick<TmdbMedia, "id" | "mediaType">): BulkItem {
  return { tmdbId: m.id, mediaType: m.mediaType === "movie" ? "MOVIE" : "TV" };
}

export type ChunkAnswer =
  | { kind: "ok"; created: number; unrequestable: number }
  /** A 2xx whose body couldn't be read: the chunk went through, its count is unknown. */
  | { kind: "unreadable" }
  | { kind: "refused"; reason: string }
  /** No answer (network, a proxy's error page, the timeout): the route may have run it. */
  | { kind: "no-answer" }
  | { kind: "aborted" };

const BulkAnswer = v.object({
  created: v.int(),
  results: v.optional(v.array(v.object({ result: v.optional(v.string()) }))),
});

/** POSTs one chunk to the bulk route and reads its answer. */
export async function postBulkChunk(chunk: BulkItem[], signal: AbortSignal, somethingWrong: string): Promise<ChunkAnswer> {
  const res = await fetchJson(withBasePath("/api/requests/bulk"), {
    init: jsonInit("POST", { items: chunk }),
    schema: BulkAnswer,
    signal,
    timeoutMs: BULK_CHUNK_TIMEOUT_MS,
    fallbackError: somethingWrong,
  });
  if (res.ok) {
    let unrequestable = 0;
    for (const r of res.data.results ?? []) {
      if (r.result !== undefined && UNREQUESTABLE.has(r.result)) unrequestable++;
    }
    return { kind: "ok", created: res.data.created, unrequestable };
  }
  switch (res.kind) {
    case "invalid":
      return { kind: "unreadable" };
    case "http":
      return { kind: "refused", reason: res.error };
    case "aborted":
      return { kind: "aborted" };
    default:
      return { kind: "no-answer" };
  }
}

export interface CollectionRequestSummary {
  total: number;
  /** Items in chunks the route answered 2xx. */
  sent: number;
  created: number;
  unrequestable: number;
  /** Some answered chunk's body couldn't be read, so `created` is a floor. */
  unreadable: boolean;
  /** Why the run stopped before the last chunk, if it did. */
  stopped: Extract<ChunkAnswer, { kind: "refused" | "no-answer" | "aborted" }> | null;
}

/** Sends `payload` in chunks, one after another, and stops at the first chunk that fails. */
export async function requestInChunks(
  payload: readonly BulkItem[],
  post: (chunk: BulkItem[]) => Promise<ChunkAnswer>,
): Promise<CollectionRequestSummary> {
  const summary: CollectionRequestSummary = {
    total: payload.length,
    sent: 0,
    created: 0,
    unrequestable: 0,
    unreadable: false,
    stopped: null,
  };
  for (let i = 0; i < payload.length; i += BULK_REQUEST_MAX_ITEMS) {
    const chunk = payload.slice(i, i + BULK_REQUEST_MAX_ITEMS);
    const answer = await post(chunk);
    if (answer.kind === "ok") {
      summary.created += answer.created;
      summary.unrequestable += answer.unrequestable;
    } else if (answer.kind === "unreadable") {
      summary.unreadable = true;
    } else {
      summary.stopped = answer;
      return summary;
    }
    summary.sent += chunk.length;
  }
  return summary;
}

export interface CollectionRequestOutcome {
  state: "done" | "error";
  message: string;
  /** Reload the page: the rows created are what the click was for. */
  refresh: boolean;
}

/** The outcome line, and whether the page should reload to show what was requested. */
export function collectionRequestOutcome(s: CollectionRequestSummary, t: Translator): CollectionRequestOutcome {
  const total = s.total;
  if (s.stopped === null) {
    // Say why fewer than all were requested, rather than a bare "2 of 5"; and
    // never "0 of 5" for a chunk whose answer couldn't be read.
    const message = s.unreadable
      ? t("request.collection.doneUnknown", { total })
      : s.unrequestable > 0
        ? t("request.collection.doneSkipped", { created: s.created, total, skipped: s.unrequestable })
        : t("request.collection.done", { created: s.created, total });
    return { state: "done", message, refresh: true };
  }
  const noAnswer = s.stopped.kind !== "refused";
  const reason = s.stopped.kind === "refused"
    ? s.stopped.reason
    : s.sent > 0 ? t("request.collection.networkErrorLower") : t("request.networkError");
  return {
    state: "error",
    message: s.sent > 0 ? t("request.collection.partial", { created: s.created, total, reason }) : reason,
    // A partial failure (chunk k of n rejected) still reloads for the rows the
    // earlier chunks created, and so does a chunk with no answer, which the
    // route may have run.
    refresh: s.sent > 0 || noAnswer,
  };
}
