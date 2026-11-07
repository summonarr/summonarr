// The toast stack's cap, kept out of toast.tsx so it can be unit-tested.

// The most toasts on screen at once. A burst (a batch action failing item by
// item) used to stack without limit, each error staying 10 seconds.
export const MAX_TOASTS = 5;

/** Appends `item` and keeps only the newest `max`. `evicted` are the ids
 *  pushed out, whose auto-dismiss timers the caller must clear. */
export function pushCapped<T extends { id: number }>(
  list: readonly T[],
  item: T,
  max: number = MAX_TOASTS,
): { kept: T[]; evicted: number[] } {
  const next = [...list, item];
  const cut = Math.max(0, next.length - Math.max(1, max));
  return { kept: next.slice(cut), evicted: next.slice(0, cut).map((t) => t.id) };
}
