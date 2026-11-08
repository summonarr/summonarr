// The numbered window PaginationBar draws: up to two pages either side of the
// current one. Pure so the edge cases are testable without rendering.
//
// A current page past the end (a stale bookmark, a list that shrank under the
// reader) anchors the window on the LAST page instead: built around the
// requested page, `start` landed past `end` and the bar showed no numbers at
// all, with Previous pointing at another empty page.
export interface PagerWindow {
  /** The page the window is centred on: the current page, clamped to the last. */
  anchor: number;
  start: number;
  end: number;
  pages: number[];
  /** The page Previous links to, or null when there is none. */
  prev: number | null;
  /** The page Next links to, or null when there is none. */
  next: number | null;
  /** The page marked current, or null when the current page is out of range. */
  active: number | null;
}

export function pagerWindow(current: number, total: number): PagerWindow {
  const pastEnd = current > total;
  const anchor = Math.max(1, Math.min(current, total));
  const start = Math.max(1, anchor - 2);
  const end = Math.min(total, anchor + 2);
  const pages: number[] = [];
  for (let i = start; i <= end; i++) pages.push(i);
  return {
    anchor,
    start,
    end,
    pages,
    prev: pastEnd ? (total >= 1 ? total : null) : current > 1 ? current - 1 : null,
    next: !pastEnd && current < total ? current + 1 : null,
    active: pastEnd ? null : current,
  };
}
