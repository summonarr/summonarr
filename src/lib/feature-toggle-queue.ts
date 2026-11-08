// How the Features tab settles its batched switch saves (features-form.tsx).
// PURE, zero imports: the form is a client component.
//
// /api/settings allows 10 PATCHes a minute per admin. The form batches flips
// made within FLUSH_DELAY_MS of each other, but an admin working down the list
// at about one switch a second sends a request per flip, and the 11th in a
// minute is refused with 429. That reply means "not sent yet", not "failed":
// reverting the switch and showing an error undid a choice the server never
// judged. So a 429 leaves the whole batch pending and the form tries again
// after a backoff (the limiter's 429 carries no retry delay of its own).

export const FLUSH_DELAY_MS = 400;
export const RATE_LIMIT_RETRY_MIN_MS = 6_000;
export const RATE_LIMIT_RETRY_MAX_MS = 60_000;

export type FlushOutcome = "saved" | "rateLimited" | "failed";

// `reply` is null when the request never got an answer (network error).
export function flushOutcome(reply: { status: number; ok: boolean | undefined } | null): FlushOutcome {
  if (reply === null) return "failed";
  if (reply.status === 429) return "rateLimited";
  return reply.status >= 200 && reply.status < 300 && reply.ok === true ? "saved" : "failed";
}

// 6s, then doubling up to a minute: the limiter's window is one minute.
export function nextRetryDelay(previousMs: number | null): number {
  return previousMs === null ? RATE_LIMIT_RETRY_MIN_MS : Math.min(previousMs * 2, RATE_LIMIT_RETRY_MAX_MS);
}

export interface ToggleQueue {
  // The last value the server confirmed, per switch.
  saved: Record<string, boolean>;
  // The value the admin wants and the server hasn't confirmed yet.
  pending: Map<string, boolean>;
}

export interface SettledSwitch {
  key: string;
  ok: boolean;
  // On failure, the confirmed value the switch goes back to.
  revertTo?: boolean;
}

// Applies a reply to the batch it answered. Returns the switches it finished;
// a switch flipped again while the request ran stays pending for the next round
// (an older reply must not overwrite a newer intent), and on a 429 the whole
// batch stays pending.
export function settleBatch(
  queue: ToggleQueue,
  batch: ReadonlyArray<readonly [key: string, target: boolean]>,
  outcome: FlushOutcome,
): SettledSwitch[] {
  if (outcome === "rateLimited") return [];
  const settled: SettledSwitch[] = [];
  for (const [key, target] of batch) {
    if (outcome === "saved") queue.saved[key] = target;
    if (queue.pending.get(key) !== target) continue;
    queue.pending.delete(key);
    settled.push(outcome === "saved" ? { key, ok: true } : { key, ok: false, revertTo: queue.saved[key] ?? false });
  }
  return settled;
}
