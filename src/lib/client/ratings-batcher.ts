"use client";
import { withBasePath } from "@/lib/base-path";
import { retryAfterDeltaSeconds } from "@/lib/client/rate-limit";
import { RATINGS_BATCH_MAX_ITEMS } from "@/lib/api-body-limits";
import { timedFetch } from "@/lib/client/fetch-json";
import { check, v, type Infer } from "@/lib/validate";

const ratingsPayloadSchema = v.object({
  imdbId: v.nullable(v.string()),
  imdbRating: v.nullable(v.string()),
  imdbVotes: v.nullable(v.string()),
  rottenTomatoes: v.nullable(v.string()),
  rtAudienceScore: v.nullable(v.string()),
  metacritic: v.nullable(v.string()),
  traktRating: v.nullable(v.string()),
  letterboxdRating: v.nullable(v.string()),
  mdblistScore: v.nullable(v.string()),
  malRating: v.nullable(v.string()),
  rogerEbertRating: v.nullable(v.string()),
});

export type RatingsPayload = Infer<typeof ratingsPayloadSchema>;

// Only well-formed entries are kept: a malformed one reads as absent.
function validRatings(raw: Record<string, unknown>): Record<string, RatingsPayload> {
  const out: Record<string, RatingsPayload> = {};
  for (const [key, value] of Object.entries(raw)) {
    const r = check(ratingsPayloadSchema, value);
    if (r.ok) out[key] = r.value;
  }
  return out;
}

type MediaType = "movie" | "tv";
type Key = string;

interface QueueEntry {
  id: number;
  type: MediaType;
  releaseDate: string | null;
  resolvers: Array<(data: RatingsPayload | null) => void>;
}

// Wait 30 ms before sending, so every card that renders in the same paint cycle
// shares one batch request.
const DEBOUNCE_MS = 30;
// /api/ratings/batch rejects a larger batch with a 400; one shared constant.
const MAX_BATCH = RATINGS_BATCH_MAX_ITEMS;
// A batch the server never answers still resolves its cards (with null) after
// this long, instead of leaving them waiting for good.
const BATCH_TIMEOUT_MS = 60_000;

// A batch refused with a 429 or a 5xx, or lost on the network, is sent once
// more after this wait (a 429's own Retry-After when it names one up to
// RETRY_MAX_WAIT_MS; past that the batch resolves null rather than hold the
// cards). Anything else — a 4xx, a body that isn't the route's JSON — is final.
let retryDelayMs = 2_000;
const RETRY_MAX_WAIT_MS = 10_000;

// Answers already fetched, so a grid revisited in the same tab doesn't ask
// again: the newest MEMO_MAX, for the life of the page (ratings move over days,
// not minutes; a reload asks again). Only real payloads: "no ratings yet" may
// be a title the server is still warming (the batch route warms cold titles
// after it answers). No clock: this module runs in client components
// (guardrail 16).
const MEMO_MAX = 500;
const memo = new Map<Key, RatingsPayload>();

const queue = new Map<Key, QueueEntry>();
// Entries whose batch POST is on the wire. A card asking for one of these joins
// it rather than queueing the same title into a second POST (which would also
// spend the user's per-minute batch limit).
const inflight = new Map<Key, QueueEntry>();
let flushTimer: ReturnType<typeof setTimeout> | null = null;

function keyOf(type: MediaType, id: number): Key {
  return `${type}:${id}`;
}

function remember(key: Key, data: RatingsPayload): void {
  memo.delete(key);
  memo.set(key, data);
  // Insertion order is age order: drop the oldest past the cap.
  while (memo.size > MEMO_MAX) memo.delete(memo.keys().next().value as Key);
}

function remembered(key: Key): RatingsPayload | null {
  return memo.get(key) ?? null;
}

/** Test seam: forget every remembered answer, and set the retry wait. */
export function __resetRatingsBatcherForTests(opts: { retryDelayMs?: number } = {}): void {
  memo.clear();
  retryDelayMs = opts.retryDelayMs ?? 2_000;
}

type BatchAttempt =
  | { kind: "ok"; ratings: Record<string, RatingsPayload> }
  | { kind: "retry"; delayMs: number }
  | { kind: "failed" };

async function postBatchOnce(items: QueueEntry[]): Promise<BatchAttempt> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), BATCH_TIMEOUT_MS);
  try {
    const res = await timedFetch(withBasePath("/api/ratings/batch"), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        items: items.map((e) => ({ id: e.id, type: e.type, releaseDate: e.releaseDate })),
      }),
      signal: controller.signal,
    }, BATCH_TIMEOUT_MS);
    if (res.status === 429) {
      const seconds = retryAfterDeltaSeconds(res.headers?.get("Retry-After"));
      if (seconds === null) return { kind: "retry", delayMs: retryDelayMs };
      const delayMs = seconds * 1000;
      return delayMs <= RETRY_MAX_WAIT_MS ? { kind: "retry", delayMs: Math.max(delayMs, retryDelayMs) } : { kind: "failed" };
    }
    if (res.status >= 500) return { kind: "retry", delayMs: retryDelayMs };
    if (!res.ok) return { kind: "failed" };
    const data: unknown = await res.json().catch(() => undefined);
    if (data === undefined) return { kind: "failed" };
    const ratings = data && typeof data === "object" ? (data as { ratings?: unknown }).ratings : undefined;
    return {
      kind: "ok",
      ratings: ratings && typeof ratings === "object" && !Array.isArray(ratings) ? validRatings(ratings as Record<string, unknown>) : {},
    };
  } catch {
    // A timeout is final (the server had a minute); a network failure is not.
    return controller.signal.aborted ? { kind: "failed" } : { kind: "retry", delayMs: retryDelayMs };
  } finally {
    clearTimeout(timeout);
  }
}

// The batch's ratings map, or null when it failed (after its one retry).
async function postBatch(items: QueueEntry[]): Promise<Record<string, RatingsPayload> | null> {
  let attempt = await postBatchOnce(items);
  if (attempt.kind === "retry") {
    const delayMs = attempt.delayMs;
    await new Promise<void>((r) => setTimeout(r, delayMs));
    attempt = await postBatchOnce(items);
  }
  return attempt.kind === "ok" ? attempt.ratings : null;
}

function scheduleFlush() {
  if (flushTimer) return;
  flushTimer = setTimeout(flush, DEBOUNCE_MS);
}

async function flush() {
  flushTimer = null;
  if (queue.size === 0) return;

  const drained = Array.from(queue.values()).slice(0, MAX_BATCH);
  for (const e of drained) {
    const key = keyOf(e.type, e.id);
    queue.delete(key);
    inflight.set(key, e);
  }
  if (queue.size > 0) scheduleFlush();

  // null = the batch failed (HTTP error, network, bad JSON, timeout).
  const ratings = await postBatch(drained);
  // Leave the in-flight map and resolve in one synchronous pass, so no card can
  // join an entry after its resolvers ran.
  for (const e of drained) {
    const key = keyOf(e.type, e.id);
    if (inflight.get(key) === e) inflight.delete(key);
    const payload = ratings ? ratings[key] ?? null : null;
    if (payload) remember(key, payload);
    for (const r of e.resolvers) r(payload);
  }
}

// Public entry point: enqueue a ratings lookup that resolves once the next
// debounced batch POST returns. Coalesces duplicate requests for the same item,
// including one whose batch is already on the wire, and answers a title already
// fetched on this page from memory. Never rejects: a failed or timed-out
// batch resolves null.
export function requestRatings(
  id: number,
  type: MediaType,
  releaseDate: string | null = null,
): Promise<RatingsPayload | null> {
  const key = keyOf(type, id);
  const known = remembered(key);
  if (known) return Promise.resolve(known);
  return new Promise((resolve) => {
    // Already in a batch on the wire: wait for that answer.
    const sent = inflight.get(key);
    if (sent) {
      sent.resolvers.push(resolve);
      return;
    }
    // Multiple components requesting the same item share a single queue entry; all resolvers fire together
    const existing = queue.get(key);
    if (existing) {
      existing.resolvers.push(resolve);
    } else {
      queue.set(key, { id, type, releaseDate, resolvers: [resolve] });
    }
    scheduleFlush();
  });
}
