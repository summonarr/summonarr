// The bookkeeping behind the notification switches' autosave
// (notification-prefs.tsx). A save sends only the switches flipped since the
// last one: the route writes every boolean it receives, so sending the whole
// set from this tab's snapshot would put back any preference changed meanwhile
// in another tab or the iOS app. Pure, so the unit suite runs it directly
// (tests/notification-prefs-delta.test.mts).

export type PrefDelta<T> = Partial<T>;

/** `prefs` with `delta` applied. */
export function applyDelta<T extends { [K in keyof T]: boolean }>(prefs: T, delta: PrefDelta<T>): T {
  return { ...prefs, ...delta };
}

/**
 * After a failed save of `failed`: put each of its switches back to the last
 * value the server confirmed, except one flipped again since (still in
 * `pending`) — the next save sends that one, and rolling it back would make
 * the switch disagree with what that save stores.
 */
export function revertFailed<T extends { [K in keyof T]: boolean }>(
  prefs: T,
  confirmed: T,
  failed: PrefDelta<T>,
  pending: PrefDelta<T> | null,
): T {
  const next = { ...prefs };
  for (const key of Object.keys(failed) as (keyof T)[]) {
    if (pending && key in pending) continue;
    next[key] = confirmed[key];
  }
  return next;
}
