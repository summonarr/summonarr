import type { IconComponent } from "@/components/icons";
import {
  Film,
  Tv2,
  LayoutDashboard,
  ClipboardList,
  Settings,
  ShieldCheck,
  Users,
  AlertTriangle,
  Heart,
  CalendarDays,
  Clock,
  UserCircle,
  MessageSquare,
  Trophy,
  Flame,
  Library,
  ScrollText,
  BarChart3,
  HardDrive,
  Trash2,
  Activity,
  Sparkles,
  Ban,
  Bookmark,
  EyeOff,
  FileText,
  FileX,
} from "@/components/icons";
import type { Translator } from "@/lib/i18n/translate";
import { hasPermission, Permission, effectivePermissions, parsePermissions, type PermissionValue } from "@/lib/permissions";

export interface NavItem {
  href: string;
  // English label. Admin items are English-only for now; user-facing items
  // also carry an i18nKey that renderers translate through navItemLabel.
  label: string;
  i18nKey?: string;
  icon: IconComponent;
  // Match only this exact path when highlighting the active item (not sub-paths).
  exact?: boolean;
  // Marks items picked for a phone bottom tab bar (at most 5). No layout
  // component reads this flag today; tests/nav-items.test.mts checks the set.
  mobileBottomBar?: boolean;
  section: "browse" | "personal" | "admin";
}

// Map of nav item href → feature flag that controls its visibility. Items not
// listed here are always visible. See src/lib/features.ts for the registry and
// defaults. Kept here (rather than on each NavItem) because NavItem is used by
// both server and client components and we want the nav definition to stay a
// plain data module with no cross-file coupling beyond href strings.
export const NAV_ITEM_FEATURE_KEY: Record<string, string> = {
  "/for-you":            "feature.page.forYou",
  "/top":                "feature.page.top",
  "/popular":            "feature.page.popular",
  "/upcoming":           "feature.page.upcoming",
  "/issues":             "feature.page.issues",
  "/votes":              "feature.page.votes",
  "/donate":             "feature.page.donate",
  // Personal history pages are empty by construction while play-history
  // tracking (default OFF) is off — nothing records, so "plays will show up
  // here" would be false. Same gate /popular already uses.
  "/watch-history":      "playHistoryEnabled",
  "/my-stats":           "playHistoryEnabled",
  "/admin/issues":       "feature.page.issues",
  "/admin/stats":        "feature.admin.stats",
  "/admin/activity":     "feature.admin.activity",
  "/admin/audit-log":    "feature.admin.auditLog",
  "/admin/backup":       "feature.admin.backup",
  "/admin/api-docs":     "feature.admin.apiDocs",
  "/admin/cleanup":      "feature.admin.cleanup",
  "/admin/trash-guides": "trashGuidesEnabled",
};

/**
 * Filter nav items by an admin-controlled feature flag map. Pass `undefined`
 * or an empty map to show everything (fail-open, so nav never disappears
 * entirely if the flag query fails).
 */
export function filterNavByFeatures<T extends { href: string }>(
  items: readonly T[],
  flags?: Record<string, boolean>,
): T[] {
  if (!flags) return [...items];
  return items.filter((item) => {
    const key = NAV_ITEM_FEATURE_KEY[item.href];
    if (!key) return true;
    // Missing key in the flag map means "no row stored yet" → fall back to
    // showing the item. getFeatureFlags() always fills in registered keys
    // with their defaults, so this only matters for unregistered keys.
    return flags[key] !== false;
  });
}

export function navItemLabel(item: Pick<NavItem, "label" | "i18nKey">, t: Translator): string {
  return item.i18nKey ? t(item.i18nKey) : item.label;
}

/**
 * The ONE "is this nav item the current page" rule, shared by the sidebar, the
 * mobile drawer, the bottom tab bar and the header breadcrumb. It used to be
 * re-derived in each renderer and the copies disagreed: the drawer knew that
 * detail routes are singular (/movie/123) while the list is plural (/movies),
 * the sidebar did not, so on desktop /tv/123 lit "TV Shows" while /movie/603
 * lit nothing at all.
 *
 *   - `exact` items match only their own path ("/" and "/admin" would otherwise
 *     match every route beneath them).
 *   - "/movies" also owns the movie detail route "/movie/…".
 *   - Everything else matches itself or a sub-path on a segment boundary
 *     ("/tv" → "/tv/123", but not "/tvsomething").
 */
export function isNavItemActive(pathname: string, item: Pick<NavItem, "href" | "exact">): boolean {
  if (item.exact) return pathname === item.href;
  if (item.href === "/movies" && pathname.startsWith("/movie/")) return true;
  return pathname === item.href || pathname.startsWith(`${item.href}/`);
}

export const userNavItems: NavItem[] = [
  { href: "/", i18nKey: "nav.discover", label: "Discover", icon: LayoutDashboard, exact: true, mobileBottomBar: true, section: "browse" },
  { href: "/for-you", i18nKey: "nav.forYou", label: "For You", icon: Sparkles, section: "browse" },
  { href: "/movies", i18nKey: "nav.movies", label: "Movies", icon: Film, mobileBottomBar: true, section: "browse" },
  { href: "/tv", i18nKey: "nav.tvShows", label: "TV Shows", icon: Tv2, mobileBottomBar: true, section: "browse" },
  { href: "/top", i18nKey: "nav.topRated", label: "Top Rated", icon: Trophy, section: "browse" },
  { href: "/popular", i18nKey: "nav.popularOnServer", label: "Popular on Server", icon: Flame, section: "browse" },
  { href: "/upcoming", i18nKey: "nav.upcoming", label: "Upcoming", icon: CalendarDays, section: "browse" },
  { href: "/requests", i18nKey: "nav.requests", label: "Requests", icon: ClipboardList, mobileBottomBar: true, section: "personal" },
  { href: "/watchlist", i18nKey: "nav.watchlist", label: "Watchlist", icon: Bookmark, section: "personal" },
  { href: "/watch-history", i18nKey: "nav.watchHistory", label: "Watch History", icon: Clock, section: "personal" },
  { href: "/my-stats", i18nKey: "nav.myStats", label: "My Stats", icon: BarChart3, section: "personal" },
  { href: "/hidden", i18nKey: "nav.hidden", label: "Hidden", icon: EyeOff, section: "personal" },
  { href: "/issues", i18nKey: "nav.myIssues", label: "My Issues", icon: MessageSquare, section: "personal" },
  { href: "/votes", i18nKey: "nav.voteToDelete", label: "Vote to Delete", icon: Trash2, section: "personal" },
  { href: "/donate", i18nKey: "nav.donate", label: "Donate", icon: Heart, section: "personal" },
  { href: "/profile", i18nKey: "nav.profile", label: "Profile", icon: UserCircle, section: "personal" },
];

export const adminNavItems: NavItem[] = [
  { href: "/admin", label: "Requested", icon: ShieldCheck, exact: true, section: "admin" },
  { href: "/admin/issues", label: "Issues", icon: AlertTriangle, section: "admin" },
  { href: "/admin/users", label: "Users", icon: Users, section: "admin" },
  { href: "/admin/library", label: "Library Diff", icon: Library, section: "admin" },
  { href: "/admin/blacklist", label: "Blacklist", icon: Ban, section: "admin" },
  { href: "/admin/cleanup", label: "Library Cleanup", icon: FileX, section: "admin" },
  { href: "/admin/stats", label: "Statistics", icon: BarChart3, section: "admin" },
  { href: "/admin/activity", label: "Activity", icon: Activity, section: "admin" },
  { href: "/admin/audit-log", label: "Audit Log", icon: ScrollText, section: "admin" },
  { href: "/admin/backup", label: "Backup", icon: HardDrive, section: "admin" },
  { href: "/admin/trash-guides", label: "TRaSH Guides", icon: Sparkles, section: "admin" },
  { href: "/admin/api-docs", label: "API Docs", icon: FileText, section: "admin" },
  { href: "/settings", label: "Settings", icon: Settings, section: "admin" },
];

// The permission each admin destination ACTUALLY requires, mirroring the gate on
// its own page (the page/layout redirect is the enforcement; this map only
// decides whether to draw the link). Kept as an href-keyed map for the same
// reason as NAV_ITEM_FEATURE_KEY — NavItem stays a plain data shape shared by
// server and client components.
//
// Only three destinations are delegable. Everything else is ADMIN-only, which is
// why a MANAGE_USERS holder must NOT be shown Backup, Settings or the Audit Log:
// their page guards redirect to "/", so those links were dead ends that read as
// broken permissions. tests/nav-items.test.mts parses the real page sources and
// fails if this map and a page's gate ever disagree.
export const ADMIN_ITEM_PERMISSION: Record<string, PermissionValue> = {
  "/admin":        Permission.MANAGE_REQUESTS,
  "/admin/issues": Permission.MANAGE_ISSUES,
  "/admin/users":  Permission.MANAGE_USERS,
};

// Resolves the admin nav items visible for a role or permission set. Each item is
// filtered on the permission its own page enforces; hasPermission short-circuits
// on the ADMIN superbit, so a full admin still gets everything.
export function getVisibleAdminItems(roleOrPerms?: string | { role?: string; permissions?: bigint | string }): NavItem[] {
  const role = typeof roleOrPerms === "string" ? roleOrPerms : roleOrPerms?.role;
  const raw = typeof roleOrPerms === "object" && roleOrPerms !== null ? roleOrPerms.permissions : undefined;
  const stored = raw == null ? 0n : typeof raw === "string" ? parsePermissions(raw) : raw;
  // Let effectivePermissions apply the rules instead of copying them here: a
  // stored mask of 0n means "never set" and falls back to the role's preset, and
  // role ADMIN always adds the ADMIN bit. That second rule matters when a raw
  // User row is passed in — an ADMIN whose mask was edited to other bits must
  // still see the admin nav.
  const perms = role ? effectivePermissions(role, stored) : stored;
  return adminNavItems.filter((item) =>
    // An unmapped destination is ADMIN-only — fail CLOSED. This is deliberately
    // the opposite default to filterNavByFeatures: an unrecognized feature flag
    // should still show a page, but a new admin page nobody has classified must
    // not be advertised to a delegated user.
    hasPermission(perms, ADMIN_ITEM_PERMISSION[item.href] ?? Permission.ADMIN),
  );
}
