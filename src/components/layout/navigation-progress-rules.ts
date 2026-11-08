// Which link clicks start the navigation progress bar, as far as the URL can
// tell (navigation-progress.tsx checks the event and the anchor first). Pure,
// so the unit suite pins it (tests/navigation-progress.test.mts).

export interface CurrentLocation {
  href: string;
  origin: string;
  pathname: string;
  search: string;
}

/**
 * True when following `href` (resolved against the current page) will make the
 * App Router fetch and commit a new page. A different origin leaves the app
 * entirely, and a same-URL or hash-only link commits no router navigation — in
 * those cases the completion signal never fires and the bar would ride its
 * stall timeout for nothing.
 */
export function startsAppNavigation(href: string, here: CurrentLocation): boolean {
  let next: URL;
  try {
    next = new URL(href, here.href);
  } catch {
    return false;
  }
  if (next.origin !== here.origin) return false;
  if (next.href === here.href) return false;
  return !(next.pathname === here.pathname && next.search === here.search);
}
