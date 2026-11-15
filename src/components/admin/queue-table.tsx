"use client";

// Admin → Download Queue's table (download-queue.tsx): one row per download,
// the optional columns the admin picks (remembered in this browser), chiplets
// for the hidden ones, the row actions, and an expandable details panel that
// always shows everything the arr reports. The page owns the data, the filters
// and the dialogs; a row's actions call back into it.
//
// Every time and size is server-supplied and formatted for the viewer's
// locale; nothing reads the clock while rendering (guardrail 16).

import { useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
import { Button } from "@/components/ui/button";
import { Chip, type ChipTone } from "@/components/ui/design";
import {
  AlertTriangle, Ban, ChevronDown, ChevronRight, Download, FileCheck, Loader2, Magnet, Radio, RotateCcw, Trash2, Wrench,
} from "@/components/icons";
import { OpenInArrLink, arrInstanceLabel } from "@/components/admin/open-in-arr";
import { episodeCode, episodeSummary, queueFormatters, seasonPackSeasons } from "@/components/admin/queue-format";
import { useT } from "@/components/i18n/i18n-provider";
import type { QualityTag, QueueItem, QueuePhase, QueueRemoveAction } from "@/lib/arr-queue";
import type { QueueTitleFilter } from "@/lib/arr-manage-links";
import type { Service } from "@/components/admin/use-queue-data";

type QueueFormatters = ReturnType<typeof queueFormatters>;

// The table's optional columns, in the arr's own order. Title and the row
// actions are always shown; everything is also in each row's details panel.
export type ColumnId =
  | "instance" | "status" | "quality" | "languages" | "customFormats" | "size" | "progress"
  | "timeLeft" | "eta" | "added" | "downloadClient" | "indexer" | "requestedBy";
export type QueueColumn = { id: ColumnId; label: string };
export const COLUMNS: ReadonlyArray<QueueColumn> = [
  { id: "instance", label: "adminManage.queue.col.instance" },
  { id: "status", label: "adminManage.queue.col.status" },
  { id: "quality", label: "adminManage.queue.col.quality" },
  { id: "languages", label: "adminManage.queue.col.languages" },
  { id: "customFormats", label: "adminManage.queue.col.customFormats" },
  { id: "size", label: "adminManage.queue.col.size" },
  { id: "progress", label: "adminManage.queue.col.progress" },
  { id: "timeLeft", label: "adminManage.queue.col.timeLeft" },
  { id: "eta", label: "adminManage.queue.col.eta" },
  { id: "added", label: "adminManage.queue.col.added" },
  { id: "downloadClient", label: "adminManage.queue.col.downloadClient" },
  { id: "indexer", label: "adminManage.queue.col.indexer" },
  { id: "requestedBy", label: "adminManage.queue.col.requestedBy" },
];
export const DEFAULT_HIDDEN: ReadonlySet<ColumnId> = new Set<ColumnId>(["instance", "quality", "languages", "customFormats", "eta", "added", "size", "downloadClient", "indexer"]);
const COLUMN_IDS = new Set<string>(COLUMNS.map((c) => c.id));
const isColumnId = (v: unknown): v is ColumnId => typeof v === "string" && COLUMN_IDS.has(v);
// Per-viewer convenience only: a blocked or empty store just means the defaults.
const HIDDEN_COLUMNS_KEY = "admin-queue-hidden-columns";

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

const QUALITY_TAG_LABEL: Record<QualityTag, string> = {
  proper: "adminManage.queue.qualityTag.proper",
  repack: "adminManage.queue.qualityTag.repack",
  real: "adminManage.queue.qualityTag.real",
};
const PROTOCOL_LABEL: Record<QueueItem["protocol"], string> = {
  torrent: "adminManage.queue.protocol.torrent",
  usenet: "adminManage.queue.protocol.usenet",
  unknown: "adminManage.queue.protocol.unknown",
};

export const rowKey = (r: QueueItem) => `${r.service}:${r.instance}:${r.ids[0]}`;

// Only a finished download the arr is holding back can be imported: blocked,
// or waiting on an import that needs a hand. A tracked download id is required.
const canImport = (r: QueueItem) => r.downloadId !== null && (r.phase === "importBlocked" || r.phase === "importPending");

const th: React.CSSProperties = { padding: "8px 10px" };
const td: React.CSSProperties = { padding: "8px 10px", verticalAlign: "top" };

// The optional columns this viewer hid, remembered in this browser. Read after
// mount so the first render matches the server's (defaults); storage can throw
// (blocked site data, some private windows) — then the defaults simply stay.
export function useHiddenColumns() {
  const [hidden, setHidden] = useState<ReadonlySet<ColumnId>>(DEFAULT_HIDDEN);
  useEffect(() => {
    try {
      const raw = localStorage.getItem(HIDDEN_COLUMNS_KEY);
      const ids: unknown = raw ? JSON.parse(raw) : null;
      if (Array.isArray(ids)) setHidden(new Set(ids.filter(isColumnId)));
    } catch {}
  }, []);
  function saveHidden(next: ReadonlySet<ColumnId>) {
    setHidden(next);
    persistHidden(next);
  }
  // From the latest set, never the one this render closed over: two toggles
  // before a re-render both land.
  function toggleColumn(id: ColumnId, on: boolean) {
    setHidden((prev) => {
      const next = new Set(prev);
      if (on) next.delete(id);
      else next.add(id);
      persistHidden(next);
      return next;
    });
  }
  return { hidden, saveHidden, toggleColumn };
}

// Idempotent, so it is safe inside a state updater (which may run twice).
function persistHidden(next: ReadonlySet<ColumnId>) {
  try {
    localStorage.setItem(HIDDEN_COLUMNS_KEY, JSON.stringify([...next]));
  } catch {}
}

// Which rows' details are open, and the table frame's visible width. Called by
// the page rather than the table, so both outlive the table while a filter
// leaves nothing to show.
//
// `liveKeys` is every row the queue holds right now (undefined while there is no
// answer yet): an open row that left the queue is forgotten, so a later download
// that reuses its key does not appear already open.
export function useQueueTableView(liveKeys?: readonly string[]) {
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(() => new Set());
  const liveSig = liveKeys ? liveKeys.join("\n") : null;
  useEffect(() => {
    if (liveSig === null) return;
    const live = new Set(liveSig === "" ? [] : liveSig.split("\n"));
    setExpanded((prev) => {
      const kept = [...prev].filter((k) => live.has(k));
      return kept.length === prev.size ? prev : new Set(kept);
    });
  }, [liveSig]);
  // The table scrolls sideways inside its frame; an expanded row's details are
  // sized to the frame's VISIBLE width and stick to its left edge, so a phone
  // (or a table with every column on) never cuts them off.
  const [frameWidth, setFrameWidth] = useState<number | null>(null);
  const frameObserver = useRef<ResizeObserver | null>(null);
  const frameRef = useCallback((el: HTMLDivElement | null) => {
    frameObserver.current?.disconnect();
    frameObserver.current = null;
    if (!el || typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(() => setFrameWidth(el.clientWidth));
    ro.observe(el);
    frameObserver.current = ro;
  }, []);
  function toggleExpanded(key: string) {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  }
  return { expanded, toggleExpanded, frameWidth, frameRef };
}

function ProtocolIcon({ row: r }: { row: QueueItem }) {
  const t = useT();
  return r.protocol === "torrent" ? (
    <Magnet style={{ width: 12, height: 12, flexShrink: 0 }} aria-label={t("adminManage.queue.protocol.torrent")} />
  ) : r.protocol === "usenet" ? (
    <Radio style={{ width: 12, height: 12, flexShrink: 0 }} aria-label={t("adminManage.queue.protocol.usenet")} />
  ) : null;
}

function Quality({ row: r }: { row: QueueItem }) {
  const t = useT();
  return (
    <span className="inline-flex flex-wrap items-center gap-1">
      <span className="ds-mono" style={{ whiteSpace: "nowrap" }}>{r.quality ?? "—"}</span>
      {r.qualityTags.map((q) => <Chip key={q}>{t(QUALITY_TAG_LABEL[q])}</Chip>)}
    </span>
  );
}

// No custom format matched means a score of 0 — nothing worth a cell; the details panel still shows it.
function CustomFormats({ row: r, fmt }: { row: QueueItem; fmt: QueueFormatters }) {
  return r.customFormats.length === 0 ? (
    "—"
  ) : (
    <span className="inline-flex flex-wrap items-center gap-1" style={{ minWidth: 140 }}>
      {r.customFormats.map((f) => <Chip key={f}>{f}</Chip>)}
      {r.customFormatScore !== null && (
        <span className="ds-mono" style={{ color: "var(--ds-fg-muted)" }}>{fmt.score(r.customFormatScore)}</span>
      )}
    </span>
  );
}

const timeLeftOf = (r: QueueItem, fmt: QueueFormatters) => (r.phase === "downloading" ? fmt.duration(r.timeLeftSeconds) : "—");
const etaOf = (r: QueueItem, fmt: QueueFormatters) => (r.phase === "downloading" ? fmt.dateTime(r.estimatedCompletion) : "—");

function QueueCell({ column, row: r, arrLabel, fmt }: { column: ColumnId; row: QueueItem; arrLabel: string; fmt: QueueFormatters }) {
  const t = useT();
  const small: React.CSSProperties = { ...td, fontSize: 12 };
  switch (column) {
    case "instance":
      return <td style={{ ...small, color: "var(--ds-fg-muted)" }}>{arrLabel}</td>;
    case "status":
      return (
        <td style={{ ...td, maxWidth: 220 }}>
          <div className="flex flex-wrap items-center gap-1" style={{ minWidth: 110 }}>
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
      );
    case "quality":
      return <td style={small}><Quality row={r} /></td>;
    case "languages":
      return <td style={{ ...small, color: "var(--ds-fg-muted)" }}>{r.languages.length > 0 ? r.languages.join(", ") : "—"}</td>;
    case "customFormats":
      return <td style={{ ...small, maxWidth: 260 }}><CustomFormats row={r} fmt={fmt} /></td>;
    case "size":
      return (
        <td className="ds-mono" style={{ ...small, whiteSpace: "nowrap" }}>
          {r.size > 0 ? fmt.size(r.size) : "—"}
          {r.sizeLeft > 0 && (
            <div style={{ fontSize: 11, color: "var(--ds-fg-subtle)" }}>{t("adminManage.queue.sizeLeft", { size: fmt.size(r.sizeLeft) })}</div>
          )}
        </td>
      );
    case "progress":
      return (
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
          <div className="ds-mono" style={{ fontSize: 11, color: "var(--ds-fg-muted)", marginTop: 3, whiteSpace: "nowrap" }}>
            {fmt.percent(r.progress)} · {fmt.size(r.size - r.sizeLeft)} / {fmt.size(r.size)}
          </div>
        </td>
      );
    case "timeLeft":
      return <td className="ds-mono" style={{ ...small, whiteSpace: "nowrap" }}>{timeLeftOf(r, fmt)}</td>;
    case "eta":
      return <td style={{ ...small, color: "var(--ds-fg-muted)", whiteSpace: "nowrap" }}>{etaOf(r, fmt)}</td>;
    case "added":
      return <td style={{ ...small, color: "var(--ds-fg-muted)", whiteSpace: "nowrap" }}>{fmt.dateTime(r.added)}</td>;
    case "downloadClient":
      return (
        <td style={small}>
          <span className="inline-flex items-center gap-1">
            <ProtocolIcon row={r} />
            {r.downloadClient ?? "—"}
          </span>
        </td>
      );
    case "indexer":
      return <td style={{ ...small, color: "var(--ds-fg-muted)" }}>{r.indexer ?? "—"}</td>;
    case "requestedBy":
      return <td style={{ ...small, color: "var(--ds-fg-muted)" }}>{r.requesters.length > 0 ? r.requesters.join(", ") : "—"}</td>;
  }
}

// Everything Radarr/Sonarr report for the download, whatever columns are shown.
function QueueDetails({ row: r, arrLabel, fmt }: { row: QueueItem; arrLabel: string; fmt: QueueFormatters }) {
  const t = useT();
  const item = (label: string, value: React.ReactNode, opts: { wide?: boolean; mono?: boolean } = {}) => (
    <div key={label} style={opts.wide ? { gridColumn: "1 / -1" } : undefined}>
      <dt style={{ fontSize: 11, color: "var(--ds-fg-subtle)" }}>{label}</dt>
      <dd className={opts.mono ? "ds-mono" : undefined} style={{ margin: 0, overflowWrap: "anywhere" }}>{value}</dd>
    </div>
  );
  // Capped so it stays in view while a wide table is scrolled to its left edge.
  return (
    <dl className="grid gap-x-6 gap-y-2" style={{ gridTemplateColumns: "repeat(auto-fill, minmax(190px, 1fr))", fontSize: 12, margin: 0, maxWidth: 1100 }}>
      {item(t("adminManage.queue.details.release"), r.title || "—", { wide: true, mono: true })}
      {r.episodes.length > 0 && item(t("adminManage.queue.details.episodes"), r.episodes.map(episodeCode).join(", "), { wide: true, mono: true })}
      {item(t("adminManage.queue.col.status"), t(`adminManage.queue.phase.${r.phase}`))}
      {item(t("adminManage.queue.col.quality"), <Quality row={r} />)}
      {item(t("adminManage.queue.col.languages"), r.languages.length > 0 ? r.languages.join(", ") : "—")}
      {item(t("adminManage.queue.col.customFormats"), r.customFormats.length > 0 ? r.customFormats.join(", ") : "—")}
      {item(t("adminManage.queue.details.score"), r.customFormatScore !== null ? fmt.score(r.customFormatScore) : "—", { mono: true })}
      {item(t("adminManage.queue.col.size"), r.size > 0 ? fmt.size(r.size) : "—", { mono: true })}
      {item(t("adminManage.queue.details.downloaded"), `${fmt.size(r.size - r.sizeLeft)} (${fmt.percent(r.progress)})`, { mono: true })}
      {item(t("adminManage.queue.details.left"), fmt.size(r.sizeLeft), { mono: true })}
      {item(t("adminManage.queue.col.timeLeft"), timeLeftOf(r, fmt), { mono: true })}
      {item(t("adminManage.queue.col.eta"), etaOf(r, fmt))}
      {item(t("adminManage.queue.col.added"), fmt.dateTime(r.added))}
      {item(t("adminManage.queue.details.protocol"), t(PROTOCOL_LABEL[r.protocol]))}
      {item(t("adminManage.queue.col.downloadClient"), r.downloadClient ?? "—")}
      {item(t("adminManage.queue.col.indexer"), r.indexer ?? "—")}
      {item(t("adminManage.queue.col.instance"), arrLabel)}
      {item(t("adminManage.queue.col.requestedBy"), r.requesters.length > 0 ? r.requesters.join(", ") : "—")}
      {item(t("adminManage.queue.details.downloadId"), r.downloadId ?? "—", { mono: true })}
      {item(t("adminManage.queue.details.outputPath"), r.outputPath ?? "—", { wide: true, mono: true })}
      {r.messages.length > 0 && item(t("adminManage.queue.details.messages"), (
        <ul className="m-0 p-0" style={{ listStyle: "none" }}>
          {r.messages.map((m, i) => <li key={i}>{m}</li>)}
        </ul>
      ), { wide: true })}
    </dl>
  );
}

/** What a row's actions ask of the page, which owns the dialogs and the requests. */
export interface QueueRowActions {
  /** Open the title manager on the row's title. */
  onManage: (target: QueueTitleFilter & { label: string }) => void;
  onImport: (row: QueueItem) => void;
  onGrab: (row: QueueItem) => void;
  /** Open the Remove dialog on the action clicked. */
  onRemove: (row: QueueItem, action: QueueRemoveAction) => void;
}

// The line under a Sonarr row's title: the seasons of a season pack, else the
// episodes, and how many episodes a multi-episode download holds.
function EpisodeLine({ row: r }: { row: QueueItem }) {
  const t = useT();
  const seasons = seasonPackSeasons(r.title, r.episodes);
  return (
    <div className="ds-mono" style={{ fontSize: 11, color: "var(--ds-fg-muted)" }}>
      {seasons
        ? `${seasons.map((n) => t("adminManage.queue.seasonNumber", { n })).join(", ")} · ${t("adminManage.queue.import.releaseTypes.seasonPack")}`
        : episodeSummary(r.episodes)}
      {r.episodes.length > 1 && <span> · {t("adminManage.queue.episodeCount", { count: r.episodes.length })}</span>}
    </div>
  );
}

// Chiplets stand in for every detail column the viewer has hidden, so the table stays narrow.
function HiddenColumnChips({ row: r, hidden, multiInstance, arrLabel, fmt }: {
  row: QueueItem;
  hidden: ReadonlySet<ColumnId>;
  multiInstance: boolean;
  arrLabel: string;
  fmt: QueueFormatters;
}) {
  const t = useT();
  return (
    <div className="flex flex-wrap items-center gap-1" style={{ marginTop: 3 }}>
      {multiInstance && hidden.has("instance") && <Chip>{arrLabel}</Chip>}
      {hidden.has("quality") && r.quality && <Chip>{r.quality}</Chip>}
      {hidden.has("quality") && r.qualityTags.map((q) => <Chip key={q}>{t(QUALITY_TAG_LABEL[q])}</Chip>)}
      {hidden.has("size") && r.size > 0 && <Chip>{fmt.size(r.size)}</Chip>}
      {hidden.has("downloadClient") && r.downloadClient && (
        <Chip><ProtocolIcon row={r} /> {r.downloadClient}</Chip>
      )}
      {hidden.has("indexer") && r.indexer && <Chip>{r.indexer}</Chip>}
      {hidden.has("languages") && r.languages.length > 0 && <Chip>{r.languages.join(", ")}</Chip>}
    </div>
  );
}

// The always-shown first cell: the details toggle, the title and its links,
// the episode line, the chiplets, and the release name when it differs.
function QueueTitleCell({ row: r, arrLabel, hidden, multiInstance, fmt, open, onToggle }: {
  row: QueueItem;
  arrLabel: string;
  hidden: ReadonlySet<ColumnId>;
  multiInstance: boolean;
  fmt: QueueFormatters;
  open: boolean;
  onToggle: (key: string) => void;
}) {
  const t = useT();
  const detailHref = r.tmdbId !== null ? `/${r.service === "radarr" ? "movie" : "tv"}/${r.tmdbId}` : null;
  const key = rowKey(r);
  const title = r.mediaTitle || r.title;
  return (
    <td style={{ ...td, maxWidth: 380 }}>
      <div className="flex items-start gap-1.5" style={{ minWidth: 220 }}>
        <button
          type="button"
          onClick={() => onToggle(key)}
          aria-expanded={open}
          aria-controls={`queue-details-${key}`}
          aria-label={t(open ? "adminManage.queue.details.hide" : "adminManage.queue.details.show", { title })}
          className="ds-hover-tint inline-flex shrink-0 items-center justify-center rounded-md text-zinc-400 hover:text-zinc-100 outline-none focus-visible:ring-2 focus-visible:ring-[var(--ds-accent-ring)]"
          style={{ width: 22, height: 22, marginTop: -1 }}
        >
          {open ? <ChevronDown style={{ width: 14, height: 14 }} aria-hidden /> : <ChevronRight style={{ width: 14, height: 14 }} aria-hidden />}
        </button>
        <div className="min-w-0">
          <div className="flex items-center gap-1" style={{ fontWeight: 500 }}>
            <span className="min-w-0" style={{ overflowWrap: "anywhere" }}>
              {detailHref ? <Link href={detailHref} className="hover:underline">{title}</Link> : title}
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
          {r.episodes.length > 0 && <EpisodeLine row={r} />}
          <HiddenColumnChips row={r} hidden={hidden} multiInstance={multiInstance} arrLabel={arrLabel} fmt={fmt} />
          {r.title !== title && (
            <div className="ds-mono" style={{ fontSize: 11, color: "var(--ds-fg-subtle)", overflowWrap: "anywhere" }} title={r.title}>
              {r.title}
            </div>
          )}
        </div>
      </div>
    </td>
  );
}

// The row's actions: manage, import, grab, and the three removals.
function QueueRowButtons({ row: r, arrLabel, acting, actions }: {
  row: QueueItem;
  arrLabel: string;
  acting: ReadonlySet<string>;
  actions: QueueRowActions;
}) {
  const t = useT();
  const key = rowKey(r);
  const title = r.mediaTitle || r.title;
  const arrId = r.arrMediaId;
  return (
    <td style={{ ...td, textAlign: "right" }}>
      <div className="flex flex-wrap justify-end gap-1" style={{ maxWidth: 170, marginLeft: "auto" }}>
        {/* Unknown/unmatched downloads name no title on the instance — nothing to manage. */}
        {arrId !== null && (
          <Button
            size="icon-xs"
            variant="ghost"
            onClick={() => actions.onManage({ service: r.service, instance: r.instance, arrId, label: arrLabel })}
            title={t("adminArr.manage.button", { name: arrLabel })}
            aria-label={t("adminManage.queue.action.manageAria", { title, name: arrLabel })}
          >
            <Wrench />
          </Button>
        )}
        {canImport(r) && (
          <Button
            size="xs"
            variant="outline"
            onClick={() => actions.onImport(r)}
            aria-label={t("adminManage.queue.action.importAria", { title })}
          >
            <FileCheck />
            {t("adminManage.queue.action.import")}
          </Button>
        )}
        {r.pending && (
          <Button
            size="xs"
            variant="outline"
            onClick={() => actions.onGrab(r)}
            disabled={acting.has(key)}
            aria-label={t("adminManage.queue.action.grabAria", { title })}
          >
            {acting.has(key) ? <Loader2 className="animate-spin" /> : <Download />}
            {t("adminManage.queue.action.grab")}
          </Button>
        )}
        {/* A held release was never downloaded — there is nothing to search a replacement FOR yet. */}
        {!r.pending && (
          <Button
            size="icon-xs"
            variant="outline"
            title={t("adminManage.queue.action.blocklistSearch")}
            onClick={() => actions.onRemove(r, "blocklistSearch")}
            aria-label={t("adminManage.queue.action.blocklistSearchAria", { title })}
          >
            <RotateCcw />
          </Button>
        )}
        <Button
          size="icon-xs"
          variant="outline"
          title={t("adminManage.queue.action.blocklist")}
          onClick={() => actions.onRemove(r, "blocklist")}
          aria-label={t("adminManage.queue.action.blocklistAria", { title })}
        >
          <Ban />
        </Button>
        <Button
          size="icon-xs"
          variant="ghost"
          title={t("adminManage.queue.remove.button")}
          onClick={() => actions.onRemove(r, "remove")}
          aria-label={t("adminManage.queue.remove.aria", { title })}
        >
          <Trash2 />
        </Button>
      </div>
    </td>
  );
}

function QueueRow({
  row: r,
  arrLabel,
  columns,
  hidden,
  multiInstance,
  fmt,
  acting,
  open,
  onToggle,
  frameWidth,
  actions,
}: {
  row: QueueItem;
  arrLabel: string;
  columns: ReadonlyArray<QueueColumn>;
  hidden: ReadonlySet<ColumnId>;
  multiInstance: boolean;
  fmt: QueueFormatters;
  acting: ReadonlySet<string>;
  open: boolean;
  onToggle: (key: string) => void;
  frameWidth: number | null;
  actions: QueueRowActions;
}) {
  const key = rowKey(r);
  return (
    <>
      <tr className="hover:bg-zinc-800/20 transition-colors" style={{ borderTop: "1px solid var(--ds-border)" }}>
        <QueueTitleCell row={r} arrLabel={arrLabel} hidden={hidden} multiInstance={multiInstance} fmt={fmt} open={open} onToggle={onToggle} />
        {columns.map((c) => <QueueCell key={c.id} column={c.id} row={r} arrLabel={arrLabel} fmt={fmt} />)}
        <QueueRowButtons row={r} arrLabel={arrLabel} acting={acting} actions={actions} />
      </tr>
      {open && (
        <tr id={`queue-details-${key}`} style={{ background: "var(--ds-bg-1)" }}>
          <td colSpan={columns.length + 2} style={{ padding: 0 }}>
            <div
              style={{
                position: "sticky",
                left: 0,
                boxSizing: "border-box",
                width: frameWidth ?? undefined,
                padding: `6px 10px 14px ${frameWidth !== null && frameWidth < 640 ? 10 : 40}px`,
              }}
            >
              <QueueDetails row={r} arrLabel={arrLabel} fmt={fmt} />
            </div>
          </td>
        </tr>
      )}
    </>
  );
}

export function QueueTable({
  rows,
  columns,
  hidden,
  multiInstance,
  instanceName,
  fmt,
  acting,
  expanded,
  onToggleExpanded,
  frameWidth,
  frameRef,
  actions,
}: {
  /** The rows the filters leave, never empty (the page shows an empty state instead). */
  rows: ReadonlyArray<QueueItem>;
  /** The optional columns shown. */
  columns: ReadonlyArray<QueueColumn>;
  hidden: ReadonlySet<ColumnId>;
  multiInstance: boolean;
  instanceName: (service: Service, slug: string) => string;
  fmt: QueueFormatters;
  /** The page's actions in flight: a row's Grab now under its rowKey. */
  acting: ReadonlySet<string>;
  /** The rows whose details are open, by rowKey (useQueueTableView). */
  expanded: ReadonlySet<string>;
  onToggleExpanded: (key: string) => void;
  frameWidth: number | null;
  frameRef: (el: HTMLDivElement | null) => void;
  actions: QueueRowActions;
}) {
  const t = useT();
  return (
    <div ref={frameRef} className="resp-table-scroll" style={{ border: "1px solid var(--ds-border)", borderRadius: 10 }}>
      <table className="w-full" style={{ fontSize: 13, borderCollapse: "collapse", color: "var(--ds-fg)" }}>
        <thead>
          <tr style={{ background: "var(--ds-bg-2)", textAlign: "left", color: "var(--ds-fg-subtle)", fontSize: 11 }}>
            <th style={th}>{t("adminManage.queue.col.title")}</th>
            {columns.map((c) => (
              <th key={c.id} style={{ ...th, whiteSpace: "nowrap", ...(c.id === "progress" ? { minWidth: 130 } : {}) }}>{t(c.label)}</th>
            ))}
            <th style={th} />
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => {
            const name = instanceName(r.service, r.instance);
            const key = rowKey(r);
            return (
              <QueueRow
                key={key}
                row={r}
                arrLabel={arrInstanceLabel(r.service, name, r.instance)}
                columns={columns}
                hidden={hidden}
                multiInstance={multiInstance}
                fmt={fmt}
                acting={acting}
                open={expanded.has(key)}
                onToggle={onToggleExpanded}
                frameWidth={frameWidth}
                actions={actions}
              />
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
