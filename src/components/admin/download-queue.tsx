"use client";

// Admin → Download Queue. Every configured Radarr and Sonarr instance's queue
// in one table (GET /api/admin/queue), one row per download, rows Radarr/Sonarr
// flag first. Refreshes itself every 20 s while the tab is visible and no
// dialog is open. Per row:
//   Import            — a download the arr would not import on its own: its
//                       Manual Import, with every correction, in QueueImportDialog.
//   Grab now          — a release the arr is HOLDING (delay profile, …).
//   Blocklist & search, Blocklist, Remove — Radarr/Sonarr's own bulk queue
//                       DELETE (POST /api/admin/queue/remove), confirmed in a
//                       dialog that opens on the action clicked and offers both
//                       halves of the arr's own: the blocklist choice and the
//                       removal method (from the client / change category / ignore).
// "Re-check downloads" asks every instance to re-check its downloads now.
// A row naming a Radarr/Sonarr title also opens the title manager on its
// History tab (ArrTitleManager, held here rather than in the row: a finished
// download leaves the list on the next poll, and the dialog must not go with it).
//
// A link may filter the page (/admin/queue?q= or ?service=&instance=&arrId=,
// parsed on the server — parseQueueLinkFilters); an exact-title filter shows as
// a removable chip.
//
// Everything the arr's own queue shows is here: quality (with its PROPER/REPACK
// tag), languages, custom formats and score, size, progress, time left and ETA,
// added, protocol, download client, indexer, output path and download id —
// as columns the admin picks (remembered in this browser) and, per row, in an
// expandable details panel that always shows all of it (queue-table.tsx).
//
// Every time and size is server-supplied and formatted for the viewer's
// locale; nothing reads the clock while rendering (guardrail 16).
//
// Instant, then live (use-queue-data.ts, use-arr-snapshot.ts): on open the
// last queue the server kept paints at once, marked with when it was read,
// while the live read is out; the live answer replaces it and polling carries
// on as before. A row painted from it acts through the same routes, which
// re-check live.

import { useCallback, useMemo, useState } from "react";
import { Button, buttonVariants } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
import { StyledSelect } from "@/components/ui/styled-select";
import { Switch } from "@/components/ui/switch";
import { EmptyState, FilterBar, StatCard } from "@/components/ui/design";
import { CheckCircle2, CircleDashed, List, Loader2, RefreshCcw, RefreshCw, X } from "@/components/icons";
import { arrInstanceLabel } from "@/components/admin/open-in-arr";
import { ArrHealthPanel } from "@/components/admin/arr-health-panel";
import { QueueImportDialog } from "@/components/admin/queue-import-dialog";
import { ArrTitleManager } from "@/components/admin/arr-title/title-manager";
import { queueFormatters } from "@/components/admin/queue-format";
import { COLUMNS, DEFAULT_HIDDEN, QueueTable, rowKey, useHiddenColumns, useQueueTableView, type ColumnId, type QueueRowActions } from "@/components/admin/queue-table";
import { useQueueData, type QueueReport, type Service } from "@/components/admin/use-queue-data";
import { useQueueFilters } from "@/components/admin/use-queue-filters";
import { useQueueActions } from "@/components/admin/use-queue-actions";
import { queueStats, type QueueFilter } from "@/components/admin/queue-filters";
import { RemoveQueueDialog } from "@/components/admin/queue-remove-dialog";
import { useLocale, useT } from "@/components/i18n/i18n-provider";
import type { QueueItem, QueueRemoveAction, RecheckError } from "@/lib/arr-queue";
import { ARR_ERROR_KIND_KEYS, isArrErrorKind } from "@/lib/arr-error-kind";
import { ArrSnapshotNote } from "@/components/admin/arr-snapshot-note";
import { manageTabFor, type QueueLinkFilters, type QueueTitleFilter } from "@/lib/arr-manage-links";

type Filter = QueueFilter;

const SERVICE_LABEL: Record<Service, string> = { radarr: "Radarr", sonarr: "Sonarr" };

const NO_LINK_FILTERS: QueueLinkFilters = { q: "", title: null };

// Why each instance failed, in the viewer's language — never the raw upstream
// text, which stays in the server log (guardrail 5e).
function ArrErrorList({
  errors,
  label,
}: {
  errors: ReadonlyArray<{ service: Service; instance: string; kind?: unknown }>;
  label: (service: Service, slug: string) => string;
}) {
  const t = useT();
  return (
    <ul className="m-0 p-0" style={{ listStyle: "none", fontSize: 12, marginTop: 2 }}>
      {errors.map((e) => (
        <li key={`${e.service}:${e.instance}`}>
          {t(ARR_ERROR_KIND_KEYS[isArrErrorKind(e.kind) ? e.kind : "other"], { name: label(e.service, e.instance) })}
        </li>
      ))}
    </ul>
  );
}

export function DownloadQueue({
  configured,
  initialFilters = NO_LINK_FILTERS,
}: {
  configured: boolean;
  /** The filters the page's link asked for (parseQueueLinkFilters). */
  initialFilters?: QueueLinkFilters;
}) {
  const t = useT();
  const locale = useLocale();
  const fmt = useMemo(() => queueFormatters(locale), [locale]);
  // The title manager opened from a row, with the row's instance label.
  const [managing, setManaging] = useState<(QueueTitleFilter & { label: string }) | null>(null);
  const [live, setLive] = useState(true);
  // The row whose Remove dialog is open, and the action it was opened on.
  const [removing, setRemoving] = useState<{ row: QueueItem; action: QueueRemoveAction } | null>(null);
  const [importing, setImporting] = useState<QueueItem | null>(null);
  const { hidden, saveHidden, toggleColumn } = useHiddenColumns();
  // Any open dialog pauses the poll (a refresh would reshuffle the row being
  // confirmed); it resumes when the dialog closes.
  const { report, setReport, loading, error, snapshotAt, load, reloadSoon } = useQueueData({
    configured,
    live,
    paused: removing !== null || importing !== null || managing !== null,
  });
  const { expanded, toggleExpanded, frameWidth, frameRef } = useQueueTableView(report?.items.map(rowKey));
  // A new link closes the title manager it was clicked in.
  const filters = useQueueFilters(initialFilters, report, () => setManaging(null));
  const { acting, notice, actionError, recheckFailed, arrVersions, loadVersions, grabNow, recheck, imported, removed } = useQueueActions({
    reloadSoon,
    dropRow: (row) => {
      const gone = rowKey(row);
      setReport((r) => (r ? { ...r, items: r.items.filter((i) => rowKey(i) !== gone) } : r));
    },
  });

  // The dialog opens on the action the admin clicked; they can still change it there.
  function openRemove(row: QueueItem, action: QueueRemoveAction) {
    if (row.service === "sonarr") void loadVersions();
    setRemoving({ row, action });
  }

  const rowActions: QueueRowActions = {
    onManage: setManaging,
    onImport: setImporting,
    onGrab: (row) => void grabNow(row),
    onRemove: openRemove,
  };

  const instanceName = useCallback(
    (service: Service, slug: string) => report?.instances.find((i) => i.service === service && i.slug === slug)?.name ?? slug,
    [report],
  );
  const instanceLabel = useCallback(
    (service: Service, slug: string) => arrInstanceLabel(service, instanceName(service, slug), slug),
    [instanceName],
  );
  const multiInstance = (report?.instances.length ?? 0) > 1;

  const counts = filters.counts;
  const services = new Set((report?.instances ?? []).map((i) => i.service));
  const segments = [
    { value: "all" as const, label: t("adminManage.queue.tab.all"), count: counts?.all },
    { value: "attention" as const, label: t("adminManage.queue.tab.attention"), count: counts?.attention },
    ...(services.has("sonarr") ? [{ value: "sonarr" as const, label: SERVICE_LABEL.sonarr, count: counts?.sonarr }] : []),
    ...(services.has("radarr") ? [{ value: "radarr" as const, label: SERVICE_LABEL.radarr, count: counts?.radarr }] : []),
  ];

  return (
    <div className="flex flex-col gap-6">
      {configured && (
        <section
          aria-label={t("adminManage.arrHealth.title")}
          style={{ padding: 14, border: "1px solid var(--ds-border)", borderRadius: 10, background: "var(--ds-bg-1)" }}
        >
          <ArrHealthPanel variant="full" />
        </section>
      )}

      <div className="flex flex-col gap-2">
        <FilterBar<Filter>
          segments={segments}
          active={filters.filter}
          onChange={filters.setFilter}
          right={
            configured ? (
              <QueueRefreshButtons
                rechecking={acting.has("recheck")}
                onRecheck={() => void recheck()}
                loading={loading}
                onRefresh={() => void load()}
              />
            ) : null
          }
        />
        <ArrSnapshotNote at={snapshotAt} refreshing={loading} />
        {report && error && <p role="alert" style={{ fontSize: 13, color: "var(--ds-danger)", margin: 0 }}>{error}</p>}
        {actionError && <p role="alert" style={{ fontSize: 13, color: "var(--ds-danger)", margin: 0 }}>{actionError}</p>}
        {!configured ? (
          <EmptyState
            icon={CircleDashed}
            title={t("adminManage.queue.notConfigured.title")}
            description={t("adminManage.queue.notConfigured.description")}
            cta={{ href: "/settings?tab=media#radarr", label: t("adminArr.common.openSettings") }}
          />
        ) : !report ? (
          error ? (
            <p role="alert" style={{ fontSize: 13, color: "var(--ds-danger)", margin: 0 }}>{error}</p>
          ) : (
            <div className="flex items-center gap-2" style={{ color: "var(--ds-fg-subtle)", fontSize: 13 }}>
              <Loader2 className="animate-spin" style={{ width: 14, height: 14 }} /> {t("adminManage.queue.loading")}
            </div>
          )
        ) : (
          <div className="flex flex-col gap-4">
            <QueueStats report={report} fmt={fmt} />
            <QueueBanners report={report} notice={notice} recheckFailed={recheckFailed} instanceLabel={instanceLabel} />
            <QueueToolbar
              report={report}
              filters={filters}
              multiInstance={multiInstance}
              instanceName={instanceName}
              live={live}
              onLiveChange={setLive}
              hidden={hidden}
              toggleColumn={toggleColumn}
              saveHidden={saveHidden}
            />
            {filters.visible.length === 0 ? (
              <QueueEmpty report={report} filters={filters} />
            ) : (
              <QueueTable
                rows={filters.visible}
                columns={COLUMNS.filter((c) => !hidden.has(c.id) && (c.id !== "instance" || multiInstance))}
                hidden={hidden}
                multiInstance={multiInstance}
                instanceName={instanceName}
                fmt={fmt}
                acting={acting}
                expanded={expanded}
                onToggleExpanded={toggleExpanded}
                frameWidth={frameWidth}
                frameRef={frameRef}
                actions={rowActions}
              />
            )}
          </div>
        )}
      </div>

      <RemoveQueueDialog
        target={removing}
        arrVersions={arrVersions}
        onClose={() => setRemoving(null)}
        onRemoved={(row, action) => {
          removed(row, action);
          setRemoving(null);
        }}
      />

      <QueueImportDialog
        row={importing}
        onClose={() => setImporting(null)}
        onImported={(row, files) => {
          setImporting(null);
          imported(row, files);
        }}
      />

      {managing && (
        <ArrTitleManager
          open
          onOpenChange={(o) => { if (!o) setManaging(null); }}
          service={managing.service}
          instance={managing.instance}
          target={{ arrId: managing.arrId }}
          instanceLabel={managing.label}
          initialTab={manageTabFor("queue", managing.service)}
          onRemoved={() => void load()}
        />
      )}
    </div>
  );
}

type Filters = ReturnType<typeof useQueueFilters>;

// "Re-check downloads" (every instance) and a manual refresh of the list.
function QueueRefreshButtons({ rechecking, onRecheck, loading, onRefresh }: {
  rechecking: boolean;
  onRecheck: () => void;
  loading: boolean;
  onRefresh: () => void;
}) {
  const t = useT();
  return (
    <div className="flex flex-wrap items-center gap-2">
      <Button
        size="sm"
        variant="outline"
        onClick={onRecheck}
        disabled={rechecking}
        title={t("adminManage.queue.recheck.hint")}
      >
        {rechecking ? <Loader2 className="animate-spin" /> : <RefreshCcw />}
        {t("adminManage.queue.recheck.button")}
      </Button>
      <Button size="sm" variant="outline" onClick={onRefresh} disabled={loading}>
        {loading ? <Loader2 className="animate-spin" /> : <RefreshCw />}
        {t("adminManage.queue.refresh")}
      </Button>
    </div>
  );
}

// Downloads, how many are moving, flagged, and what is left to fetch.
function QueueStats({ report, fmt }: { report: QueueReport; fmt: ReturnType<typeof queueFormatters> }) {
  const t = useT();
  const stats = useMemo(() => queueStats(report.items), [report.items]);
  return (
    <div className="grid gap-3" style={{ gridTemplateColumns: "repeat(auto-fit, minmax(160px, 1fr))" }}>
      <StatCard label={t("adminManage.queue.stat.downloads")} value={stats.total} hint={t("adminManage.queue.stat.downloadsHint", { count: stats.downloading })} />
      <StatCard label={t("adminManage.queue.stat.attention")} value={stats.attention} hint={t("adminManage.queue.stat.attentionHint")} />
      <StatCard label={t("adminManage.queue.stat.remaining")} value={fmt.size(stats.sizeLeft)} hint={t("adminManage.queue.stat.remainingHint")} />
    </div>
  );
}

// What the page has to say above the table: instances that failed or were cut
// short, the last action's success, and a Re-check's refusals.
function QueueBanners({ report, notice, recheckFailed, instanceLabel }: {
  report: QueueReport;
  notice: string;
  recheckFailed: { all: boolean; failed: RecheckError[] } | null;
  instanceLabel: (service: Service, slug: string) => string;
}) {
  const t = useT();
  return (
    <>
      {report.errors.length > 0 && (
        <div role="status" className="rounded-md bg-amber-500/15 text-amber-400" style={{ padding: "8px 12px", fontSize: 13 }}>
          <p className="m-0">
            {t("adminManage.queue.arrErrors", { list: report.errors.map((e) => instanceLabel(e.service, e.instance)).join(", ") })}
          </p>
          <ArrErrorList errors={report.errors} label={instanceLabel} />
        </div>
      )}
      {/* A queue past the server's page ceiling is listed in part — said, never shown as whole. */}
      {report.truncated && report.truncated.length > 0 && (
        <div role="status" className="rounded-md bg-amber-500/15 text-amber-400" style={{ padding: "8px 12px", fontSize: 13 }}>
          <ul className="m-0 p-0" style={{ listStyle: "none" }}>
            {report.truncated.map((e) => (
              <li key={`${e.service}:${e.instance}`}>
                {t("adminManage.queue.truncated", { name: instanceLabel(e.service, e.instance), read: e.read, total: e.total })}
              </li>
            ))}
          </ul>
        </div>
      )}
      {notice && (
        <p role="status" className="flex items-center gap-1.5 text-green-400" style={{ fontSize: 13, margin: 0 }}>
          <CheckCircle2 style={{ width: 14, height: 14 }} aria-hidden /> {notice}
        </p>
      )}
      {recheckFailed && (
        <div
          role={recheckFailed.all ? "alert" : "status"}
          className={recheckFailed.all ? "rounded-md bg-red-500/15 text-red-400" : "rounded-md bg-amber-500/15 text-amber-400"}
          style={{ padding: "8px 12px", fontSize: 13 }}
        >
          <p className="m-0">
            {recheckFailed.all
              ? t("adminManage.queue.recheck.allFailed")
              : t("adminManage.queue.recheck.someFailed", { list: recheckFailed.failed.map((e) => instanceLabel(e.service, e.instance)).join(", ") })}
          </p>
          <ArrErrorList errors={recheckFailed.failed} label={instanceLabel} />
        </div>
      )}
    </>
  );
}

// The title text box, the instance picker (several instances only), Live, the
// exact-title chip and the column picker.
function QueueToolbar({ report, filters, multiInstance, instanceName, live, onLiveChange, hidden, toggleColumn, saveHidden }: {
  report: QueueReport;
  filters: Filters;
  multiInstance: boolean;
  instanceName: (service: Service, slug: string) => string;
  live: boolean;
  onLiveChange: (on: boolean) => void;
  hidden: ReadonlySet<ColumnId>;
  toggleColumn: (id: ColumnId, on: boolean) => void;
  saveHidden: (next: ReadonlySet<ColumnId>) => void;
}) {
  const t = useT();
  const { query, setQuery, instance, setInstance, titleFilter, titleRows, clearTitleFilter } = filters;
  // The chip names the title by its downloads; with none in the queue, by its instance and id.
  const titleFilterLabel = titleFilter
    ? titleRows[0]
      ? titleRows[0].mediaTitle || titleRows[0].title
      : t("adminManage.queue.filter.titleById", {
          name: arrInstanceLabel(titleFilter.service, instanceName(titleFilter.service, titleFilter.instance), titleFilter.instance),
          id: titleFilter.arrId,
        })
    : "";
  return (
    <div className="flex flex-wrap items-center gap-2" style={{ fontSize: 13 }}>
      <Input
        value={query}
        onChange={(e) => setQuery(e.target.value.slice(0, 200))}
        placeholder={t("adminManage.queue.filter.titlePlaceholder")}
        aria-label={t("adminManage.queue.filter.title")}
        className="w-[220px]"
      />
      {multiInstance && (
        <StyledSelect compact className="w-auto" value={instance} onChange={(e) => setInstance(e.target.value)} aria-label={t("adminManage.queue.filter.instance")}>
          <option value="all">{t("adminManage.queue.filter.allInstances")}</option>
          {report.instances.map((i) => (
            <option key={`${i.service}:${i.slug}`} value={`${i.service}:${i.slug}`}>{arrInstanceLabel(i.service, i.name, i.slug)}</option>
          ))}
        </StyledSelect>
      )}
      <label className="flex items-center gap-2" style={{ color: "var(--ds-fg)" }}>
        <Switch checked={live} onCheckedChange={onLiveChange} aria-label={t("adminManage.queue.filter.live")} />
        {t("adminManage.queue.filter.live")}
      </label>
      {titleFilter && (
        <span
          className="inline-flex max-w-full min-w-0 items-center gap-1 rounded-full text-xs"
          style={{ padding: "3px 4px 3px 10px", border: "1px solid var(--ds-accent)", background: "var(--ds-accent-soft)", color: "var(--ds-accent-text)" }}
        >
          <span className="min-w-0 truncate">{t("adminManage.queue.filter.onlyTitle", { title: titleFilterLabel })}</span>
          <button
            type="button"
            onClick={clearTitleFilter}
            aria-label={t("adminManage.queue.filter.clearTitle")}
            title={t("adminManage.queue.filter.clearTitle")}
            className="ds-hover-tint inline-flex shrink-0 items-center justify-center rounded-full outline-none focus-visible:ring-2 focus-visible:ring-[var(--ds-accent-ring)]"
            style={{ width: 20, height: 20 }}
          >
            <X style={{ width: 12, height: 12 }} aria-hidden />
          </button>
        </span>
      )}
      <DropdownMenu>
        <DropdownMenuTrigger className={buttonVariants({ variant: "outline", size: "sm" })}>
          <List aria-hidden />
          {t("adminManage.queue.columns.button")}
        </DropdownMenuTrigger>
        <DropdownMenuContent align="start" className="w-56">
          <DropdownMenuGroup>
            <DropdownMenuLabel className="px-2 text-[10px] font-semibold uppercase tracking-wider text-zinc-500">
              {t("adminManage.queue.columns.menuLabel")}
            </DropdownMenuLabel>
            {COLUMNS.filter((c) => c.id !== "instance" || multiInstance).map((c) => (
              <DropdownMenuCheckboxItem key={c.id} checked={!hidden.has(c.id)} onCheckedChange={(on) => toggleColumn(c.id, on)}>
                {t(c.label)}
              </DropdownMenuCheckboxItem>
            ))}
          </DropdownMenuGroup>
          <DropdownMenuSeparator />
          <DropdownMenuItem onClick={() => saveHidden(new Set())}>{t("adminManage.queue.columns.showAll")}</DropdownMenuItem>
          <DropdownMenuItem onClick={() => saveHidden(DEFAULT_HIDDEN)}>{t("adminManage.queue.columns.reset")}</DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  );
}

// Nothing to show: the linked title has no downloads (with a way out), the
// filters hide every row, or the queue is empty.
function QueueEmpty({ report, filters }: { report: QueueReport; filters: Filters }) {
  const t = useT();
  if (filters.titleFilter && filters.titleRows.length === 0) {
    return (
      <EmptyState
        icon={CircleDashed}
        title={t("adminManage.queue.empty.titleFilterTitle")}
        description={t("adminManage.queue.empty.titleFilterDescription")}
        action={
          <Button size="sm" variant="outline" onClick={filters.clearTitleFilter}>
            {t("adminManage.queue.filter.clearTitle")}
          </Button>
        }
      />
    );
  }
  if (report.items.length > 0) {
    return <EmptyState icon={CircleDashed} title={t("adminManage.queue.empty.filteredTitle")} description={t("adminManage.queue.empty.filteredDescription")} />;
  }
  return <EmptyState icon={CheckCircle2} title={t("adminManage.queue.empty.title")} description={t("adminManage.queue.empty.description")} />;
}
