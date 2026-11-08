"use client";

import { Fragment, memo, useCallback, useDeferredValue, useEffect, useId, useMemo, useRef, useState } from "react";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Chip } from "@/components/ui/design";
import { stripTrashHtml } from "@/lib/trash-html";
import { useHasMounted } from "@/hooks/use-has-mounted";
import { useAsyncAction } from "@/hooks/use-async-action";
import { useFocusReturn } from "@/hooks/use-focus-return";
import { useLocale, useT } from "@/components/i18n/i18n-provider";
import { formatRelativeTimeLocalized } from "@/lib/relative-time";
import { fetchJson, jsonInit, type FetchJsonFailure, type FetchJsonOptions } from "@/lib/client/fetch-json";
import type { Translator } from "@/lib/i18n/translate";
import {
  ChevronDown,
  ChevronRight,
  Loader2,
  Shield,
  ShieldOff,
  XCircle,
} from "@/components/icons";
import {
  SPEC_DETAIL_ANSWER,
  SPEC_STATUS_ANSWER,
  type SpecDetail,
  type SpecStatus,
  type TrashService,
  type TrashSpecKind,
} from "./types";
import { ApplyLog } from "./apply-log";
import { answerOf, applyOutcome } from "./outcomes";
import { countSpecs, filterSpecs, specMatches, SPEC_FILTERS, SPEC_FILTER_LABEL_KEYS, type SpecFilter } from "./spec-filters";
import { StatusNote } from "./status-note";
import { useTrashRun, type TrashRun } from "./use-trash-run";
import { withBasePath } from "@/lib/base-path";

interface SpecSectionProps {
  title: string;
  description: string;
  service: TrashService;
  kind: TrashSpecKind;
  // Which instance to manage — an instance slug ("" default, "4k", or a named
  // slug). The parent remounts this component (via a variant-keyed `key`) when
  // the toggle flips, so state resets cleanly.
  variant?: string;
  disabled: boolean;
  // Notify parent to refetch e.g. KPI counts when the application set changes.
  onChanged?: () => void;
  // Controlled mode: a page rendering several sections fetches /status ONCE
  // (it returns every kind) via useSpecStatus and hands the result to each
  // section — see SpecSections. Omitted, the section fetches for itself.
  status?: SpecStatusState;
}

export interface SpecStatusState {
  specs: SpecStatus[];
  loaded: boolean;
  loadError: string | null;
  reload: () => Promise<void>;
}

/** The latest value of something a stable callback reads (set after each commit, never during render). */
function useLatest<T>(value: T) {
  const ref = useRef(value);
  useEffect(() => {
    ref.current = value;
  });
  return ref;
}

// One /status fetch for a (service, variant) pair. `enabled: false` makes it
// inert (a section handed a controlled `status` must not fetch a second copy).
export function useSpecStatus(service: TrashService, variant: string, enabled = true): SpecStatusState {
  const t = useT();
  // Read through a ref: a page refresh hands the provider a new `t`, and as a
  // dependency it would re-read the whole catalog with nobody clicking.
  const tRef = useLatest(t);
  const [specs, setSpecs] = useState<SpecStatus[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);

  const load = useCallback(async (signal?: AbortSignal) => {
    const res = await fetchJson(
      withBasePath(`/api/admin/trash-guides/status?service=${service.toLowerCase()}&variant=${encodeURIComponent(variant)}`),
      { schema: SPEC_STATUS_ANSWER, signal },
    );
    // A superseded request (service/variant switched) must not overwrite
    // the newer selection's specs.
    if (signal?.aborted || (!res.ok && res.kind === "aborted")) return;
    if (res.ok) {
      setSpecs(res.data.specs ?? []);
      setLoadError(null);
    } else {
      setSpecs([]);
      setLoadError(
        res.kind === "http" ? res.error || `HTTP ${res.status}`
          : res.kind === "invalid" ? `HTTP ${res.status}`
            : tRef.current("trash.spec.error.network"),
      );
    }
    setLoaded(true);
  }, [service, variant, tRef]);

  useEffect(() => {
    if (!enabled) return;
    const controller = new AbortController();
    void load(controller.signal);
    return () => controller.abort();
  }, [load, enabled]);

  const reload = useCallback(() => load(), [load]);
  return { specs, loaded, loadError, reload };
}

// The detail payloads of the expanded rows. Each is read once per version of
// its spec (`fetchedAt` moves when a catalog refresh rewrites the spec), so an
// expanded row never shows an outdated payload or SHA after a refresh. A row
// collapsed mid-read drops its read, and a read already out is never started
// twice. A failed read hands the row back to `onFailed`.
function useSpecDetails(
  specs: readonly SpecStatus[],
  expanded: ReadonlySet<string>,
  variant: string,
  onFailed: (id: string, message: string) => void,
): ReadonlyMap<string, SpecDetail> {
  const t = useT();
  const [read, setRead] = useState<ReadonlyMap<string, { version: string; detail: SpecDetail }>>(() => new Map());
  const action = useAsyncAction();
  const onFailedRef = useLatest(onFailed);
  const tRef = useLatest(t);

  useEffect(() => {
    for (const spec of specs) {
      const key = `detail:${spec.id}`;
      if (!expanded.has(spec.id)) {
        if (action.busy(key)) action.abort(key);
        continue;
      }
      if (read.get(spec.id)?.version === spec.fetchedAt || action.busy(key)) continue;
      const version = spec.fetchedAt;
      void action.run(key, (signal) =>
        fetchJson(withBasePath(`/api/admin/trash-guides/spec/${spec.id}?variant=${encodeURIComponent(variant)}`), {
          schema: SPEC_DETAIL_ANSWER,
          signal,
        }), { ifBusy: "skip" }).then((res) => {
        if (!res || (!res.ok && res.kind === "aborted")) return;
        if (res.ok) {
          setRead((prev) => new Map(prev).set(spec.id, { version, detail: res.data }));
          return;
        }
        onFailedRef.current(
          spec.id,
          res.kind === "http" || res.kind === "invalid"
            ? tRef.current("trash.spec.error.loadDetail", { status: res.status })
            : tRef.current("trash.spec.error.network"),
        );
      });
    }
  }, [specs, expanded, read, variant, action, onFailedRef, tRef]);

  return useMemo(() => {
    const current = new Map<string, SpecDetail>();
    for (const spec of specs) {
      const r = read.get(spec.id);
      if (r && r.version === spec.fetchedAt) current.set(spec.id, r.detail);
    }
    return current;
  }, [specs, read]);
}

// Literal keys (the i18n dead-key check can't see a built one).
const ROW_FAILURE_KEYS = {
  pause: "trash.spec.error.pause",
  resume: "trash.spec.error.resume",
  forget: "trash.spec.error.forget",
} as const;

// A row action's failure: the route's own reason (TRaSH switched off, the row
// gone), else the generic line with its status.
function rowFailure(res: FetchJsonFailure, what: keyof typeof ROW_FAILURE_KEYS, t: Translator): string {
  if (res.kind === "http") return res.error || t(ROW_FAILURE_KEYS[what], { status: res.status });
  if (res.kind === "invalid") return t(ROW_FAILURE_KEYS[what], { status: res.status });
  return t("trash.spec.error.network");
}

function toggled(set: ReadonlySet<string>, id: string): ReadonlySet<string> {
  const next = new Set(set);
  if (next.has(id)) next.delete(id);
  else next.add(id);
  return next;
}

export function SpecSection({
  title,
  description,
  service,
  kind,
  variant = "",
  disabled,
  onChanged,
  status,
}: SpecSectionProps) {
  const mounted = useHasMounted();
  const t = useT();
  const own = useSpecStatus(service, variant, status === undefined);
  const { specs, loaded, loadError, reload: load } = status ?? own;
  const [selected, setSelected] = useState<ReadonlySet<string>>(() => new Set());
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(() => new Set());
  const [filter, setFilter] = useState<SpecFilter>("all");
  const [search, setSearch] = useState("");
  // A catalog is hundreds of rows: the list follows the search at low
  // priority, so typing stays responsive.
  const deferredSearch = useDeferredValue(search);
  const [rowError, setRowError] = useState<string | null>(null);
  const detailIdPrefix = useId();
  const onChangedRef = useLatest(onChanged);
  const run = useTrashRun();
  const rowAction = useAsyncAction();

  const specsHere = useMemo(
    () => specs.filter((s) => s.service === service && s.kind === kind),
    [specs, service, kind],
  );
  const filtered = useMemo(() => filterSpecs(specsHere, filter, deferredSearch), [specsHere, filter, deferredSearch]);

  // Selections survive a filter/search change but must not be acted on while
  // hidden — every count, the header checkbox and the apply payload read the
  // intersection with the visible rows.
  const visibleSelected = useMemo(
    () => filtered.filter((s) => selected.has(s.id)),
    [filtered, selected],
  );

  const details = useSpecDetails(specsHere, expanded, variant, (id, message) => {
    setRowError(message);
    setExpanded((prev) => (prev.has(id) ? toggled(prev, id) : prev));
  });

  // Stable, so a row only re-renders when its own props change.
  const toggleSelected = useCallback((id: string) => setSelected((prev) => toggled(prev, id)), []);
  const toggleRow = useCallback((id: string) => {
    setRowError(null);
    setExpanded((prev) => toggled(prev, id));
  }, []);

  // One application's PATCH (pause/resume) or DELETE (forget). The route's own
  // reason when it refuses (TRaSH switched off, the row gone); a second click
  // while one is out does nothing.
  const applicationAction = useCallback(async (
    appId: string,
    init: FetchJsonOptions["init"],
    what: keyof typeof ROW_FAILURE_KEYS,
  ) => {
    setRowError(null);
    const res = await rowAction.run(`app:${appId}`, (signal) =>
      fetchJson(withBasePath(`/api/admin/trash-guides/applications/${appId}`), { init, signal }),
    { ifBusy: "skip" });
    if (!res || (!res.ok && res.kind === "aborted")) return;
    if (!res.ok) {
      setRowError(rowFailure(res, what, t));
      return;
    }
    await load();
    onChangedRef.current?.();
  }, [rowAction, load, onChangedRef, t]);

  const setManaged = useCallback(
    (appId: string, enabled: boolean) => applicationAction(appId, jsonInit("PATCH", { enabled }), enabled ? "resume" : "pause"),
    [applicationAction],
  );
  const forget = useCallback(
    (appId: string) => applicationAction(appId, { method: "DELETE" }, "forget"),
    [applicationAction],
  );

  async function applySelected() {
    const ids = visibleSelected.map((s) => s.id);
    if (ids.length === 0 || run.busy()) return;
    run.begin();
    // Every selected spec is written to the instance in one request: no client
    // timeout, or a slow success would read as a failure.
    const res = await run.request((signal) =>
      fetchJson(withBasePath(`/api/admin/trash-guides/apply`), { init: jsonInit("POST", { specIds: ids, variant }), timeoutMs: Infinity, signal }),
    );
    if (!res) return;
    const answer = answerOf(res);
    if (answer === undefined) return;
    if (answer === null) {
      run.fail(t("trash.spec.error.network"));
      return;
    }
    // 409 (the trash lock is held) ran nothing: "already running", as on the
    // other cards. A refusal (403 off, 429, 400) keeps the selection for a
    // retry and shows the route's reason.
    const outcome = applyOutcome(answer.status, answer.body, t("trash.spec.error.apply", { status: answer.status }));
    if (outcome.kind === "skipped") {
      run.skip("running");
      return;
    }
    run.done(outcome.failed, outcome.errors.length > 0 ? { errors: outcome.errors } : null, outcome.results);
    if (outcome.results.length > 0 || !outcome.failed) {
      setSelected((prev) => {
        const next = new Set(prev);
        for (const id of ids) next.delete(id);
        return next;
      });
      await load();
      onChangedRef.current?.();
    }
  }

  const selectAllFiltered = () => setSelected(new Set(filtered.map((s) => s.id)));
  const selectBy = (f: SpecFilter) => setSelected(new Set(filtered.filter((s) => specMatches(s, f)).map((s) => s.id)));
  const clearSelection = () => setSelected(new Set());

  const allSelected = filtered.length > 0 && visibleSelected.length === filtered.length;
  const someSelected = visibleSelected.length > 0 && visibleSelected.length < filtered.length;

  return (
    <div className="space-y-4">
      <Card className="bg-zinc-900 border-zinc-800 p-6">
        <div className="flex items-start justify-between gap-4 mb-4 flex-wrap">
          <div>
            <h2 className="font-semibold text-zinc-100 text-lg">{title}</h2>
            <p className="text-sm text-zinc-500 mt-0.5">{description}</p>
          </div>
          <SpecCounts specs={specsHere} />
        </div>

        {rowError && (
          <p className="text-sm text-red-400 mb-3">{rowError}</p>
        )}

        <SpecFilterBar filter={filter} onFilter={setFilter} search={search} onSearch={setSearch} />

        <div className="flex flex-wrap items-center gap-2 mb-3 text-xs">
          <span className="text-zinc-500">{t("trash.starter.quickSelect")}</span>
          <BulkButton onClick={selectAllFiltered} disabled={disabled}>{t("trash.spec.allVisible", { count: filtered.length })}</BulkButton>
          {QUICK_SELECT.map((f) => (
            <BulkButton key={f} onClick={() => selectBy(f)} disabled={disabled}>{t(SPEC_FILTER_LABEL_KEYS[f])}</BulkButton>
          ))}
          {selected.size > 0 && (
            // Counts what Apply will act on (the visible intersection), so the two
            // counters agree; a selection the filter hides is called out — Clear
            // still drops it.
            <>
              <BulkButton onClick={clearSelection} tone="ghost">{t("trash.starter.clearCount", { count: visibleSelected.length })}</BulkButton>
              {selected.size > visibleSelected.length && (
                <span className="text-zinc-500">{t("trash.spec.hiddenSelected", { count: selected.size - visibleSelected.length })}</span>
              )}
            </>
          )}
        </div>

        <SpecListBody loaded={loaded} loadError={loadError} empty={specsHere.length === 0} noMatch={filtered.length === 0}>
          <div className="overflow-x-auto -mx-6">
            <table className="w-full text-sm">
              <SpecTableHead
                allSelected={allSelected}
                someSelected={someSelected}
                disabled={disabled}
                onToggleAll={() => (allSelected ? clearSelection() : selectAllFiltered())}
              />
              <tbody>
                {filtered.map((spec) => (
                  <SpecRow
                    key={spec.id}
                    spec={spec}
                    kind={kind}
                    selected={selected.has(spec.id)}
                    isOpen={expanded.has(spec.id)}
                    detail={details.get(spec.id) ?? null}
                    detailId={`${detailIdPrefix}-detail-${spec.id}`}
                    disabled={disabled}
                    mounted={mounted}
                    onToggleSelected={toggleSelected}
                    onToggleRow={toggleRow}
                    onSetManaged={setManaged}
                    onForget={forget}
                  />
                ))}
              </tbody>
            </table>
          </div>
        </SpecListBody>

        <ApplyBar run={run} count={visibleSelected.length} disabled={disabled || visibleSelected.length === 0} onApply={applySelected} />
      </Card>

      {run.log.length > 0 && <ApplyLog results={run.log} onDismiss={run.dismissLog} />}
    </div>
  );
}

// The quick-select buttons after "All visible", in order: each selects the
// visible rows its filter chip would list.
const QUICK_SELECT = ["unmanaged", "managed", "errored"] as const satisfies readonly SpecFilter[];

function SpecFilterBar({
  filter,
  onFilter,
  search,
  onSearch,
}: {
  filter: SpecFilter;
  onFilter: (f: SpecFilter) => void;
  search: string;
  onSearch: (q: string) => void;
}) {
  const t = useT();
  return (
    <div className="flex flex-wrap gap-2 mb-3">
      {SPEC_FILTERS.map((f) => (
        <button
          key={f}
          type="button"
          aria-pressed={filter === f}
          onClick={() => onFilter(f)}
          className={`px-2.5 py-1 rounded-full text-xs font-medium transition-colors ${
            filter === f
              ? "bg-indigo-600 text-[var(--ds-accent-fg)]"
              : "bg-zinc-800 text-zinc-400 hover:text-zinc-100"
          }`}
        >
          {t(SPEC_FILTER_LABEL_KEYS[f])}
        </button>
      ))}
      <input
        type="search"
        aria-label={t("trash.spec.searchAria")}
        placeholder={t("trash.spec.searchPlaceholder")}
        value={search}
        onChange={(e) => onSearch(e.target.value)}
        className="ml-auto bg-zinc-800 border border-zinc-700 rounded px-2 py-1 text-xs text-zinc-100 placeholder-zinc-500 focus:outline-none focus:border-indigo-500 w-60"
      />
    </div>
  );
}

// Apply and its result: "Applied", "already running" (a 409), or the failure
// inline with its own Dismiss (the apply log below stays).
function ApplyBar({
  run,
  count,
  disabled,
  onApply,
}: {
  run: TrashRun;
  count: number;
  disabled: boolean;
  onApply: () => void;
}) {
  const t = useT();
  return (
    <div className="mt-4 flex items-center gap-3">
      <Button
        type="button"
        onClick={onApply}
        disabled={disabled || run.running}
        className="bg-indigo-600 hover:bg-indigo-500 text-[var(--ds-accent-fg)]"
      >
        {run.running
          ? <><Loader2 className="w-4 h-4 mr-2 animate-spin" />{t("trash.starter.applying")}</>
          : <>{t("trash.starter.applySelected", { count })}</>}
      </Button>
      {run.state === "ok" && <StatusNote tone="ok">{t("trash.spec.applied")}</StatusNote>}
      {run.skipped && <StatusNote tone="running">{t("trash.sync.alreadyRunning")}</StatusNote>}
      {run.state === "error" && (
        <span className="text-xs text-red-400 flex items-center gap-1.5 flex-wrap">
          <XCircle className="w-3.5 h-3.5 shrink-0" />
          <span className="break-words">{run.error ? run.error.errors.join("; ") : t("trash.spec.someFailedLog")}</span>
          <button
            type="button"
            onClick={run.dismissStatus}
            className="py-1.5 px-2 -my-1.5 text-red-400 hover:text-[var(--ds-danger-hover)]"
          >
            {t("trash.common.dismiss")}
          </button>
        </span>
      )}
    </div>
  );
}

// The header's counts. "Managed" is one predicate everywhere (spec-filters.ts).
function SpecCounts({ specs }: { specs: readonly SpecStatus[] }) {
  const t = useT();
  const erroredCount = countSpecs(specs, "errored");
  return (
    <div className="flex items-center gap-3 text-xs text-zinc-500">
      <span>{t("trash.spec.total", { count: specs.length })}</span>
      <span className="text-green-400">{t("trash.spec.managedCount", { count: countSpecs(specs, "managed") })}</span>
      {erroredCount > 0 && <span className="text-red-400">{t("trash.starter.erroredCount", { count: erroredCount })}</span>}
    </div>
  );
}

// What stands in for the table: loading, the load's failure, an empty catalog,
// or a filter that matches nothing.
function SpecListBody({
  loaded,
  loadError,
  empty,
  noMatch,
  children,
}: {
  loaded: boolean;
  loadError: string | null;
  empty: boolean;
  noMatch: boolean;
  children: React.ReactNode;
}) {
  const t = useT();
  if (!loaded) {
    return (
      <p className="text-sm text-zinc-500 italic flex items-center gap-2">
        <Loader2 className="w-4 h-4 animate-spin" /> {t("trash.spec.loading")}
      </p>
    );
  }
  if (loadError) return <p className="text-sm text-red-400">{t("trash.spec.loadError", { error: loadError })}</p>;
  if (empty) return <p className="text-sm text-zinc-500 italic">{t("trash.spec.emptyCatalog")}</p>;
  if (noMatch) return <p className="text-sm text-zinc-500 italic">{t("trash.spec.noMatch")}</p>;
  return <>{children}</>;
}

function SpecTableHead({
  allSelected,
  someSelected,
  disabled,
  onToggleAll,
}: {
  allSelected: boolean;
  someSelected: boolean;
  disabled: boolean;
  onToggleAll: () => void;
}) {
  const t = useT();
  const th = "py-2 pr-4 text-xs font-semibold uppercase tracking-wider text-zinc-500";
  return (
    <thead>
      <tr className="border-b border-zinc-800 text-left">
        <th className="py-2 px-6 w-8">
          <input
            type="checkbox"
            aria-label={t("trash.spec.selectAllAria")}
            checked={allSelected}
            ref={(el) => { if (el) el.indeterminate = someSelected; }}
            onChange={onToggleAll}
            disabled={disabled}
            className="w-4 h-4 rounded border-zinc-600 bg-zinc-800 accent-indigo-500"
          />
        </th>
        <th className="py-2 pr-4 w-6" />
        <th className={th}>{t("trash.spec.col.name")}</th>
        <th className={th}>{t("trash.spec.col.status")}</th>
        <th className={th}>{t("trash.spec.col.lastApplied")}</th>
        <th className="py-2 pr-6 text-xs font-semibold uppercase tracking-wider text-zinc-500 text-right">{t("trash.spec.col.actions")}</th>
      </tr>
    </thead>
  );
}

// One spec: its row, and its detail row while expanded. Memoized — the
// callbacks it takes are stable — so a search keystroke or a neighbour's
// change re-renders only the rows whose own props changed.
const SpecRow = memo(function SpecRow({
  spec,
  kind,
  selected,
  isOpen,
  detail,
  detailId,
  disabled,
  mounted,
  onToggleSelected,
  onToggleRow,
  onSetManaged,
  onForget,
}: {
  spec: SpecStatus;
  kind: TrashSpecKind;
  selected: boolean;
  isOpen: boolean;
  detail: SpecDetail | null;
  detailId: string;
  disabled: boolean;
  /** Relative times are client-only (guardrail 16): blank until mounted. */
  mounted: boolean;
  onToggleSelected: (id: string) => void;
  onToggleRow: (id: string) => void;
  onSetManaged: (appId: string, enabled: boolean) => Promise<void>;
  onForget: (appId: string) => Promise<void>;
}) {
  const t = useT();
  const locale = useLocale();
  const app = spec.application;
  const focus = useFocusReturn();

  return (
    <Fragment>
      <tr className="border-b border-zinc-800/50 hover:bg-zinc-800/30">
        <td className="py-2.5 px-6">
          <input
            type="checkbox"
            aria-label={t("trash.spec.selectAria", { name: spec.name })}
            checked={selected}
            onChange={() => onToggleSelected(spec.id)}
            disabled={disabled}
            className="w-4 h-4 rounded border-zinc-600 bg-zinc-800 accent-indigo-500"
          />
        </td>
        <td className="py-2.5 pr-2">
          <button
            type="button"
            ref={focus.refFor("expand")}
            onClick={() => onToggleRow(spec.id)}
            className="text-zinc-500 hover:text-zinc-100"
            aria-label={isOpen ? t("trash.spec.collapse") : t("trash.spec.expand")}
            aria-expanded={isOpen}
            aria-controls={isOpen ? detailId : undefined}
          >
            {isOpen ? <ChevronDown className="w-4 h-4" /> : <ChevronRight className="w-4 h-4" />}
          </button>
        </td>
        <td className="py-2.5 pr-4">
          <div className="text-zinc-100">{spec.name}</div>
          <div className="text-xs text-zinc-500 font-mono">{spec.trashId.slice(0, 12)}…</div>
        </td>
        <td className="py-2.5 pr-4">
          <div className="flex items-center gap-1.5">
            <StatusBadge spec={spec} />
            {app && app.errorCount > 1 && (
              <span
                className="text-[10px] px-1.5 py-0.5 rounded bg-red-500/15 text-red-400 font-mono"
                title={
                  // Relative time is client-only (guardrail 16); before mount the
                  // count-only form stands in rather than a raw ISO stamp.
                  app.lastErrorAt && mounted
                    ? t("trash.spec.failuresLast", { count: app.errorCount, last: formatRelativeTimeLocalized(app.lastErrorAt, locale) })
                    : t("trash.spec.failures", { count: app.errorCount })
                }
              >
                ×{app.errorCount}
              </span>
            )}
          </div>
        </td>
        <td className="py-2.5 pr-4 text-zinc-400 text-xs">
          {mounted
            ? app?.appliedAt
              ? formatRelativeTimeLocalized(app.appliedAt, locale)
              : t("trash.spec.never")
            : ""}
          {app?.lastError && (
            <div className="text-red-400 text-xs mt-1 max-w-xs truncate" title={app.lastError}>
              {app.lastError}
            </div>
          )}
        </td>
        <td className="py-2.5 pr-6 text-right">
          {app ? (
            <SpecActions
              app={app}
              onSetManaged={onSetManaged}
              onForget={(appId) => {
                // The actions cell is about to empty out: focus moves to this
                // row's expand button rather than falling to <body>.
                focus.returnTo("expand");
                void onForget(appId);
              }}
            />
          ) : (
            <span className="text-xs text-zinc-500">—</span>
          )}
        </td>
      </tr>
      {isOpen && (
        <tr id={detailId} className="bg-zinc-950/50 border-b border-zinc-800/50">
          <td colSpan={6} className="px-10 py-4">
            <SpecDetailView detail={detail} kind={kind} />
          </td>
        </tr>
      )}
    </Fragment>
  );
});

// A managed spec's actions: pause/resume, and Forget — which asks first,
// inline. Focus moves into the question (its confirm button); Cancel hands it
// back to Forget.
function SpecActions({
  app,
  onSetManaged,
  onForget,
}: {
  app: NonNullable<SpecStatus["application"]>;
  onSetManaged: (appId: string, enabled: boolean) => Promise<void>;
  onForget: (appId: string) => void;
}) {
  const t = useT();
  const [confirmingForget, setConfirmingForget] = useState(false);
  const focus = useFocusReturn();

  if (confirmingForget) {
    return (
      <div className="flex items-center gap-2 justify-end">
        <button
          type="button"
          aria-label={t("trash.spec.confirmForgetAria")}
          onClick={() => {
            setConfirmingForget(false);
            onForget(app.id);
          }}
          className="text-xs px-2 py-0.5 rounded bg-red-600 text-[var(--ds-on-status)] hover:bg-[var(--ds-danger-hover)] inline-flex items-center gap-1"
          autoFocus
        >
          {t("trash.spec.confirmForget")}
        </button>
        <button
          type="button"
          aria-label={t("trash.spec.cancelForgetAria")}
          onClick={() => {
            focus.returnTo("forget");
            setConfirmingForget(false);
          }}
          className="text-xs px-2 py-1.5 -my-1.5 text-zinc-400 hover:text-zinc-100"
        >
          {t("trash.spec.cancel")}
        </button>
      </div>
    );
  }
  return (
    <div className="flex items-center gap-2 justify-end">
      <button
        type="button"
        onClick={() => void onSetManaged(app.id, !app.enabled)}
        className="text-xs py-1.5 px-2 -my-1.5 text-zinc-400 hover:text-zinc-100 inline-flex items-center gap-1"
        title={app.enabled ? t("trash.spec.pauseTitle") : t("trash.spec.resumeTitle")}
      >
        {app.enabled
          ? <><Shield className="w-3.5 h-3.5" />{t("trash.spec.status.managed")}</>
          : <><ShieldOff className="w-3.5 h-3.5" />{t("trash.spec.status.paused")}</>}
      </button>
      <button
        type="button"
        ref={focus.refFor("forget")}
        onClick={() => setConfirmingForget(true)}
        className="text-xs py-1.5 px-2 -my-1.5 text-zinc-500 hover:text-red-400"
      >
        {t("trash.spec.forget")}
      </button>
    </div>
  );
}

function BulkButton({
  onClick,
  children,
  tone = "solid",
  disabled = false,
}: {
  onClick: () => void;
  children: React.ReactNode;
  tone?: "solid" | "ghost";
  disabled?: boolean;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      className={
        (tone === "ghost"
          ? "px-2 py-0.5 text-xs text-zinc-400 hover:text-zinc-100 rounded"
          : "px-2 py-0.5 text-xs bg-zinc-800 hover:bg-zinc-700 text-zinc-300 hover:text-zinc-100 rounded") +
        " disabled:opacity-50 disabled:cursor-not-allowed"
      }
    >
      {children}
    </button>
  );
}

// The DS status Chip, so a TRaSH application state looks like a request/issue
// state everywhere else in admin.
function StatusBadge({ spec }: { spec: SpecStatus }) {
  const t = useT();
  const app = spec.application;
  if (!app) return <Chip tone="neutral">{t("trash.spec.filter.unmanaged")}</Chip>;
  if (app.lastError) return <Chip tone="declined">{t("trash.spec.status.error")}</Chip>;
  if (!app.enabled) return <Chip tone="neutral">{t("trash.spec.status.paused")}</Chip>;
  if (app.appliedAt) return <Chip tone="approved">{t("trash.spec.status.managed")}</Chip>;
  return <Chip tone="pending">{t("trash.spec.status.pending")}</Chip>;
}

function SpecDetailView({ detail, kind }: { detail: SpecDetail | null; kind: TrashSpecKind }) {
  const t = useT();
  if (!detail) {
    return (
      <div className="text-xs text-zinc-500 flex items-center gap-2">
        <Loader2 className="w-3.5 h-3.5 animate-spin" /> {t("trash.spec.loadingDetail")}
      </div>
    );
  }
  if (kind === "CUSTOM_FORMAT") return <CustomFormatDetail detail={detail} />;
  if (kind === "CUSTOM_FORMAT_GROUP") return <CustomFormatGroupDetail detail={detail} />;
  if (kind === "QUALITY_PROFILE") return <QualityProfileDetail detail={detail} />;
  if (kind === "NAMING") return <NamingDetail detail={detail} />;
  if (kind === "QUALITY_SIZE") return <QualitySizeDetail detail={detail} />;
  return null;
}

function CustomFormatGroupDetail({ detail }: { detail: SpecDetail }) {
  const t = useT();
  const payload = detail.payload as {
    trash_id?: string;
    trash_description?: string;
    default?: string;
    custom_formats?: Array<{ name: string; trash_id: string; required: boolean }>;
    quality_profiles?: { include?: Record<string, string> };
  };
  const members = payload.custom_formats ?? [];
  const requiredCount = members.filter((m) => m.required).length;
  const includedProfiles = Object.entries(payload.quality_profiles?.include ?? {});
  return (
    <div className="space-y-3 text-xs text-zinc-300">
      <div className="grid grid-cols-2 gap-x-6 gap-y-1">
        <div><span className="text-zinc-500">trash_id:</span> <span className="font-mono">{payload.trash_id ?? "—"}</span></div>
        <div><span className="text-zinc-500">default:</span> {payload.default ?? "false"}</div>
        <div className="col-span-2"><span className="text-zinc-500">{t("trash.spec.detail.upstreamPath")}</span> <span className="font-mono">{detail.upstreamPath}</span></div>
      </div>
      {payload.trash_description && (
        <p className="text-zinc-400 italic whitespace-pre-line">{stripTrashHtml(payload.trash_description)}</p>
      )}
      {members.length > 0 && (
        <div>
          <p className="text-zinc-400 font-medium mb-1">
            {requiredCount > 0
              ? t("trash.spec.detail.membersRequired", { count: members.length, required: requiredCount })
              : t("trash.spec.detail.members", { count: members.length })}
          </p>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-x-4 gap-y-0.5 max-h-60 overflow-y-auto">
            {members.map((m) => (
              <div key={m.trash_id} className="flex items-center gap-2 min-w-0">
                <span className="font-mono text-[11px] text-zinc-500 shrink-0" title={m.trash_id}>{m.trash_id.slice(0, 10)}…</span>
                <span className="text-zinc-300 truncate">{m.name}</span>
                {m.required && <span className="text-sky-400 text-[10px] uppercase shrink-0">{t("trash.spec.detail.required")}</span>}
              </div>
            ))}
          </div>
        </div>
      )}
      {includedProfiles.length > 0 && (
        <div>
          <p className="text-zinc-400 font-medium mb-1">{t("trash.spec.detail.autoIncluded", { count: includedProfiles.length })}</p>
          <div className="flex flex-wrap gap-1.5 max-h-40 overflow-y-auto">
            {includedProfiles.map(([label, trashId]) => (
              <span key={trashId} className="px-2 py-0.5 bg-zinc-800 rounded">
                <span className="text-zinc-300">{label}</span>
              </span>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

function QualitySizeDetail({ detail }: { detail: SpecDetail }) {
  const t = useT();
  const payload = detail.payload as {
    trash_id?: string;
    type?: string;
    qualities?: Array<{ quality: string; min: number; preferred?: number; max: number }>;
  };
  const rows = payload.qualities ?? [];
  return (
    <div className="space-y-3 text-xs text-zinc-300">
      <div className="grid grid-cols-2 gap-x-6 gap-y-1">
        <div><span className="text-zinc-500">trash_id:</span> <span className="font-mono">{payload.trash_id ?? "—"}</span></div>
        <div><span className="text-zinc-500">type:</span> {payload.type ?? "—"}</div>
      </div>
      <div>
        <p className="text-zinc-400 font-medium mb-1">{t("trash.spec.detail.perQualityLimits")}</p>
        <div className="overflow-x-auto">
          <table className="w-full text-[11px]">
            <thead>
              <tr className="border-b border-zinc-800 text-left text-zinc-500">
                <th className="py-1 pr-3 font-semibold">{t("trash.spec.detail.quality")}</th>
                <th className="py-1 pr-3 font-semibold text-right">{t("trash.spec.detail.min")}</th>
                <th className="py-1 pr-3 font-semibold text-right">{t("trash.spec.detail.preferred")}</th>
                <th className="py-1 pr-3 font-semibold text-right">{t("trash.spec.detail.max")}</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((q) => (
                <tr key={q.quality} className="border-b border-zinc-800/50">
                  <td className="py-1 pr-3 text-zinc-200">{q.quality}</td>
                  <td className="py-1 pr-3 text-right font-mono">{q.min}</td>
                  <td className="py-1 pr-3 text-right font-mono">{q.preferred ?? "—"}</td>
                  <td className="py-1 pr-3 text-right font-mono">{q.max}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}

function readSpecValue(fields: unknown): unknown {
  if (Array.isArray(fields)) {
    return (fields as Array<{ name?: string; value?: unknown }>)
      .find((f) => f.name === "value")?.value;
  }
  if (fields && typeof fields === "object") {
    return (fields as Record<string, unknown>).value;
  }
  return undefined;
}

function CustomFormatDetail({ detail }: { detail: SpecDetail }) {
  const t = useT();
  const payload = detail.payload as {
    trash_id?: string;
    trash_scores?: Record<string, number>;
    includeCustomFormatWhenRenaming?: boolean;
    specifications?: Array<{ name?: string; implementation?: string; negate?: boolean; required?: boolean; fields?: Array<{ name?: string; value?: unknown }> | Record<string, unknown> }>;
  };
  const scores = payload.trash_scores ?? {};
  const specs = payload.specifications ?? [];
  return (
    <div className="space-y-3 text-xs text-zinc-300">
      <div className="grid grid-cols-2 gap-x-6 gap-y-1">
        <div><span className="text-zinc-500">trash_id:</span> <span className="font-mono">{payload.trash_id}</span></div>
        <div><span className="text-zinc-500">includeCustomFormatWhenRenaming:</span> {String(payload.includeCustomFormatWhenRenaming ?? false)}</div>
        <div><span className="text-zinc-500">{t("trash.spec.detail.upstreamPath")}</span> <span className="font-mono">{detail.upstreamPath}</span></div>
        <div><span className="text-zinc-500">sha:</span> <span className="font-mono">{detail.upstreamSha?.slice(0, 12) ?? "—"}</span></div>
      </div>

      {Object.keys(scores).length > 0 && (
        <div>
          <p className="text-zinc-400 font-medium mb-1">{t("trash.spec.detail.trashScores")}</p>
          <div className="flex flex-wrap gap-1.5">
            {Object.entries(scores).map(([set, score]) => (
              <span key={set} className="px-2 py-0.5 bg-zinc-800 rounded">
                <span className="text-zinc-500">{set}:</span> <span className="font-mono">{score > 0 ? "+" : ""}{score}</span>
              </span>
            ))}
          </div>
        </div>
      )}

      {specs.length > 0 && (
        <div>
          <p className="text-zinc-400 font-medium mb-1">{t("trash.spec.detail.specifications", { count: specs.length })}</p>
          <div className="space-y-1">
            {specs.map((s, i) => {
              const value = readSpecValue(s.fields);
              return (
                <div key={i} className="flex items-center gap-2 py-0.5">
                  <span className="font-medium text-zinc-200 min-w-0 truncate">{s.name}</span>
                  <span className="text-zinc-500">({s.implementation})</span>
                  {s.negate && <span className="text-amber-400 text-[10px] uppercase">{t("trash.spec.detail.negated")}</span>}
                  {s.required && <span className="text-sky-400 text-[10px] uppercase">{t("trash.spec.detail.required")}</span>}
                  {value != null && (
                    <span className="font-mono text-zinc-400 truncate text-[11px]">{String(value).slice(0, 60)}</span>
                  )}
                </div>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
}

function QualityProfileDetail({ detail }: { detail: SpecDetail }) {
  const t = useT();
  const payload = detail.payload as {
    upgradeAllowed?: boolean;
    cutoff?: string;
    cutoffFormatScore?: number;
    minFormatScore?: number;
    minUpgradeFormatScore?: number;
    score_set?: string;
    language?: string;
    items?: Array<{ name?: string; allowed?: boolean; items?: string[] }>;
    formatItems?: Record<string, string>;
  };
  const items = payload.items ?? [];
  const allowedItems = items.filter((q) => q.allowed);
  const formatItems = Object.entries(payload.formatItems ?? {});

  return (
    <div className="space-y-3 text-xs text-zinc-300">
      <div className="grid grid-cols-2 md:grid-cols-4 gap-x-6 gap-y-1">
        <div><span className="text-zinc-500">{t("trash.spec.detail.upgradeAllowed")}</span> {String(payload.upgradeAllowed ?? true)}</div>
        <div><span className="text-zinc-500">{t("trash.spec.detail.cutoff")}</span> {payload.cutoff ?? "—"}</div>
        <div><span className="text-zinc-500">{t("trash.spec.detail.cutoffFormatScore")}</span> {payload.cutoffFormatScore ?? 0}</div>
        <div><span className="text-zinc-500">{t("trash.spec.detail.minFormatScore")}</span> {payload.minFormatScore ?? 0}</div>
        {payload.minUpgradeFormatScore != null && (
          <div><span className="text-zinc-500">{t("trash.spec.detail.minUpgradeScore")}</span> {payload.minUpgradeFormatScore}</div>
        )}
        <div><span className="text-zinc-500">{t("trash.spec.detail.scoreSet")}</span> {payload.score_set ?? "default"}</div>
        <div><span className="text-zinc-500">{t("trash.spec.detail.language")}</span> {payload.language ?? "Original"}</div>
      </div>

      {allowedItems.length > 0 && (
        <div>
          <p className="text-zinc-400 font-medium mb-1">{t("trash.spec.detail.allowedQualities", { allowed: allowedItems.length, total: items.length })}</p>
          <div className="flex flex-wrap gap-1.5">
            {allowedItems.map((q, i) => (
              <span key={i} className="px-2 py-0.5 bg-zinc-800 rounded">
                {q.items?.length ? (
                  <>
                    <span className="font-medium">{q.name}</span>
                    <span className="text-zinc-500"> ({q.items.join(", ")})</span>
                  </>
                ) : (
                  <span>{q.name}</span>
                )}
              </span>
            ))}
          </div>
        </div>
      )}

      {formatItems.length > 0 && (
        <div>
          <p className="text-zinc-400 font-medium mb-1">{t("trash.spec.detail.referencedFormats", { count: formatItems.length })}</p>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-x-4 gap-y-0.5 max-h-60 overflow-y-auto">
            {formatItems.map(([label, trashId]) => (
              <div key={trashId} className="flex items-center gap-2 min-w-0">
                <span className="font-mono text-[11px] text-zinc-500 shrink-0" title={trashId}>{trashId.slice(0, 10)}…</span>
                <span className="text-zinc-300 truncate">{label}</span>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

function NamingDetail({ detail }: { detail: SpecDetail }) {
  const t = useT();
  const payload = detail.payload as Record<string, unknown>;
  const entries = Object.entries(payload).filter(([k]) => k !== "name");
  return (
    <div className="space-y-2 text-xs">
      <div className="text-zinc-500">{t("trash.spec.detail.upstream")} <span className="font-mono text-zinc-400">{detail.upstreamPath}</span></div>
      <table className="w-full">
        <tbody>
          {entries.map(([key, value]) => (
            <tr key={key} className="align-top">
              <td className="py-1 pr-3 text-zinc-400 font-medium whitespace-nowrap">{key}</td>
              <td className="py-1 font-mono text-zinc-300 break-all">{typeof value === "string" ? value : JSON.stringify(value)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
