"use client";

// One list of Radarr/Sonarr history events — shared by the title manager's
// History tab (one title) and Admin → Download History (one instance). A grab
// can be marked failed (POST /api/admin/arr/history/failed — the arr's own
// "Mark as failed": blocklist the release and search again), confirmed inline.
// Times are server-supplied and only rendered after a client fetch.

import Link from "next/link";
import { useMemo, useState } from "react";
import { Button } from "@/components/ui/button";
import { Chip, type ChipTone } from "@/components/ui/design";
import { AlertTriangle, Ban, Loader2 } from "@/components/icons";
import { useLocale, useT } from "@/components/i18n/i18n-provider";
import { episodeCode, queueFormatters } from "@/components/admin/queue-format";
import type { ArrHistoryEvent, HistoryKind } from "@/lib/arr-history";

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

export const historyKindLabel = (kind: HistoryKind) => KIND_LABEL[kind];

export function ArrHistoryList({
  events,
  showTitle,
  onMarkFailed,
}: {
  events: ArrHistoryEvent[];
  /** The History page lists many titles; a title's own tab does not repeat its name. */
  showTitle: boolean;
  /** Mark a grab failed; resolves to an error message, or null when the arr accepted it. */
  onMarkFailed?: (event: ArrHistoryEvent) => Promise<string | null>;
}) {
  const t = useT();
  const locale = useLocale();
  const fmt = useMemo(() => queueFormatters(locale), [locale]);
  const [confirming, setConfirming] = useState<number | null>(null);
  const [busy, setBusy] = useState<number | null>(null);
  const [errors, setErrors] = useState<Record<number, string>>({});
  // Keyed by downloadId where there is one: Sonarr writes a Grabbed record per
  // episode of a pack, and marking any one fails the whole download.
  const [marked, setMarked] = useState<ReadonlySet<string>>(new Set());
  const markKey = (e: ArrHistoryEvent) => (e.downloadId !== null ? `d:${e.downloadId}` : `h:${e.id}`);

  async function mark(e: ArrHistoryEvent) {
    if (!onMarkFailed) return;
    setBusy(e.id);
    const err = await onMarkFailed(e);
    setBusy(null);
    setConfirming(null);
    if (err) setErrors((m) => ({ ...m, [e.id]: err }));
    else setMarked((s) => new Set(s).add(markKey(e)));
  }

  if (events.length === 0) return <p className="m-0 py-6 text-center text-sm text-zinc-500">{t("adminArr.history.none")}</p>;

  return (
    <ul className="m-0 grid list-none gap-0 rounded-lg p-0" style={{ border: "1px solid var(--ds-border)" }}>
      {events.map((e, i) => {
        const href = e.tmdbId !== null ? (e.service === "radarr" ? `/movie/${e.tmdbId}` : `/tv/${e.tmdbId}`) : null;
        const details = [
          e.indexer && t("adminArr.history.indexer", { name: e.indexer }),
          e.downloadClient && t("adminArr.history.client", { name: e.downloadClient }),
          e.releaseGroup,
          e.size !== null ? fmt.size(e.size) : null,
          e.reason && t("adminArr.history.reason", { reason: e.reason }),
        ].filter((x): x is string => !!x);
        return (
          <li key={`${e.instance}:${e.id}`} className="grid gap-1 px-3 py-2.5" style={i > 0 ? { borderTop: "1px solid var(--ds-border)" } : undefined}>
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
              {e.episode && (
                <span className="text-xs text-zinc-400">
                  <span className="ds-mono">{episodeCode(e.episode)}</span>
                  {e.episode.title && ` · ${e.episode.title}`}
                </span>
              )}
              {e.kind === "grabbed" && onMarkFailed && e.arrMediaId !== null && (
                <span className="ml-auto flex items-center gap-1">
                  {marked.has(markKey(e)) ? (
                    <span className="text-xs text-zinc-500">{t("adminArr.history.markedFailed")}</span>
                  ) : confirming === e.id ? (
                    <>
                      <Button variant="ghost" size="xs" onClick={() => setConfirming(null)} disabled={busy !== null}>{t("adminArr.common.cancel")}</Button>
                      <Button size="xs" className="bg-red-600 text-[var(--ds-on-status)] hover:bg-[var(--ds-danger-hover)]" onClick={() => void mark(e)} disabled={busy !== null}>
                        {busy === e.id && <Loader2 className="animate-spin" />} {t("adminArr.history.confirmMarkFailed")}
                      </Button>
                    </>
                  ) : (
                    <Button variant="outline" size="xs" onClick={() => setConfirming(e.id)} disabled={busy !== null} title={t("adminArr.history.markFailedHint")}>
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
              {e.customFormatScore !== null && e.customFormats.length > 0 && (
                <span title={e.customFormats.join(", ")}>{t("adminArr.files.customFormats", { count: e.customFormats.length })} ({fmt.score(e.customFormatScore)})</span>
              )}
              {details.map((d) => <span key={d}>{d}</span>)}
            </div>
            {e.message && <div className="text-xs text-amber-400">{e.message}</div>}
            {e.importedPath && <div className="break-all text-xs text-zinc-500">{t("adminArr.history.importedTo", { path: e.importedPath })}</div>}
            {e.kind === "renamed" && e.path && (
              <div className="break-all text-xs text-zinc-500">{t("adminArr.history.renamedTo", { from: e.sourcePath ?? "?", to: e.path })}</div>
            )}
            {errors[e.id] && (
              <p role="alert" className="m-0 flex items-center gap-1 text-xs" style={{ color: "var(--ds-danger)" }}>
                <AlertTriangle className="h-3 w-3 shrink-0" /> {errors[e.id]}
              </p>
            )}
          </li>
        );
      })}
    </ul>
  );
}
