import { adminNavItems, userNavItems, type NavItem } from "@/lib/nav-items";

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
