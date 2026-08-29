import { adminNavItems, userNavItems, type NavItem } from "@/lib/nav-items";

export type Crumb = { label: string; href?: string };

/**
 * Derive a header breadcrumb for the given pathname.
 *
 * Matches against the flat nav list first; detail routes (/movie/[id],
 * /tv/[id]) get a two-segment crumb so users see where they are.
 *
 * `detailTitle` is the title of the thing being viewed, supplied by the detail
 * page through DetailTitleProvider. Without it the last crumb read the literal
 * "Detail" — accurate but useless, with the actual title sitting right below it
 * in the hero. It stays the fallback for the first render (the context starts
 * null on both server and client, so hydration matches) and for any detail
 * route that doesn't publish one.
 */
export function breadcrumbFor(pathname: string, detailTitle?: string | null): Crumb[] {
  if (pathname.startsWith("/movie/")) {
    return [{ label: "Movies", href: "/movies" }, { label: detailTitle || "Detail" }];
  }
  if (pathname.startsWith("/tv/")) {
    return [{ label: "TV Shows", href: "/tv" }, { label: detailTitle || "Detail" }];
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
