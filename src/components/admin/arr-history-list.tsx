"use client";

// One list of Radarr/Sonarr history events — shared by the title manager's
// History tab (one title) and Admin → Download History (one instance). Sonarr's
// per-episode records of one download fold into one row (groupHistoryEvents),
// and a grab's state comes from the list's own records (grabStateOf): failed
// since, imported since — believed only where the list could hold them
// (grabStateKnown: not a kind-filtered list, not a page past the first). A
// grab not yet failed can be marked failed (POST
// /api/admin/arr/history/failed — the arr's own "Mark as failed": blocklist the
// release and search again), confirmed inline. Times are server-supplied and
// only rendered after a client fetch. On the History page each row also opens
// its title in the title manager (`renderManage`); never inside the manager.

import Link from "next/link";
import { useEffect, useMemo, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { Chip, type ChipTone } from "@/components/ui/design";
import { AlertTriangle, Ban, ChevronDown, Loader2 } from "@/components/icons";
import { useLocale, useT } from "@/components/i18n/i18n-provider";
import { episodeCode, queueFormatters } from "@/components/admin/queue-format";
import { grabStateKnown, grabStateOf, groupHistoryEvents, type ArrHistoryEvent, type HistoryKind, type HistoryRow } from "@/lib/arr-history";

const KIND_TONE: Record<HistoryKind, ChipTone> = {
  grabbed: "accent",
  imported: "approved",
  failed: "declined",
  deleted: "declined",
  renamed: "neutral",
  ignored: "pending",
  unknown: "neutral",
};
const KIND_LABEL: Record<HistoryKind, string> = {
  grabbed: "adminArr.history.kind.grabbed",
  imported: "adminArr.history.kind.imported",
  failed: "adminArr.history.kind.failed",
  deleted: "adminArr.history.kind.deleted",
  renamed: "adminArr.history.kind.renamed",
  ignored: "adminArr.history.kind.ignored",
  unknown: "adminArr.history.kind.unknown",
};

// Why a file was deleted, as the arrs' DeleteMediaFileReason names it, by
// lower-cased name. A literal map (the dead-key check can't see a built key);
// a reason not listed here is shown as the arr wrote it.
const DELETE_REASON_LABEL: Record<string, string> = {
  upgrade: "adminArr.history.deleteReason.upgrade",
  missingfromdisk: "adminArr.history.deleteReason.missingFromDisk",
  manual: "adminArr.history.deleteReason.manual",
  manualoverride: "adminArr.history.deleteReason.manualOverride",
};

export const historyKindLabel = (kind: HistoryKind) => KIND_LABEL[kind];

const seasonCode = (n: number) => `S${String(n).padStart(2, "0")}`;
// The marker a successful Mark failed leaves until the list's own records say
// so. Keyed by download: marking any grab of it failed the whole download.
const markKey = (e: ArrHistoryEvent) => `${e.instance}\u0000${e.downloadId !== null ? `d:${e.downloadId}` : `h:${e.id}`}`;

export function ArrHistoryList({
  events,
  showTitle,
  onMarkFailed,
  edges,
  filtered = false,
  renderManage,
}: {
  events: ArrHistoryEvent[];
  /** The History page lists many titles; a title's own tab does not repeat its name. */
  showTitle: boolean;
  /** Mark a grab failed; resolves to an error message, or null when the arr accepted it. */
  onMarkFailed?: (event: ArrHistoryEvent) => Promise<string | null>;
  /** On a paged list: whether there are pages before and after this one (a download's records can span them). */
  edges?: { hasPrevious: boolean; hasNext: boolean };
  /**
   * The arr filtered this list by kind: it holds no failures or imports to
   * judge a grab by, so a grab's state is unknown, not "neither".
   */
  filtered?: boolean;
  /**
   * Set ⇒ a row naming a Radarr/Sonarr title (an arr id) shows what this
   * renders beside its name — the History page's Manage icon. Off by default:
   * the title manager's own History tab renders this list and must not offer a
   * manager inside itself. A render prop, so this list never imports the
   * manager that imports it.
   */
  renderManage?: (event: ArrHistoryEvent & { arrMediaId: number }) => React.ReactNode;
}) {
  const t = useT();
  const locale = useLocale();
  const fmt = useMemo(() => queueFormatters(locale), [locale]);
  const hasPrevious = edges?.hasPrevious ?? false;
  const hasNext = edges?.hasNext ?? false;
  const paged = edges !== undefined;
  // Every newer record of a download is on this list only when the arr didn't
  // filter it and no page comes before it.
  const complete = !filtered && !hasPrevious;
  const rows = useMemo(
    () => groupHistoryEvents(events, paged ? { hasPrevious, hasNext } : null),
    [events, paged, hasPrevious, hasNext],
  );
  const [confirming, setConfirming] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(new Set());
  // Bridges the moment between the arr accepting a Mark failed and a reload
  // showing its failure records — and a list filtered to grabs, which never
  // shows them.
  const [marked, setMarked] = useState<ReadonlySet<string>>(new Set());
  // The inline confirm replaces the button that opened it: focus moves to its
  // Cancel, and back to the row's Mark failed when it closes unconfirmed.
  const cancelRef = useRef<HTMLButtonElement>(null);
  const openers = useRef(new Map<string, HTMLButtonElement>());
  const refocus = useRef<string | null>(null);
  useEffect(() => {
    if (confirming !== null) cancelRef.current?.focus();
    else if (refocus.current !== null) {
      openers.current.get(refocus.current)?.focus();
      refocus.current = null;
    }
  }, [confirming]);

  async function mark(row: HistoryRow) {
    if (!onMarkFailed) return;
    setBusy(row.key);
    // A retry starts clean: an earlier attempt's error must not outlive its success.
    setErrors((m) => {
      if (!(row.key in m)) return m;
      const next = { ...m };
      delete next[row.key];
      return next;
    });
    const err = await onMarkFailed(row.lead);
    setBusy(null);
    if (err) {
      // The button comes back; focus with it.
      refocus.current = row.key;
      setErrors((m) => ({ ...m, [row.key]: err }));
    } else setMarked((s) => new Set(s).add(markKey(row.lead)));
    setConfirming(null);
  }
  function cancel(row: HistoryRow) {
    refocus.current = row.key;
    setConfirming(null);
  }

  if (events.length === 0) return <p className="m-0 py-6 text-center text-sm text-zinc-500">{t("adminArr.history.none")}</p>;

  return (
    <ul className="m-0 grid list-none gap-0 rounded-lg p-0" style={{ border: "1px solid var(--ds-border)" }}>
      {rows.map((row, i) => {
        const e = row.lead;
        const group = row.events.length > 1;
        const state = grabStateOf(row, events);
        const known = grabStateKnown(state, { complete });
        const failed = state.failed || marked.has(markKey(e));
        const isOpen = expanded.has(row.key);
        const href = e.tmdbId !== null ? (e.service === "radarr" ? `/movie/${e.tmdbId}` : `/tv/${e.tmdbId}`) : null;
        const reasonKey = e.reason ? DELETE_REASON_LABEL[e.reason.toLowerCase()] : undefined;
        const details = [
          e.indexer && t("adminArr.history.indexer", { name: e.indexer }),
          e.downloadClient && t("adminArr.history.client", { name: e.downloadClient }),
          e.releaseGroup,
          e.size !== null ? fmt.size(e.size) : null,
          e.reason && t("adminArr.history.reason", { reason: reasonKey ? t(reasonKey) : e.reason }),
        ].filter((x): x is string => !!x);
        const scope = row.seasons.length > 0
          ? `${row.seasons.map(seasonCode).join(", ")} · ${t("adminArr.blocklist.episodes", { count: row.episodeCount })}`
          : t("adminArr.blocklist.episodes", { count: row.episodeCount });
        const listId = `arr-history-eps-${row.key}`;
        // The paths of one file; a folded row's files are listed per episode.
        const sharedDropped = row.events.every((x) => x.droppedPath === e.droppedPath) ? e.droppedPath : null;
        return (
          <li key={row.key} className="grid gap-1 px-3 py-2.5" style={i > 0 ? { borderTop: "1px solid var(--ds-border)" } : undefined}>
            <div className="flex flex-wrap items-center gap-2">
              <Chip tone={KIND_TONE[e.kind]}>{t(KIND_LABEL[e.kind])}</Chip>
              <span className="text-xs text-zinc-500">{fmt.dateTime(e.date)}</span>
              {showTitle && (
                href ? (
                  <Link href={href} className="text-sm font-medium text-zinc-100 hover:underline">{e.mediaTitle || t("adminArr.history.unknownTitle")}</Link>
                ) : (
                  <span className="text-sm font-medium text-zinc-100">{e.mediaTitle || t("adminArr.history.unknownTitle")}</span>
                )
              )}
              {/* By the arr's own id: a title with no TMDB id (Sonarr v3) is reachable this way too. */}
              {renderManage && e.arrMediaId !== null && renderManage({ ...e, arrMediaId: e.arrMediaId })}
              {group ? (
                row.episodes.length > 0 ? (
                  <button
                    type="button"
                    aria-expanded={isOpen}
                    aria-controls={listId}
                    onClick={() => setExpanded((s) => {
                      const next = new Set(s);
                      if (next.has(row.key)) next.delete(row.key);
                      else next.add(row.key);
                      return next;
                    })}
                    className="ds-hover-tint inline-flex items-center gap-1 rounded px-1 text-xs text-zinc-400"
                  >
                    <span className="ds-mono">{scope}</span>
                    <ChevronDown className={`h-3 w-3 transition-transform ${isOpen ? "rotate-180" : ""}`} aria-hidden />
                  </button>
                ) : (
                  row.episodeCount > 1 && <span className="text-xs text-zinc-400">{scope}</span>
                )
              ) : (
                e.episode && (
                  <span className="text-xs text-zinc-400">
                    <span className="ds-mono">{episodeCode(e.episode)}</span>
                    {e.episode.title && ` · ${e.episode.title}`}
                  </span>
                )
              )}
              {e.kind === "grabbed" && state.imported && <Chip tone="approved">{t("adminArr.history.kind.imported")}</Chip>}
              {e.kind === "grabbed" && onMarkFailed && e.arrMediaId !== null && (
                <span className="ml-auto flex flex-wrap items-center justify-end gap-1">
                  {failed ? (
                    state.failed
                      ? <Chip tone="declined">{t("adminArr.history.kind.failed")}</Chip>
                      : <span className="text-xs text-zinc-500">{t("adminArr.history.markedFailed")}</span>
                  ) : confirming === row.key ? (
                    <>
                      {row.episodeCount > 1 && <span className="text-xs text-zinc-300">{t("adminArr.history.wholeDownload", { count: row.episodeCount })}</span>}
                      {state.imported
                        ? <span className="text-xs text-amber-400">{t("adminArr.history.alreadyImported")}</span>
                        : !known && <span className="text-xs text-amber-400">{t("adminArr.history.stateUnknown")}</span>}
                      <Button ref={cancelRef} variant="ghost" size="xs" onClick={() => cancel(row)} disabled={busy !== null}>{t("adminArr.common.cancel")}</Button>
                      <Button size="xs" className="bg-red-600 text-[var(--ds-on-status)] hover:bg-[var(--ds-danger-hover)]" onClick={() => void mark(row)} disabled={busy !== null}>
                        {busy === row.key && <Loader2 className="animate-spin" />} {t("adminArr.history.confirmMarkFailed")}
                      </Button>
                    </>
                  ) : (
                    <Button
                      ref={(el) => {
                        if (el) openers.current.set(row.key, el);
                        else openers.current.delete(row.key);
                      }}
                      variant="outline"
                      size="xs"
                      onClick={() => setConfirming(row.key)}
                      disabled={busy !== null}
                      title={t("adminArr.history.markFailedHint")}
                    >
                      <Ban /> {t("adminArr.history.markFailed")}
                    </Button>
                  )}
                </span>
              )}
            </div>
            {e.sourceTitle && <div className="break-all text-xs text-zinc-300">{e.sourceTitle}</div>}
            <div className="flex flex-wrap items-center gap-1.5 text-xs text-zinc-500">
              {e.quality && (
                <Chip>
                  {e.quality}
                  {e.qualityTags.length > 0 && ` ${e.qualityTags.map((tag) => t(`adminManage.queue.qualityTag.${tag}`)).join(" ")}`}
                </Chip>
              )}
              {e.languages.length > 0 && <span>{e.languages.join(", ")}</span>}
              {e.customFormatScore !== null && e.customFormats.length > 0 && (
                <span title={e.customFormats.join(", ")}>{t("adminArr.files.customFormats", { count: e.customFormats.length })} ({fmt.score(e.customFormatScore)})</span>
              )}
              {details.map((d) => <span key={d}>{d}</span>)}
            </div>
            {e.message && <div className="text-xs text-amber-400">{e.message}</div>}
            {sharedDropped && <div className="break-all text-xs text-zinc-500">{t("adminArr.history.droppedFrom", { path: sharedDropped })}</div>}
            {!group && e.importedPath && <div className="break-all text-xs text-zinc-500">{t("adminArr.history.importedTo", { path: e.importedPath })}</div>}
            {e.kind === "renamed" && e.path && (
              <div className="break-all text-xs text-zinc-500">{t("adminArr.history.renamedTo", { from: e.sourcePath ?? "?", to: e.path })}</div>
            )}
            {group && isOpen && (
              <ul id={listId} className="m-0 grid list-none gap-0.5 p-0 pl-2 text-xs text-zinc-400" style={{ borderLeft: "2px solid var(--ds-border)" }}>
                {row.episodes.map((ep) => {
                  const code = episodeCode(ep);
                  const files = row.events.flatMap((x) => (x.importedPath && x.episode && episodeCode(x.episode) === code ? [{ id: x.id, path: x.importedPath }] : []));
                  return (
                    <li key={code} className="grid">
                      <span>
                        <span className="ds-mono">{code}</span>
                        {ep.title && ` · ${ep.title}`}
                      </span>
                      {files.map((f) => <span key={f.id} className="break-all text-zinc-500">{t("adminArr.history.importedTo", { path: f.path })}</span>)}
                    </li>
                  );
                })}
              </ul>
            )}
            {row.continuesBefore && <div className="text-xs text-zinc-500">{t("adminArr.history.continuesPrevious")}</div>}
            {row.continuesAfter && <div className="text-xs text-zinc-500">{t("adminArr.history.continuesNext")}</div>}
            {errors[row.key] && (
              <p role="alert" className="m-0 flex items-center gap-1 text-xs" style={{ color: "var(--ds-danger)" }}>
                <AlertTriangle className="h-3 w-3 shrink-0" /> {errors[row.key]}
              </p>
            )}
          </li>
        );
      })}
    </ul>
  );
}
