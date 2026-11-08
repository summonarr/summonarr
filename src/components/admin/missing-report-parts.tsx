"use client";

// Admin → Missing's pieces around the list (missing-report.tsx): the mode
// switch, the stat cards, the instance notices, the filter row, an expanded
// series' episodes, the bulk bar and its confirmation. Each takes what it
// shows as props; the page owns the state.

import Link from "next/link";
import { useT } from "@/components/i18n/i18n-provider";
import { posterUrl } from "@/lib/tmdb-types";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { StyledSelect } from "@/components/ui/styled-select";
import { Switch } from "@/components/ui/switch";
import { Dialog, DialogBackdrop, DialogClose, DialogPopup, DialogPortal, DialogTitle } from "@/components/ui/dialog";
import { Chip, StatCard } from "@/components/ui/design";
import { Poster } from "@/components/admin/activity-ui";
import { OpenInArrLink } from "@/components/admin/open-in-arr";
import { ManageTitleButton } from "@/components/admin/arr-title/title-manager";
import { episodeCode } from "@/components/admin/queue-format";
import { manageTabFor } from "@/lib/arr-manage-links";
import { Check, CheckCircle2, ChevronDown, ChevronRight, Loader2, RotateCcw, Search, X } from "@/components/icons";
import { ARR_ERROR_KIND_KEYS, isArrErrorKind } from "@/lib/arr-error-kind";
import { BULK_SEARCH_MAX } from "@/lib/bulk-search-run";
import type { CutoffMovie, CutoffSeries, MissingEpisode, MissingMovie, MissingSeries } from "@/lib/arr-missing";
import type { BulkResult, SearchState, useBulkSelection } from "@/components/admin/use-bulk-search";
import type { Mode, Report, ReportKey, Service } from "@/components/admin/use-missing-reports";
import { modeOf, serviceOf, type MovieSort, type SeriesSort } from "@/components/admin/missing-report-rules";

export const SERVICE_LABEL = { sonarr: "Sonarr", radarr: "Radarr" } as const;

export type EpisodeState = { loading: boolean; error: string; episodes: MissingEpisode[] };

// The table cells every list shares (missing-report.tsx builds the rows).
export const th: React.CSSProperties = { padding: "8px 10px" };
export const td: React.CSSProperties = { padding: "6px 10px" };

// Once a search has started the button stays done until the next Refresh —
// a second click would only queue the same indexer hits again. A 409 ("nothing
// missing any more") is the title being complete, not a failure: shown in a
// neutral tone, and the button stays off — it would only 409 again. A row a
// running bulk search has yet to take is off too, or one click and the run
// would search it twice.
export function MissingSearchCell({ reportKey, title, st, pending, onSearch }: {
  reportKey: ReportKey;
  title: string;
  /** The row's search, if one was asked for. */
  st: SearchState | undefined;
  /** A running bulk search has yet to take this row. */
  pending: boolean;
  onSearch: () => void;
}) {
  const t = useT();
  const ariaKey = modeOf(reportKey) === "cutoff" ? "adminManage.missing.cutoff.searchAria" : "adminManage.missing.searchAria";
  const started = st?.outcome === "started";
  const already = st?.outcome === "already";
  return (
    <td style={{ ...td, textAlign: "right", whiteSpace: "nowrap" }}>
      <Button
        size="xs"
        variant="outline"
        onClick={onSearch}
        disabled={st?.busy || started || already || pending}
        aria-label={started || already ? undefined : t(ariaKey, { service: SERVICE_LABEL[serviceOf(reportKey)], title })}
      >
        {st?.busy ? <Loader2 className="animate-spin" /> : started ? <Check /> : already ? <CheckCircle2 /> : <Search />}
        {started ? t("adminManage.missing.searchStarted") : already ? t("adminArr.missingBulk.rowAlready") : t("adminManage.missing.search")}
      </Button>
      {st?.outcome === "failed" && st.message && (
        <div role="alert" style={{ fontSize: 11, color: "var(--ds-danger)", marginTop: 4, whiteSpace: "normal", maxWidth: 220, marginLeft: "auto" }}>
          {st.message}
        </div>
      )}
      {(already || started) && st.message && (
        <div role="status" style={{ fontSize: 11, color: "var(--ds-fg-muted)", marginTop: 4, whiteSpace: "normal", maxWidth: 220, marginLeft: "auto" }}>
          {st.message}
        </div>
      )}
    </td>
  );
}

/** A row's title: poster, link to its page, Open in Radarr/Sonarr, the title manager, and an unmonitored chip. */
export function MissingTitleCell({ service, mode, row: r, href, arrLabel, onRemoved }: {
  service: Service;
  mode: Mode;
  row: { title: string; year: number | null; posterPath: string | null; monitored?: boolean; instance: string; arrId: number };
  href: string | null;
  /** The instance's label ("Sonarr (4K)"). */
  arrLabel: string;
  /** The title manager removed the title from the arr. */
  onRemoved: () => void;
}) {
  const t = useT();
  return (
    <div className="flex items-center gap-2">
      <Poster src={posterUrl(r.posterPath)} letter={(r.title[0] ?? "?").toUpperCase()} w={26} h={39} radius={3} />
      <div className="min-w-0">
        <div className="flex items-center gap-1" style={{ fontWeight: 500 }}>
          <span className="min-w-0">
            {href ? <Link href={href} className="hover:underline">{r.title}</Link> : r.title}
            {r.year ? <span style={{ color: "var(--ds-fg-subtle)" }}> ({r.year})</span> : null}
          </span>
          <OpenInArrLink
            service={service}
            instance={r.instance}
            target={{ arrId: r.arrId }}
            label={t("adminManage.openIn", { name: arrLabel })}
            iconOnly
          />
          {/* The title manager on what this mode is about: the file below cutoff, or the missing seasons (a movie's settings). */}
          <ManageTitleButton
            service={service}
            instance={r.instance}
            target={{ arrId: r.arrId }}
            instanceLabel={arrLabel}
            variant="icon"
            initialTab={manageTabFor(mode, service)}
            onRemoved={onRemoved}
          />
        </div>
        {r.monitored === false && <Chip style={{ marginTop: 2 }}>{t("adminManage.missing.unmonitored")}</Chip>}
      </div>
    </div>
  );
}

/** A row's tick box for "Search selected". */
export function MissingSelectCell({ title, ticked, disabled, onToggle }: { title: string; ticked: boolean; disabled: boolean; onToggle: () => void }) {
  const t = useT();
  return (
    <td style={{ ...td, width: 32 }}>
      <input
        type="checkbox"
        checked={ticked}
        disabled={disabled}
        onChange={onToggle}
        aria-label={t("adminArr.missingBulk.selectAria", { title })}
        className="accent-[var(--ds-accent)]"
      />
    </td>
  );
}

/** A Sonarr row's expand/collapse button. */
export function MissingExpanderCell({ open, title, cutoff, onClick }: { open: boolean; title: string; cutoff: boolean; onClick: () => void }) {
  const t = useT();
  const label = cutoff
    ? open ? t("adminManage.missing.cutoff.collapse", { title }) : t("adminManage.missing.cutoff.expand", { title })
    : open ? t("adminManage.missing.collapse", { title }) : t("adminManage.missing.expand", { title });
  return (
    <td style={td}>
      <Button
        size="icon-xs"
        variant="ghost"
        aria-expanded={open}
        aria-label={label}
        onClick={onClick}
      >
        {open ? <ChevronDown /> : <ChevronRight />}
      </Button>
    </td>
  );
}

/** An expanded series' episodes: code, title, and the list's own last column. */
export function EpisodeLines<E extends { seasonNumber: number; episodeNumber: number; title: string }>({ label, eps, last }: {
  label: string;
  eps: readonly E[];
  last: (e: E) => React.ReactNode;
}) {
  return (
    <ul style={{ margin: 0, padding: 0, listStyle: "none", fontSize: 12 }} aria-label={label}>
      {eps.map((e) => (
        <li key={`${e.seasonNumber}:${e.episodeNumber}`} className="flex flex-wrap gap-x-3" style={{ padding: "2px 0" }}>
          <span className="ds-mono" style={{ color: "var(--ds-fg-muted)" }}>{episodeCode(e)}</span>
          <span style={{ flex: "1 1 200px" }}>{e.title || "—"}</span>
          <span className="ds-mono" style={{ color: "var(--ds-fg-subtle)" }}>{last(e)}</span>
        </li>
      ))}
    </ul>
  );
}

export function MissingModeToggle({ mode, onMode }: { mode: Mode; onMode: (m: Mode) => void }) {
  const t = useT();
  const modeButton = (m: Mode, text: string) => (
    <button
      type="button"
      onClick={() => onMode(m)}
      aria-pressed={mode === m}
      className="ds-hover-tint inline-flex items-center whitespace-nowrap font-medium border-0 min-h-9 sm:min-h-8"
      style={{
        padding: "5px 12px",
        borderRadius: 6,
        fontSize: 12,
        background: mode === m ? "var(--ds-bg-2)" : "transparent",
        boxShadow: mode === m ? "var(--ds-shadow-sm), inset 0 0 0 1px var(--ds-border-strong)" : undefined,
        color: mode === m ? "var(--ds-fg)" : "var(--ds-fg-muted)",
      }}
    >
      {text}
    </button>
  );
  return (
    <div
      role="group"
      aria-label={t("adminManage.missing.mode.label")}
      className="flex"
      style={{ padding: 2, background: "var(--ds-bg-1)", border: "1px solid var(--ds-border)", borderRadius: 8 }}
    >
      {modeButton("missing", t("adminManage.missing.mode.missing"))}
      {modeButton("cutoff", t("adminManage.missing.mode.cutoff"))}
    </div>
  );
}

/** The stat cards over the list on screen: what the filters leave, counted the way the list is. */
export function MissingStats({ current, lists, unmonitored }: {
  current: ReportKey;
  /** Each list as the filters leave it. */
  lists: {
    movies: readonly MissingMovie[];
    series: readonly MissingSeries[];
    cutoffMovies: readonly CutoffMovie[];
    cutoffSeries: readonly CutoffSeries[];
  };
  /** Missing lists: the unmonitored titles under the same instance and title filters. */
  unmonitored: number;
}) {
  const t = useT();
  const unmonitoredCard = <StatCard label={t("adminManage.missing.stat.unmonitored")} value={unmonitored} hint={t("adminManage.missing.stat.unmonitoredHint")} />;
  switch (current) {
    case "radarr:missing":
      return (
        <>
          <StatCard label={t("adminManage.missing.stat.movies")} value={lists.movies.length} hint={t("adminManage.missing.stat.moviesHint")} />
          <StatCard label={t("adminManage.missing.stat.over30")} value={lists.movies.filter((m) => m.daysMissing >= 30).length} hint={t("adminManage.missing.stat.over30Hint")} />
          {unmonitoredCard}
        </>
      );
    case "sonarr:missing":
      return (
        <>
          <StatCard label={t("adminManage.missing.stat.series")} value={lists.series.length} hint={t("adminManage.missing.stat.seriesHint")} />
          <StatCard label={t("adminManage.missing.stat.episodes")} value={lists.series.reduce((n, s) => n + s.missing, 0)} hint={t("adminManage.missing.stat.episodesHint")} />
          {unmonitoredCard}
        </>
      );
    case "radarr:cutoff":
      return <StatCard label={t("adminManage.missing.cutoff.stat.movies")} value={lists.cutoffMovies.length} hint={t("adminManage.missing.cutoff.stat.moviesHint")} />;
    case "sonarr:cutoff":
      return (
        <>
          <StatCard label={t("adminManage.missing.cutoff.stat.series")} value={lists.cutoffSeries.length} hint={t("adminManage.missing.cutoff.stat.seriesHint")} />
          <StatCard
            label={t("adminManage.missing.cutoff.stat.episodes")}
            value={lists.cutoffSeries.reduce((n, s) => n + s.episodes.length, 0)}
            hint={t("adminManage.missing.cutoff.stat.episodesHint")}
          />
        </>
      );
  }
}

/** Instances that couldn't be read, and listings cut at the read's ceiling. */
export function MissingReportNotices({ report, mode, instanceLabel }: { report: Report<unknown>; mode: Mode; instanceLabel: (slug: string) => string }) {
  const t = useT();
  return (
    <>
      {report.errors.length > 0 && (
        <div role="status" className="rounded-md bg-amber-500/15 text-amber-400" style={{ padding: "8px 12px", fontSize: 13 }}>
          <p className="m-0">{t("adminManage.missing.arrErrors", { list: report.errors.map((e) => instanceLabel(e.instance)).join(", ") })}</p>
          {/* Why, translated from the error's kind; the raw upstream text stays in the server log. */}
          <ul className="m-0" style={{ paddingLeft: 18, marginTop: 4 }}>
            {report.errors.map((e) => (
              <li key={e.instance}>
                {t(ARR_ERROR_KIND_KEYS[isArrErrorKind(e.kind) ? e.kind : "other"], { name: instanceLabel(e.instance) })}
              </li>
            ))}
          </ul>
        </div>
      )}

      {/* An instance whose listing ran past the read's ceiling — the list is incomplete, and says so. */}
      {report.truncated && report.truncated.length > 0 && (
        <div role="status" className="rounded-md bg-amber-500/15 text-amber-400" style={{ padding: "8px 12px", fontSize: 13 }}>
          <ul className="m-0" style={{ paddingLeft: 18 }}>
            {report.truncated.map((e) => (
              <li key={e.instance}>
                {mode === "cutoff"
                  ? t("adminManage.missing.cutoff.truncated", { name: instanceLabel(e.instance), read: e.read, total: e.total })
                  : t("adminManage.missing.truncated", { name: instanceLabel(e.instance), read: e.read, total: e.total })}
              </li>
            ))}
          </ul>
          <p className="m-0" style={{ marginTop: 4 }}>
            {mode === "cutoff"
              ? t("adminManage.missing.cutoff.truncatedHint", { action: t("adminArr.system.searchAllCutoff") })
              : t("adminManage.missing.truncatedHint", { action: t("adminArr.system.searchAllMissing") })}{" "}
            <Link href="/admin/arr-system?tab=tasks" className="underline">{t("adminArr.missingBulk.capLink")}</Link>
          </p>
        </div>
      )}
    </>
  );
}

export function MissingFilterRow({
  current, query, onQuery, instances, instance, onInstance, movieSort, onMovieSort, seriesSort, onSeriesSort, showUnmonitored, onShowUnmonitored,
}: {
  current: ReportKey;
  query: string;
  onQuery: (q: string) => void;
  /** The list's instances when it has several (the picker), else null. */
  instances: ReadonlyArray<{ slug: string; name: string }> | null;
  instance: string;
  onInstance: (slug: string) => void;
  movieSort: MovieSort;
  onMovieSort: (s: MovieSort) => void;
  seriesSort: SeriesSort;
  onSeriesSort: (s: SeriesSort) => void;
  showUnmonitored: boolean;
  onShowUnmonitored: (on: boolean) => void;
}) {
  const t = useT();
  return (
    <div className="flex flex-wrap items-center gap-2" style={{ fontSize: 13 }}>
      <Input
        value={query}
        onChange={(e) => onQuery(e.target.value.slice(0, 200))}
        placeholder={t("adminManage.missing.filter.titlePlaceholder")}
        aria-label={t("adminManage.missing.filter.title")}
        className="w-[200px]"
      />
      {instances && (
        <StyledSelect compact className="w-auto" value={instance} onChange={(e) => onInstance(e.target.value)} aria-label={t("adminManage.missing.filter.instance")}>
          <option value="all">{t("adminManage.missing.filter.allInstances")}</option>
          {instances.map((i) => <option key={i.slug} value={i.slug}>{i.name || i.slug}</option>)}
        </StyledSelect>
      )}
      {current === "radarr:missing" && (
        <StyledSelect compact className="w-auto" value={movieSort} onChange={(e) => onMovieSort(e.target.value as MovieSort)} aria-label={t("adminManage.missing.filter.sort")}>
          <option value="recent">{t("adminManage.missing.sort.recentRelease")}</option>
          <option value="oldest">{t("adminManage.missing.sort.oldestRelease")}</option>
          <option value="title">{t("adminManage.missing.sort.title")}</option>
        </StyledSelect>
      )}
      {current === "sonarr:missing" && (
        <StyledSelect compact className="w-auto" value={seriesSort} onChange={(e) => onSeriesSort(e.target.value as SeriesSort)} aria-label={t("adminManage.missing.filter.sort")}>
          <option value="recent">{t("adminManage.missing.sort.recentAired")}</option>
          <option value="most">{t("adminManage.missing.sort.mostMissing")}</option>
          <option value="title">{t("adminManage.missing.sort.title")}</option>
        </StyledSelect>
      )}
      {modeOf(current) === "missing" ? (
        <label className="flex items-center gap-2" style={{ color: "var(--ds-fg)" }}>
          <Switch checked={showUnmonitored} onCheckedChange={onShowUnmonitored} aria-label={t("adminManage.missing.filter.unmonitored")} />
          {t("adminManage.missing.filter.unmonitored")}
        </label>
      ) : (
        <span style={{ fontSize: 12, color: "var(--ds-fg-subtle)" }}>{t("adminManage.missing.cutoff.monitoredOnly")}</span>
      )}
    </div>
  );
}

/** An expanded missing series' episodes: loading, its failure, none, or the list `lines` renders. */
export function MissingEpisodesDetail({ state, lines }: { state: EpisodeState | undefined; lines: (episodes: readonly MissingEpisode[]) => React.ReactNode }) {
  const t = useT();
  if (!state || state.loading) {
    return (
      <div className="flex items-center gap-2" style={{ color: "var(--ds-fg-subtle)", fontSize: 12 }}>
        <Loader2 className="animate-spin" style={{ width: 12, height: 12 }} /> {t("adminManage.missing.episodes.loading")}
      </div>
    );
  }
  if (state.error) return <p role="alert" style={{ fontSize: 12, color: "var(--ds-danger)", margin: 0 }}>{state.error}</p>;
  if (state.episodes.length === 0) return <p style={{ fontSize: 12, color: "var(--ds-fg-subtle)", margin: 0 }}>{t("adminManage.missing.episodes.empty")}</p>;
  return <>{lines(state.episodes)}</>;
}

// "N started, M already complete, K failed" — the shorter forms when nothing
// was already complete.
function useBulkSummary() {
  const t = useT();
  return (r: BulkResult) => {
    const failed = r.failed.length;
    if (r.already > 0) {
      const vars = { started: r.started, already: r.already, failed };
      return modeOf(r.key) === "cutoff" ? t("adminArr.missingBulk.summaryCutoff", vars) : t("adminArr.missingBulk.summary", vars);
    }
    if (failed > 0) return t("adminArr.missingBulk.doneWithFailures", { started: r.started, failed });
    return t("adminArr.missingBulk.done", { count: r.started });
  };
}

type BulkSelection = ReturnType<typeof useBulkSelection>;

/** "Search selected" on the list on screen: the run's progress, its last result, the selection and its cap. */
export function MissingBulkBar({ mode, selection, visibleCount, loadingHere, onCancel }: {
  mode: Mode;
  selection: Pick<BulkSelection, "runningHere" | "resultHere" | "selectedHere" | "selectedOffPage" | "selectedHidden" | "bulkRunning" | "toRun" | "atCap" | "requestBulk" | "clearSelection" | "retryFailed">;
  /** Rows the filters list; the last result shows only over a list with rows. */
  visibleCount: number;
  loadingHere: boolean;
  onCancel: () => void;
}) {
  const t = useT();
  const bulkSummary = useBulkSummary();
  const { runningHere, resultHere, selectedHere, selectedOffPage, selectedHidden, bulkRunning, toRun, atCap, requestBulk, clearSelection, retryFailed } = selection;
  if (!(runningHere || selectedHere.length > 0 || (resultHere && visibleCount > 0))) return null;
  return (
    <div
      role="region"
      aria-label={t("adminArr.missingBulk.region")}
      className="flex flex-col gap-2 rounded-lg"
      style={{ padding: "8px 12px", fontSize: 13, border: "1px solid var(--ds-border)", background: "var(--ds-bg-1)" }}
    >
      {runningHere ? (
        <div className="flex flex-wrap items-center gap-2">
          <span className="flex items-center gap-2" role="status">
            <Loader2 className="animate-spin" style={{ width: 14, height: 14 }} />
            {runningHere.cancelling
              ? t("adminArr.missingBulk.cancelling")
              : t("adminArr.missingBulk.progress", { done: runningHere.done, total: runningHere.total })}
          </span>
          <Button size="sm" variant="outline" disabled={runningHere.cancelling} onClick={onCancel} aria-label={t("adminArr.missingBulk.cancelAria")}>
            <X /> {t("adminArr.common.cancel")}
          </Button>
        </div>
      ) : (
        <>
          {resultHere && (
            <div className="flex flex-wrap items-center gap-2">
              <span role="status" className="flex flex-wrap items-center gap-x-2">
                {resultHere.failed.length === 0 && !resultHere.cancelled && <Check style={{ width: 14, height: 14 }} />}
                <span>{bulkSummary(resultHere)}</span>
                {resultHere.skipped > 0 && <span>{t("adminArr.missingBulk.skipped", { count: resultHere.skipped })}</span>}
                {resultHere.cancelled && resultHere.notRun > 0 && (
                  <span>{t("adminArr.missingBulk.cancelled", { notRun: resultHere.notRun, total: resultHere.total })}</span>
                )}
              </span>
              {resultHere.failed.length > 0 && (
                <Button size="sm" variant="outline" onClick={retryFailed}>
                  <RotateCcw /> {t("adminArr.missingBulk.retryFailed")}
                </Button>
              )}
            </div>
          )}
          {selectedHere.length > 0 && (
            <div className="flex flex-wrap items-center gap-2">
              <span>{t("adminArr.missingBulk.selected", { count: selectedHere.length })}</span>
              {selectedOffPage > 0 && (
                <span style={{ fontSize: 12, color: "var(--ds-fg-subtle)" }}>{t("adminArr.missingBulk.selectedOffPage", { count: selectedOffPage })}</span>
              )}
              {selectedHidden.length > 0 && (
                <span style={{ fontSize: 12, color: "var(--ds-fg-subtle)" }}>{t("adminArr.missingBulk.selectedHidden", { count: selectedHidden.length })}</span>
              )}
              <Button size="sm" disabled={bulkRunning || loadingHere} onClick={requestBulk}>
                <Search /> {mode === "cutoff" ? t("adminArr.missingBulk.searchCutoff", { count: toRun.length }) : t("adminArr.missingBulk.search", { count: toRun.length })}
              </Button>
              <Button size="sm" variant="ghost" disabled={bulkRunning} onClick={clearSelection}>{t("adminArr.missingBulk.clear")}</Button>
              <span style={{ fontSize: 12, color: "var(--ds-fg-subtle)" }}>
                {mode === "cutoff" ? t("adminArr.missingBulk.hintCutoff") : t("adminArr.missingBulk.hint")}
              </span>
            </div>
          )}
          {atCap && (
            <p className="m-0" style={{ fontSize: 12, color: "var(--ds-fg-subtle)" }}>
              {t("adminArr.missingBulk.capNote", {
                max: BULK_SEARCH_MAX,
                action: mode === "cutoff" ? t("adminArr.system.searchAllCutoff") : t("adminArr.system.searchAllMissing"),
              })}{" "}
              <Link href="/admin/arr-system?tab=tasks" className="hover:underline" style={{ color: "var(--ds-accent-text)" }}>
                {t("adminArr.missingBulk.capLink")}
              </Link>
            </p>
          )}
        </>
      )}
    </div>
  );
}

/** A bulk run going on another tab or mode: its progress and Cancel stay reachable here. */
export function OtherListRunning({ bulk, onCancel }: {
  bulk: { key: ReportKey; done: number; total: number; cancelling: boolean };
  onCancel: () => void;
}) {
  const t = useT();
  return (
    <div role="status" className="flex flex-wrap items-center gap-2" style={{ fontSize: 12, color: "var(--ds-fg-muted)" }}>
      <Loader2 className="animate-spin" style={{ width: 12, height: 12 }} />
      {bulk.cancelling
        ? t("adminArr.missingBulk.cancelling")
        : t("adminArr.missingBulk.otherRunning", {
            service: SERVICE_LABEL[serviceOf(bulk.key)],
            mode: modeOf(bulk.key) === "cutoff" ? t("adminManage.missing.mode.cutoff") : t("adminManage.missing.mode.missing"),
            done: bulk.done,
            total: bulk.total,
          })}
      <Button size="xs" variant="ghost" disabled={bulk.cancelling} onClick={onCancel} aria-label={t("adminArr.missingBulk.cancelAria")}>
        <X /> {t("adminArr.common.cancel")}
      </Button>
    </div>
  );
}

/** "Search N titles?" — the confirmation a large bulk search asks for. */
export function MissingBulkConfirmDialog({ confirming, onClose, onConfirm }: {
  confirming: { key: ReportKey; count: number; unmonitored: number } | null;
  onClose: () => void;
  onConfirm: () => void;
}) {
  const t = useT();
  const cutoff = confirming !== null && modeOf(confirming.key) === "cutoff";
  return (
    <Dialog open={confirming !== null} onOpenChange={(o) => { if (!o) onClose(); }}>
      <DialogPortal>
        <DialogBackdrop />
        <DialogPopup className="max-w-md">
          <div className="flex items-center justify-between px-6 py-4 border-b border-zinc-700">
            <DialogTitle className="text-base font-semibold text-zinc-100">
              {confirming &&
                (cutoff
                  ? t("adminArr.missingBulk.confirmTitleCutoff", { count: confirming.count })
                  : t("adminArr.missingBulk.confirmTitle", { count: confirming.count }))}
            </DialogTitle>
            <DialogClose
              aria-label={t("adminArr.common.close")}
              title={t("adminArr.common.close")}
              className="text-zinc-500 hover:text-zinc-300 transition-colors"
            >
              <X className="w-5 h-5" />
            </DialogClose>
          </div>
          {confirming && (
            <div className="flex flex-col gap-3 px-6 py-4 text-sm text-zinc-400">
              <p className="m-0">
                {t("adminArr.missingBulk.confirmBody", { count: confirming.count, service: SERVICE_LABEL[serviceOf(confirming.key)] })}
              </p>
              {confirming.unmonitored > 0 && (
                <p className="m-0 text-amber-400">
                  {t("adminArr.missingBulk.confirmUnmonitored", {
                    count: confirming.unmonitored,
                    service: SERVICE_LABEL[serviceOf(confirming.key)],
                  })}
                </p>
              )}
            </div>
          )}
          <div className="flex items-center justify-between px-6 py-4 border-t border-zinc-700 bg-zinc-900">
            <button type="button" onClick={onClose} className="rounded px-2 py-1 text-sm text-zinc-500 hover:text-zinc-300">
              {t("adminArr.common.cancel")}
            </button>
            {confirming && (
              <Button size="sm" onClick={onConfirm}>
                <Search />
                {cutoff
                  ? t("adminArr.missingBulk.searchCutoff", { count: confirming.count })
                  : t("adminArr.missingBulk.search", { count: confirming.count })}
              </Button>
            )}
          </div>
        </DialogPopup>
      </DialogPortal>
    </Dialog>
  );
}
