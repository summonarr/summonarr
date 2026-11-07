// URL rules shared by the list-page filters (FilterPills and SearchBox in
// src/components/user-list-filters.tsx). Pure, so tests/user-list-search-sync
// can pin them without rendering the client components.
import { sanitizeContainsSearch } from "@/lib/sanitize";

type ParamReader = { get(key: string): string | null };

/** The href a filter navigates to: only the `preserve` keys are carried over
 *  (everything else, the page number included, is dropped), then `param` is
 *  set, or left out when `value` is empty. */
export function buildParamHref(
  pathname: string,
  current: ParamReader,
  param: string,
  value: string,
  preserve?: readonly string[],
): string {
  const params = new URLSearchParams();
  if (preserve) {
    for (const key of preserve) {
      const v = current.get(key);
      if (v) params.set(key, v);
    }
  }
  if (value) params.set(param, value);
  return `${pathname}?${params.toString()}`;
}

/** True when two hrefs name the same path and the same params, whatever their
 *  order — so a click that would land on the current URL can be skipped. */
export function sameListHref(a: string, b: string): boolean {
  const norm = (href: string) => {
    const q = href.indexOf("?");
    const path = q === -1 ? href : href.slice(0, q);
    const params = new URLSearchParams(q === -1 ? "" : href.slice(q + 1));
    params.sort();
    return `${path}?${params.toString()}`;
  };
  return norm(a) === norm(b);
}

/** What the list pages echo back as `initial` for a typed search: each runs
 *  sanitizeContainsSearch(q.trim()) before rendering. */
export function searchEcho(raw: string): string {
  return sanitizeContainsSearch(raw.trim());
}

/** Whether a new `initial` from the server should replace the text in the box.
 *  Only a change from OUTSIDE does (back/forward, a pill, a link): never while
 *  the user's own search is still waiting to be sent, and never when `initial`
 *  is just the server's normalised echo of what the box last pushed ("star "
 *  comes back as "star"; `%`, `_` and `\` are stripped). */
export function shouldResyncSearch(initial: string, lastPushedEcho: string, pending: boolean): boolean {
  return !pending && initial !== lastPushedEcho;
}
