"use client";

// Admin → Download Queue. Every configured Radarr and Sonarr instance's queue
// in one table (GET /api/admin/queue), one row per download, rows Radarr/Sonarr
// flag first. Refreshes itself every POLL_MS while the tab is visible and no
// dialog is open. Per row:
//   Import            — a download the arr would not import on its own: its
//                       Manual Import, in QueueImportDialog.
//   Blocklist & search, Blocklist, Remove — Radarr/Sonarr's own bulk queue
//                       DELETE (POST /api/admin/queue/remove), confirmed in a
//                       dialog that opens on the action clicked.
//
// Every time and size is server-supplied and formatted for the viewer's
// locale; nothing reads the clock while rendering (guardrail 16).

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { StyledSelect } from "@/components/ui/styled-select";
import { Switch } from "@/components/ui/switch";
import { Dialog, DialogBackdrop, DialogClose, DialogPopup, DialogPortal, DialogTitle } from "@/components/ui/dialog";
import { Chip, EmptyState, FilterBar, StatCard, type ChipTone } from "@/components/ui/design";
import { AlertTriangle, Ban, CheckCircle2, CircleDashed, FileCheck, Loader2, Magnet, Radio, RefreshCw, RotateCcw, Trash2, X } from "@/components/icons";
import { OpenInArrLink, arrInstanceLabel } from "@/components/admin/open-in-arr";
import { ArrHealthPanel } from "@/components/admin/arr-health-panel";
import { QueueImportDialog } from "@/components/admin/queue-import-dialog";
import { episodeSummary, queueFormatters } from "@/components/admin/queue-format";
import { withBasePath } from "@/lib/base-path";
import { useLocale, useT } from "@/components/i18n/i18n-provider";
import type { QueueItem, QueuePhase, QueueRemoveAction } from "@/lib/arr-queue";

type Service = "radarr" | "sonarr";
type Filter = "all" | "attention" | Service;

interface QueueReport {
  instances: Array<{ service: Service; slug: string; name: string }>;
  errors: Array<{ service: Service; instance: string; error: string }>;
  items: QueueItem[];
}

const POLL_MS = 20_000;
const SERVICE_LABEL: Record<Service, string> = { radarr: "Radarr", sonarr: "Sonarr" };

const PHASE_TONE: Record<QueuePhase, ChipTone> = {
  downloading: "accent",
  queued: "neutral",
  paused: "neutral",
  delay: "neutral",
  importPending: "approved",
  importing: "approved",
  importBlocked: "declined",
  failed: "declined",
  clientUnavailable: "declined",
  unknown: "neutral",
};

const rowKey = (r: QueueItem) => `${r.service}:${r.instance}:${r.ids[0]}`;

// Only a finished download the arr is holding back can be imported: blocked,
// or waiting on an import that needs a hand. A tracked download id is required.
const canImport = (r: QueueItem) => r.downloadId !== null && (r.phase === "importBlocked" || r.phase === "importPending");
async function readError(res: Response, fallback: string): Promise<string> {
  const d = (await res.json().catch(() => null)) as { error?: string } | null;
  return d?.error ?? fallback;
}

const th: React.CSSProperties = { padding: "8px 10px" };
const td: React.CSSProperties = { padding: "8px 10px", verticalAlign: "top" };

export function DownloadQueue({ configured }: { configured: boolean }) {
  const t = useT();
  const locale = useLocale();
  const fmt = useMemo(() => queueFormatters(locale), [locale]);
  const [report, setReport] = useState<QueueReport | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [filter, setFilter] = useState<Filter>("all");
  const [instance, setInstance] = useState("all");
  const [query, setQuery] = useState("");
  const [live, setLive] = useState(true);
  const [removing, setRemoving] = useState<QueueItem | null>(null);
  const [importing, setImporting] = useState<QueueItem | null>(null);
  const [removeAction, setRemoveAction] = useState<QueueRemoveAction>("blocklistSearch");
  const [removeFromClient, setRemoveFromClient] = useState(true);
  const [removeBusy, setRemoveBusy] = useState(false);
  const [removeError, setRemoveError] = useState("");
  const [notice, setNotice] = useState("");
  // Only the newest load may write state — a slow poll must not overwrite the
  // result of a refresh the admin clicked after it started.
  const loadSeq = useRef(0);

  const load = useCallback(async () => {
    const seq = ++loadSeq.current;
    setLoading(true);
    try {
      const res = await fetch(withBasePath("/api/admin/queue"));
      if (seq !== loadSeq.current) return;
      if (!res.ok) {
        const message = await readError(res, t("adminManage.queue.error.load"));
        if (seq === loadSeq.current) setError(message);
        return;
      }
      const data = (await res.json()) as QueueReport;
      if (seq !== loadSeq.current) return;
      setReport(data);
      setError("");
    } catch {
      if (seq === loadSeq.current) setError(t("adminManage.queue.error.loadNetwork"));
    } finally {
      if (seq === loadSeq.current) setLoading(false);
    }
  }, [t]);

  useEffect(() => {
    if (configured) void load();
  }, [configured, load]);

  // Poll while live, visible, and no dialog is open (a refresh would
  // reshuffle the row being confirmed).
  useEffect(() => {
    if (!configured || !live || removing || importing) return;
    const id = window.setInterval(() => {
      if (document.visibilityState === "visible") void load();
    }, POLL_MS);
    return () => window.clearInterval(id);
  }, [configured, live, removing, importing, load]);

  // The dialog opens on the action the admin clicked; they can still change it there.
  function openRemove(row: QueueItem, action: QueueRemoveAction) {
    setRemoving(row);
    setRemoveAction(action);
    setRemoveFromClient(true);
    setRemoveError("");
  }

  function imported(row: QueueItem, files: number) {
    setImporting(null);
    setNotice(t("adminManage.queue.import.done", { title: row.mediaTitle || row.title, count: files }));
    // The arr imports in the background; give it a moment before re-reading.
    window.setTimeout(() => void load(), 3_000);
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
          ids: removing.ids,
          action: removeAction,
          removeFromClient,
        }),
      });
      if (!res.ok) {
        setRemoveError(await readError(res, t("adminManage.queue.remove.failed")));
        return;
      }
      const gone = rowKey(removing);
      setReport((r) => (r ? { ...r, items: r.items.filter((i) => rowKey(i) !== gone) } : r));
      setNotice(
        removeAction === "blocklistSearch"
          ? t("adminManage.queue.remove.doneSearch", { title: removing.mediaTitle || removing.title })
          : t("adminManage.queue.remove.done", { title: removing.mediaTitle || removing.title }),
      );
      setRemoving(null);
    } catch {
      setRemoveError(t("adminManage.queue.remove.failed"));
    } finally {
      setRemoveBusy(false);
    }
  }

  const items = report?.items;
  const instanceName = useCallback(
    (service: Service, slug: string) => report?.instances.find((i) => i.service === service && i.slug === slug)?.name ?? slug,
    [report],
  );
  const multiInstance = (report?.instances.length ?? 0) > 1;
  const visible = useMemo(() => {
    const q = query.trim().toLowerCase();
    return (items ?? []).filter(
      (r) =>
        (filter === "all" || (filter === "attention" ? r.attention : r.service === filter)) &&
        (instance === "all" || `${r.service}:${r.instance}` === instance) &&
        (!q || r.mediaTitle.toLowerCase().includes(q) || r.title.toLowerCase().includes(q)),
    );
  }, [items, filter, instance, query]);

  const count = (f: Filter) =>
    items ? items.filter((r) => (f === "all" ? true : f === "attention" ? r.attention : r.service === f)).length : undefined;
  const services = new Set((report?.instances ?? []).map((i) => i.service));

  let body: React.ReactNode;
  if (!configured) {
    body = (
      <EmptyState icon={CircleDashed} title={t("adminManage.queue.notConfigured.title")} description={t("adminManage.queue.notConfigured.description")} />
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
          <p role="status" className="rounded-md bg-amber-500/15 text-amber-400" style={{ padding: "8px 12px", fontSize: 13, margin: 0 }}>
            {t("adminManage.queue.arrErrors", {
              list: report.errors.map((e) => arrInstanceLabel(e.service, instanceName(e.service, e.instance), e.instance)).join(", "),
            })}
          </p>
        )}
        {notice && (
          <p role="status" className="flex items-center gap-1.5 text-green-400" style={{ fontSize: 13, margin: 0 }}>
            <CheckCircle2 style={{ width: 14, height: 14 }} aria-hidden /> {notice}
          </p>
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
        </div>

        {visible.length === 0 ? (
          report.items.length > 0 ? (
            <EmptyState icon={CircleDashed} title={t("adminManage.queue.empty.filteredTitle")} description={t("adminManage.queue.empty.filteredDescription")} />
          ) : (
            <EmptyState icon={CheckCircle2} title={t("adminManage.queue.empty.title")} description={t("adminManage.queue.empty.description")} />
          )
        ) : (
          <div className="resp-table-scroll" style={{ border: "1px solid var(--ds-border)", borderRadius: 10 }}>
            <table className="w-full" style={{ fontSize: 13, borderCollapse: "collapse", color: "var(--ds-fg)" }}>
              <thead>
                <tr style={{ background: "var(--ds-bg-2)", textAlign: "left", color: "var(--ds-fg-subtle)", fontSize: 11 }}>
                  <th style={th}>{t("adminManage.queue.col.title")}</th>
                  {multiInstance && <th style={th}>{t("adminManage.queue.col.instance")}</th>}
                  <th style={th}>{t("adminManage.queue.col.status")}</th>
                  <th style={{ ...th, minWidth: 150 }}>{t("adminManage.queue.col.progress")}</th>
                  <th style={th}>{t("adminManage.queue.col.timeLeft")}</th>
                  <th style={th}>{t("adminManage.queue.col.source")}</th>
                  <th style={th}>{t("adminManage.queue.col.requestedBy")}</th>
                  <th style={th} />
                </tr>
              </thead>
              <tbody>
                {visible.map((r) => {
                  const detailHref = r.tmdbId !== null ? `/${r.service === "radarr" ? "movie" : "tv"}/${r.tmdbId}` : null;
                  const name = instanceName(r.service, r.instance);
                  const arrLabel = arrInstanceLabel(r.service, name, r.instance);
                  return (
                    <tr key={rowKey(r)} className="hover:bg-zinc-800/20 transition-colors" style={{ borderTop: "1px solid var(--ds-border)" }}>
                      <td style={{ ...td, maxWidth: 380 }}>
                        <div className="flex items-center gap-1" style={{ fontWeight: 500 }}>
                          <span className="min-w-0" style={{ overflowWrap: "anywhere" }}>
                            {detailHref ? <Link href={detailHref} className="hover:underline">{r.mediaTitle || r.title}</Link> : r.mediaTitle || r.title}
                            {r.year ? <span style={{ color: "var(--ds-fg-subtle)", fontWeight: 400 }}> ({r.year})</span> : null}
                          </span>
                          {r.arrMediaId !== null && (
                            <OpenInArrLink
                              service={r.service}
                              instance={r.instance}
                              target={{ arrId: r.arrMediaId }}
                              label={t("adminManage.openIn", { name: arrLabel })}
                              iconOnly
                            />
                          )}
                        </div>
                        {r.episodes.length > 0 && (
                          <div className="ds-mono" style={{ fontSize: 11, color: "var(--ds-fg-muted)" }}>{episodeSummary(r.episodes)}</div>
                        )}
                        <div className="ds-mono" style={{ fontSize: 11, color: "var(--ds-fg-subtle)", overflowWrap: "anywhere" }} title={r.title}>
                          {r.title}
                        </div>
                      </td>
                      {multiInstance && <td style={{ ...td, fontSize: 12, color: "var(--ds-fg-muted)" }}>{arrLabel}</td>}
                      <td style={{ ...td, maxWidth: 280 }}>
                        <div className="flex flex-wrap items-center gap-1">
                          <Chip tone={PHASE_TONE[r.phase]}>{t(`adminManage.queue.phase.${r.phase}`)}</Chip>
                          {r.attention && (
                            <Chip tone="pending">
                              <AlertTriangle style={{ width: 11, height: 11 }} aria-hidden /> {t("adminManage.queue.attention")}
                            </Chip>
                          )}
                        </div>
                        {r.messages.length > 0 && (
                          <ul className="m-0 p-0" style={{ listStyle: "none", marginTop: 4, fontSize: 11, color: r.attention ? "var(--ds-warning)" : "var(--ds-fg-subtle)" }}>
                            {r.messages.map((m, i) => <li key={i} style={{ overflowWrap: "anywhere" }}>{m}</li>)}
                          </ul>
                        )}
                      </td>
                      <td style={td}>
                        <div
                          role="progressbar"
                          aria-valuemin={0}
                          aria-valuemax={100}
                          aria-valuenow={Math.round(r.progress * 100)}
                          aria-label={t("adminManage.queue.progressLabel", { title: r.mediaTitle || r.title })}
                          style={{ height: 6, borderRadius: 3, background: "var(--ds-bg-3)", overflow: "hidden" }}
                        >
                          <div style={{ width: `${Math.round(r.progress * 100)}%`, height: "100%", background: r.attention ? "var(--ds-warning)" : "var(--ds-accent)" }} />
                        </div>
                        <div className="ds-mono" style={{ fontSize: 11, color: "var(--ds-fg-muted)", marginTop: 3 }}>
                          {fmt.percent(r.progress)} · {fmt.size(r.size - r.sizeLeft)} / {fmt.size(r.size)}
                        </div>
                      </td>
                      <td className="ds-mono" style={{ ...td, fontSize: 12 }}>{r.phase === "downloading" ? fmt.duration(r.timeLeftSeconds) : "—"}</td>
                      <td style={{ ...td, fontSize: 12 }}>
                        <div className="flex items-center gap-1" style={{ color: "var(--ds-fg-muted)" }}>
                          {r.protocol === "torrent" ? (
                            <Magnet style={{ width: 12, height: 12 }} aria-label={t("adminManage.queue.protocol.torrent")} />
                          ) : r.protocol === "usenet" ? (
                            <Radio style={{ width: 12, height: 12 }} aria-label={t("adminManage.queue.protocol.usenet")} />
                          ) : null}
                          {r.downloadClient ?? "—"}
                        </div>
                        {r.indexer && <div style={{ fontSize: 11, color: "var(--ds-fg-subtle)" }}>{r.indexer}</div>}
                        {r.quality && <div className="ds-mono" style={{ fontSize: 11, color: "var(--ds-fg-subtle)" }}>{r.quality}</div>}
                      </td>
                      <td style={{ ...td, fontSize: 12, color: "var(--ds-fg-muted)" }}>
                        {r.requesters.length > 0 ? r.requesters.join(", ") : "—"}
                      </td>
                      <td style={{ ...td, textAlign: "right" }}>
                        <div className="flex flex-wrap justify-end gap-1" style={{ minWidth: 150, maxWidth: 240, marginLeft: "auto" }}>
                          {canImport(r) && (
                            <Button
                              size="xs"
                              variant="outline"
                              onClick={() => setImporting(r)}
                              aria-label={t("adminManage.queue.action.importAria", { title: r.mediaTitle || r.title })}
                            >
                              <FileCheck />
                              {t("adminManage.queue.action.import")}
                            </Button>
                          )}
                          <Button
                            size="xs"
                            variant="outline"
                            onClick={() => openRemove(r, "blocklistSearch")}
                            aria-label={t("adminManage.queue.action.blocklistSearchAria", { title: r.mediaTitle || r.title })}
                          >
                            <RotateCcw />
                            {t("adminManage.queue.action.blocklistSearch")}
                          </Button>
                          <Button
                            size="xs"
                            variant="outline"
                            onClick={() => openRemove(r, "blocklist")}
                            aria-label={t("adminManage.queue.action.blocklistAria", { title: r.mediaTitle || r.title })}
                          >
                            <Ban />
                            {t("adminManage.queue.action.blocklist")}
                          </Button>
                          <Button
                            size="xs"
                            variant="ghost"
                            onClick={() => openRemove(r, "remove")}
                            aria-label={t("adminManage.queue.remove.aria", { title: r.mediaTitle || r.title })}
                          >
                            <Trash2 />
                            {t("adminManage.queue.remove.button")}
                          </Button>
                        </div>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
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

  const REMOVE_OPTIONS: Array<{ value: QueueRemoveAction; label: string; help: string }> = [
    { value: "blocklistSearch", label: t("adminManage.queue.remove.blocklistSearch"), help: t("adminManage.queue.remove.blocklistSearchHelp") },
    { value: "blocklist", label: t("adminManage.queue.remove.blocklist"), help: t("adminManage.queue.remove.blocklistHelp") },
    { value: "remove", label: t("adminManage.queue.remove.remove"), help: t("adminManage.queue.remove.removeHelp") },
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
              <Button size="sm" variant="outline" onClick={() => void load()} disabled={loading}>
                {loading ? <Loader2 className="animate-spin" /> : <RefreshCw />}
                {t("adminManage.queue.refresh")}
              </Button>
            ) : null
          }
        />
        {report && error && <p role="alert" style={{ fontSize: 13, color: "var(--ds-danger)", margin: 0 }}>{error}</p>}
        {body}
      </div>

      <Dialog open={removing !== null} onOpenChange={(o) => { if (!o && !removeBusy) setRemoving(null); }}>
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
                  <legend className="sr-only">{t("adminManage.queue.remove.title")}</legend>
                  {REMOVE_OPTIONS.map((o) => (
                    <label
                      key={o.value}
                      className="flex items-start gap-2.5 rounded-md"
                      style={{
                        padding: "8px 10px",
                        border: `1px solid ${removeAction === o.value ? "var(--ds-border-strong)" : "var(--ds-border)"}`,
                        background: removeAction === o.value ? "var(--ds-bg-2)" : "transparent",
                      }}
                    >
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
                <label className="flex items-center gap-2 text-sm text-zinc-100">
                  <Switch checked={removeFromClient} onCheckedChange={setRemoveFromClient} aria-label={t("adminManage.queue.remove.fromClient")} />
                  {t("adminManage.queue.remove.fromClient")}
                </label>
                {!removeFromClient && removeAction === "remove" && (
                  <p className="m-0 text-xs text-zinc-500">{t("adminManage.queue.remove.ignoreHelp")}</p>
                )}
                {removeError && (
                  <p role="alert" className="m-0 text-xs flex items-center gap-1" style={{ color: "var(--ds-danger)" }}>
                    <AlertTriangle style={{ width: 12, height: 12 }} aria-hidden /> {removeError}
                  </p>
                )}
              </div>
            )}
            <div className="flex items-center justify-between px-6 py-4 border-t border-zinc-700 bg-zinc-900">
              <button type="button" onClick={() => setRemoving(null)} disabled={removeBusy} className="rounded px-2 py-1 text-sm text-zinc-500 hover:text-zinc-300">
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

      <QueueImportDialog row={importing} onClose={() => setImporting(null)} onImported={imported} />
    </div>
  );
}
