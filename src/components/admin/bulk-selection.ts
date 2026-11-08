// What is ticked on Admin → Missing's list on screen, as useBulkSelection
// (use-bulk-search.ts) reads it: the counts, the cap and the run. Pure and
// directive-free, so the cap arithmetic is unit-tested
// (tests/bulk-selection.test.mts).
//
// A tick outlives a page turn and a filter change, so the selection is every
// ticked row of this tab and mode — the listed ones in the order shown (every
// page), then those the filters now hide. The cap, the count on the button and
// the run all use this one list: counting only the rows on screen let a filter
// change tick past the cap, and the run then searched fewer titles than the
// button said.
import { BULK_SEARCH_MAX, capSelection } from "@/lib/bulk-search-run";

export interface SelectableRow {
  instance: string;
  arrId: number;
}

export interface SelectionRules<R> {
  selected: ReadonlySet<string>;
  /** The row's selection key on this list. */
  selKey: (r: R) => string;
  /** The row can be ticked (not being searched, searched, complete or held by a run). */
  isOpen: (r: R) => boolean;
}

/** The passes over the whole list — every page, and the unfiltered report. */
export interface ListSelection<R> {
  /** Ticked rows the filters list, in the order shown, across every page. */
  selectedListed: R[];
  /** Ticked rows the filters hide (in the report, not listed). */
  selectedHidden: R[];
  /** Everything ticked on this list: what the cap counts and a run takes. */
  selectedHere: R[];
  /** What a run takes — and so what the button says. */
  toRun: R[];
  atCap: boolean;
}

export function listSelection<R>(
  currentRows: readonly R[],
  reportItems: readonly R[],
  { selected, selKey, isOpen }: SelectionRules<R>,
): ListSelection<R> {
  const listedKeys = new Set(currentRows.map(selKey));
  const selectedListed = currentRows.filter((r) => selected.has(selKey(r)) && isOpen(r));
  const selectedHidden = reportItems.filter((r) => !listedKeys.has(selKey(r)) && selected.has(selKey(r)) && isOpen(r));
  const selectedHere = [...selectedListed, ...selectedHidden];
  return {
    selectedListed,
    selectedHidden,
    selectedHere,
    toRun: capSelection(selectedHere),
    atCap: selectedHere.length >= BULK_SEARCH_MAX,
  };
}

/** The header box's view of the rows on screen (this page). */
export interface PageSelection<R> {
  /** Rows on screen that can be ticked. */
  selectable: R[];
  /** Keys of every row on screen. */
  shownKeys: ReadonlySet<string>;
  /** Ticked rows elsewhere in the list (other pages). */
  selectedOffPage: number;
  /** The room the cap leaves on this page beside the ticks elsewhere. */
  roomOnPage: number;
  /** Every row on screen that the cap leaves room for is ticked. */
  allSelected: boolean;
}

/**
 * `pageRows` must be a slice of the list `list` was computed from (the page of
 * the filtered rows): the off-page count is the listed ticks minus this page's.
 */
export function pageSelection<R>(
  list: ListSelection<R>,
  pageRows: readonly R[],
  { selected, selKey, isOpen }: SelectionRules<R>,
): PageSelection<R> {
  const selectable = pageRows.filter(isOpen);
  const selectedShown = selectable.filter((r) => selected.has(selKey(r))).length;
  const selectedOffPage = list.selectedListed.length - selectedShown;
  const roomOnPage = BULK_SEARCH_MAX - selectedOffPage - list.selectedHidden.length;
  return {
    selectable,
    shownKeys: new Set(pageRows.map(selKey)),
    selectedOffPage,
    roomOnPage,
    allSelected: selectedShown > 0 && selectedShown === Math.min(selectable.length, roomOnPage),
  };
}
