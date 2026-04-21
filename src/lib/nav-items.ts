import type { LucideIcon } from "lucide-react";
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
} from "lucide-react";

export interface NavItem {
  href: string;
  label: string;
  icon: LucideIcon;
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
  { href: "/movies", label: "Movies", icon: Film, mobileBottomBar: true, section: "browse" },
  { href: "/tv", label: "TV Shows", icon: Tv2, mobileBottomBar: true, section: "browse" },
  { href: "/top", label: "Top Rated", icon: Trophy, section: "browse" },
  { href: "/popular", label: "Popular on Server", icon: Flame, section: "browse" },
  { href: "/upcoming", label: "Upcoming", icon: CalendarDays, section: "browse" },
  { href: "/requests", label: "Requests", icon: ClipboardList, mobileBottomBar: true, section: "personal" },
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
  { href: "/admin/stats", label: "Statistics", icon: BarChart3, section: "admin" },
  { href: "/admin/activity", label: "Activity", icon: Activity, section: "admin" },
  { href: "/admin/audit-log", label: "Audit Log", icon: ScrollText, section: "admin" },
  { href: "/admin/backup", label: "Backup", icon: HardDrive, section: "admin" },
  { href: "/admin/trash-guides", label: "TRaSH Guides", icon: Sparkles, section: "admin" },
  { href: "/settings", label: "Settings", icon: Settings, section: "admin" },
];

export function getVisibleAdminItems(role?: string): NavItem[] {
  if (role === "ADMIN") return adminNavItems;
  if (role === "ISSUE_ADMIN") return adminNavItems.filter((i) => i.href === "/admin/issues");
  return [];
}
