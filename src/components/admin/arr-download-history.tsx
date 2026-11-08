"use client";

// Admin → Download History. Two tabs over one Radarr/Sonarr instance at a time
// (the arr pages its own lists; merging instances could not order a page
// honestly):
//   History   — every grab, import, failure, deletion, rename and ignored
//               download, filterable by kind, a grab markable as failed
//               (GET /api/admin/arr/history, POST …/history/failed).
//   Blocklist — releases the arr will never grab again, with why; remove some
//               or clear the list so they can be grabbed (GET/DELETE
//               /api/admin/arr/blocklist, POST …/blocklist/clear).
// The tab, instance, kind filter and page live in the URL so a reload or a
// shared link keeps them. The view, its reads and its snapshot are
// use-history-view.ts.
//
// Every write names the instance of the records it acts on, never the one in
// view: blocklist ids are per-instance autoincrement and collide across
// instances. A reload after a write goes through the view's `reload` — the
// loader of the view on screen NOW — so a slow write can never paint another
// instance's or tab's data over the current one. Mark failed is a write too:
// while one is in flight the tab, instance, kind and page stay put, or its
// refusal would land on a list no longer on screen. While Clear blocklist's
// command is followed, Clear and Remove wait for it — the list on screen is
// the one being cleared.
//
// Instant, then live (src/lib/arr-snapshot.ts): opening the page, or changing
// the tab, instance, kind or page, first draws the answer the server kept for
// exactly that read, marked with when it was read, then the live load replaces
// it. A snapshot is never drawn while a write is in flight or over its re-read,
// and it is display only: every write re-checks the arr live on the server.

import { useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { Button } from "@/components/ui/button";
import { StyledSelect } from "@/components/ui/styled-select";
import { Chip, EmptyState, FilterBar } from "@/components/ui/design";
import { ArrHistoryList, historyKindLabel } from "@/components/admin/arr-history-list";
import { ArrSnapshotNote } from "@/components/admin/arr-snapshot-note";
import { CommandWatchLine, isWatchActive, useArrCommandWatch } from "@/components/admin/arr-command-watch";
import { arrInstanceKey } from "@/components/admin/arr-title/shared";
import { arrInstanceLabel } from "@/components/admin/open-in-arr";
import { ManageTitleButton } from "@/components/admin/arr-title/title-manager";
import { queueFormatters } from "@/components/admin/queue-format";
import { AlertTriangle, Ban, Check, ChevronLeft, ChevronRight, Loader2, Magnet, Radio, RefreshCw, ScrollText, Trash2 } from "@/components/icons";
import { useLocale, useT } from "@/components/i18n/i18n-provider";
import { withBasePath } from "@/lib/base-path";
import type { ArrHistoryEvent, ArrPage, BlocklistEntry, HistoryFilterKind } from "@/lib/arr-history";
import { manageTabFor } from "@/lib/arr-manage-links";
import { arrCall } from "@/lib/client/arr-call";
import { BLOCKLIST_CLEARED, BLOCKLIST_REMOVED, idsOf } from "@/lib/client/arr-answers";
import { withQuery } from "@/lib/client/url-query";
import { useAsyncAction } from "@/hooks/use-async-action";
import { entryKey, useHistoryView, type InstanceRef, type Service, type Tab } from "./use-history-view";

const KINDS: readonly HistoryFilterKind[] = ["grabbed", "imported", "failed", "deleted", "renamed", "ignored"];
// The page's writes, each its own action key: while one is out the view holds still.
const WRITES = ["mark", "remove", "clear"] as const;

type LabelOf = (service: Service, slug: string) => string;

// Pages by the size the arr answered with, not the one asked for. Shown while
// the page in view is past the last one too, so a stranded admin can step back.
function Pager({ page, pageSize, total, onPage, disabled }: { page: number; pageSize: number; total: number; onPage: (p: number) => void; disabled: boolean }) {
  const t = useT();
  const pages = Math.max(1, Math.ceil(total / Math.max(1, pageSize)));
  if (pages <= 1 && page <= 1) return null;
  return (
    <div className="flex items-center justify-end gap-2 text-xs text-zinc-400">
      <Button variant="outline" size="sm" disabled={disabled || page <= 1} onClick={() => onPage(Math.min(page - 1, pages))} aria-label={t("adminArr.common.previousPage")}>
        <ChevronLeft />
      </Button>
      {t("adminArr.common.pageOf", { page, pages })}
      <Button variant="outline" size="sm" disabled={disabled || page >= pages} onClick={() => onPage(page + 1)} aria-label={t("adminArr.common.nextPage")}>
        <ChevronRight />
      </Button>
    </div>
  );
}

export function ArrDownloadHistory({
  instances,
  initialTab,
  initialInstance,
  initialKind = null,
  initialPage = 1,
}: {
  instances: InstanceRef[];
  initialTab: Tab;
  /** "service:slug"; the first instance when absent or unknown. */
  initialInstance: string | null;
  /** The History tab's kind filter; all kinds when null. */
  initialKind?: HistoryFilterKind | null;
  initialPage?: number;
}) {
  const t = useT();
  // Mark failed, Remove and Clear. Read live by the view's snapshot gate: a
  // snapshot landing mid-write sees the write the moment it starts.
  const writes = useAsyncAction();
  const busy = WRITES.find((k) => writes.busy(k)) ?? null;
  // Clear blocklist's command, followed live; the list is re-read once it ends.
  const { watch: watchCommand, stop: stopWatch, watches } = useArrCommandWatch();
  // Clear blocklist's command still running: the list on screen is being emptied.
  const clearing = isWatchActive(watches.clear);
  const view = useHistoryView({
    instances,
    initialTab,
    initialInstance,
    initialKind,
    initialPage,
    writing: () => WRITES.some((k) => writes.busy(k)) || clearing,
  });
  const { tab, current, inst, kind, page, history, blocklist, selected, reload } = view;
  const [notice, setNotice] = useState("");
  const [confirmClear, setConfirmClear] = useState(false);

  // The inline Clear confirm replaces the button that opened it: focus moves to
  // its Cancel, and back to Clear when it closes.
  const clearCancelRef = useRef<HTMLButtonElement>(null);
  const clearOpenRef = useRef<HTMLButtonElement>(null);
  const refocusClear = useRef(false);
  useEffect(() => {
    if (confirmClear) clearCancelRef.current?.focus();
    else if (refocusClear.current) {
      refocusClear.current = false;
      clearOpenRef.current?.focus();
    }
  }, [confirmClear]);

  // A clear still being followed belongs to the view that started it: a switch
  // stops it (no re-read, no line); unmounting stops it too.
  const cancelReload = () => stopWatch("clear");

  // The URL keeps this page's own keys; any other param and the #fragment stay.
  useEffect(() => {
    if (!current) return;
    const [service, ...rest] = current.split(":");
    window.history.replaceState(null, "", withQuery(window.location, {
      tab,
      service,
      instance: rest.join(":"),
      kind: tab === "history" && kind !== "all" ? kind : null,
      page: page > 1 ? String(page) : null,
    }));
  }, [tab, current, kind, page]);

  function switchTab(next: Tab) {
    if (next === tab || busy !== null) return;
    cancelReload();
    view.showTab(next);
    setNotice("");
    setConfirmClear(false);
  }
  function switchInstance(next: string) {
    if (busy !== null) return;
    cancelReload();
    view.showInstance(next);
    setNotice("");
    setConfirmClear(false);
  }

  async function markFailed(e: ArrHistoryEvent): Promise<string | null> {
    const fallback = t("adminArr.history.markFailedError");
    if (e.arrMediaId === null) return fallback;
    const res = await writes.run(
      "mark",
      (signal) => arrCall(withBasePath("/api/admin/arr/history/failed"), {
        method: "POST",
        body: { service: e.service, instance: e.instance, arrId: e.arrMediaId, historyId: e.id },
        signal,
        fallback,
      }),
      { ifBusy: "skip" },
    );
    if (!res) return fallback;
    if (!res.ok) return res.error;
    // The arr records the failure as it accepts it; the reload shows it.
    void reload();
    return null;
  }

  async function removeSelected() {
    const entries = [...selected.values()];
    if (entries.length === 0) return;
    const { service, instance } = entries[0];
    // The selection is one page of one instance; anything else is not sent.
    if (entries.some((r) => r.service !== service || r.instance !== instance)) return;
    view.setError("");
    const q = new URLSearchParams({ service, instance, ids: entries.map((r) => r.id).join(",") });
    // The page they were picked from: the server re-reads it before any scan.
    if (blocklist && entries.every((r) => blocklist.records.some((x) => entryKey(x) === entryKey(r)))) {
      q.set("page", String(blocklist.page));
      q.set("pageSize", String(blocklist.pageSize));
    }
    const res = await writes.run(
      "remove",
      (signal) => arrCall(withBasePath(`/api/admin/arr/blocklist?${q.toString()}`), {
        method: "DELETE",
        schema: BLOCKLIST_REMOVED,
        signal,
        fallback: t("adminArr.blocklist.removeFailed"),
      }),
      { ifBusy: "skip" },
    );
    if (!res) return;
    if (res.ok) {
      const removed = res.data.removed;
      setNotice(t("adminArr.blocklist.removed", { count: typeof removed === "number" ? removed : entries.length }));
      view.setSelected(new Map());
      await reload();
    } else {
      view.setError(res.error);
      // 409: the page in view is stale — show the list as it is now, the refusal kept.
      if (res.status === 409) await reload({ keepError: true });
    }
  }

  async function clearAll() {
    if (!inst) return;
    view.setError("");
    const res = await writes.run(
      "clear",
      (signal) => arrCall(withBasePath("/api/admin/arr/blocklist/clear"), {
        method: "POST",
        body: { service: inst.service, instance: inst.slug, count: blocklist?.totalRecords ?? 0 },
        schema: BLOCKLIST_CLEARED,
        signal,
        fallback: t("adminArr.blocklist.clearFailed"),
      }),
      { ifBusy: "skip" },
    );
    if (!res) return;
    if (!res.ok) {
      view.setError(res.error);
      return;
    }
    refocusClear.current = true;
    setConfirmClear(false);
    // The arr clears in the background: follow its command and re-read the
    // list once it ends. An arr that sent no command id leaves the notice.
    const ids = idsOf(res.data.commandIds);
    if (ids.length > 0) {
      setNotice("");
      watchCommand("clear", { service: inst.service, instance: inst.slug }, ids, {
        pendingText: t("adminArr.blocklist.cleared"),
        onDone: () => void reload(),
      });
    } else {
      // Nothing to follow: re-read once now (a clear is quick); Reload is there if it isn't done yet.
      cancelReload();
      setNotice(t("adminArr.blocklist.cleared"));
      void reload();
    }
  }

  if (instances.length === 0 || !inst) {
    return <EmptyState icon={ScrollText} title={t("adminArr.common.noneConfigured")} description={t("adminArr.common.noneConfiguredHint")} cta={{ href: "/settings?tab=media#radarr", label: t("adminArr.common.openSettings") }} />;
  }

  // A record's own instance, labelled — the Manage icon on each row opens the title there.
  const labelOf: LabelOf = (service, slug) =>
    arrInstanceLabel(service, instances.find((i) => i.service === service && i.slug === slug)?.name, slug);
  // A write in flight pins the view: its follow-up reload is this view's.
  const switching = busy !== null;

  return (
    <div className="grid gap-4">
      <fieldset disabled={switching} className="m-0 min-w-0 border-0 p-0">
        <FilterBar
          segments={[
            { value: "history" as const, label: t("adminArr.historyPage.tab.history") },
            { value: "blocklist" as const, label: t("adminArr.historyPage.tab.blocklist"), count: view.blocklistTotal },
          ]}
          active={tab}
          onChange={switchTab}
          className="mb-0"
          right={
            <div className="flex items-center gap-2">
              <StyledSelect compact value={current} onChange={(e) => switchInstance(e.target.value)} aria-label={t("adminArr.common.instance")} className="w-auto md:text-xs">
                {instances.map((i) => <option key={arrInstanceKey(i)} value={arrInstanceKey(i)}>{arrInstanceLabel(i.service, i.name, i.slug)}</option>)}
              </StyledSelect>
              <Button variant="ghost" size="sm" disabled={view.loading} onClick={() => void view.load()} aria-label={t("adminArr.common.reload")}>
                {view.loading ? <Loader2 className="animate-spin" /> : <RefreshCw />}
              </Button>
            </div>
          }
        />
      </fieldset>

      <ArrSnapshotNote at={view.staleAt} refreshing={view.loading} />
      {view.error && (
        <p role="alert" className="m-0 flex items-center gap-1.5 text-sm" style={{ color: "var(--ds-danger)" }}>
          <AlertTriangle className="h-4 w-4 shrink-0" /> {view.error}
        </p>
      )}
      {notice && <p role="status" className="m-0 flex items-center gap-1.5 text-sm text-green-400"><Check className="h-4 w-4" /> {notice}</p>}
      {watches.clear && <CommandWatchLine watch={watches.clear} className="text-sm" />}

      {tab === "history" ? (
        <HistoryPanel
          history={history}
          historyKind={view.historyKind}
          kind={kind}
          page={page}
          loading={view.loading}
          busy={busy !== null}
          onKind={view.showKind}
          onPage={view.setPage}
          onMarkFailed={markFailed}
          onRemoved={() => void reload()}
          labelOf={labelOf}
        />
      ) : (
        <BlocklistPanel
          blocklist={blocklist}
          page={page}
          loading={view.loading}
          busy={busy}
          clearing={clearing}
          selected={selected}
          onSelected={view.setSelected}
          onRemove={() => void removeSelected()}
          confirmClear={confirmClear}
          clearOpenRef={clearOpenRef}
          clearCancelRef={clearCancelRef}
          onAskClear={() => setConfirmClear(true)}
          onCancelClear={() => {
            refocusClear.current = true;
            setConfirmClear(false);
          }}
          onClear={() => void clearAll()}
          onPage={view.setPage}
          onRemoved={() => void reload()}
          labelOf={labelOf}
        />
      )}
    </div>
  );
}

/** The History tab: the kind filter, the list, and its pages. */
function HistoryPanel({ history, historyKind, kind, page, loading, busy, onKind, onPage, onMarkFailed, onRemoved, labelOf }: {
  history: ArrPage<ArrHistoryEvent> | null;
  /** The kind the rows on screen were read with. */
  historyKind: HistoryFilterKind | "all";
  kind: HistoryFilterKind | "all";
  page: number;
  loading: boolean;
  /** A write is in flight: the filter and the pages hold still. */
  busy: boolean;
  onKind: (kind: HistoryFilterKind | "all") => void;
  onPage: (page: number) => void;
  onMarkFailed: (e: ArrHistoryEvent) => Promise<string | null>;
  /** The title manager took a row's title off the arr (which drops its history with it). */
  onRemoved: () => void;
  labelOf: LabelOf;
}) {
  const t = useT();
  return (
    <>
      <div className="flex flex-wrap gap-1.5">
        {(["all", ...KINDS] as const).map((k) => (
          <button
            key={k}
            type="button"
            aria-pressed={kind === k}
            disabled={busy}
            onClick={() => onKind(k)}
            className="ds-hover-tint rounded-full px-2.5 py-1 text-xs"
            style={{
              border: `1px solid ${kind === k ? "var(--ds-accent)" : "var(--ds-border)"}`,
              background: kind === k ? "var(--ds-accent-soft)" : "var(--ds-bg-2)",
              color: kind === k ? "var(--ds-accent-text)" : "var(--ds-fg-muted)",
            }}
          >
            {k === "all" ? t("adminArr.history.kind.all") : t(historyKindLabel(k))}
          </button>
        ))}
      </div>
      {!history ? (
        loading && <div className="flex items-center gap-2 py-10 text-sm text-zinc-500"><Loader2 className="h-4 w-4 animate-spin" /> {t("adminArr.common.loading")}</div>
      ) : (
        <>
          <ArrHistoryList
            events={history.records}
            showTitle
            filtered={historyKind !== "all"}
            onMarkFailed={onMarkFailed}
            renderManage={(e) => (
              <ManageTitleButton
                service={e.service}
                instance={e.instance}
                target={{ arrId: e.arrMediaId }}
                instanceLabel={labelOf(e.service, e.instance)}
                variant="icon"
                initialTab={manageTabFor("history", e.service)}
                onRemoved={onRemoved}
              />
            )}
            edges={{ hasPrevious: history.page > 1, hasNext: history.page * history.pageSize < history.totalRecords }}
          />
          {history.totalRecords > 0 && <Pager page={page} pageSize={history.pageSize} total={history.totalRecords} onPage={onPage} disabled={loading || busy} />}
        </>
      )}
    </>
  );
}

/** The Blocklist tab: select and remove entries, or clear the list; its rows and pages. */
function BlocklistPanel({
  blocklist, page, loading, busy, clearing, selected, onSelected, onRemove, confirmClear, clearOpenRef, clearCancelRef,
  onAskClear, onCancelClear, onClear, onPage, onRemoved, labelOf,
}: {
  blocklist: ArrPage<BlocklistEntry> | null;
  page: number;
  loading: boolean;
  busy: (typeof WRITES)[number] | null;
  /** Clear's command is still running: the list on screen is being emptied. */
  clearing: boolean;
  selected: ReadonlyMap<string, BlocklistEntry>;
  onSelected: (next: ReadonlyMap<string, BlocklistEntry>) => void;
  onRemove: () => void;
  confirmClear: boolean;
  clearOpenRef: React.Ref<HTMLButtonElement>;
  clearCancelRef: React.Ref<HTMLButtonElement>;
  onAskClear: () => void;
  onCancelClear: () => void;
  onClear: () => void;
  onPage: (page: number) => void;
  onRemoved: () => void;
  labelOf: LabelOf;
}) {
  const t = useT();
  const locale = useLocale();
  const fmt = useMemo(() => queueFormatters(locale), [locale]);
  const records = blocklist?.records ?? [];
  const allSelected = records.length > 0 && records.every((r) => selected.has(entryKey(r)));
  return (
    <>
      <div className="flex flex-wrap items-center gap-2">
        {records.length > 0 && (
          <label className="mr-1 flex items-center gap-2 text-xs text-zinc-400">
            <input
              type="checkbox"
              checked={allSelected}
              onChange={(e) => onSelected(e.target.checked ? new Map(records.map((r) => [entryKey(r), r])) : new Map())}
              className="accent-[var(--ds-accent)]"
            />
            {t("adminArr.files.selectAll")}
          </label>
        )}
        <Button variant="outline" size="sm" disabled={selected.size === 0 || busy !== null || clearing} onClick={onRemove}>
          {busy === "remove" ? <Loader2 className="animate-spin" /> : <Trash2 />} {t("adminArr.blocklist.remove", { count: selected.size })}
        </Button>
        <span className="flex-1" />
        {confirmClear ? (
          <span className="flex flex-wrap items-center gap-2 text-xs text-zinc-300">
            {t("adminArr.blocklist.confirmClear", { count: blocklist?.totalRecords ?? 0 })}
            <Button ref={clearCancelRef} variant="ghost" size="sm" disabled={busy !== null} onClick={onCancelClear}>
              {t("adminArr.common.cancel")}
            </Button>
            <Button size="sm" className="bg-red-600 text-[var(--ds-on-status)] hover:bg-[var(--ds-danger-hover)]" disabled={busy !== null || clearing} onClick={onClear}>
              {busy === "clear" && <Loader2 className="animate-spin" />} {t("adminArr.blocklist.clear")}
            </Button>
          </span>
        ) : (
          <Button ref={clearOpenRef} variant="outline" size="sm" disabled={!blocklist || blocklist.totalRecords === 0 || busy !== null || clearing} onClick={onAskClear}>
            <Ban /> {t("adminArr.blocklist.clear")}
          </Button>
        )}
      </div>
      {!blocklist ? (
        loading && <div className="flex items-center gap-2 py-10 text-sm text-zinc-500"><Loader2 className="h-4 w-4 animate-spin" /> {t("adminArr.common.loading")}</div>
      ) : blocklist.totalRecords === 0 ? (
        <EmptyState icon={Ban} title={t("adminArr.blocklist.empty")} description={t("adminArr.blocklist.emptyHint")} />
      ) : (
        <>
          {records.length > 0 && (
            <ul className="m-0 grid list-none gap-0 rounded-lg p-0" style={{ border: "1px solid var(--ds-border)" }}>
              {records.map((r, i) => {
                const key = entryKey(r);
                return (
                  <BlocklistRow
                    key={key}
                    entry={r}
                    first={i === 0}
                    selected={selected.has(key)}
                    onToggle={() => {
                      const next = new Map(selected);
                      if (next.has(key)) next.delete(key);
                      else next.set(key, r);
                      onSelected(next);
                    }}
                    onRemoved={onRemoved}
                    labelOf={labelOf}
                    fmt={fmt}
                  />
                );
              })}
            </ul>
          )}
          <Pager page={page} pageSize={blocklist.pageSize} total={blocklist.totalRecords} onPage={onPage} disabled={loading || busy !== null} />
        </>
      )}
    </>
  );
}

function BlocklistRow({ entry: r, first, selected, onToggle, onRemoved, labelOf, fmt }: {
  entry: BlocklistEntry;
  first: boolean;
  selected: boolean;
  onToggle: () => void;
  onRemoved: () => void;
  labelOf: LabelOf;
  fmt: ReturnType<typeof queueFormatters>;
}) {
  const t = useT();
  const href = r.tmdbId !== null ? (r.service === "radarr" ? `/movie/${r.tmdbId}` : `/tv/${r.tmdbId}`) : null;
  return (
    <li className="flex items-start gap-3 px-3 py-2.5" style={!first ? { borderTop: "1px solid var(--ds-border)" } : undefined}>
      <input
        type="checkbox"
        checked={selected}
        onChange={onToggle}
        className="mt-1 accent-[var(--ds-accent)]"
        aria-label={t("adminArr.files.selectAria", { name: r.sourceTitle })}
      />
      <div className="grid min-w-0 flex-1 gap-1">
        <div className="flex flex-wrap items-center gap-2">
          {href ? (
            <Link href={href} className="text-sm font-medium text-zinc-100 hover:underline">{r.mediaTitle || t("adminArr.history.unknownTitle")}</Link>
          ) : (
            <span className="text-sm font-medium text-zinc-100">{r.mediaTitle || t("adminArr.history.unknownTitle")}</span>
          )}
          {r.arrMediaId !== null && (
            <ManageTitleButton
              service={r.service}
              instance={r.instance}
              target={{ arrId: r.arrMediaId }}
              instanceLabel={labelOf(r.service, r.instance)}
              variant="icon"
              initialTab={manageTabFor("blocklist", r.service)}
              onRemoved={onRemoved}
            />
          )}
          {r.episodeCount > 0 && <span className="text-xs text-zinc-500">{t("adminArr.blocklist.episodes", { count: r.episodeCount })}</span>}
          <span className="text-xs text-zinc-500">{fmt.dateTime(r.date)}</span>
        </div>
        <div className="flex items-start gap-1.5 break-all text-xs text-zinc-300">
          <span className={`mt-0.5 shrink-0 ${r.protocol === "torrent" ? "text-green-500" : "text-sky-400"}`} aria-hidden>
            {r.protocol === "torrent" ? <Magnet className="h-3 w-3" /> : <Radio className="h-3 w-3" />}
          </span>
          {r.sourceTitle}
        </div>
        <div className="flex flex-wrap items-center gap-1.5 text-xs text-zinc-500">
          {r.quality && <Chip>{r.quality}</Chip>}
          {r.languages.length > 0 && <span>{r.languages.join(", ")}</span>}
          {r.indexer && <span>{t("adminArr.history.indexer", { name: r.indexer })}</span>}
        </div>
        {r.message && <div className="text-xs text-amber-400">{r.message}</div>}
      </div>
    </li>
  );
}
