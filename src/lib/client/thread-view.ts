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

type ThreadItem = { id: string; createdAt: string };

// Oldest first, the id breaking createdAt ties — the server's order reversed.
function sortsBefore(a: ThreadItem, b: ThreadItem): boolean {
  if (a.createdAt !== b.createdAt) return a.createdAt < b.createdAt;
  return a.id < b.id;
}

/**
 * A reload's list (the newest page) merged with what the thread already shows:
 * older messages loaded through "load older" stay (a reload would otherwise
 * drop them, and as the window slides they could not be re-read without a gap),
 * and the viewer's own sends in `pending` that the list doesn't hold yet stay at
 * the end (a reload sent before the POST committed answers without them).
 */
export function mergeThreadReload<T extends ThreadItem>(list: T[], prev: T[], pending: ReadonlySet<string>): T[] {
  const seen = new Set(list.map((m) => m.id));
  const oldest = list[0];
  const older = oldest ? prev.filter((m) => !seen.has(m.id) && !pending.has(m.id) && sortsBefore(m, oldest)) : [];
  const kept = prev.filter((m) => pending.has(m.id) && !seen.has(m.id));
  return older.length === 0 && kept.length === 0 ? list : [...older, ...list, ...kept];
}

/** Older messages joined to the top of the thread, skipping any already shown. */
export function prependOlder<T extends ThreadItem>(prev: T[], olderPage: T[]): T[] {
  const seen = new Set(prev.map((m) => m.id));
  const fresh = olderPage.filter((m) => !seen.has(m.id));
  return fresh.length === 0 ? prev : [...fresh, ...prev];
}
