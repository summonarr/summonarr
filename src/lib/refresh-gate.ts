// Holds a live list's refresh while a dialog opened from one of its rows is
// open. A refresh can drop that row (its status left the page's filter, a new
// entry pushed it to the next page) and the dialog with it — unsaved edits
// and all — so the refresh waits, and runs once when the last dialog closes.
// Pure and zero-import: the request list (admin-request-list.tsx) drives it
// from ManageTitleButton's onActiveChange.

export interface RefreshGate {
  /** A refresh is wanted. True when it may run now; false when it was deferred. */
  request(): boolean;
  /** A dialog opened. */
  opened(): void;
  /** A dialog closed. True when a refresh deferred meanwhile should run now. */
  closed(): boolean;
}

export function createRefreshGate(): RefreshGate {
  let open = 0;
  let deferred = false;
  return {
    request() {
      if (open > 0) {
        deferred = true;
        return false;
      }
      return true;
    },
    opened() {
      open++;
    },
    closed() {
      // An unmatched close (never opened) must not drive the count negative —
      // the next open would then read as closed.
      open = Math.max(0, open - 1);
      if (open > 0 || !deferred) return false;
      deferred = false;
      return true;
    },
  };
}
