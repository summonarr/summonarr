// Which section an in-page nav highlights (the settings side nav's scroll-spy).
// Pure so the rule is unit-tested; the nav is a client component the test
// loader can't import.

// A section's top within this many px of the scroller's top counts as reached.
export const SECTION_SPY_THRESHOLD_PX = 80;
// Within this many px of the end the scroller counts as fully scrolled.
const BOTTOM_SLACK_PX = 2;

export interface SpySection {
  id: string;
  /** Top edge relative to the scroller's top edge; null when not rendered. */
  top: number | null;
}

export interface SpyScroller {
  scrollTop: number;
  clientHeight: number;
  scrollHeight: number;
}

/**
 * The active section: the last one, in nav order, whose top has reached the
 * threshold. Once the scroller can go no further, a short section at the end
 * of the page can never reach the threshold, so the last section on the page
 * wins instead — or `preferred` (the entry just clicked) when it is on screen,
 * so clicking one of several short final sections keeps it highlighted.
 */
export function activeSectionId(
  sections: readonly SpySection[],
  scroller: SpyScroller,
  preferred: string | null = null,
): string {
  let current = sections[0]?.id ?? "";
  for (const { id, top } of sections) {
    if (top !== null && top <= SECTION_SPY_THRESHOLD_PX) current = id;
  }
  // A page that doesn't scroll at all is not "at the bottom": its first
  // section stays the default.
  const scrollable = scroller.scrollHeight - scroller.clientHeight > BOTTOM_SLACK_PX;
  const atBottom = scroller.scrollTop + scroller.clientHeight >= scroller.scrollHeight - BOTTOM_SLACK_PX;
  if (!scrollable || !atBottom) return current;
  const onPage = sections.filter((s) => s.top !== null);
  // Its top edge is on screen (an anchor jump to it puts it there).
  const visible = (s: SpySection) => s.top !== null && s.top >= 0 && s.top < scroller.clientHeight;
  const clicked = preferred === null ? undefined : onPage.find((s) => s.id === preferred);
  if (clicked && visible(clicked)) return clicked.id;
  return onPage.length > 0 ? onPage[onPage.length - 1].id : current;
}
