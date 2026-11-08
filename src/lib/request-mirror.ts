// Which statuses of ANOTHER user's request for the same title on the same
// instance count as a greenlight a new request may copy instead of going to
// review. One rule for the three create paths: request-create.ts (web + the
// watchlist auto-request), the bulk route and the Discord pick.
//
// APPROVED always: an admin approved it, or its requester could auto-approve.
//
// AVAILABLE only when the instance's own *arr-available cache holds the title.
// AVAILABLE is not an approval: the sync's library pass flips a PENDING request
// AVAILABLE as soon as the title shows up on ANY Plex/Jellyfin server (a
// restricted one this requester has no grant for, or the HD copy when the
// request is for a 4K instance). Copied as APPROVED, a request the *arr does not
// have is re-pushed by the sync (sync/route.ts, "stillApproved") — a download
// nobody approved. With the *arr holding it, the copy is true for this
// requester too and nothing is pushed.
//
// Pure and zero-import so every caller and its tests share it.
export type GreenlitPeerStatus = "APPROVED" | "AVAILABLE";

export function greenlitPeerStatuses(arrHasTitle: boolean): GreenlitPeerStatus[] {
  return arrHasTitle ? ["APPROVED", "AVAILABLE"] : ["APPROVED"];
}
