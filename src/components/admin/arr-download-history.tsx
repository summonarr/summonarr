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
// The tab and instance live in the URL so a reload or a shared link keeps them.

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { Button } from "@/components/ui/button";
import { StyledSelect } from "@/components/ui/styled-select";
import { Chip, EmptyState, FilterBar } from "@/components/ui/design";
import { ArrHistoryList, historyKindLabel } from "@/components/admin/arr-history-list";
import { arrInstanceLabel } from "@/components/admin/open-in-arr";
import { queueFormatters } from "@/components/admin/queue-format";
import { AlertTriangle, Ban, Check, ChevronLeft, ChevronRight, Loader2, Magnet, Radio, RefreshCw, ScrollText, Trash2 } from "@/components/icons";
import { useLocale, useT } from "@/components/i18n/i18n-provider";
import { withBasePath } from "@/lib/base-path";
import type { ArrHistoryEvent, ArrPage, BlocklistEntry, HistoryFilterKind } from "@/lib/arr-history";

type Service = "radarr" | "sonarr";
type Tab = "history" | "blocklist";
interface InstanceRef { service: Service; slug: string; name: string }

const PAGE_SIZE = 50;
const KINDS: readonly HistoryFilterKind[] = ["grabbed", "imported", "failed", "deleted", "renamed", "ignored"];
const instKey = (i: { service: Service; slug: string }) => `${i.service}:${i.slug}`;

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

function Pager({ page, total, onPage, disabled }: { page: number; total: number; onPage: (p: number) => void; disabled: boolean }) {
  const t = useT();
  const pages = Math.max(1, Math.ceil(total / PAGE_SIZE));
  if (pages <= 1) return null;
  return (
    <div className="flex items-center justify-end gap-2 text-xs text-zinc-400">
      <Button variant="outline" size="sm" disabled={disabled || page <= 1} onClick={() => onPage(page - 1)} aria-label={t("adminArr.common.previousPage")}>
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
}: {
  instances: InstanceRef[];
  initialTab: Tab;
  /** "service:slug"; the first instance when absent or unknown. */
  initialInstance: string | null;
}) {
  const t = useT();
  const locale = useLocale();
  const fmt = useMemo(() => queueFormatters(locale), [locale]);
  const [tab, setTab] = useState<Tab>(initialTab);
  const [current, setCurrent] = useState<string>(
    instances.some((i) => instKey(i) === initialInstance) ? (initialInstance as string) : instances[0] ? instKey(instances[0]) : "",
  );
  const inst = instances.find((i) => instKey(i) === current) ?? null;
  const [kind, setKind] = useState<HistoryFilterKind | "all">("all");
  const [page, setPage] = useState(1);
  const [history, setHistory] = useState<ArrPage<ArrHistoryEvent> | null>(null);
  const [blocklist, setBlocklist] = useState<ArrPage<BlocklistEntry> | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [selected, setSelected] = useState<ReadonlySet<number>>(new Set());
  const [confirmClear, setConfirmClear] = useState(false);
  const [busy, setBusy] = useState<"remove" | "clear" | null>(null);
  const seq = useRef(0);

  const load = useCallback(async () => {
    if (!inst) return;
    const id = ++seq.current;
    setLoading(true);
    setError("");
    const q = new URLSearchParams({ service: inst.service, instance: inst.slug, page: String(page), pageSize: String(PAGE_SIZE) });
    if (tab === "history") {
      if (kind !== "all") q.set("kind", kind);
      const res = await getJson<ArrPage<ArrHistoryEvent>>(`/api/admin/arr/history?${q.toString()}`, t("adminArr.history.loadFailed"));
      if (id !== seq.current) return;
      if ("data" in res) setHistory(res.data);
      else setError(res.error);
    } else {
      const res = await getJson<ArrPage<BlocklistEntry>>(`/api/admin/arr/blocklist?${q.toString()}`, t("adminArr.blocklist.loadFailed"));
      if (id !== seq.current) return;
      if ("data" in res) {
        setBlocklist(res.data);
        setSelected((prev) => new Set([...prev].filter((x) => res.data.records.some((r) => r.id === x))));
      } else setError(res.error);
    }
    setLoading(false);
  }, [inst, page, tab, kind, t]);

  useEffect(() => {
    void load();
  }, [load]);

  function syncUrl(nextTab: Tab, nextInst: string) {
    const [service, ...rest] = nextInst.split(":");
    const q = new URLSearchParams({ tab: nextTab, service, instance: rest.join(":") });
    window.history.replaceState(null, "", `?${q.toString()}`);
  }
  function switchTab(next: Tab) {
    if (next === tab) return;
    setTab(next);
    setPage(1);
    setNotice("");
    setConfirmClear(false);
    syncUrl(next, current);
  }
  function switchInstance(next: string) {
    setCurrent(next);
    setPage(1);
    setHistory(null);
    setBlocklist(null);
    setSelected(new Set());
    setNotice("");
    setConfirmClear(false);
    syncUrl(tab, next);
  }

  async function markFailed(e: ArrHistoryEvent): Promise<string | null> {
    if (!inst || e.arrMediaId === null) return t("adminArr.history.markFailedError");
    try {
      const res = await fetch(withBasePath("/api/admin/arr/history/failed"), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ service: inst.service, instance: inst.slug, arrId: e.arrMediaId, historyId: e.id }),
      });
      if (res.ok) return null;
      const data = (await res.json().catch(() => null)) as { error?: string } | null;
      return data?.error ?? t("adminArr.history.markFailedError");
    } catch {
      return t("adminArr.history.markFailedError");
    }
  }

  async function removeSelected() {
    if (!inst) return;
    setBusy("remove");
    setError("");
    const q = new URLSearchParams({ service: inst.service, instance: inst.slug, ids: [...selected].join(",") });
    try {
      const res = await fetch(withBasePath(`/api/admin/arr/blocklist?${q.toString()}`), { method: "DELETE" });
      const data = (await res.json().catch(() => null)) as { removed?: number; error?: string } | null;
      if (!res.ok) setError(data?.error ?? t("adminArr.blocklist.removeFailed"));
      else {
        setNotice(t("adminArr.blocklist.removed", { count: data?.removed ?? selected.size }));
        setSelected(new Set());
        await load();
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
        body: JSON.stringify({ service: inst.service, instance: inst.slug }),
      });
      const data = (await res.json().catch(() => null)) as { error?: string } | null;
      if (!res.ok) setError(data?.error ?? t("adminArr.blocklist.clearFailed"));
      else {
        setNotice(t("adminArr.blocklist.cleared"));
        setConfirmClear(false);
        // The arr clears in the background.
        window.setTimeout(() => void load(), 2_000);
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

  const records = blocklist?.records ?? [];
  const allSelected = records.length > 0 && records.every((r) => selected.has(r.id));

  return (
    <div className="grid gap-4">
      <FilterBar
        segments={[
          { value: "history" as const, label: t("adminArr.historyPage.tab.history") },
          { value: "blocklist" as const, label: t("adminArr.historyPage.tab.blocklist"), count: blocklist?.totalRecords },
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

      {error && (
        <p role="alert" className="m-0 flex items-center gap-1.5 text-sm" style={{ color: "var(--ds-danger)" }}>
          <AlertTriangle className="h-4 w-4 shrink-0" /> {error}
        </p>
      )}
      {notice && <p role="status" className="m-0 flex items-center gap-1.5 text-sm text-green-400"><Check className="h-4 w-4" /> {notice}</p>}

      {tab === "history" ? (
        <>
          <div className="flex flex-wrap gap-1.5">
            {(["all", ...KINDS] as const).map((k) => (
              <button
                key={k}
                type="button"
                aria-pressed={kind === k}
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
              <ArrHistoryList events={history.records} showTitle onMarkFailed={markFailed} />
              <Pager page={page} total={history.totalRecords} onPage={setPage} disabled={loading} />
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
                  onChange={(e) => setSelected(e.target.checked ? new Set(records.map((r) => r.id)) : new Set())}
                  className="accent-[var(--ds-accent)]"
                />
                {t("adminArr.files.selectAll")}
              </label>
            )}
            <Button variant="outline" size="sm" disabled={selected.size === 0 || busy !== null} onClick={() => void removeSelected()}>
              {busy === "remove" ? <Loader2 className="animate-spin" /> : <Trash2 />} {t("adminArr.blocklist.remove", { count: selected.size })}
            </Button>
            <span className="flex-1" />
            {confirmClear ? (
              <span className="flex flex-wrap items-center gap-2 text-xs text-zinc-300">
                {t("adminArr.blocklist.confirmClear", { count: blocklist?.totalRecords ?? 0 })}
                <Button variant="ghost" size="sm" disabled={busy !== null} onClick={() => setConfirmClear(false)}>{t("adminArr.common.cancel")}</Button>
                <Button size="sm" className="bg-red-600 text-[var(--ds-on-status)] hover:bg-[var(--ds-danger-hover)]" disabled={busy !== null} onClick={() => void clearAll()}>
                  {busy === "clear" && <Loader2 className="animate-spin" />} {t("adminArr.blocklist.clear")}
                </Button>
              </span>
            ) : (
              <Button variant="outline" size="sm" disabled={!blocklist || blocklist.totalRecords === 0 || busy !== null} onClick={() => setConfirmClear(true)}>
                <Ban /> {t("adminArr.blocklist.clear")}
              </Button>
            )}
          </div>
          {!blocklist ? (
            loading && <div className="flex items-center gap-2 py-10 text-sm text-zinc-500"><Loader2 className="h-4 w-4 animate-spin" /> {t("adminArr.common.loading")}</div>
          ) : records.length === 0 ? (
            <EmptyState icon={Ban} title={t("adminArr.blocklist.empty")} description={t("adminArr.blocklist.emptyHint")} />
          ) : (
            <>
              <ul className="m-0 grid list-none gap-0 rounded-lg p-0" style={{ border: "1px solid var(--ds-border)" }}>
                {records.map((r, i) => {
                  const href = r.tmdbId !== null ? (r.service === "radarr" ? `/movie/${r.tmdbId}` : `/tv/${r.tmdbId}`) : null;
                  return (
                    <li key={r.id} className="flex items-start gap-3 px-3 py-2.5" style={i > 0 ? { borderTop: "1px solid var(--ds-border)" } : undefined}>
                      <input
                        type="checkbox"
                        checked={selected.has(r.id)}
                        onChange={() => setSelected((prev) => {
                          const next = new Set(prev);
                          if (next.has(r.id)) next.delete(r.id);
                          else next.add(r.id);
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
              <Pager page={page} total={blocklist.totalRecords} onPage={setPage} disabled={loading} />
            </>
          )}
        </>
      )}
    </div>
  );
}
