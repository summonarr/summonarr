// The mobile bottom tab bar's tabs: Discover, Browse, Requests and a fourth
// slot that depends on what the viewer may open (admin area, the issue queue,
// or Profile). Tab membership comes from each NavItem's `section` through the
// shared isNavItemActive rule, never a hand-kept path list. Pure, so the unit
// suite checks it (tests/mobile-tabs.test.mts).
import {
  LayoutDashboard,
  Film,
  ClipboardList,
  UserCircle,
  ShieldCheck,
  AlertTriangle,
  type IconComponent,
} from "@/components/icons";
import { isNavItemActive, userNavItems, type NavItem } from "@/lib/nav-items";
import type { Translator } from "@/lib/i18n/translate";

export type MobileTab = {
  href: string;
  label: string;
  icon: IconComponent;
  match: (pathname: string) => boolean;
};

// Personal-section pages the Profile tab claims when it is present (the 4th slot
// without admin access). They are carved out of the Requests tab's membership
// so a page never lights two tabs; when an admin tab replaces Profile, these
// light nothing and the "More" button takes the accent.
export const PROFILE_TAB_HREFS: ReadonlySet<string> = new Set(["/profile", "/donate"]);

// The one rule the sidebar uses: an item owns its path and its sub-paths.
function matchesAnyOf(items: readonly NavItem[]): (pathname: string) => boolean {
  return (pathname) => items.some((i) => isNavItemActive(pathname, i));
}

function sectionMatcher(
  section: NavItem["section"],
  omit: ReadonlySet<string>,
): (pathname: string) => boolean {
  return matchesAnyOf(userNavItems.filter((i) => i.section === section && !omit.has(i.href)));
}

export type FourthTab = "admin" | "issues" | "profile";

// The 4th slot comes from the same admin-item list the sidebar draws, so it
// always points at a page this viewer is allowed to open (not a hardcoded
// "/admin" that some delegates would be redirected away from). An issue
// manager with nothing else gets the issue queue under its own name.
export function fourthTab(adminItems: readonly Pick<NavItem, "href">[]): FourthTab {
  if (adminItems.length === 0) return "profile";
  if (adminItems.length === 1 && adminItems[0].href === "/admin/issues") return "issues";
  return "admin";
}

/** The four bottom tabs for a viewer whose visible admin items are `adminItems`. */
export function buildMobileTabs(adminItems: readonly Pick<NavItem, "href">[], t: Translator): MobileTab[] {
  const discover: MobileTab = {
    href: "/",
    label: t("nav.discover"),
    icon: LayoutDashboard,
    match: (p) => p === "/",
  };
  // /movies carries no feature flag, so Browse always lands there.
  const browse: MobileTab = {
    href: "/movies",
    label: t("nav.tab.browse"),
    icon: Film,
    // Every browse-section page except Discover's own "/" (which has its tab).
    match: sectionMatcher("browse", new Set(["/"])),
  };
  const requests: MobileTab = {
    href: "/requests",
    label: t("nav.requests"),
    icon: ClipboardList,
    match: sectionMatcher("personal", PROFILE_TAB_HREFS),
  };
  return [discover, browse, requests, fourthSlot(fourthTab(adminItems), adminItems, t)];
}

function fourthSlot(kind: FourthTab, adminItems: readonly Pick<NavItem, "href">[], t: Translator): MobileTab {
  switch (kind) {
    case "admin":
      return {
        href: adminItems[0].href,
        label: t("nav.section.admin"),
        icon: ShieldCheck,
        match: (p) => p.startsWith("/admin") || p === "/settings",
      };
    case "issues":
      return {
        href: "/admin/issues",
        label: t("nav.tab.issues"),
        icon: AlertTriangle,
        match: (p) => p.startsWith("/admin/issues"),
      };
    case "profile":
      return {
        href: "/profile",
        label: t("nav.profile"),
        icon: UserCircle,
        match: matchesAnyOf(userNavItems.filter((i) => PROFILE_TAB_HREFS.has(i.href))),
      };
  }
}
