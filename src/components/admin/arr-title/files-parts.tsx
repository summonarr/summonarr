"use client";

// The Files tab's pieces (files-tab.tsx holds the state and the actions): one
// file's row with its media info, the delete confirm, and the rename preview.

import { Button } from "@/components/ui/button";
import { Chip } from "@/components/ui/design";
import { AlertTriangle, ArrowDown, ChevronDown, ChevronRight, Loader2 } from "@/components/icons";
import { useT } from "@/components/i18n/i18n-provider";
import { episodeSummary, queueFormatters } from "@/components/admin/queue-format";
import type { RenamePreview, TitleFile, TitleFileMedia } from "@/lib/arr-title";

type T = ReturnType<typeof useT>;
type Formatters = ReturnType<typeof queueFormatters>;

export function mediaSummary(m: TitleFileMedia | null, t: T): string {
  if (!m) return "";
  const audio = [m.audioCodec, m.audioChannels !== null ? String(m.audioChannels) : null].filter(Boolean).join(" ");
  return [
    m.resolution,
    m.videoCodec,
    m.videoDynamicRange,
    m.videoBitDepth ? t("adminArr.files.bitDepth", { bits: m.videoBitDepth }) : null,
    audio || null,
    m.audioLanguages,
    m.subtitles ? t("adminArr.files.subtitles", { list: m.subtitles }) : null,
    m.runTime,
  ].filter((x): x is string => !!x).join(" · ");
}

export type MediaFormatters = { kbps: Intl.NumberFormat; num: Intl.NumberFormat };

// Built once per locale, not once per file per render.
export function mediaFormatters(locale: string): MediaFormatters {
  return {
    kbps: new Intl.NumberFormat(locale, { style: "unit", unit: "kilobit-per-second", unitDisplay: "narrow", maximumFractionDigits: 0 }),
    num: new Intl.NumberFormat(locale, { maximumFractionDigits: 3 }),
  };
}

// The rest of the media info the arr reports, for a file's details.
export function mediaDetails(m: TitleFileMedia | null, t: T, { kbps, num }: MediaFormatters): Array<[string, string]> {
  if (!m) return [];
  const rows: Array<[string, string | null]> = [
    [t("adminArr.files.detail.videoBitrate"), m.videoBitrate ? kbps.format(m.videoBitrate / 1000) : null],
    [t("adminArr.files.detail.fps"), m.videoFps ? num.format(m.videoFps) : null],
    [t("adminArr.files.detail.scanType"), m.scanType],
    [t("adminArr.files.detail.audioBitrate"), m.audioBitrate ? kbps.format(m.audioBitrate / 1000) : null],
    [t("adminArr.files.detail.audioStreams"), m.audioStreamCount !== null ? String(m.audioStreamCount) : null],
    [t("adminArr.files.detail.runTime"), m.runTime],
  ];
  return rows.filter((r): r is [string, string] => r[1] !== null && r[1] !== "");
}

/** The inline delete confirm (an alertdialog): how many, how big, which. */
export function DeleteConfirm({ files, isSeries, busy, deleting, cancelRef, onCancel, onConfirm, fmt }: {
  /** The files about to go. */
  files: TitleFile[];
  isSeries: boolean;
  /** Anything of the tab's in flight: the confirm waits. */
  busy: boolean;
  /** The delete itself is in flight. */
  deleting: boolean;
  cancelRef: React.Ref<HTMLButtonElement>;
  onCancel: () => void;
  onConfirm: () => void;
  fmt: Formatters;
}) {
  const t = useT();
  const size = files.reduce((n, f) => n + f.size, 0);
  return (
    <div role="alertdialog" aria-label={t("adminArr.files.confirmTitle")} className="flex flex-wrap items-center gap-3 rounded-lg px-3 py-2.5 text-sm" style={{ background: "color-mix(in oklab, var(--ds-danger) 12%, transparent)", border: "1px solid var(--ds-danger)" }}>
      <AlertTriangle className="h-4 w-4 shrink-0" style={{ color: "var(--ds-danger)" }} />
      <span className="min-w-0 flex-1 text-zinc-100">
        {t("adminArr.files.confirm", { count: files.length })}
        <span className="block text-xs text-zinc-400">
          {t("adminArr.files.confirmSize", { size: fmt.size(size) })}
          {" · "}
          {files.slice(0, 4).map((f) => (isSeries && f.episodes.length > 0 ? episodeSummary(f.episodes) : f.relativePath)).join(", ")}
          {files.length > 4 && ` ${t("adminArr.files.andMore", { count: files.length - 4 })}`}
        </span>
      </span>
      <Button ref={cancelRef} variant="ghost" size="sm" onClick={onCancel} disabled={busy}>
        {t("adminArr.common.cancel")}
      </Button>
      <Button size="sm" className="bg-red-600 text-[var(--ds-on-status)] hover:bg-[var(--ds-danger-hover)]" onClick={onConfirm} disabled={busy}>
        {deleting && <Loader2 className="animate-spin" />} {t("adminArr.files.confirmDelete")}
      </Button>
    </div>
  );
}

/** The arr's rename preview: each file's current and new path, every one ticked to start with. */
export function RenamePanel({ renames, selected, onSelectedChange, busy, renaming, onCancel, onApply }: {
  renames: RenamePreview[];
  selected: ReadonlySet<number>;
  onSelectedChange: (next: ReadonlySet<number>) => void;
  busy: boolean;
  /** The rename itself is in flight. */
  renaming: boolean;
  onCancel: () => void;
  onApply: () => void;
}) {
  const t = useT();
  return (
    <div className="grid gap-2 rounded-lg p-3" style={{ border: "1px solid var(--ds-border)", background: "var(--ds-bg-1)" }}>
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-sm font-medium text-zinc-100">{t("adminArr.files.renameTitle")}</span>
        <span className="text-xs text-zinc-500">{t("adminArr.files.renameHint")}</span>
        <span className="flex-1" />
        <Button variant="ghost" size="sm" onClick={onCancel} disabled={busy}>{t("adminArr.common.cancel")}</Button>
        <Button size="sm" onClick={onApply} disabled={selected.size === 0 || busy}>
          {renaming && <Loader2 className="animate-spin" />} {t("adminArr.files.renameApply", { count: selected.size })}
        </Button>
      </div>
      {renames.length === 0 ? (
        <p className="m-0 text-xs text-zinc-500">{t("adminArr.files.renameNone")}</p>
      ) : (
        <>
          {/* Every listed file starts ticked; a long show's preview lists thousands. */}
          <label className="flex items-center gap-2 text-xs text-zinc-400">
            <input
              type="checkbox"
              checked={renames.every((r) => selected.has(r.fileId))}
              onChange={(e) => onSelectedChange(e.target.checked ? new Set(renames.map((r) => r.fileId)) : new Set())}
              disabled={busy}
              className="accent-[var(--ds-accent)]"
            />
            {t("adminArr.files.selectAll")}
          </label>
          <ul className="m-0 grid list-none gap-2 p-0">
            {renames.map((r) => (
              <li key={r.fileId} className="flex items-start gap-2">
                <input
                  type="checkbox"
                  checked={selected.has(r.fileId)}
                  onChange={(e) => {
                    const next = new Set(selected);
                    if (e.target.checked) next.add(r.fileId);
                    else next.delete(r.fileId);
                    onSelectedChange(next);
                  }}
                  className="mt-1 accent-[var(--ds-accent)]"
                  aria-label={r.existingPath}
                />
                <div className="min-w-0 text-xs">
                  <div className="break-all text-zinc-500">{r.existingPath}</div>
                  <div className="flex items-start gap-1 break-all text-zinc-200"><ArrowDown className="mt-0.5 h-3 w-3 shrink-0 text-zinc-500" aria-hidden /> {r.newPath}</div>
                </div>
              </li>
            ))}
          </ul>
        </>
      )}
    </div>
  );
}

/** One file: its checkbox, name, quality, size and media line, and its details on demand. */
export function FileRow({ file: f, first, isSeries, media, details, expanded, onToggleExpanded, selected, onSelect, busy, fmt }: {
  file: TitleFile;
  first: boolean;
  isSeries: boolean;
  media: string;
  details: Array<[string, string]>;
  expanded: boolean;
  onToggleExpanded: () => void;
  selected: boolean;
  onSelect: () => void;
  /** A delete or rename is running: the selection holds still. */
  busy: boolean;
  fmt: Formatters;
}) {
  const t = useT();
  return (
    <li className="flex items-start gap-3 px-3 py-2.5" style={!first ? { borderTop: "1px solid var(--ds-border)" } : undefined}>
      {/* Locked while a delete or rename runs: a change of selection would close the confirm holding the delete's only spinner. */}
      <input
        type="checkbox"
        checked={selected}
        onChange={onSelect}
        disabled={busy}
        className="mt-1 accent-[var(--ds-accent)]"
        aria-label={t("adminArr.files.selectAria", { name: f.relativePath })}
      />
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-2">
          {isSeries && f.episodes.length > 0 && <span className="ds-mono text-xs text-zinc-500">{episodeSummary(f.episodes)}</span>}
          <span className="min-w-0 break-all text-sm text-zinc-100" title={f.path ?? undefined}>{f.relativePath}</span>
        </div>
        <div className="mt-1 flex flex-wrap items-center gap-1.5 text-xs text-zinc-500">
          {f.quality && (
            <Chip tone={f.qualityCutoffNotMet ? "pending" : "accent"}>
              {f.quality}
              {f.qualityTags.length > 0 && ` ${f.qualityTags.map((tag) => t(`adminManage.queue.qualityTag.${tag}`)).join(" ")}`}
            </Chip>
          )}
          {f.qualityCutoffNotMet && <Chip tone="pending">{t("adminArr.files.cutoffUnmet")}</Chip>}
          <span>{fmt.size(f.size)}</span>
          {f.languages.length > 0 && <span>{f.languages.join(", ")}</span>}
          {f.releaseGroup && <span>{f.releaseGroup}</span>}
          {f.edition && <span>{f.edition}</span>}
          {f.customFormats.length > 0 && (
            <span title={f.customFormats.join(", ")}>
              {t("adminArr.files.customFormats", { count: f.customFormats.length })}
              {f.customFormatScore !== null && ` (${fmt.score(f.customFormatScore)})`}
            </span>
          )}
          {f.dateAdded && <span>{t("adminArr.files.added", { date: fmt.dateTime(f.dateAdded) })}</span>}
        </div>
        {media && <div className="mt-1 text-xs text-zinc-500">{media}</div>}
        {f.sceneName && <div className="mt-1 truncate text-xs text-zinc-500" title={f.sceneName}>{f.sceneName}</div>}
        {(details.length > 0 || f.path) && (
          <button
            type="button"
            aria-expanded={expanded}
            onClick={onToggleExpanded}
            className="mt-1 flex items-center gap-1 text-xs text-zinc-500 hover:text-zinc-300"
          >
            {expanded ? <ChevronDown className="h-3 w-3" /> : <ChevronRight className="h-3 w-3" />} {t("adminArr.files.details")}
          </button>
        )}
        {expanded && (
          <dl className="m-0 mt-1 grid gap-x-4 gap-y-0.5 text-xs sm:grid-cols-[auto_1fr]">
            {details.map(([k, v]) => (
              <div key={k} className="contents">
                <dt className="text-zinc-500">{k}</dt>
                <dd className="m-0 text-zinc-300">{v}</dd>
              </div>
            ))}
            {f.path && (
              <div className="contents">
                <dt className="text-zinc-500">{t("adminArr.files.detail.path")}</dt>
                <dd className="m-0 break-all text-zinc-300">{f.path}</dd>
              </div>
            )}
          </dl>
        )}
      </div>
    </li>
  );
}
