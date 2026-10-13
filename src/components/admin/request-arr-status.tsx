"use client";

// "Why is this request stuck?" — the request queue's inline status panel for
// one APPROVED request. Mounted only when the admin clicks "Why?", so nothing
// is read from Radarr/Sonarr for a row nobody asked about. The verdict and its
// precedence are server-side (src/lib/request-arr-status.ts); this renders
// them: a chip, one line of explanation, the download's progress, a few
// details, and the next action — which REUSES the row's own Search / Pick
// release / Re-push handlers rather than calling anything new. Delegates with
// MANAGE_REQUESTS read the same coarse answer; the Download Queue link shows
// only for an admin (the route says so in `canOpenQueue`).
//
// No clock read anywhere (guardrail 16): every time shown is one the server sent.

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { Button } from "@/components/ui/button";
import { Chip, type ChipTone } from "@/components/ui/design";
import { AlertTriangle, Download, ExternalLink, Loader2, RefreshCw, RotateCcw, Search, X } from "@/components/icons";
import { queueFormatters } from "@/components/admin/queue-format";
import { useLocale, useT } from "@/components/i18n/i18n-provider";
import { arrInstanceLabel } from "@/components/admin/open-in-arr";
import { withBasePath } from "@/lib/base-path";
import { ARR_ERROR_KIND_KEYS, isArrErrorKind } from "@/lib/arr-error-kind";
import type { QueuePhase } from "@/lib/arr-queue";
import { unmonitoredEpisodesOnly, type ArrStatusVerdict, type RequestArrStatus } from "@/lib/request-arr-status";

type Loaded = RequestArrStatus & { canOpenQueue?: boolean };

// Literal maps, never keys built from a value: the i18n dead-key check can't
// see a built key.
const VERDICT_KEYS = {
  unreachable: "adminQueue.arrStatus.verdict.unreachable",
  notInArr: "adminQueue.arrStatus.verdict.notInArr",
  ready: "adminQueue.arrStatus.verdict.ready",
  inArrNotInLibrary: "adminQueue.arrStatus.verdict.inArrNotInLibrary",
  waitingForLibrary: "adminQueue.arrStatus.verdict.waitingForLibrary",
  importBlocked: "adminQueue.arrStatus.verdict.importBlocked",
  downloading: "adminQueue.arrStatus.verdict.downloading",
  unmonitored: "adminQueue.arrStatus.verdict.unmonitored",
  notReleased: "adminQueue.arrStatus.verdict.notReleased",
  downloadFailed: "adminQueue.arrStatus.verdict.downloadFailed",
  incomplete: "adminQueue.arrStatus.verdict.incomplete",
  waiting: "adminQueue.arrStatus.verdict.waiting",
} as const satisfies Record<ArrStatusVerdict, string>;

const PHASE_KEYS = {
  downloading: "adminManage.queue.phase.downloading",
  queued: "adminManage.queue.phase.queued",
  paused: "adminManage.queue.phase.paused",
  delay: "adminManage.queue.phase.delay",
  importPending: "adminManage.queue.phase.importPending",
  importing: "adminManage.queue.phase.importing",
  importBlocked: "adminManage.queue.phase.importBlocked",
  failed: "adminManage.queue.phase.failed",
  clientUnavailable: "adminManage.queue.phase.clientUnavailable",
  unknown: "adminManage.queue.phase.unknown",
} as const satisfies Record<QueuePhase, string>;

// Status fills take --ds-on-status (the Chip tones already do); a verdict that
// only describes is neutral.
const VERDICT_TONE: Record<ArrStatusVerdict, ChipTone> = {
  unreachable: "declined",
  notInArr: "pending",
  ready: "approved",
  inArrNotInLibrary: "approved",
  waitingForLibrary: "neutral",
  importBlocked: "pending",
  downloading: "accent",
  unmonitored: "pending",
  notReleased: "neutral",
  downloadFailed: "declined",
  incomplete: "neutral",
  waiting: "neutral",
};

type NextAction = "search" | "pick" | "repush";
const NEXT_ACTIONS: Record<ArrStatusVerdict, readonly NextAction[]> = {
  unreachable: [],
  notInArr: ["repush"],
  ready: [],
  inArrNotInLibrary: [],
  waitingForLibrary: [],
  importBlocked: [],
  downloading: [],
  // Re-push re-monitors a title the arr already has (addMovieToRadarr / addSeriesToSonarr).
  unmonitored: ["repush"],
  notReleased: [],
  downloadFailed: ["search", "pick"],
  incomplete: ["search", "pick"],
  waiting: ["search", "pick"],
};

// A series monitored at the series level only: Re-push re-monitors an
// UNMONITORED series and returns early for a monitored one, so it can't help.
const actionsFor = (s: Loaded): readonly NextAction[] => (unmonitoredEpisodesOnly(s) ? [] : NEXT_ACTIONS[s.verdict]);

interface RequestArrStatusPanelProps {
  requestId: string;
  /** "MOVIE" | "TV" — names the service while the first check runs. */
  mediaType: string;
  /** The request's instance slug ("" = default) — the route judges THAT instance (guardrail 32). */
  arrInstance: string;
  /** The instance's display name; the default instance is a bare "Radarr"/"Sonarr". */
  arrInstanceName?: string | null;
  id?: string;
  /** A row action is running — the next-action buttons wait for it. */
  busy: boolean;
  onSearch: () => Promise<void>;
  onPickRelease: () => void;
  onRepush: () => Promise<void>;
  onClose: () => void;
}

export function RequestArrStatusPanel({ requestId, mediaType, arrInstance, arrInstanceName, id, busy, onSearch, onPickRelease, onRepush, onClose }: RequestArrStatusPanelProps) {
  const t = useT();
  const locale = useLocale();
  const fmt = useMemo(() => queueFormatters(locale), [locale]);
  // A movie's release date is a calendar DATE (midnight UTC): shown in UTC, or
  // everyone west of UTC sees it a day early.
  const calendarDate = useMemo(() => new Intl.DateTimeFormat(locale, { dateStyle: "medium", timeZone: "UTC" }), [locale]);

  const [status, setStatus] = useState<Loaded | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const seq = useRef(0);
  // The translator through a ref: the request queue router.refresh()es on every
  // request:* event, which hands the provider a new catalog object and so a new
  // `t`. As a `load` dependency that re-ran the mount read — four Radarr/Sonarr
  // calls and the action buttons disabled — with nobody clicking.
  const tRef = useRef(t);
  useEffect(() => {
    tRef.current = t;
  }, [t]);

  const load = useCallback(async () => {
    const mine = ++seq.current;
    setLoading(true);
    setError(null);
    try {
      const res = await fetch(withBasePath(`/api/requests/${encodeURIComponent(requestId)}/arr-status`));
      const data = (await res.json().catch(() => ({}))) as Loaded & { error?: string };
      if (mine !== seq.current) return;
      if (!res.ok) {
        setError(data.error ?? tRef.current("adminQueue.arrStatus.loadFailed"));
        return;
      }
      setStatus(data);
    } catch {
      if (mine === seq.current) setError(tRef.current("adminQueue.arrStatus.loadFailed"));
    } finally {
      if (mine === seq.current) setLoading(false);
    }
  }, [requestId]);

  // The panel is mounted by the click, so this IS the click's read. The row
  // closes the panel whenever it would unmount it (the delete confirm, a status
  // other than APPROVED) and keys it on the request, so a re-mount or a new
  // representative request never reads without a click.
  useEffect(() => {
    void load();
    const counter = seq;
    return () => { counter.current++; };
  }, [load]);

  // A verdict that could not be re-confirmed (a re-check running or failed)
  // offers no action: its buttons would act on what it no longer describes.
  const stale = loading || error !== null;
  // The panel's own Search / Re-push re-read the verdict once they finish — a
  // click, so the read-on-click design holds — unless a re-check or an unmount
  // happened meanwhile.
  const thenRecheck = (action: () => Promise<void>) => {
    const at = seq.current;
    void action().then(() => {
      if (seq.current === at) void load();
    });
  };

  // Named per instance: the route judges the request's own instance, and a
  // down 4K Radarr read as "Radarr couldn't be reached" sent the admin to the
  // healthy default one.
  const service = arrInstanceLabel(status?.service ?? (mediaType === "MOVIE" ? "radarr" : "sonarr"), arrInstanceName, arrInstance);
  const calendarDay = (iso: string | null) => {
    const ms = iso === null ? Number.NaN : Date.parse(iso);
    return Number.isFinite(ms) ? calendarDate.format(ms) : null;
  };

  function explanation(s: Loaded): string {
    switch (s.verdict) {
      case "unreachable":
        return t(ARR_ERROR_KIND_KEYS[isArrErrorKind(s.errorKind) ? s.errorKind : "other"], { name: service });
      case "notInArr": return t("adminQueue.arrStatus.why.notInArr", { service });
      case "ready": return t("adminQueue.arrStatus.why.ready");
      case "inArrNotInLibrary": return t("adminQueue.arrStatus.why.inArrNotInLibrary", { service });
      case "waitingForLibrary": return t("adminQueue.arrStatus.why.waitingForLibrary", { service });
      case "importBlocked": return t("adminQueue.arrStatus.why.importBlocked", { service });
      case "downloading":
        return s.downloads.length > 0 && s.downloads.every((d) => d.pending)
          ? t("adminQueue.arrStatus.why.held", { service })
          : t("adminQueue.arrStatus.why.downloading", { service });
      case "unmonitored":
        return unmonitoredEpisodesOnly(s)
          ? t("adminQueue.arrStatus.why.unmonitoredEpisodes", { service })
          : t("adminQueue.arrStatus.why.unmonitored", { service });
      case "notReleased": {
        if (s.service === "radarr") {
          const date = calendarDay(s.expectedAt);
          return date ? t("adminQueue.arrStatus.why.notReleasedMovieOn", { date }) : t("adminQueue.arrStatus.why.notReleasedMovie");
        }
        return s.expectedAt
          ? t("adminQueue.arrStatus.why.notReleasedSeriesOn", { date: fmt.dateTime(s.expectedAt) })
          : t("adminQueue.arrStatus.why.notReleasedSeries");
      }
      case "downloadFailed": return t("adminQueue.arrStatus.why.downloadFailed", { service });
      case "incomplete":
        return t("adminQueue.arrStatus.why.incomplete", { withFile: s.episodes?.withFile ?? 0, total: s.episodes?.total ?? 0, service });
      case "waiting": return t("adminQueue.arrStatus.why.waiting", { service });
    }
  }

  function details(s: Loaded): string[] {
    const out: string[] = [];
    if (s.episodes && s.verdict !== "incomplete" && s.verdict !== "notReleased" && s.episodes.total > 0) {
      out.push(t("adminQueue.arrStatus.episodesOnDisk", { withFile: s.episodes.withFile, total: s.episodes.total }));
    }
    // The release date only explains a title nothing is downloading.
    if (s.service === "radarr" && s.releasedAt && (s.verdict === "waiting" || s.verdict === "downloadFailed" || s.verdict === "unmonitored")) {
      const date = calendarDay(s.releasedAt);
      if (date) out.push(t("adminQueue.arrStatus.releasedOn", { date }));
    }
    if (s.service === "sonarr" && s.expectedAt && s.verdict !== "notReleased") {
      out.push(t("adminQueue.arrStatus.nextAiring", { date: fmt.dateTime(s.expectedAt) }));
    }
    if (s.failures.count > 0) {
      out.push(t("adminQueue.arrStatus.failureCount", { count: s.failures.count }));
      if (s.failures.lastAt) out.push(t("adminQueue.arrStatus.lastFailure", { date: fmt.dateTime(s.failures.lastAt) }));
    }
    if (s.inLibrary && s.verdict !== "ready") out.push(t("adminQueue.arrStatus.onMediaServer"));
    if (s.downloadCount > s.downloads.length) out.push(t("adminQueue.arrStatus.moreDownloads", { count: s.downloadCount - s.downloads.length }));
    return out;
  }

  const actionButton = "h-6 px-2 text-[11px] border-zinc-700 text-zinc-400 hover:text-zinc-100 gap-1";

  return (
    <div
      id={id}
      role="group"
      aria-label={t("adminQueue.arrStatus.panelLabel")}
      className="w-full sm:w-80 rounded-md p-2.5 text-left"
      style={{ border: "1px solid var(--ds-border)", background: "var(--ds-bg-2)" }}
    >
      <div className="flex items-center justify-between gap-2">
        <div className="min-w-0">
          {status ? (
            <Chip tone={VERDICT_TONE[status.verdict]}>{t(VERDICT_KEYS[status.verdict], { service })}</Chip>
          ) : loading ? (
            <span className="flex items-center gap-1.5 text-[11px] text-zinc-400">
              <Loader2 className="w-3 h-3 animate-spin" />{t("adminQueue.arrStatus.checking")}
            </span>
          ) : null}
        </div>
        <div className="flex items-center shrink-0">
          <button
            type="button"
            onClick={() => void load()}
            disabled={loading}
            aria-label={t("adminQueue.arrStatus.recheck")}
            title={t("adminQueue.arrStatus.recheck")}
            className="rounded p-1.5 text-zinc-500 hover:text-zinc-100 disabled:opacity-50"
          >
            <RefreshCw className={`w-3.5 h-3.5 ${loading ? "animate-spin" : ""}`} />
          </button>
          <button
            type="button"
            onClick={onClose}
            aria-label={t("adminQueue.arrStatus.close")}
            title={t("adminQueue.arrStatus.close")}
            className="rounded p-1.5 text-zinc-500 hover:text-zinc-100"
          >
            <X className="w-3.5 h-3.5" />
          </button>
        </div>
      </div>

      <div aria-live="polite" aria-busy={loading}>
        {error && (
          <p role="alert" className="mt-1.5 flex items-start gap-1 text-[11px] text-amber-400">
            <AlertTriangle className="w-3 h-3 shrink-0 mt-px" />{error}
          </p>
        )}
        {status && (
          <>
            <p className="mt-1.5 text-xs text-zinc-100 break-words">{explanation(status)}</p>

            {status.downloads.map((d, i) => {
              const pct = Math.round(d.progress * 100);
              // Time left only while there is something left to fetch.
              const fetching = d.progress < 1 && !d.pending;
              const meta = [
                t(PHASE_KEYS[d.phase]),
                fmt.percent(d.progress),
                fetching && d.timeLeftSeconds !== null ? t("adminQueue.arrStatus.timeLeft", { time: fmt.duration(d.timeLeftSeconds) }) : null,
                fetching && d.timeLeftSeconds === null && d.estimatedCompletion ? t("adminQueue.arrStatus.eta", { date: fmt.dateTime(d.estimatedCompletion) }) : null,
                d.quality,
                d.episodes > 0 ? t("adminQueue.arrStatus.episodesInDownload", { count: d.episodes }) : null,
              ].filter((x): x is string => typeof x === "string" && x !== "");
              return (
                <div key={i} className="mt-2">
                  <div
                    role="progressbar"
                    aria-valuemin={0}
                    aria-valuemax={100}
                    aria-valuenow={pct}
                    aria-label={t("adminQueue.arrStatus.progressLabel")}
                    style={{ height: 6, borderRadius: 3, background: "var(--ds-bg-3)", overflow: "hidden" }}
                  >
                    <div style={{ width: `${pct}%`, height: "100%", background: d.attention ? "var(--ds-warning)" : "var(--ds-accent)" }} />
                  </div>
                  <p className="ds-mono mt-1 text-[11px] text-zinc-400 break-words">{meta.join(" · ")}</p>
                  {d.messages.map((m) => (
                    <p key={m} className="mt-0.5 flex items-start gap-1 text-[11px] text-amber-400 break-words">
                      <AlertTriangle className="w-3 h-3 shrink-0 mt-px" />{m}
                    </p>
                  ))}
                </div>
              );
            })}

            {status.verdict === "downloadFailed" && status.failures.message && (
              <p className="mt-1 flex items-start gap-1 text-[11px] text-amber-400 break-words">
                <AlertTriangle className="w-3 h-3 shrink-0 mt-px" />{status.failures.message}
              </p>
            )}

            {details(status).length > 0 && (
              <ul className="mt-1.5 space-y-0.5 text-[11px] text-zinc-400">
                {details(status).map((line) => <li key={line}>{line}</li>)}
              </ul>
            )}

            {status.verdict === "importBlocked" && (
              <p className="mt-1.5 text-[11px]">
                {status.canOpenQueue ? (
                  <Link href="/admin/queue" className="inline-flex items-center gap-1 hover:underline" style={{ color: "var(--ds-accent-text)" }}>
                    {t("adminQueue.arrStatus.openQueue")}<ExternalLink className="w-3 h-3" />
                  </Link>
                ) : (
                  <span className="text-zinc-400">{t("adminQueue.arrStatus.askAdmin")}</span>
                )}
              </p>
            )}

            {actionsFor(status).length > 0 && (
              <div className="mt-2 flex flex-wrap items-center justify-end gap-1.5">
                {actionsFor(status).includes("search") && (
                  <Button size="sm" variant="outline" onClick={() => thenRecheck(onSearch)} disabled={busy || stale} className={actionButton}>
                    <Search className="w-3 h-3" />{t("adminQueue.actions.search")}
                  </Button>
                )}
                {actionsFor(status).includes("pick") && (
                  <Button size="sm" variant="outline" onClick={onPickRelease} disabled={busy || stale} className={actionButton}>
                    <Download className="w-3 h-3" />{t("adminQueue.actions.pickRelease")}
                  </Button>
                )}
                {actionsFor(status).includes("repush") && (
                  <Button size="sm" variant="outline" onClick={() => thenRecheck(onRepush)} disabled={busy || stale} className={actionButton}>
                    <RotateCcw className="w-3 h-3" />{t("adminQueue.actions.repush")}
                  </Button>
                )}
              </div>
            )}
          </>
        )}
      </div>
    </div>
  );
}
