import { adminNavItems, userNavItems, type NavItem } from "@/lib/nav-items";

export type Crumb = { label: string; href?: string };

/**
 * Derive a header breadcrumb for the given pathname.
 *
 * Matches against the flat nav list first; detail routes (/movie/[id],
 * /tv/[id]) get a two-segment crumb so users see where they are.
 */
export function breadcrumbFor(pathname: string): Crumb[] {
  if (pathname.startsWith("/movie/")) {
    return [{ label: "Movies", href: "/movies" }, { label: "Detail" }];
  }
  if (pathname.startsWith("/tv/")) {
    return [{ label: "TV Shows", href: "/tv" }, { label: "Detail" }];
  }

  const all: readonly NavItem[] = [...userNavItems, ...adminNavItems];
  const match = all
    .filter((i) =>
      i.exact ? pathname === i.href : pathname.startsWith(i.href),
    )
    // Prefer the longest href so /admin/issues wins over /admin.
    .sort((a, b) => b.href.length - a.href.length)[0];

  if (match) return [{ label: match.label }];
  return [{ label: "—" }];
}
