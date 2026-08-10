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
} from "@/components/icons";
import { hasPermission, Permission, effectivePermissions, parsePermissions, type PermissionValue } from "@/lib/permissions";

export interface NavItem {
  href: string;
  label: string;
  icon: IconComponent;
  exact?: boolean;

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
  "/admin/issues":       "feature.page.issues",
  "/admin/stats":        "feature.admin.stats",
  "/admin/activity":     "feature.admin.activity",
  "/admin/audit-log":    "feature.admin.auditLog",
  "/admin/backup":       "feature.admin.backup",
  "/admin/api-docs":     "feature.admin.apiDocs",
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

export const userNavItems: NavItem[] = [
  { href: "/", label: "Discover", icon: LayoutDashboard, exact: true, mobileBottomBar: true, section: "browse" },
  { href: "/for-you", label: "For You", icon: Sparkles, section: "browse" },
  { href: "/movies", label: "Movies", icon: Film, mobileBottomBar: true, section: "browse" },
  { href: "/tv", label: "TV Shows", icon: Tv2, mobileBottomBar: true, section: "browse" },
  { href: "/top", label: "Top Rated", icon: Trophy, section: "browse" },
  { href: "/popular", label: "Popular on Server", icon: Flame, section: "browse" },
  { href: "/upcoming", label: "Upcoming", icon: CalendarDays, section: "browse" },
  { href: "/requests", label: "Requests", icon: ClipboardList, mobileBottomBar: true, section: "personal" },
  { href: "/watchlist", label: "Watchlist", icon: Bookmark, section: "personal" },
  { href: "/watch-history", label: "Watch History", icon: Clock, section: "personal" },
  { href: "/my-stats", label: "My Stats", icon: BarChart3, section: "personal" },
  { href: "/hidden", label: "Hidden", icon: EyeOff, section: "personal" },
  { href: "/issues", label: "My Issues", icon: MessageSquare, section: "personal" },
  { href: "/votes", label: "Vote to Delete", icon: Trash2, section: "personal" },
  { href: "/donate", label: "Donate", icon: Heart, section: "personal" },
  { href: "/profile", label: "Profile", icon: UserCircle, section: "personal" },
];

export const adminNavItems: NavItem[] = [
  { href: "/admin", label: "Requested", icon: ShieldCheck, exact: true, section: "admin" },
  { href: "/admin/issues", label: "Issues", icon: AlertTriangle, section: "admin" },
  { href: "/admin/users", label: "Users", icon: Users, section: "admin" },
  { href: "/admin/library", label: "Library Diff", icon: Library, section: "admin" },
  { href: "/admin/blacklist", label: "Blacklist", icon: Ban, section: "admin" },
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
  // Resolve through effectivePermissions rather than re-deriving its convention
  // here. It owns both halves: a stored mask of 0n means "never seeded" and falls
  // back to the role preset, and role ADMIN always contributes the superbit. The
  // previous inline version consulted the role ONLY when the mask was zero, so an
  // ADMIN row carrying any other non-zero bits — reachable via the permissions
  // editor in /api/admin/users/[id], which can write an arbitrary mask over an
  // existing ADMIN — resolved without the ADMIN bit and got NO admin nav at all.
  // Not live today (claimsToSession normalizes before every current call site),
  // but the {role, permissions} signature invites passing a raw User row.
  const perms = role ? effectivePermissions(role, stored) : stored;
  return adminNavItems.filter((item) =>
    // An unmapped destination is ADMIN-only — fail CLOSED. This is deliberately
    // the opposite default to filterNavByFeatures: an unrecognized feature flag
    // should still show a page, but a new admin page nobody has classified must
    // not be advertised to a delegated user.
    hasPermission(perms, ADMIN_ITEM_PERMISSION[item.href] ?? Permission.ADMIN),
  );
}
