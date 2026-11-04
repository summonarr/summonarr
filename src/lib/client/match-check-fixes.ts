// The library match check's "fixed on this page" bookkeeping
// (library-match-check.tsx). Pure and zero-import so it can be pinned.
//
// Why: an item-mode fix drops its flag from the STORED report and lowers
// counts.flagged in the same transaction (dropMatchFlagInTx), and Fix all ends
// with router.refresh(), which re-renders the page with that report but keeps
// the component's state. Subtracting every fix from the fresh counts counted
// each one twice, and a row kept on screen for its warning (a partial remap)
// vanished the moment its flag left the report.
//
// So a fix counts against the report only while the report still lists it, a
// fix with a warning keeps its row (from the flag it was made on), and a report
// from a NEW check — another checkedAt — voids the fixes made on the old one.

export interface MatchFlagIdentity {
  server: string;
  serverInstance: string;
  itemKey: string;
}

export const matchFlagKey = (f: MatchFlagIdentity): string => `${f.server}:${f.serverInstance}:${f.itemKey}`;

export interface MatchFixes<F> {
  /** The report (its checkedAt) the fixes were made on. */
  checkedAt: string | null;
  /** key -> the flag fixed and its warning ("" = none). */
  entries: ReadonlyMap<string, { flag: F; warning: string }>;
}

export function noMatchFixes<F>(): MatchFixes<F> {
  return { checkedAt: null, entries: new Map() };
}

/** Record one fix made on the report checked at `checkedAt`. */
export function recordMatchFix<F extends MatchFlagIdentity>(
  prev: MatchFixes<F>,
  checkedAt: string,
  flag: F,
  warning = "",
): MatchFixes<F> {
  const entries = new Map(prev.checkedAt === checkedAt ? prev.entries : []);
  entries.set(matchFlagKey(flag), { flag, warning });
  return { checkedAt, entries };
}

export interface MatchCheckView<F> {
  /** Rows to list: fixed-with-warning rows the report already dropped (first), then the report's flags less those fixed without a warning. */
  flags: F[];
  /** counts.flagged less the fixes the report doesn't reflect yet. */
  flagged: number;
  /** key -> warning ("" = none) for every fix made on THIS report. */
  fixed: ReadonlyMap<string, string>;
}

export function matchCheckView<F extends MatchFlagIdentity>(
  report: { checkedAt: string; counts: { flagged: number }; flags: readonly F[] } | null,
  fixes: MatchFixes<F>,
): MatchCheckView<F> {
  if (!report) return { flags: [], flagged: 0, fixed: new Map() };
  const entries = fixes.checkedAt === report.checkedAt ? fixes.entries : new Map<string, { flag: F; warning: string }>();
  const listed = new Set(report.flags.map(matchFlagKey));
  const fixed = new Map<string, string>();
  const kept: F[] = [];
  let unreflected = 0;
  for (const [key, { flag, warning }] of entries) {
    fixed.set(key, warning);
    if (listed.has(key)) unreflected++;
    else if (warning !== "") kept.push(flag);
  }
  return {
    flags: [...kept, ...report.flags.filter((f) => fixed.get(matchFlagKey(f)) !== "")],
    flagged: Math.max(0, report.counts.flagged - unreflected),
    fixed,
  };
}
