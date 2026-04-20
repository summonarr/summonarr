"use client";

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

// 30 ms debounce coalesces ratings requests from all cards that render in a single paint cycle
const DEBOUNCE_MS = 30;
// Cap batch size so the POST body stays well within Next.js / Vercel request size limits
const MAX_BATCH = 200;

const queue = new Map<Key, QueueEntry>();
let flushTimer: ReturnType<typeof setTimeout> | null = null;

function scheduleFlush() {
  if (flushTimer) return;
  flushTimer = setTimeout(flush, DEBOUNCE_MS);
}

async function flush() {
  flushTimer = null;
  if (queue.size === 0) return;

  const drained = Array.from(queue.values()).slice(0, MAX_BATCH);
  for (const e of drained) queue.delete(`${e.type}:${e.id}`);
  if (queue.size > 0) scheduleFlush();

  try {
    const res = await fetch("/api/ratings/batch", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        items: drained.map((e) => ({ id: e.id, type: e.type, releaseDate: e.releaseDate })),
      }),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = (await res.json()) as { ratings?: Record<string, RatingsPayload> };
    const ratings = data.ratings ?? {};
    for (const e of drained) {
      const payload = ratings[`${e.type}:${e.id}`] ?? null;
      for (const r of e.resolvers) r(payload);
    }
  } catch {
    for (const e of drained) {
      for (const r of e.resolvers) r(null);
    }
  }
}

export function requestRatings(
  id: number,
  type: MediaType,
  releaseDate: string | null = null,
): Promise<RatingsPayload | null> {
  return new Promise((resolve) => {
    const key = `${type}:${id}`;
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
