// Admin → Arr System, the pure half of its tabs (arr-system-*.tsx): the keys
// its per-instance state lives under, which commands a card shows running, and
// the Indexers & clients tab's per-provider state.
//
// A card is one instance ("service:instance"); a SECTION is one kind of
// provider on it (its indexers, or its download clients). Everything a test or
// a save leaves behind lives in its section, per provider id — never in
// parallel maps under hand-built string keys:
//   result    the last test or save outcome shown under the row;
//   override  the provider as a save answered it, shown until a reload brings
//             the report's own copy;
//   held      a switch-ON the arr held back for warnings alone.
// A section also keeps its last Test All: the summary, or the refusal for the
// whole kind. Indexers and download clients keep separate section maps, so a
// saved indexer can never be read back as a client.
//
// A result or a summary belongs to the provider (or the list) AS THE REPORT HAD
// IT when the test or save was sent (`against`): a report that changes it hides
// the verdict, which no longer describes what is on screen.
//
// Zero runtime imports, so the unit suite loads it (tests/arr-system-state.test.mts).
import type { ArrCommandRow, ProviderKind, ProviderTestResult } from "@/lib/arr-system";

export type ArrServiceName = "radarr" | "sonarr";

/** One instance's card. */
export const cardKey = (service: ArrServiceName, instance: string) => `${service}:${instance}`;
/** One kind of provider on one card. */
export const sectionKey = (card: string, kind: ProviderKind) => `${card}:${kind}`;

/** The command names the report lists queued or running — read once per card, by every Run and search button on it. */
export function activeCommandNames(commands: readonly ArrCommandRow[]): ReadonlySet<string> {
  const names = new Set<string>();
  for (const c of commands) if (c.status === "started" || c.status === "queued") names.add(c.commandName);
  return names;
}

/**
 * What a row shows for a test or a save. `pending`: the page stopped waiting
 * while the arr was still at it — neither a pass nor a failure. `uncertain`:
 * Test All's answer doesn't say whether the failures were only warnings.
 */
export type TestView = Pick<ProviderTestResult, "ok" | "warning" | "messages" | "uncertain"> & { pending?: boolean };

/** A failed call's line: its reason, and whether the job may still finish on the server. */
export function failureView(error: string, stillRunning: boolean): TestView {
  return { ok: false, warning: false, messages: [error], ...(stillRunning ? { pending: true } : {}) };
}

export type Change = Record<string, boolean>;
export interface Held { change: Change; messages: string[] }
export interface Verdict { view: TestView; against: string }
export interface Summary { working: number; count: number; uncertain: number; against: string }

export interface RowState<P> {
  result?: Verdict;
  override?: P;
  held?: Held;
}
export interface SectionState<P> {
  summary?: Summary;
  /** Test All's own refusal (or still-running) for the whole kind. */
  all?: Verdict;
  rows: Readonly<Record<number, RowState<P>>>;
}
export type Sections<P> = Readonly<Record<string, SectionState<P>>>;

const EMPTY_SECTION: SectionState<never> = Object.freeze({ rows: Object.freeze({}) });

/** A provider as the report has it, for `against`. The route projects every provider the same way, so equal JSON is the same provider. */
export const providerSignature = (p: object): string => JSON.stringify(p);
/** A kind's whole list, for a Test All's summary. */
export const listSignature = (ps: readonly object[]): string => ps.map(providerSignature).join("\n");

export function sectionOf<P>(sections: Sections<P>, key: string): SectionState<P> {
  return sections[key] ?? EMPTY_SECTION;
}

const isEmptyRow = (row: RowState<unknown>) => row.result === undefined && row.override === undefined && row.held === undefined;

function withRow<P>(section: SectionState<P>, id: number, row: RowState<P>): SectionState<P> {
  const rows = { ...section.rows };
  if (isEmptyRow(row)) delete rows[id];
  else rows[id] = row;
  return { ...section, rows };
}

function withSection<P>(sections: Sections<P>, key: string, section: SectionState<P>): Sections<P> {
  return { ...sections, [key]: section };
}

/** `fn` applied to one section, absent or not. */
export function updateSection<P>(sections: Sections<P>, key: string, fn: (s: SectionState<P>) => SectionState<P>): Sections<P> {
  return withSection(sections, key, fn(sectionOf(sections, key)));
}

/**
 * A Test All answered: every row's verdict is replaced by the answer (a row it
 * didn't test — one switched off — must not keep an older one), the summary
 * counts it, and the kind's earlier refusal goes. `signatures` holds each
 * provider as the report had it when the test was sent.
 */
export function testAllAnswered<P>(
  section: SectionState<P>,
  answered: readonly ProviderTestResult[],
  signatures: ReadonlyMap<number, string>,
  listAgainst: string,
): SectionState<P> {
  const rows: Record<number, RowState<P>> = {};
  for (const [id, row] of Object.entries(section.rows)) {
    const kept: RowState<P> = { ...row };
    delete kept.result;
    if (!isEmptyRow(kept)) rows[Number(id)] = kept;
  }
  for (const r of answered) rows[r.id] = { ...rows[r.id], result: { view: r, against: signatures.get(r.id) ?? "" } };
  return {
    rows,
    summary: {
      working: answered.filter((r) => r.ok).length,
      count: answered.length,
      uncertain: answered.filter((r) => r.uncertain === true).length,
      against: listAgainst,
    },
  };
}

/** A Test All refused (or still running): the kind's line says so; the summary of an older one goes. */
export function testAllFailed<P>(section: SectionState<P>, view: TestView, listAgainst: string): SectionState<P> {
  return { rows: section.rows, all: { view, against: listAgainst } };
}

/**
 * A single test answered: its row shows the verdict, and the kind's Test All
 * verdicts (its refusal, its summary) go — they no longer describe every row.
 */
export function singleTestAnswered<P>(
  section: SectionState<P>,
  answered: readonly ProviderTestResult[],
  signatures: ReadonlyMap<number, string>,
): SectionState<P> {
  let next: SectionState<P> = { rows: section.rows };
  for (const r of answered) next = withRow(next, r.id, { ...next.rows[r.id], result: { view: r, against: signatures.get(r.id) ?? "" } });
  return next;
}

/** A single test refused (or still running): its row says so; the kind's Test All verdicts stay. */
export function singleTestFailed<P>(section: SectionState<P>, id: number, view: TestView, against: string): SectionState<P> {
  return withRow(section, id, { ...section.rows[id], result: { view, against } });
}

/** A save landed: the row shows the provider as the arr answered it; its old verdict and any held prompt go. */
export function saved<P>(section: SectionState<P>, id: number, provider: P): SectionState<P> {
  return withRow(section, id, { override: provider });
}

/** A switch-ON the arr held back for warnings alone: the prompt replaces the row's verdict. */
export function heldBack<P>(section: SectionState<P>, id: number, held: Held): SectionState<P> {
  const { override } = section.rows[id] ?? {};
  return withRow(section, id, { override, held });
}

/** A save refused or still running: its line, and — when the refusal says what the arr now holds — that provider. */
export function saveFailed<P>(section: SectionState<P>, id: number, view: TestView, against: string, provider: P | null): SectionState<P> {
  const row = section.rows[id] ?? {};
  return withRow(section, id, { override: provider ?? row.override, result: { view, against } });
}

/** The admin dropped a held prompt. */
export function dropHeld<P>(section: SectionState<P>, id: number): SectionState<P> {
  const row = section.rows[id];
  if (!row?.held) return section;
  const next = { ...row };
  delete next.held;
  return withRow(section, id, next);
}

/**
 * After a successful reload: the overrides and held prompts that were there at
 * the click are dropped — the report now says what the arr holds. One a save
 * wrote while the reload was out (another object) may be newer than what the
 * reload read, so it stays.
 */
export function pruneAfterReload<P>(now: Sections<P>, before: Sections<P>): Sections<P> {
  const out: Record<string, SectionState<P>> = {};
  for (const [key, section] of Object.entries(now)) {
    const was = before[key]?.rows ?? {};
    let next = section;
    for (const [rawId, row] of Object.entries(section.rows)) {
      const id = Number(rawId);
      const old = was[id];
      const kept: RowState<P> = { ...row };
      if (row.override !== undefined && row.override === old?.override) delete kept.override;
      if (row.held !== undefined && row.held === old?.held) delete kept.held;
      if (kept.override !== row.override || kept.held !== row.held) next = withRow(next, id, kept);
    }
    out[key] = next;
  }
  return out;
}

/** The verdict to show beside a provider as the report has it now — none once the report changed it. */
export function visibleVerdict(verdict: Verdict | undefined, against: string): TestView | undefined {
  return verdict && verdict.against === against ? verdict.view : undefined;
}

/** A Test All's summary, while the list it tested is the list on screen. */
export function visibleSummary(summary: Summary | undefined, listAgainst: string): Summary | undefined {
  return summary && summary.against === listAgainst ? summary : undefined;
}
