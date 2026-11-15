// The admin nav's count badges (href → count, e.g. the Download Queue's
// downloads needing attention), as the browser keeps them fresh. Pure and
// zero-import, so the "use client" NavBadgesProvider (admin-nav-groups.tsx)
// imports it directly.
//
// The (app) layout renders the first value, but App Router layouts do not
// re-render on client navigation — so without a re-read the badge froze at the
// last full page load, and the "stale snapshot ⇒ no badge" rule never fired in
// a long session. The provider re-reads GET /api/admin/arr-watch (its
// `navBadges` field, computed server-side by the same rule as the layout) on
// this interval and when the tab comes back — and the server pushes the same
// field as a `nav:badges` SSE frame the moment a monitor run stores a new count.

/** How often an open tab re-reads the badges. The monitor itself runs every 15 minutes by default. */
export const NAV_BADGE_POLL_MS = 5 * 60_000;
/** A tab flicking back into view re-reads at most this often. */
export const NAV_BADGE_MIN_REFETCH_MS = 60_000;

const MAX_BADGES = 50;

/**
 * The Activity item's badge: the streams playing right now. It is NOT part of
 * the arr-watch answer — the layout renders the first count and the
 * `activity:sessions` SSE frame (every play-history poll, ~5 s) keeps it live.
 */
export const ACTIVITY_BADGE_HREF = "/admin/activity";

/** `badges` with the Activity count set to `count` (0 removes it). Undefined ⇒ no badges at all. */
export function withActivityCount(
  badges: Readonly<Record<string, number>> | undefined,
  count: number,
): Record<string, number> | undefined {
  const { [ACTIVITY_BADGE_HREF]: _old, ...rest } = badges ?? {};
  const out: Record<string, number> = Number.isSafeInteger(count) && count > 0 ? { ...rest, [ACTIVITY_BADGE_HREF]: count } : rest;
  return Object.keys(out).length > 0 ? out : undefined;
}

/**
 * A new arr-watch answer (the poll, or a `nav:badges` push) over what is
 * shown: it replaces every badge EXCEPT the Activity count, which that answer
 * never carries and the session stream owns.
 */
export function withArrBadges(
  shown: Readonly<Record<string, number>> | undefined,
  next: Readonly<Record<string, number>>,
): Record<string, number> | undefined {
  const { [ACTIVITY_BADGE_HREF]: _stale, ...arr } = next;
  return withActivityCount(arr, shown?.[ACTIVITY_BADGE_HREF] ?? 0);
}

/**
 * The `navBadges` field of a GET /api/admin/arr-watch answer, or null when it
 * isn't one (an older server, a garbled body) — null keeps the badges the page
 * already shows. An object, even an empty one, is the new truth: `{}` is "no
 * badges". Only whole, non-negative counts under an admin href survive.
 */
export function parseNavBadges(raw: unknown): Record<string, number> | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const out: Record<string, number> = {};
  for (const [href, n] of Object.entries(raw as Record<string, unknown>)) {
    if (Object.keys(out).length >= MAX_BADGES) break;
    if (!href.startsWith("/admin") || href.length > 100) continue;
    if (typeof n === "number" && Number.isSafeInteger(n) && n > 0) out[href] = n;
  }
  return out;
}
