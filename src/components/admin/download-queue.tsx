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

import { useCallback, useMemo, useRef, useState } from "react";
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
import { Dialog, DialogBackdrop, DialogClose, DialogPopup, DialogPortal, DialogTitle } from "@/components/ui/dialog";
import { EmptyState, FilterBar, StatCard } from "@/components/ui/design";
import {
  AlertTriangle, Ban, CheckCircle2, CircleDashed, List, Loader2, RefreshCcw, RefreshCw, RotateCcw, Trash2, X,
} from "@/components/icons";
import { arrInstanceLabel } from "@/components/admin/open-in-arr";
import { ArrHealthPanel } from "@/components/admin/arr-health-panel";
import { QueueImportDialog } from "@/components/admin/queue-import-dialog";
import { ArrTitleManager } from "@/components/admin/arr-title/title-manager";
import { episodeSummary, queueFormatters } from "@/components/admin/queue-format";
import { COLUMNS, DEFAULT_HIDDEN, QueueTable, rowKey, useHiddenColumns, useQueueTableView, type QueueRowActions } from "@/components/admin/queue-table";
import { useQueueData, type Service } from "@/components/admin/use-queue-data";
import { apiErrorText, readApiError } from "@/lib/client/api-error";
import { withBasePath } from "@/lib/base-path";
import { useLocale, useT } from "@/components/i18n/i18n-provider";
import {
  blocklistRedownload, recheckOutcome, removalIds,
  type QueueItem, type QueueRemoveAction, type QueueRemoveMethod, type RecheckError,
} from "@/lib/arr-queue";
import { ARR_ERROR_KIND_KEYS, isArrErrorKind } from "@/lib/arr-error-kind";
import { ArrSnapshotNote } from "@/components/admin/arr-snapshot-note";
import { manageTabFor, matchesQueueTitle, queueLinkKey, type QueueLinkFilters, type QueueTitleFilter } from "@/lib/arr-manage-links";

type Filter = "all" | "attention" | Service;

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
  const [filter, setFilter] = useState<Filter>(initialFilters.filter ?? "all");
  const [instance, setInstance] = useState("all");
  const [query, setQuery] = useState(initialFilters.q);
  const [titleFilter, setTitleFilter] = useState<QueueTitleFilter | null>(initialFilters.title);
  // The title manager opened from a row, with the row's instance label.
  const [managing, setManaging] = useState<(QueueTitleFilter & { label: string }) | null>(null);
  // Following a link to this page while on it (a title manager's "See its
  // downloads in the queue") re-renders the server page, which hands over a NEW
  // filters object. When it asks for other filters than the URL holds now
  // (`linked` — clearTitleFilter edits the URL without a server render), they
  // replace the ones on screen and close the manager the link was clicked in
  // (adjust-state-during-render). A re-render of the same URL (router.refresh)
  // asks for the same filters and leaves the admin's alone.
  const [seenFilters, setSeenFilters] = useState(initialFilters);
  const [linked, setLinked] = useState(() => queueLinkKey(initialFilters));
  if (seenFilters !== initialFilters) {
    setSeenFilters(initialFilters);
    const incoming = queueLinkKey(initialFilters);
    if (incoming !== linked) {
      setLinked(incoming);
      setQuery(initialFilters.q);
      setTitleFilter(initialFilters.title);
      setFilter(initialFilters.filter ?? "all");
      setManaging(null);
    }
  }
  const [live, setLive] = useState(true);
  // The row whose Remove dialog is open, and the action it was opened on.
  const [removing, setRemoving] = useState<{ row: QueueItem; action: QueueRemoveAction } | null>(null);
  const [importing, setImporting] = useState<QueueItem | null>(null);
  // Grab now / Re-check in flight: each row's key, and "recheck". A Set, so
  // one finishing never re-enables another that is still running.
  const [acting, setActing] = useState<ReadonlySet<string>>(() => new Set());
  const startActing = (key: string) => setActing((s) => new Set(s).add(key));
  const stopActing = (key: string) => setActing((s) => {
    const next = new Set(s);
    next.delete(key);
    return next;
  });
  const [notice, setNotice] = useState("");
  // A Grab now / Re-check failure: its own line, which only those two clear —
  // the next poll's successful load clears `error`, and took this with it.
  const [actionError, setActionError] = useState("");
  // Instances that refused the last Re-check (the route answers 202 even when
  // every one did), and whether that was all of them.
  const [recheckFailed, setRecheckFailed] = useState<{ all: boolean; failed: RecheckError[] } | null>(null);
  // Each instance's version, from the health report, read ONCE per page when
  // the first Sonarr row's Remove opens: Sonarr v3 ignores skipRedownload, so
  // its "Blocklist" can't promise "no new search". Until a Sonarr instance's
  // version is known (the read still running or failed) the dialog says so
  // instead of promising anything (`blocklistRedownload` → "unknown").
  const [arrVersions, setArrVersions] = useState<Record<string, string | null>>({});
  // The health report reads every configured instance (a dark one takes the
  // full timeout), so it is never re-read per dialog open — not even after a
  // failure, which leaves the cautious wording for the session.
  const versionsRequested = useRef(false);
  const { hidden, saveHidden, toggleColumn } = useHiddenColumns();
  const { expanded, toggleExpanded, frameWidth, frameRef } = useQueueTableView();
  // Any open dialog pauses the poll (a refresh would reshuffle the row being
  // confirmed); it resumes when the dialog closes.
  const { report, setReport, loading, error, snapshotAt, load, reloadSoon } = useQueueData({
    configured,
    live,
    paused: removing !== null || importing !== null || managing !== null,
  });

  // Drop the exact-title filter, and its parameters from the URL so a reload
  // shows the whole queue too (any `q` stays). `linked` follows the URL, so a
  // later link back to the same title applies again.
  function clearTitleFilter() {
    setTitleFilter(null);
    setLinked(queueLinkKey({ q: initialFilters.q, title: null }));
    try {
      const sp = new URLSearchParams(window.location.search);
      for (const k of ["service", "instance", "arrId"]) sp.delete(k);
      const qs = sp.toString();
      window.history.replaceState(null, "", qs ? `?${qs}` : window.location.pathname);
    } catch {}
  }

  // The dialog opens on the action the admin clicked; they can still change it there.
  async function loadVersions() {
    if (versionsRequested.current) return;
    versionsRequested.current = true;
    try {
      const res = await fetch(withBasePath("/api/admin/arr-health"));
      if (!res.ok) return;
      const data = (await res.json().catch(() => null)) as { instances?: Array<{ service?: unknown; slug?: unknown; version?: unknown }> } | null;
      const next: Record<string, string | null> = {};
      for (const i of data?.instances ?? []) {
        if (typeof i?.service === "string" && typeof i.slug === "string") next[`${i.service}:${i.slug}`] = typeof i.version === "string" ? i.version : null;
      }
      setArrVersions((v) => ({ ...v, ...next }));
    } catch {
      // Unknown version: the dialog keeps the cautious wording.
    }
  }

  function openRemove(row: QueueItem, action: QueueRemoveAction) {
    if (row.service === "sonarr") void loadVersions();
    setRemoving({ row, action });
  }

  async function grabNow(row: QueueItem) {
    const key = rowKey(row);
    startActing(key);
    setNotice("");
    setActionError("");
    try {
      const res = await fetch(withBasePath("/api/admin/queue/grab"), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ service: row.service, instance: row.instance, ids: row.ids }),
      });
      if (!res.ok) {
        setActionError(await readApiError(res, t("adminManage.queue.grab.failed")));
        return;
      }
      setNotice(t("adminManage.queue.grab.done", { title: row.mediaTitle || row.title }));
      reloadSoon(2_000);
    } catch {
      setActionError(t("adminManage.queue.grab.failed"));
    } finally {
      stopActing(key);
    }
  }

  async function recheck() {
    startActing("recheck");
    setNotice("");
    setActionError("");
    setRecheckFailed(null);
    try {
      const res = await fetch(withBasePath("/api/admin/queue/recheck"), { method: "POST" });
      const data = (await res.json().catch(() => null)) as { instances?: number; errors?: unknown[] } | null;
      if (!res.ok) {
        setActionError(apiErrorText(data, t("adminManage.queue.recheck.failed")));
        return;
      }
      const outcome = recheckOutcome(data);
      if (outcome.failed.length > 0) setRecheckFailed({ all: outcome.allFailed, failed: outcome.failed });
      if (!outcome.allFailed) setNotice(t("adminManage.queue.recheck.done", { count: outcome.asked }));
      reloadSoon(5_000);
    } catch {
      setActionError(t("adminManage.queue.recheck.failed"));
    } finally {
      stopActing("recheck");
    }
  }

  function imported(row: QueueItem, files: number) {
    setImporting(null);
    setNotice(t("adminManage.queue.import.done", { title: row.mediaTitle || row.title, count: files }));
    // The arr imports in the background; give it a moment before re-reading.
    reloadSoon(3_000);
  }

  // The arr accepted the removal: the row goes at once (the next poll agrees).
  function removed(row: QueueItem, action: QueueRemoveAction) {
    const gone = rowKey(row);
    setReport((r) => (r ? { ...r, items: r.items.filter((i) => rowKey(i) !== gone) } : r));
    setNotice(
      action === "blocklistSearch"
        ? t("adminManage.queue.remove.doneSearch", { title: row.mediaTitle || row.title })
        : t("adminManage.queue.remove.done", { title: row.mediaTitle || row.title }),
    );
    setRemoving(null);
  }

  const rowActions: QueueRowActions = {
    onManage: setManaging,
    onImport: setImporting,
    onGrab: (row) => void grabNow(row),
    onRemove: openRemove,
  };

  const items = report?.items;
  const instanceName = useCallback(
    (service: Service, slug: string) => report?.instances.find((i) => i.service === service && i.slug === slug)?.name ?? slug,
    [report],
  );
  const instanceLabel = useCallback(
    (service: Service, slug: string) => arrInstanceLabel(service, instanceName(service, slug), slug),
    [instanceName],
  );
  const multiInstance = (report?.instances.length ?? 0) > 1;
  const shownColumns = COLUMNS.filter((c) => !hidden.has(c.id) && (c.id !== "instance" || multiInstance));

  // The exact-title filter applies before the others: it is what the link was for.
  const titleRows = useMemo(
    () => (titleFilter ? (items ?? []).filter((r) => matchesQueueTitle(r, titleFilter)) : (items ?? [])),
    [items, titleFilter],
  );
  const visible = useMemo(() => {
    const q = query.trim().toLowerCase();
    return titleRows.filter(
      (r) =>
        (filter === "all" || (filter === "attention" ? r.attention : r.service === filter)) &&
        (instance === "all" || `${r.service}:${r.instance}` === instance) &&
        (!q || r.mediaTitle.toLowerCase().includes(q) || r.title.toLowerCase().includes(q)),
    );
  }, [titleRows, filter, instance, query]);
  // The chip names the title by its downloads; with none in the queue, by its instance and id.
  const titleFilterLabel = titleFilter
    ? titleRows[0]
      ? titleRows[0].mediaTitle || titleRows[0].title
      : t("adminManage.queue.filter.titleById", {
          name: arrInstanceLabel(titleFilter.service, instanceName(titleFilter.service, titleFilter.instance), titleFilter.instance),
          id: titleFilter.arrId,
        })
    : "";

  const count = (f: Filter) =>
    items ? titleRows.filter((r) => (f === "all" ? true : f === "attention" ? r.attention : r.service === f)).length : undefined;
  const services = new Set((report?.instances ?? []).map((i) => i.service));

  let body: React.ReactNode;
  if (!configured) {
    body = (
      <EmptyState
        icon={CircleDashed}
        title={t("adminManage.queue.notConfigured.title")}
        description={t("adminManage.queue.notConfigured.description")}
        cta={{ href: "/settings?tab=media#radarr", label: t("adminArr.common.openSettings") }}
      />
    );
  } else if (!report) {
    body = error ? (
      <p role="alert" style={{ fontSize: 13, color: "var(--ds-danger)", margin: 0 }}>{error}</p>
    ) : (
      <div className="flex items-center gap-2" style={{ color: "var(--ds-fg-subtle)", fontSize: 13 }}>
        <Loader2 className="animate-spin" style={{ width: 14, height: 14 }} /> {t("adminManage.queue.loading")}
      </div>
    );
  } else {
    const downloading = report.items.filter((i) => i.phase === "downloading").length;
    const left = report.items.reduce((n, i) => n + i.sizeLeft, 0);
    body = (
      <div className="flex flex-col gap-4">
        <div className="grid gap-3" style={{ gridTemplateColumns: "repeat(auto-fit, minmax(160px, 1fr))" }}>
          <StatCard label={t("adminManage.queue.stat.downloads")} value={report.items.length} hint={t("adminManage.queue.stat.downloadsHint", { count: downloading })} />
          <StatCard label={t("adminManage.queue.stat.attention")} value={report.items.filter((i) => i.attention).length} hint={t("adminManage.queue.stat.attentionHint")} />
          <StatCard label={t("adminManage.queue.stat.remaining")} value={fmt.size(left)} hint={t("adminManage.queue.stat.remainingHint")} />
        </div>

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
            <Switch checked={live} onCheckedChange={setLive} aria-label={t("adminManage.queue.filter.live")} />
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

        {visible.length === 0 ? (
          titleFilter && titleRows.length === 0 ? (
            <EmptyState
              icon={CircleDashed}
              title={t("adminManage.queue.empty.titleFilterTitle")}
              description={t("adminManage.queue.empty.titleFilterDescription")}
              action={
                <Button size="sm" variant="outline" onClick={clearTitleFilter}>
                  {t("adminManage.queue.filter.clearTitle")}
                </Button>
              }
            />
          ) : report.items.length > 0 ? (
            <EmptyState icon={CircleDashed} title={t("adminManage.queue.empty.filteredTitle")} description={t("adminManage.queue.empty.filteredDescription")} />
          ) : (
            <EmptyState icon={CheckCircle2} title={t("adminManage.queue.empty.title")} description={t("adminManage.queue.empty.description")} />
          )
        ) : (
          <QueueTable
            rows={visible}
            columns={shownColumns}
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
    );
  }

  const segments = [
    { value: "all" as const, label: t("adminManage.queue.tab.all"), count: count("all") },
    { value: "attention" as const, label: t("adminManage.queue.tab.attention"), count: count("attention") },
    ...(services.has("sonarr") ? [{ value: "sonarr" as const, label: SERVICE_LABEL.sonarr, count: count("sonarr") }] : []),
    ...(services.has("radarr") ? [{ value: "radarr" as const, label: SERVICE_LABEL.radarr, count: count("radarr") }] : []),
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
          active={filter}
          onChange={setFilter}
          right={
            configured ? (
              <div className="flex flex-wrap items-center gap-2">
                <Button
                  size="sm"
                  variant="outline"
                  onClick={() => void recheck()}
                  disabled={acting.has("recheck")}
                  title={t("adminManage.queue.recheck.hint")}
                >
                  {acting.has("recheck") ? <Loader2 className="animate-spin" /> : <RefreshCcw />}
                  {t("adminManage.queue.recheck.button")}
                </Button>
                <Button size="sm" variant="outline" onClick={() => void load()} disabled={loading}>
                  {loading ? <Loader2 className="animate-spin" /> : <RefreshCw />}
                  {t("adminManage.queue.refresh")}
                </Button>
              </div>
            ) : null
          }
        />
        <ArrSnapshotNote at={snapshotAt} refreshing={loading} />
        {report && error && <p role="alert" style={{ fontSize: 13, color: "var(--ds-danger)", margin: 0 }}>{error}</p>}
        {actionError && <p role="alert" style={{ fontSize: 13, color: "var(--ds-danger)", margin: 0 }}>{actionError}</p>}
        {body}
      </div>

      <RemoveQueueDialog target={removing} arrVersions={arrVersions} onClose={() => setRemoving(null)} onRemoved={removed} />

      <QueueImportDialog row={importing} onClose={() => setImporting(null)} onImported={imported} />

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

// Admin → Download Queue → Remove: both halves of the arr's own "Remove from
// queue" dialog — the blocklist choice and the removal method. It opens on the
// action the admin clicked; they can still change it here.
function RemoveQueueDialog({
  target,
  arrVersions,
  onClose,
  onRemoved,
}: {
  target: { row: QueueItem; action: QueueRemoveAction } | null;
  /** Each instance's version (`service:slug`), from the health report. */
  arrVersions: Record<string, string | null>;
  onClose: () => void;
  onRemoved: (row: QueueItem, action: QueueRemoveAction) => void;
}) {
  const t = useT();
  const removing = target?.row ?? null;
  const [removeAction, setRemoveAction] = useState<QueueRemoveAction>(target?.action ?? "blocklistSearch");
  const [removeMethod, setRemoveMethod] = useState<QueueRemoveMethod>("removeFromClient");
  const [removeBusy, setRemoveBusy] = useState(false);
  const [removeError, setRemoveError] = useState("");
  // Each open starts on the action clicked, the default method and no error
  // (adjust-state-during-render; keying the Dialog would cut its close animation).
  const [opened, setOpened] = useState(target);
  if (opened !== target) {
    setOpened(target);
    if (target) {
      setRemoveAction(target.action);
      setRemoveMethod("removeFromClient");
      setRemoveError("");
    }
  }

  async function confirmRemove() {
    if (!removing) return;
    setRemoveBusy(true);
    setRemoveError("");
    try {
      const res = await fetch(withBasePath("/api/admin/queue/remove"), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          service: removing.service,
          instance: removing.instance,
          ids: removalIds(removing),
          action: removeAction,
          method: removing.pending ? "removeFromClient" : removeMethod,
        }),
      });
      if (!res.ok) {
        setRemoveError(await readApiError(res, t("adminManage.queue.remove.failed")));
        return;
      }
      onRemoved(removing, removeAction);
    } catch {
      setRemoveError(t("adminManage.queue.remove.failed"));
    } finally {
      setRemoveBusy(false);
    }
  }

  // Both halves of the arr's own "Remove from queue" dialog.
  const redownload = removing ? blocklistRedownload(removing.service, arrVersions[`${removing.service}:${removing.instance}`]) : "skipped";
  const REMOVE_OPTIONS: Array<{ value: QueueRemoveAction; label: string; help: string }> = [
    ...(removing?.pending ? [] : [{ value: "blocklistSearch" as const, label: t("adminManage.queue.remove.blocklistSearch"), help: t("adminManage.queue.remove.blocklistSearchHelp") }]),
    {
      value: "blocklist",
      label: t("adminManage.queue.remove.blocklist"),
      help: redownload === "searches"
        ? t("adminManage.queue.remove.blocklistHelpSonarrV3")
        : redownload === "unknown"
          ? t("adminManage.queue.remove.blocklistHelpSonarrUnknown")
          : t("adminManage.queue.remove.blocklistHelp"),
    },
    { value: "remove", label: t("adminManage.queue.remove.remove"), help: t("adminManage.queue.remove.removeHelp") },
  ];
  const METHOD_OPTIONS: Array<{ value: QueueRemoveMethod; label: string; help: string }> = [
    { value: "removeFromClient", label: t("adminManage.queue.remove.method.removeFromClient"), help: t("adminManage.queue.remove.method.removeFromClientHelp") },
    ...(removing?.canChangeCategory
      ? [{ value: "changeCategory" as const, label: t("adminManage.queue.remove.method.changeCategory"), help: t("adminManage.queue.remove.method.changeCategoryHelp") }]
      : []),
    { value: "ignore", label: t("adminManage.queue.remove.method.ignore"), help: t("adminManage.queue.remove.method.ignoreHelp") },
  ];
  const radioBox = (on: boolean): React.CSSProperties => ({
    padding: "8px 10px",
    border: `1px solid ${on ? "var(--ds-border-strong)" : "var(--ds-border)"}`,
    background: on ? "var(--ds-bg-2)" : "transparent",
  });

  return (
    <Dialog open={target !== null} onOpenChange={(o) => { if (!o && !removeBusy) onClose(); }}>
      <DialogPortal>
        <DialogBackdrop />
        <DialogPopup className="max-w-lg">
          <div className="flex items-center justify-between px-6 py-4 border-b border-zinc-700">
            <DialogTitle className="text-base font-semibold text-zinc-100">
              {removeAction === "remove" ? t("adminManage.queue.remove.title") : t("adminManage.queue.remove.titleBlocklist")}
            </DialogTitle>
            <DialogClose
              disabled={removeBusy}
              aria-label={t("adminQueue.common.close")}
              title={t("adminQueue.common.close")}
              className="text-zinc-500 hover:text-zinc-300 disabled:opacity-40 transition-colors"
            >
              <X className="w-5 h-5" />
            </DialogClose>
          </div>
          {removing && (
            <div className="flex flex-col gap-4 px-6 py-4">
              <div>
                <p className="m-0 text-sm font-medium text-zinc-100">
                  {removing.mediaTitle || removing.title}
                  {removing.episodes.length > 0 && <span className="ds-mono text-zinc-400"> · {episodeSummary(removing.episodes)}</span>}
                </p>
                <p className="m-0 ds-mono text-zinc-500" style={{ fontSize: 11, overflowWrap: "anywhere" }}>{removing.title}</p>
              </div>
              <fieldset className="flex flex-col gap-2 m-0 p-0 border-0">
                <legend className="text-xs font-medium text-zinc-400 mb-1">{t("adminManage.queue.remove.blocklistLegend")}</legend>
                {REMOVE_OPTIONS.map((o) => (
                  <label key={o.value} className="flex items-start gap-2.5 rounded-md" style={radioBox(removeAction === o.value)}>
                    <input
                      type="radio"
                      name="queue-remove-action"
                      value={o.value}
                      checked={removeAction === o.value}
                      onChange={() => setRemoveAction(o.value)}
                      style={{ marginTop: 3 }}
                    />
                    <span className="flex flex-col">
                      <span className="text-sm text-zinc-100">{o.label}</span>
                      <span className="text-xs text-zinc-500">{o.help}</span>
                    </span>
                  </label>
                ))}
              </fieldset>
              {/* A held release is in no download client — there is no removal method to pick. */}
              {!removing.pending && (
                <fieldset className="flex flex-col gap-2 m-0 p-0 border-0">
                  <legend className="text-xs font-medium text-zinc-400 mb-1">{t("adminManage.queue.remove.methodLegend")}</legend>
                  {METHOD_OPTIONS.map((o) => (
                    <label key={o.value} className="flex items-start gap-2.5 rounded-md" style={radioBox(removeMethod === o.value)}>
                      <input
                        type="radio"
                        name="queue-remove-method"
                        value={o.value}
                        checked={removeMethod === o.value}
                        onChange={() => setRemoveMethod(o.value)}
                        style={{ marginTop: 3 }}
                      />
                      <span className="flex flex-col">
                        <span className="text-sm text-zinc-100">{o.label}</span>
                        <span className="text-xs text-zinc-500">{o.help}</span>
                      </span>
                    </label>
                  ))}
                </fieldset>
              )}
              {removeError && (
                <p role="alert" className="m-0 text-xs flex items-center gap-1" style={{ color: "var(--ds-danger)" }}>
                  <AlertTriangle style={{ width: 12, height: 12 }} aria-hidden /> {removeError}
                </p>
              )}
            </div>
          )}
          <div className="flex items-center justify-between px-6 py-4 border-t border-zinc-700 bg-zinc-900">
            <button type="button" onClick={onClose} disabled={removeBusy} className="rounded px-2 py-1 text-sm text-zinc-500 hover:text-zinc-300">
              {t("shared.common.cancel")}
            </button>
            <Button
              size="sm"
              onClick={() => void confirmRemove()}
              disabled={removeBusy}
              className="bg-red-600 text-[var(--ds-on-status)] hover:bg-[var(--ds-danger-hover)]"
            >
              {removeBusy ? <Loader2 className="animate-spin" /> : removeAction === "remove" ? <Trash2 /> : removeAction === "blocklist" ? <Ban /> : <RotateCcw />}
              {removeAction === "blocklistSearch"
                ? t("adminManage.queue.remove.confirmBlocklistSearch")
                : removeAction === "blocklist"
                  ? t("adminManage.queue.remove.confirmBlocklist")
                  : t("adminManage.queue.remove.confirm")}
            </Button>
          </div>
        </DialogPopup>
      </DialogPortal>
    </Dialog>
  );
}
