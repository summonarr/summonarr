"use client";
import { withBasePath } from "@/lib/base-path";

export interface RatingsPayload {
  imdbId: string | null;
  imdbRating: string | null;
  imdbVotes: string | null;
  rottenTomatoes: string | null;
  rtAudienceScore: string | null;
  metacritic: string | null;
  traktRating: string | null;
  letterboxdRating: string | null;
  mdblistScore: string | null;
  malRating: string | null;
  rogerEbertRating: string | null;
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
// Must match MAX_BATCH in /api/ratings/batch, which rejects larger batches with a 400.
const MAX_BATCH = 200;
// A batch the server never answers still resolves its cards (with null) after
// this long, instead of leaving them waiting for good.
const BATCH_TIMEOUT_MS = 60_000;

const queue = new Map<Key, QueueEntry>();
// Entries whose batch POST is on the wire. A card asking for one of these joins
// it rather than queueing the same title into a second POST (which would also
// spend the user's per-minute batch limit).
const inflight = new Map<Key, QueueEntry>();
let flushTimer: ReturnType<typeof setTimeout> | null = null;

function keyOf(type: MediaType, id: number): Key {
  return `${type}:${id}`;
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

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), BATCH_TIMEOUT_MS);
  // null = the batch failed (HTTP error, network, bad JSON, timeout).
  let ratings: Record<string, RatingsPayload> | null;
  try {
    const res = await fetch(withBasePath("/api/ratings/batch"), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        items: drained.map((e) => ({ id: e.id, type: e.type, releaseDate: e.releaseDate })),
      }),
      signal: controller.signal,
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = (await res.json()) as { ratings?: Record<string, RatingsPayload> };
    ratings = data.ratings ?? {};
  } catch {
    ratings = null;
  } finally {
    clearTimeout(timeout);
  }
  // Leave the in-flight map and resolve in one synchronous pass, so no card can
  // join an entry after its resolvers ran.
  for (const e of drained) {
    const key = keyOf(e.type, e.id);
    if (inflight.get(key) === e) inflight.delete(key);
    const payload = ratings ? ratings[key] ?? null : null;
    for (const r of e.resolvers) r(payload);
  }
}

// Public entry point: enqueue a ratings lookup that resolves once the next
// debounced batch POST returns. Coalesces duplicate requests for the same item,
// including one whose batch is already on the wire. Never rejects: a failed or
// timed-out batch resolves null.
export function requestRatings(
  id: number,
  type: MediaType,
  releaseDate: string | null = null,
): Promise<RatingsPayload | null> {
  return new Promise((resolve) => {
    const key = keyOf(type, id);
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
