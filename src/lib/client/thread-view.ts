// View rules shared by the issue thread and the request comment thread
// (src/components/issues/issue-thread.tsx, src/components/requests/request-thread.tsx).
// Pure, no React and no DOM types, so the unit suite can pin them.

export type ThreadLoadState = "idle" | "loading" | "ready" | "error";

/**
 * The state a failed thread read leaves behind. A silent (live-event) refresh
 * over a READY thread keeps it: one transient miss must not blank a healthy
 * view. Anything else is an error with its Retry — including a silent reload
 * that superseded a first load still on "loading". That first load's answer is
 * dropped as stale, so keeping "loading" left a spinner, a disabled reply box
 * and no Retry for good.
 */
export function failedLoadState(prev: ThreadLoadState, silent: boolean): ThreadLoadState {
  return silent && prev === "ready" ? prev : "error";
}

// How close to the bottom still counts as "reading the newest message".
export const NEAR_BOTTOM_PX = 40;

/** Whether a scroll container is at (or within NEAR_BOTTOM_PX of) its bottom. */
export function isNearBottom(el: { scrollHeight: number; scrollTop: number; clientHeight: number }): boolean {
  return el.scrollHeight - el.scrollTop - el.clientHeight < NEAR_BOTTOM_PX;
}
