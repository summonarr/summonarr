import { adminNavItems, isNavItemActive, navItemLabel, userNavItems, type NavItem } from "@/lib/nav-items";
import type { Translator } from "@/lib/i18n/translate";

export type Crumb = { label: string; href?: string };

// Last-resort label for a route the nav list doesn't know: Title-Case the last
// path segment ("watch-history" → "Watch History"), so the header shows a real
// name instead of a bare "—".
function titleCaseSegment(pathname: string): string | null {
  const segment = pathname.split("/").filter(Boolean).pop();
  if (!segment) return null;
  let decoded = segment;
  try {
    decoded = decodeURIComponent(segment);
  } catch {
    // keep the raw segment
  }
  const words = decoded
    .split(/[-_]+/)
    .filter(Boolean)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1));
  return words.length > 0 ? words.join(" ") : null;
}

/**
 * Derive a header breadcrumb for the given pathname.
 *
 * Matches against the flat nav list first; detail routes (/movie/[id],
 * /tv/[id], /person/[id]) get a two-segment crumb so users see where they are.
 *
 * `detailTitle` is the title of the thing being viewed (e.g. the movie name),
 * supplied by the detail page through DetailTitleProvider. Until it arrives the
 * last crumb falls back to "Detail"/"Person" — that is also what the first
 * render shows on both server and browser, so hydration matches.
 */
export function breadcrumbFor(
  pathname: string,
  detailTitle: string | null | undefined,
  t: Translator,
): Crumb[] {
  if (pathname.startsWith("/movie/")) {
    return [{ label: t("nav.movies"), href: "/movies" }, { label: detailTitle || t("nav.crumb.detail") }];
  }
  if (pathname.startsWith("/tv/")) {
    return [{ label: t("nav.tvShows"), href: "/tv" }, { label: detailTitle || t("nav.crumb.detail") }];
  }
  // People have no list page to link back to, so the parent crumb is a label.
  if (pathname.startsWith("/person/")) {
    return [{ label: t("nav.crumb.people") }, { label: detailTitle || t("nav.crumb.person") }];
  }
  if (pathname === "/my-stats/wrapped" || pathname.startsWith("/my-stats/wrapped/")) {
    return [{ label: t("nav.myStats"), href: "/my-stats" }, { label: t("nav.crumb.wrapped") }];
  }
  if (pathname === "/notifications" || pathname.startsWith("/notifications/")) {
    return [{ label: t("nav.crumb.notifications") }];
  }

  const all: readonly NavItem[] = [...userNavItems, ...adminNavItems];
  // Same matcher the sidebar/drawer/tab bar highlight with, so the crumb names
  // the item that is lit.
  const match = all
    .filter((i) => isNavItemActive(pathname, i))
    // Prefer the longest href so /admin/issues wins over /admin.
    .sort((a, b) => b.href.length - a.href.length)[0];

  if (match) return [{ label: navItemLabel(match, t) }];
  return [{ label: titleCaseSegment(pathname) ?? "—" }];
}
