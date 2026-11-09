"use client";

// The Library cleanup page's pieces (library-cleanup.tsx holds the state and
// the requests): the totals, the rules form, the filter bar, the table and the
// protected list. Each renders what it is handed; nothing here fetches.

import { useT } from "@/components/i18n/i18n-provider";
import { posterUrl } from "@/lib/tmdb-types";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { StyledSelect } from "@/components/ui/styled-select";
import { Switch } from "@/components/ui/switch";
import { SectionHeader, StatCard } from "@/components/ui/design";
import { Poster } from "@/components/admin/activity-ui";
import { arrFailureText } from "@/lib/cleanup-error-text";
import { ArrowDown, ArrowUp, ArrowUpDown, Loader2, Shield, ShieldOff, Trash2 } from "@/components/icons";
import { arrSlugLabel as instanceLabel, cleanupKeyOf as keyOf, type CleanupDeleteState } from "@/components/admin/cleanup-delete";
import {
  CLEANUP_EXCLUSIONS,
  CLEANUP_MAX_ITEMS,
  CLEANUP_NUMERIC_BOUNDS,
  CLEANUP_RULES,
  cleanupDraftInBounds,
  cleanupNumberInBounds,
  cleanupSelectAllOn,
  type CleanupSettings,
} from "@/lib/library-cleanup";
import {
  CLEANUP_SIZE_FILTERS,
  CLEANUP_SORT_KEYS,
  cleanupFiltersActive,
  defaultCleanupSortDir,
  type CleanupSizeFilter,
  type CleanupSortKey,
  type CleanupViewState,
} from "@/lib/library-cleanup-view";
import { ruleNumberText, type CleanupProtectedTitle, type CleanupReportRow, type CleanupReportView } from "./library-cleanup-report";

// Literal key maps — the i18n dead-string check can't see a built key.
const SORT_KEYS: Record<CleanupSortKey, string> = {
  size: "adminManage.cleanup.sort.size",
  idle: "adminManage.cleanup.sort.idle",
  added: "adminManage.cleanup.sort.added",
  lastPlayed: "adminManage.cleanup.sort.lastPlayed",
  plays: "adminManage.cleanup.sort.plays",
  votes: "adminManage.cleanup.sort.votes",
  title: "adminManage.cleanup.sort.title",
};
const SIZE_KEYS: Record<CleanupSizeFilter, string> = {
  any: "adminManage.cleanup.filter.size.any",
  "1g": "adminManage.cleanup.filter.size.1g",
  "10g": "adminManage.cleanup.filter.size.10g",
  "50g": "adminManage.cleanup.filter.size.50g",
  "100g": "adminManage.cleanup.filter.size.100g",
  unknown: "adminManage.cleanup.filter.size.unknown",
};

export const cleanupPanelStyle: React.CSSProperties = {
  padding: 16,
  borderRadius: 10,
  border: "1px solid var(--ds-border)",
  background: "var(--ds-bg-1)",
};
const inputStyle: React.CSSProperties = {
  width: 76,
  padding: "4px 8px",
  fontSize: 13,
  color: "var(--ds-fg)",
  background: "var(--ds-bg-2)",
  border: "1px solid var(--ds-border)",
  borderRadius: 6,
};

export type NumericField = keyof typeof CLEANUP_NUMERIC_BOUNDS;
export type BooleanField = "unwatchedEnabled" | "neverWatchedEnabled" | "votesEnabled" | "excludeAiring" | "requireUpstreamCheck";

export function CleanupStats({ report, formatBytes }: { report: CleanupReportView; formatBytes: (n: number | null) => string }) {
  const t = useT();
  return (
    <div className="grid gap-3" style={{ gridTemplateColumns: "repeat(auto-fit, minmax(160px, 1fr))" }}>
      <StatCard label={t("adminManage.cleanup.stat.candidates")} value={report.totals.candidates} hint={t("adminManage.cleanup.stat.candidatesHint")} />
      <StatCard label={t("adminManage.cleanup.stat.held")} value={report.totals.held} hint={t("adminManage.cleanup.stat.heldHint")} />
      <StatCard label={t("adminManage.cleanup.stat.reclaimable")} value={formatBytes(report.totals.reclaimableBytes)} hint={t("adminManage.cleanup.stat.reclaimableHint")} />
      <StatCard label={t("adminManage.cleanup.stat.libraryTitles")} value={report.libraryTitles} hint={t("adminManage.cleanup.stat.libraryTitlesHint")} />
    </div>
  );
}

export function CleanupBanners({ report }: { report: CleanupReportView }) {
  const t = useT();
  return (
    <>
      {!report.playHistoryTracked && (
        <p role="status" className="rounded-md bg-amber-500/15 text-amber-400" style={{ padding: "8px 12px", fontSize: 13, margin: 0 }}>
          {t("adminManage.cleanup.trackingOff")}
        </p>
      )}
      {report.arrErrors.length > 0 && (
        <p role="status" className="rounded-md bg-amber-500/15 text-amber-400" style={{ padding: "8px 12px", fontSize: 13, margin: 0 }}>
          {t("adminManage.cleanup.arrErrorsList", { list: report.arrErrors.map((e) => arrFailureText(t, instanceLabel(e.service, e.instance), e)).join("; ") })}
        </p>
      )}
    </>
  );
}

// The rules and the exclusions, edited as a draft and saved together.
// `savingRules`: a save is in flight — every control is locked until its
// reload has landed, or an edit made meanwhile would be replaced by the saved
// settings without a word.
export function RulesPanel({
  draft,
  settings,
  historyStart,
  savingRules,
  day,
  onNumber,
  onToggle,
  onSave,
}: {
  draft: CleanupSettings;
  settings: CleanupSettings;
  historyStart: string | null;
  savingRules: boolean;
  day: (iso: string | null) => string;
  onNumber: (field: NumericField, raw: string) => void;
  onToggle: (field: BooleanField, on: boolean) => void;
  onSave: () => void;
}) {
  const t = useT();
  const dirty = JSON.stringify(draft) !== JSON.stringify(settings);
  // The server refuses a value outside its bounds (never repairs it), so Save
  // stays off and the field is marked rather than offering a doomed request.
  const draftValid = cleanupDraftInBounds(draft);
  // One rule number input: bounds from CLEANUP_NUMERIC_BOUNDS, the write path's own.
  // A cleared field stays empty (and invalid) while it is retyped — never a silent 0.
  const numInput = (field: NumericField, aria: string) => {
    const bad = !cleanupNumberInBounds(field, draft[field]);
    return (
      <input
        type="number"
        style={bad ? { ...inputStyle, borderColor: "var(--ds-danger)" } : inputStyle}
        min={CLEANUP_NUMERIC_BOUNDS[field].min}
        max={CLEANUP_NUMERIC_BOUNDS[field].max}
        value={ruleNumberText(draft[field])}
        onChange={(e) => onNumber(field, e.target.value)}
        disabled={savingRules}
        aria-label={aria}
        aria-invalid={bad || undefined}
      />
    );
  };
  const toggle = (field: BooleanField, aria: string) => (
    <Switch checked={draft[field]} onCheckedChange={(v) => onToggle(field, v)} disabled={savingRules} aria-label={aria} />
  );
  return (
    <section className="flex flex-col gap-3" style={cleanupPanelStyle} aria-labelledby="cleanup-rules">
      {/* The wrapper carries the id the section's aria-labelledby points at
          (SectionHeader exposes none) and cancels the header's own 12px
          bottom margin — the column's gap-3 already spaces it. */}
      <div id="cleanup-rules" className="-mb-3">
        <SectionHeader title={t("adminManage.cleanup.rules")} />
      </div>
      <p style={{ fontSize: 12, color: "var(--ds-fg-subtle)", margin: 0 }}>
        {historyStart
          ? t("adminManage.cleanup.rulesHelpSince", { date: day(historyStart) })
          : t("adminManage.cleanup.rulesHelp")}
      </p>
      <div className="flex flex-col gap-2" style={{ fontSize: 13, color: "var(--ds-fg)" }}>
        {/* A div, not a label: each row holds two controls (the switch and
            the number), and a label may name only one. Both carry their own
            aria-label. */}
        <div className="flex flex-wrap items-center gap-2">
          {toggle("unwatchedEnabled", t("adminManage.cleanup.rule.unwatchedAria"))}
          {t("adminManage.cleanup.rule.unwatchedBefore")}
          {numInput("unwatchedDays", t("adminManage.cleanup.rule.unwatchedDaysAria"))}
          {t("adminManage.cleanup.days")}
        </div>
        <div className="flex flex-wrap items-center gap-2">
          {toggle("neverWatchedEnabled", t("adminManage.cleanup.rule.neverWatchedAria"))}
          {t("adminManage.cleanup.rule.neverWatchedBefore")}
          {numInput("neverWatchedDays", t("adminManage.cleanup.rule.neverWatchedDaysAria"))}
          {t("adminManage.cleanup.days")}
        </div>
        <div className="flex flex-wrap items-center gap-2">
          {toggle("votesEnabled", t("adminManage.cleanup.rule.votesAria"))}
          {t("adminManage.cleanup.rule.votesBefore")}
          {numInput("votesMin", t("adminManage.cleanup.rule.votesMinAria"))}
          {t("adminManage.cleanup.rule.votesAfter")}
        </div>
      </div>
      <h3 style={{ fontSize: 13, fontWeight: 600, color: "var(--ds-fg)", margin: "4px 0 0" }}>{t("adminManage.cleanup.alwaysExcluded")}</h3>
      <div className="flex flex-col gap-2" style={{ fontSize: 13, color: "var(--ds-fg)" }}>
        <label className="flex flex-wrap items-center gap-2">
          {t("adminManage.cleanup.excl.minAgeBefore")}
          {numInput("minAgeDays", t("adminManage.cleanup.excl.minAgeAria"))}
          {t("adminManage.cleanup.excl.minAgeAfter")}
        </label>
        <label className="flex flex-wrap items-center gap-2">
          {t("adminManage.cleanup.excl.recentBefore")}
          {numInput("recentRequestDays", t("adminManage.cleanup.excl.recentAria"))}
          {t("adminManage.cleanup.excl.recentAfter")}
        </label>
        <label className="flex flex-wrap items-center gap-2">
          {toggle("excludeAiring", t("adminManage.cleanup.excl.airingAria"))}
          {t("adminManage.cleanup.excl.airing")}
        </label>
        <label className="flex flex-wrap items-center gap-2">
          {toggle("requireUpstreamCheck", t("adminManage.cleanup.excl.upstreamAria"))}
          {t("adminManage.cleanup.excl.upstream")}
        </label>
        <p style={{ fontSize: 12, color: "var(--ds-fg-subtle)", margin: 0 }}>
          {t("adminManage.cleanup.excl.alsoHeld")}
        </p>
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <Button size="sm" onClick={onSave} disabled={!dirty || !draftValid || savingRules}>
          {savingRules ? <Loader2 className="animate-spin" /> : null}
          {t("adminManage.cleanup.saveRules")}
        </Button>
        {!draftValid && (
          <span role="status" style={{ fontSize: 12, color: "var(--ds-danger)" }}>{t("adminManage.cleanup.rulesOutOfRange")}</span>
        )}
      </div>
    </section>
  );
}

// Every filter, the sort, the counts and the bulk delete.
export function CleanupFilterBar({
  vs,
  patchView,
  resetFilters,
  serverOptions,
  arrOptions,
  shownCount,
  totalCount,
  selectedCount,
  selectedSize,
  hiddenSelected,
  del,
}: {
  vs: CleanupViewState;
  patchView: (p: Partial<CleanupViewState>) => void;
  resetFilters: () => void;
  serverOptions: string[];
  arrOptions: [string, string][];
  shownCount: number;
  totalCount: number;
  selectedCount: number;
  selectedSize: string;
  /** Selected titles the current filters hide: the delete still takes them. */
  hiddenSelected: number;
  del: CleanupDeleteState;
}) {
  const t = useT();
  return (
    <div className="flex flex-col gap-2" style={{ fontSize: 13 }}>
      <div className="flex flex-wrap items-center gap-2">
        <StyledSelect compact className="w-auto" value={vs.view} onChange={(e) => patchView({ view: e.target.value as CleanupViewState["view"] })} aria-label={t("adminManage.cleanup.filter.show")}>
          <option value="candidates">{t("adminManage.cleanup.stat.candidates")}</option>
          <option value="held">{t("adminManage.cleanup.stat.held")}</option>
          <option value="all">{t("adminManage.cleanup.filter.allMatched")}</option>
        </StyledSelect>
        <StyledSelect compact className="w-auto" value={vs.type} onChange={(e) => patchView({ type: e.target.value as CleanupViewState["type"] })} aria-label={t("adminManage.cleanup.filter.mediaType")}>
          <option value="all">{t("adminManage.cleanup.filter.moviesAndTv")}</option>
          <option value="MOVIE">{t("nav.movies")}</option>
          <option value="TV">{t("adminManage.cleanup.tv")}</option>
        </StyledSelect>
        <StyledSelect compact className="w-auto" value={vs.rule} onChange={(e) => patchView({ rule: e.target.value as CleanupViewState["rule"] })} aria-label={t("adminManage.cleanup.filter.rule")}>
          <option value="any">{t("adminManage.cleanup.filter.anyRule")}</option>
          {CLEANUP_RULES.map((r) => (
            <option key={r} value={r}>{t(`adminManage.cleanup.ruleLabel.${r}`)}</option>
          ))}
        </StyledSelect>
        <StyledSelect compact className="w-auto" value={vs.excl} onChange={(e) => patchView({ excl: e.target.value as CleanupViewState["excl"] })} aria-label={t("adminManage.cleanup.filter.heldBy")}>
          <option value="any">{t("adminManage.cleanup.filter.heldByAny")}</option>
          <option value="none">{t("adminManage.cleanup.filter.heldByNone")}</option>
          {CLEANUP_EXCLUSIONS.map((x) => (
            <option key={x} value={x}>{t(`adminManage.cleanup.exclusionLabel.${x}`)}</option>
          ))}
        </StyledSelect>
        {/* Input is the h-8 twin of the compact selects beside it; the old
            hand-rolled 26px field sat visibly shorter in the same row. */}
        <Input
          value={vs.q}
          onChange={(e) => patchView({ q: e.target.value.slice(0, 200) })}
          placeholder={t("adminManage.cleanup.filter.titlePlaceholder")}
          aria-label={t("adminManage.cleanup.filter.title")}
          className="w-[200px]"
        />
      </div>
      <div className="flex flex-wrap items-center gap-2">
        {serverOptions.length > 1 && (
          <StyledSelect compact className="w-auto" value={vs.server} onChange={(e) => patchView({ server: e.target.value })} aria-label={t("adminManage.cleanup.filter.server")}>
            <option value="">{t("adminManage.cleanup.filter.serverAny")}</option>
            {serverOptions.map((sv) => <option key={sv} value={sv}>{sv}</option>)}
          </StyledSelect>
        )}
        <StyledSelect compact className="w-auto" value={vs.arr} onChange={(e) => patchView({ arr: e.target.value })} aria-label={t("adminManage.cleanup.filter.arr")}>
          <option value="">{t("adminManage.cleanup.filter.arrAny")}</option>
          {arrOptions.map(([k, label]) => <option key={k} value={k}>{label}</option>)}
          <option value="none">{t("adminManage.cleanup.filter.arrNone")}</option>
        </StyledSelect>
        <StyledSelect compact className="w-auto" value={vs.size} onChange={(e) => patchView({ size: e.target.value as CleanupSizeFilter })} aria-label={t("adminManage.cleanup.filter.size")}>
          {CLEANUP_SIZE_FILTERS.map((f) => <option key={f} value={f}>{t(SIZE_KEYS[f])}</option>)}
        </StyledSelect>
        <label className="inline-flex items-center gap-1.5" style={{ color: "var(--ds-fg)" }}>
          <input type="checkbox" checked={vs.deletable} onChange={(e) => patchView({ deletable: e.target.checked })} />
          {t("adminManage.cleanup.filter.deletableOnly")}
        </label>
        <span className="inline-flex items-center gap-1">
          <StyledSelect
            compact
            className="w-auto"
            value={vs.sort}
            onChange={(e) => {
              const sort = e.target.value as CleanupSortKey;
              patchView({ sort, dir: defaultCleanupSortDir(sort) });
            }}
            aria-label={t("adminManage.cleanup.sort.label")}
          >
            {CLEANUP_SORT_KEYS.map((k) => <option key={k} value={k}>{t(SORT_KEYS[k])}</option>)}
          </StyledSelect>
          <Button
            size="icon-sm"
            variant="outline"
            onClick={() => patchView({ dir: vs.dir === "asc" ? "desc" : "asc" })}
            aria-label={t("adminManage.cleanup.sort.reverse")}
            title={t("adminManage.cleanup.sort.reverse")}
          >
            {vs.dir === "asc" ? <ArrowUp /> : <ArrowDown />}
          </Button>
        </span>
        {cleanupFiltersActive(vs) && (
          <Button size="sm" variant="ghost" onClick={resetFilters}>
            {t("adminManage.cleanup.filter.reset")}
          </Button>
        )}
        <span style={{ color: "var(--ds-fg-subtle)", fontSize: 12 }}>
          {t("adminManage.cleanup.showing", { shown: shownCount, total: totalCount })}
        </span>
        <div className="flex-1" />
        {hiddenSelected > 0 && (
          <span role="status" style={{ color: "var(--ds-fg-subtle)", fontSize: 12 }}>
            {t("adminManage.cleanup.selectedHidden", { count: hiddenSelected })}
          </span>
        )}
        <Button size="sm" variant="destructive" onClick={() => void del.dryRun()} disabled={selectedCount === 0 || del.planning || del.executing}>
          {del.planning ? <Loader2 className="animate-spin" /> : <Trash2 />}
          {selectedCount > 0
            ? t("adminManage.cleanup.deleteSelectedSize", { count: selectedCount, size: selectedSize })
            : t("adminManage.cleanup.deleteSelected", { count: 0 })}
        </Button>
      </div>
    </div>
  );
}

// The view's rows (at most one delete's worth — the page caps them), each with
// its checkbox and its Protect/Unprotect.
export function CleanupTable({
  shown,
  selected,
  selectableKeys,
  selectionFull,
  sort,
  dir,
  onSort,
  onToggle,
  onToggleAll,
  isBusy,
  onProtect,
  day,
  formatBytes,
}: {
  shown: CleanupReportRow[];
  selected: ReadonlySet<string>;
  selectableKeys: string[];
  selectionFull: boolean;
  sort: CleanupSortKey;
  dir: "asc" | "desc";
  onSort: (key: CleanupSortKey) => void;
  onToggle: (key: string) => void;
  onToggleAll: () => void;
  isBusy: (key: string) => boolean;
  onProtect: (row: CleanupReportRow, on: boolean) => void;
  day: (iso: string | null) => string;
  formatBytes: (n: number | null) => string;
}) {
  const t = useT();
  // A clickable column header; shares its state with the Sort select.
  const sortHead = (k: CleanupSortKey, label: string, align?: "right") => {
    const active = sort === k;
    const Icon = !active ? ArrowUpDown : dir === "asc" ? ArrowUp : ArrowDown;
    return (
      <th style={{ padding: "8px 10px", textAlign: align ?? "left", whiteSpace: "nowrap" }} aria-sort={active ? (dir === "asc" ? "ascending" : "descending") : "none"}>
        <button
          type="button"
          onClick={() => onSort(k)}
          className="inline-flex items-center gap-1 hover:text-zinc-100"
          style={{ font: "inherit", color: active ? "var(--ds-fg)" : "inherit" }}
        >
          {label}
          <Icon style={{ width: 11, height: 11, opacity: active ? 1 : 0.5 }} />
        </button>
      </th>
    );
  };
  return (
    <div className="resp-table-scroll" style={{ border: "1px solid var(--ds-border)", borderRadius: 10 }}>
      <table className="w-full" style={{ fontSize: 13, borderCollapse: "collapse", color: "var(--ds-fg)" }}>
        <thead>
          <tr style={{ background: "var(--ds-bg-2)", textAlign: "left", color: "var(--ds-fg-subtle)", fontSize: 11 }}>
            <th style={{ padding: "8px 10px", width: 32 }}>
              <input
                type="checkbox"
                aria-label={t("adminManage.cleanup.selectAll")}
                checked={cleanupSelectAllOn(selected, selectableKeys)}
                onChange={onToggleAll}
                disabled={selectableKeys.length === 0}
              />
            </th>
            {sortHead("title", t("adminManage.cleanup.col.title"))}
            <th style={{ padding: "8px 10px" }}>{t("adminManage.cleanup.col.on")}</th>
            {sortHead("added", t("adminManage.cleanup.col.added"))}
            {sortHead("lastPlayed", t("adminManage.cleanup.col.lastPlayed"))}
            {sortHead("plays", t("adminManage.cleanup.col.plays"), "right")}
            {sortHead("votes", t("adminManage.cleanup.col.votes"), "right")}
            {sortHead("size", t("adminManage.cleanup.col.size"), "right")}
            <th style={{ padding: "8px 10px" }}>{t("adminManage.cleanup.col.why")}</th>
            <th style={{ padding: "8px 10px" }} />
          </tr>
        </thead>
        <tbody>
          {shown.map((r) => {
            const k = keyOf(r);
            const deletable = r.candidate && r.arr.length > 0;
            const isProtected = r.excludedBy.includes("protected");
            const busy = isBusy(k);
            return (
              <tr key={k} className="hover:bg-zinc-800/20 transition-colors" style={{ borderTop: "1px solid var(--ds-border)" }}>
                <td style={{ padding: "6px 10px" }}>
                  <input
                    type="checkbox"
                    aria-label={t("adminManage.cleanup.select", { title: r.title })}
                    checked={selected.has(k)}
                    disabled={!deletable || (selectionFull && !selected.has(k))}
                    title={
                      !deletable
                        ? r.candidate ? t("adminManage.cleanup.notManaged") : t("adminManage.cleanup.heldByExclusion")
                        : selectionFull && !selected.has(k) ? t("adminManage.cleanup.selectionFull", { max: CLEANUP_MAX_ITEMS }) : undefined
                    }
                    onChange={() => onToggle(k)}
                  />
                </td>
                <td style={{ padding: "6px 10px" }}>
                  <div className="flex items-center gap-2">
                    <Poster src={posterUrl(r.posterPath)} letter={(r.title[0] ?? "?").toUpperCase()} w={26} h={39} radius={3} />
                    <div>
                      <div style={{ fontWeight: 500 }}>{r.title}{r.year ? <span style={{ color: "var(--ds-fg-subtle)" }}> ({r.year})</span> : null}</div>
                      <div style={{ fontSize: 11, color: "var(--ds-fg-subtle)" }}>
                        {r.mediaType === "MOVIE" ? t("adminManage.cleanup.movie") : t("adminManage.cleanup.tv")}
                        {r.idleDays !== null ? ` · ${t("adminManage.cleanup.idle", { days: r.idleDays })}` : ""}
                      </div>
                    </div>
                  </div>
                </td>
                <td style={{ padding: "6px 10px", fontSize: 11, color: "var(--ds-fg-muted)" }}>
                  <div>{r.servers.join(", ")}</div>
                  <div style={{ color: "var(--ds-fg-subtle)" }}>
                    {r.arr.length > 0 ? r.arr.map((a) => instanceLabel(a.service, a.instance)).join(", ") : t("adminManage.cleanup.notInArr")}
                  </div>
                </td>
                <td className="ds-mono" style={{ padding: "6px 10px", fontSize: 12, whiteSpace: "nowrap" }}>{day(r.addedAt)}</td>
                <td className="ds-mono" style={{ padding: "6px 10px", fontSize: 12, whiteSpace: "nowrap" }}>{r.lastPlayedAt ? day(r.lastPlayedAt) : t("adminManage.cleanup.never")}</td>
                <td className="ds-mono" style={{ padding: "6px 10px", fontSize: 12, textAlign: "right", whiteSpace: "nowrap" }}>{r.playCount}</td>
                <td className="ds-mono" style={{ padding: "6px 10px", fontSize: 12, textAlign: "right", whiteSpace: "nowrap" }}>{r.votes}</td>
                <td className="ds-mono" style={{ padding: "6px 10px", fontSize: 12, textAlign: "right", whiteSpace: "nowrap" }}>{formatBytes(r.sizeOnDisk)}</td>
                <td style={{ padding: "6px 10px" }}>
                  <div className="flex flex-wrap gap-1">
                    {r.matched.map((m) => (
                      <span key={m} className="rounded bg-red-500/15 text-red-400" style={{ padding: "1px 6px", fontSize: 11 }}>{t(`adminManage.cleanup.ruleLabel.${m}`)}</span>
                    ))}
                    {r.excludedBy.map((x) => (
                      <span key={x} className="rounded bg-sky-500/15 text-sky-400" style={{ padding: "1px 6px", fontSize: 11 }}>{t(`adminManage.cleanup.exclusionLabel.${x}`)}</span>
                    ))}
                  </div>
                </td>
                <td style={{ padding: "6px 10px", textAlign: "right" }}>
                  <Button
                    size="xs"
                    variant="ghost"
                    onClick={() => onProtect(r, !isProtected)}
                    disabled={busy}
                    aria-label={isProtected ? t("adminManage.cleanup.unprotectTitle", { title: r.title }) : t("adminManage.cleanup.protectTitle", { title: r.title })}
                  >
                    {busy ? <Loader2 className="animate-spin" /> : isProtected ? <ShieldOff /> : <Shield />}
                    {isProtected ? t("adminManage.cleanup.unprotect") : t("adminManage.cleanup.protect")}
                  </Button>
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

export function ProtectedList({
  titles,
  total,
  isBusy,
  onUnprotect,
  day,
}: {
  titles: CleanupProtectedTitle[];
  total: number;
  isBusy: (key: string) => boolean;
  onUnprotect: (title: CleanupProtectedTitle) => void;
  day: (iso: string | null) => string;
}) {
  const t = useT();
  if (titles.length === 0) return null;
  return (
    <section className="flex flex-col gap-2" style={cleanupPanelStyle} aria-labelledby="cleanup-protected">
      <div id="cleanup-protected" className="-mb-3">
        <SectionHeader title={t("adminManage.cleanup.protectedCount", { count: total })} />
      </div>
      {total > titles.length && (
        <p role="status" style={{ fontSize: 12, color: "var(--ds-fg-subtle)", margin: 0 }}>
          {t("adminManage.cleanup.protectedCapped", { cap: titles.length, total })}
        </p>
      )}
      {titles.map((p) => (
        <div key={keyOf(p)} className="flex items-center justify-between" style={{ fontSize: 13, color: "var(--ds-fg)" }}>
          <span>
            {p.title ?? `${p.mediaType} ${p.tmdbId}`}
            <span style={{ color: "var(--ds-fg-subtle)" }}> · {p.mediaType === "MOVIE" ? t("adminManage.cleanup.movie") : t("adminManage.cleanup.tv")} · {t("adminManage.cleanup.since", { date: day(p.createdAt) })}</span>
          </span>
          <Button size="xs" variant="ghost" onClick={() => onUnprotect(p)} disabled={isBusy(keyOf(p))}>
            {isBusy(keyOf(p)) ? <Loader2 className="animate-spin" /> : <ShieldOff />}
            {t("adminManage.cleanup.unprotect")}
          </Button>
        </div>
      ))}
    </section>
  );
}

