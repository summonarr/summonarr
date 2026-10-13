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
// shared link keeps them.
//
// Every write names the instance of the records it acts on, never the one in
// view: blocklist ids are per-instance autoincrement and collide across
// instances. A reload after a write goes through `loadRef` — the loader of the
// view on screen NOW — so a slow write can never paint another instance's or
// tab's data over the current one. Mark failed is a write too: while one is in
// flight the tab, instance, kind and page stay put, or its refusal would land
// on a list no longer on screen. While Clear blocklist's command is followed,
// Clear and Remove wait for it — the list on screen is the one being cleared.

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { Button } from "@/components/ui/button";
import { StyledSelect } from "@/components/ui/styled-select";
import { Chip, EmptyState, FilterBar } from "@/components/ui/design";
import { ArrHistoryList, historyKindLabel } from "@/components/admin/arr-history-list";
import { CommandWatchLine, isWatchActive, useArrCommandWatch } from "@/components/admin/arr-command-watch";
import { useTRef } from "@/components/admin/arr-title/shared";
import { arrInstanceLabel } from "@/components/admin/open-in-arr";
import { ManageTitleButton } from "@/components/admin/arr-title/title-manager";
import { queueFormatters } from "@/components/admin/queue-format";
import { AlertTriangle, Ban, Check, ChevronLeft, ChevronRight, Loader2, Magnet, Radio, RefreshCw, ScrollText, Trash2 } from "@/components/icons";
import { useLocale, useT } from "@/components/i18n/i18n-provider";
import { withBasePath } from "@/lib/base-path";
import { lastPageIfStranded, type ArrHistoryEvent, type ArrPage, type BlocklistEntry, type HistoryFilterKind } from "@/lib/arr-history";
import { manageTabFor } from "@/lib/arr-manage-links";

type Service = "radarr" | "sonarr";
type Tab = "history" | "blocklist";
interface InstanceRef { service: Service; slug: string; name: string }

const PAGE_SIZE = 50;
const KINDS: readonly HistoryFilterKind[] = ["grabbed", "imported", "failed", "deleted", "renamed", "ignored"];
const instKey = (i: { service: Service; slug: string }) => `${i.service}:${i.slug}`;
// A blocklist entry's identity: its id alone collides across instances.
const entryKey = (r: BlocklistEntry) => `${r.service}:${r.instance}:${r.id}`;

async function getJson<T>(path: string, fallback: string): Promise<{ data: T } | { error: string }> {
  try {
    const res = await fetch(withBasePath(path));
    const data = (await res.json().catch(() => null)) as (T & { error?: string }) | null;
    if (!res.ok || !data) return { error: data?.error ?? fallback };
    return { data };
  } catch {
    return { error: fallback };
  }
}

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
  const tRef = useTRef();
  const locale = useLocale();
  const fmt = useMemo(() => queueFormatters(locale), [locale]);
  const [tab, setTab] = useState<Tab>(initialTab);
  const [current, setCurrent] = useState<string>(
    instances.some((i) => instKey(i) === initialInstance) ? (initialInstance as string) : instances[0] ? instKey(instances[0]) : "",
  );
  const inst = instances.find((i) => instKey(i) === current) ?? null;
  const [kind, setKind] = useState<HistoryFilterKind | "all">(initialKind ?? "all");
  const [page, setPage] = useState(initialPage);
  const [history, setHistory] = useState<ArrPage<ArrHistoryEvent> | null>(null);
  // The kind filter `history` was READ with — the one in `kind` may still be loading.
  const [historyKind, setHistoryKind] = useState<HistoryFilterKind | "all">("all");
  const [blocklist, setBlocklist] = useState<ArrPage<BlocklistEntry> | null>(null);
  // The Blocklist tab's count before the tab is visited: a pageSize=1 read.
  const [blocklistCount, setBlocklistCount] = useState<{ inst: string; total: number } | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [selected, setSelected] = useState<ReadonlyMap<string, BlocklistEntry>>(new Map());
  const [confirmClear, setConfirmClear] = useState(false);
  const [busy, setBusy] = useState<"remove" | "clear" | "mark" | null>(null);
  const seq = useRef(0);
  // Clear blocklist's command, followed live; the list is re-read once it ends.
  const { watch: watchCommand, stop: stopWatch, watches } = useArrCommandWatch();
  // Set when a load jumps to the last page: the load that follows continues it.
  const keepErrorNext = useRef(false);

  const load = useCallback(async (opts: { keepError?: boolean } = {}) => {
    if (!inst) return;
    const id = ++seq.current;
    setLoading(true);
    const keepError = opts.keepError === true || keepErrorNext.current;
    keepErrorNext.current = false;
    if (!keepError) setError("");
    const q = new URLSearchParams({ service: inst.service, instance: inst.slug, page: String(page), pageSize: String(PAGE_SIZE) });
    if (tab === "history") {
      if (kind !== "all") q.set("kind", kind);
      const res = await getJson<ArrPage<ArrHistoryEvent>>(`/api/admin/arr/history?${q.toString()}`, tRef.current("adminArr.history.loadFailed"));
      if (id !== seq.current) return;
      if ("data" in res) {
        // Past the end (its records were removed, or the URL named a page the
        // list no longer has): show the last page instead — the effect loads it.
        const last = lastPageIfStranded(page, res.data);
        if (last !== null) {
          keepErrorNext.current = true;
          setPage(last);
          return;
        }
        setHistory(res.data);
        setHistoryKind(kind);
      } else setError(res.error);
    } else {
      const res = await getJson<ArrPage<BlocklistEntry>>(`/api/admin/arr/blocklist?${q.toString()}`, tRef.current("adminArr.blocklist.loadFailed"));
      if (id !== seq.current) return;
      if ("data" in res) {
        const last = lastPageIfStranded(page, res.data);
        if (last !== null) {
          keepErrorNext.current = true;
          setPage(last);
          return;
        }
        const records = res.data.records;
        setBlocklist(res.data);
        setSelected((prev) => new Map([...prev].filter(([k]) => records.some((r) => entryKey(r) === k))));
      } else setError(res.error);
    }
    setLoading(false);
  }, [inst, page, tab, kind, tRef]);

  // The loader of the view on screen now, for reloads that finish after a click.
  const loadRef = useRef(load);
  useEffect(() => {
    loadRef.current = load;
  }, [load]);

  useEffect(() => {
    void load();
  }, [load]);

  // A clear still being followed belongs to the view that started it: a switch
  // stops it (no re-read, no line); unmounting stops it too.
  const cancelReload = useCallback(() => stopWatch("clear"), [stopWatch]);

  useEffect(() => {
    if (!inst) return;
    let live = true;
    const key = instKey(inst);
    const q = new URLSearchParams({ service: inst.service, instance: inst.slug, page: "1", pageSize: "1" });
    void getJson<ArrPage<BlocklistEntry>>(`/api/admin/arr/blocklist?${q.toString()}`, "").then((res) => {
      if (live && "data" in res) setBlocklistCount({ inst: key, total: res.data.totalRecords });
    });
    return () => {
      live = false;
    };
  }, [inst]);

  useEffect(() => {
    if (!current) return;
    const [service, ...rest] = current.split(":");
    const q = new URLSearchParams({ tab, service, instance: rest.join(":") });
    if (tab === "history" && kind !== "all") q.set("kind", kind);
    if (page > 1) q.set("page", String(page));
    window.history.replaceState(null, "", `?${q.toString()}`);
  }, [tab, current, kind, page]);

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

  function switchTab(next: Tab) {
    if (next === tab || busy !== null) return;
    cancelReload();
    setTab(next);
    setPage(1);
    setNotice("");
    setConfirmClear(false);
  }
  function switchInstance(next: string) {
    if (busy !== null) return;
    cancelReload();
    setCurrent(next);
    setPage(1);
    setHistory(null);
    setBlocklist(null);
    setSelected(new Map());
    setNotice("");
    setConfirmClear(false);
  }

  async function markFailed(e: ArrHistoryEvent): Promise<string | null> {
    const fallback = t("adminArr.history.markFailedError");
    if (e.arrMediaId === null) return fallback;
    setBusy("mark");
    try {
      const res = await fetch(withBasePath("/api/admin/arr/history/failed"), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ service: e.service, instance: e.instance, arrId: e.arrMediaId, historyId: e.id }),
      });
      if (res.ok) {
        // The arr records the failure as it accepts it; the reload shows it.
        void loadRef.current();
        return null;
      }
      const data = (await res.json().catch(() => null)) as { error?: string } | null;
      return data?.error ?? fallback;
    } catch {
      return fallback;
    } finally {
      setBusy(null);
    }
  }

  async function removeSelected() {
    const entries = [...selected.values()];
    if (entries.length === 0) return;
    const { service, instance } = entries[0];
    // The selection is one page of one instance; anything else is not sent.
    if (entries.some((r) => r.service !== service || r.instance !== instance)) return;
    setBusy("remove");
    setError("");
    const q = new URLSearchParams({ service, instance, ids: entries.map((r) => r.id).join(",") });
    // The page they were picked from: the server re-reads it before any scan.
    if (blocklist && entries.every((r) => blocklist.records.some((x) => entryKey(x) === entryKey(r)))) {
      q.set("page", String(blocklist.page));
      q.set("pageSize", String(blocklist.pageSize));
    }
    try {
      const res = await fetch(withBasePath(`/api/admin/arr/blocklist?${q.toString()}`), { method: "DELETE" });
      const data = (await res.json().catch(() => null)) as { removed?: number; error?: string } | null;
      if (res.ok) {
        setNotice(t("adminArr.blocklist.removed", { count: data?.removed ?? entries.length }));
        setSelected(new Map());
        await loadRef.current();
      } else {
        setError(data?.error ?? t("adminArr.blocklist.removeFailed"));
        // 409: the page in view is stale — show the list as it is now, the refusal kept.
        if (res.status === 409) await loadRef.current({ keepError: true });
      }
    } catch {
      setError(t("adminArr.blocklist.removeFailed"));
    } finally {
      setBusy(null);
    }
  }

  async function clearAll() {
    if (!inst) return;
    setBusy("clear");
    setError("");
    try {
      const res = await fetch(withBasePath("/api/admin/arr/blocklist/clear"), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ service: inst.service, instance: inst.slug, count: blocklist?.totalRecords ?? 0 }),
      });
      const data = (await res.json().catch(() => null)) as { error?: string; commandIds?: unknown } | null;
      if (!res.ok) setError(data?.error ?? t("adminArr.blocklist.clearFailed"));
      else {
        refocusClear.current = true;
        setConfirmClear(false);
        // The arr clears in the background: follow its command and re-read the
        // list once it ends. An arr that sent no command id leaves the notice.
        const ids = Array.isArray(data?.commandIds) ? data.commandIds.filter((x): x is number => typeof x === "number") : [];
        if (ids.length > 0) {
          setNotice("");
          watchCommand("clear", { service: inst.service, instance: inst.slug }, ids, {
            pendingText: t("adminArr.blocklist.cleared"),
            onDone: () => void loadRef.current(),
          });
        } else {
          // Nothing to follow: re-read once now (a clear is quick); Reload is there if it isn't done yet.
          cancelReload();
          setNotice(t("adminArr.blocklist.cleared"));
          void loadRef.current();
        }
      }
    } catch {
      setError(t("adminArr.blocklist.clearFailed"));
    } finally {
      setBusy(null);
    }
  }

  if (instances.length === 0 || !inst) {
    return <EmptyState icon={ScrollText} title={t("adminArr.common.noneConfigured")} description={t("adminArr.common.noneConfiguredHint")} />;
  }

  // A record's own instance, labelled — the Manage icon on each row opens the title there.
  const labelOf = (service: Service, slug: string) =>
    arrInstanceLabel(service, instances.find((i) => i.service === service && i.slug === slug)?.name, slug);

  const records = blocklist?.records ?? [];
  const allSelected = records.length > 0 && records.every((r) => selected.has(entryKey(r)));
  const blocklistTotal = blocklist?.totalRecords ?? (blocklistCount?.inst === current ? blocklistCount.total : undefined);
  const switching = busy !== null;
  // Clear blocklist's command still running: the list on screen is being emptied.
  const clearing = isWatchActive(watches.clear);

  return (
    <div className="grid gap-4">
      {/* A write in flight pins the view: its follow-up reload is this view's. */}
      <fieldset disabled={switching} className="m-0 min-w-0 border-0 p-0">
        <FilterBar
          segments={[
            { value: "history" as const, label: t("adminArr.historyPage.tab.history") },
            { value: "blocklist" as const, label: t("adminArr.historyPage.tab.blocklist"), count: blocklistTotal },
          ]}
          active={tab}
          onChange={switchTab}
          className="mb-0"
          right={
            <div className="flex items-center gap-2">
              <StyledSelect compact value={current} onChange={(e) => switchInstance(e.target.value)} aria-label={t("adminArr.common.instance")} className="w-auto md:text-xs">
                {instances.map((i) => <option key={instKey(i)} value={instKey(i)}>{arrInstanceLabel(i.service, i.name, i.slug)}</option>)}
              </StyledSelect>
              <Button variant="ghost" size="sm" disabled={loading} onClick={() => void load()} aria-label={t("adminArr.common.reload")}>
                {loading ? <Loader2 className="animate-spin" /> : <RefreshCw />}
              </Button>
            </div>
          }
        />
      </fieldset>

      {error && (
        <p role="alert" className="m-0 flex items-center gap-1.5 text-sm" style={{ color: "var(--ds-danger)" }}>
          <AlertTriangle className="h-4 w-4 shrink-0" /> {error}
        </p>
      )}
      {notice && <p role="status" className="m-0 flex items-center gap-1.5 text-sm text-green-400"><Check className="h-4 w-4" /> {notice}</p>}
      {watches.clear && <CommandWatchLine watch={watches.clear} className="text-sm" />}

      {tab === "history" ? (
        <>
          <div className="flex flex-wrap gap-1.5">
            {(["all", ...KINDS] as const).map((k) => (
              <button
                key={k}
                type="button"
                aria-pressed={kind === k}
                disabled={busy !== null}
                onClick={() => { setKind(k); setPage(1); }}
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
                onMarkFailed={markFailed}
                renderManage={(e) => (
                  <ManageTitleButton
                    service={e.service}
                    instance={e.instance}
                    target={{ arrId: e.arrMediaId }}
                    instanceLabel={labelOf(e.service, e.instance)}
                    variant="icon"
                    initialTab={manageTabFor("history", e.service)}
                    // Removed from the arr (which drops its history with it): re-read the page.
                    onRemoved={() => void loadRef.current()}
                  />
                )}
                edges={{ hasPrevious: history.page > 1, hasNext: history.page * history.pageSize < history.totalRecords }}
              />
              {history.totalRecords > 0 && <Pager page={page} pageSize={history.pageSize} total={history.totalRecords} onPage={setPage} disabled={loading || busy !== null} />}
            </>
          )}
        </>
      ) : (
        <>
          <div className="flex flex-wrap items-center gap-2">
            {records.length > 0 && (
              <label className="mr-1 flex items-center gap-2 text-xs text-zinc-400">
                <input
                  type="checkbox"
                  checked={allSelected}
                  onChange={(e) => setSelected(e.target.checked ? new Map(records.map((r) => [entryKey(r), r])) : new Map())}
                  className="accent-[var(--ds-accent)]"
                />
                {t("adminArr.files.selectAll")}
              </label>
            )}
            <Button variant="outline" size="sm" disabled={selected.size === 0 || busy !== null || clearing} onClick={() => void removeSelected()}>
              {busy === "remove" ? <Loader2 className="animate-spin" /> : <Trash2 />} {t("adminArr.blocklist.remove", { count: selected.size })}
            </Button>
            <span className="flex-1" />
            {confirmClear ? (
              <span className="flex flex-wrap items-center gap-2 text-xs text-zinc-300">
                {t("adminArr.blocklist.confirmClear", { count: blocklist?.totalRecords ?? 0 })}
                <Button
                  ref={clearCancelRef}
                  variant="ghost"
                  size="sm"
                  disabled={busy !== null}
                  onClick={() => {
                    refocusClear.current = true;
                    setConfirmClear(false);
                  }}
                >
                  {t("adminArr.common.cancel")}
                </Button>
                <Button size="sm" className="bg-red-600 text-[var(--ds-on-status)] hover:bg-[var(--ds-danger-hover)]" disabled={busy !== null || clearing} onClick={() => void clearAll()}>
                  {busy === "clear" && <Loader2 className="animate-spin" />} {t("adminArr.blocklist.clear")}
                </Button>
              </span>
            ) : (
              <Button ref={clearOpenRef} variant="outline" size="sm" disabled={!blocklist || blocklist.totalRecords === 0 || busy !== null || clearing} onClick={() => setConfirmClear(true)}>
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
                    const href = r.tmdbId !== null ? (r.service === "radarr" ? `/movie/${r.tmdbId}` : `/tv/${r.tmdbId}`) : null;
                    return (
                      <li key={key} className="flex items-start gap-3 px-3 py-2.5" style={i > 0 ? { borderTop: "1px solid var(--ds-border)" } : undefined}>
                        <input
                          type="checkbox"
                          checked={selected.has(key)}
                          onChange={() => setSelected((prev) => {
                            const next = new Map(prev);
                            if (next.has(key)) next.delete(key);
                            else next.set(key, r);
                            return next;
                          })}
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
                                onRemoved={() => void loadRef.current()}
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
                  })}
                </ul>
              )}
              <Pager page={page} pageSize={blocklist.pageSize} total={blocklist.totalRecords} onPage={setPage} disabled={loading || busy !== null} />
            </>
          )}
        </>
      )}
    </div>
  );
}
