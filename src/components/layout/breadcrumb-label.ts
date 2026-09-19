import { adminNavItems, userNavItems, type NavItem } from "@/lib/nav-items";

export type Crumb = { label: string; href?: string };

// Last-resort label for a route the nav list doesn't know: Title-Case the last
// path segment ("watch-history" → "Watch History"). Anything is better than
// the literal "—" this used to render, which was verified live on
// /notifications — a page with a real name that just isn't a nav item.
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
  // People have no list page to link back to, so the parent crumb is a label.
  if (pathname.startsWith("/person/")) {
    return [{ label: "People" }, { label: detailTitle || "Person" }];
  }
  if (pathname === "/my-stats/wrapped" || pathname.startsWith("/my-stats/wrapped/")) {
    return [{ label: "My Stats", href: "/my-stats" }, { label: "Wrapped" }];
  }
  if (pathname === "/notifications" || pathname.startsWith("/notifications/")) {
    return [{ label: "Notifications" }];
  }

  const all: readonly NavItem[] = [...userNavItems, ...adminNavItems];
  const match = all
    .filter((i) =>
      i.exact ? pathname === i.href : pathname.startsWith(i.href),
    )
    // Prefer the longest href so /admin/issues wins over /admin.
    .sort((a, b) => b.href.length - a.href.length)[0];

  if (match) return [{ label: match.label }];
  return [{ label: titleCaseSegment(pathname) ?? "—" }];
}
