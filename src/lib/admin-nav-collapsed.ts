// The admin nav's collapsed groups as a cookie, so the (app) layout can render
// them collapsed on a hard load instead of painting every group open and
// collapsing them after hydration. localStorage stays the browser's copy
// (admin-nav-groups.tsx); this cookie mirrors it for the server. A display
// preference only: never read for anything but which headers start closed.
// Zero runtime imports (nav-items.ts pulls in the icon components), so the ids
// are listed here and checked against the AdminNavGroup union at compile time.
import type { AdminNavGroup } from "@/lib/nav-items";

export const ADMIN_NAV_COLLAPSED_COOKIE = "summonarr-admin-nav-collapsed";
// A year; the choice is renewed on every toggle.
const MAX_AGE_SECONDS = 365 * 24 * 60 * 60;

const IDS = ["requests", "downloads", "library", "insights", "system"] as const satisfies readonly AdminNavGroup[];
// Fails to compile when a group is added to AdminNavGroup but not to IDS.
const EVERY_GROUP_LISTED: Exclude<AdminNavGroup, (typeof IDS)[number]> extends never ? true : never = true;
void EVERY_GROUP_LISTED;
const GROUP_IDS: ReadonlySet<string> = new Set<string>(IDS);

/** The cookie's value → the known group ids it names, each once (anything else is dropped). */
export function parseCollapsedGroupsCookie(value: string | undefined): AdminNavGroup[] {
  if (!value) return [];
  const out = new Set<AdminNavGroup>();
  // At most one entry per group: a long hand-made value is never walked whole.
  for (const id of value.split(".", GROUP_IDS.size + 1)) {
    if (GROUP_IDS.has(id)) out.add(id as AdminNavGroup);
  }
  return [...out];
}

/** The `document.cookie` assignment that stores `ids` (ids are plain words: no encoding needed). */
export function collapsedGroupsCookie(ids: Iterable<AdminNavGroup>): string {
  const value = [...ids].filter((id) => GROUP_IDS.has(id)).join(".");
  return `${ADMIN_NAV_COLLAPSED_COOKIE}=${value}; path=/; max-age=${MAX_AGE_SECONDS}; samesite=lax`;
}
