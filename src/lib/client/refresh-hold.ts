// A hold on the page's live refresh, for a dialog whose result must stay on
// screen, and the one debounced refresh the page's buttons and LiveRefresh
// share. Pure and module-level, no React: LiveRefresh and the dialogs share
// one hold count and one refresh timer for the whole page.
//
// Why: an issue's Replace file / Replace release flips the issue to
// IN_PROGRESS — and announces it over SSE — BEFORE the work. LiveRefresh then
// refreshes the page, and on the default OPEN tab the issue (and with it the
// open dialog, below xl) leaves the list mid-request: the result, its
// "may stay unmonitored" warning and any refusal were never seen. While a hold
// is taken, a refresh is DEFERRED; the last release runs it once.
//
// Only a dialog takes a hold, in an effect whose cleanup releases it, so an
// unmount or a closed panel always lets the refresh through.

let holds = 0;
let pending: (() => void) | null = null;

/** Defer refreshes until the returned release is called. The release is idempotent. */
export function holdLiveRefresh(): () => void {
  holds++;
  let released = false;
  return () => {
    if (released) return;
    released = true;
    holds--;
    if (holds === 0 && pending) {
      const run = pending;
      pending = null;
      run();
    }
  };
}

/** Run a refresh now, or — while any hold is taken — once the last hold is released (the latest one asked for). */
export function runOrDefer(fn: () => void): void {
  if (holds > 0) {
    pending = fn;
    return;
  }
  fn();
}

// One page refresh per burst, shared by the page's buttons and LiveRefresh.
//
// Why: an issue button refreshed the page itself, and the change it made was
// announced over SSE, so LiveRefresh refreshed it again ~500 ms later — two
// full server renders (the issue list, counts, library lookups, Radarr/Sonarr
// holders) for every click. Both now ask here: the click's request and the
// event announcing it land in one window and make one refresh.
export const PAGE_REFRESH_DEBOUNCE_MS = 500;
let refreshTimer: ReturnType<typeof setTimeout> | null = null;

/** Refresh the page once the burst settles (each call restarts the wait), through runOrDefer. */
export function requestPageRefresh(fn: () => void): void {
  if (refreshTimer !== null) clearTimeout(refreshTimer);
  refreshTimer = setTimeout(() => {
    refreshTimer = null;
    runOrDefer(fn);
  }, PAGE_REFRESH_DEBOUNCE_MS);
}

/** Drop a refresh still waiting for its burst to settle (the page is going away). */
export function cancelPageRefresh(): void {
  if (refreshTimer !== null) clearTimeout(refreshTimer);
  refreshTimer = null;
}
