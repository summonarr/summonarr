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
import { fetchJson } from "@/lib/client/fetch-json";
import { unmonitoredEpisodesOnly, type ArrStatusVerdict } from "@/lib/request-arr-status";
import { QUEUE_ATTENTION_HREF, queueTitleHref } from "@/lib/arr-manage-links";
import {
  ARR_STATUS_ANSWER,
  VERDICT_KEYS,
  downloadMeta,
  verdictDetails,
  verdictExplanation,
  type LoadedArrStatus,
  type StatusDownload,
  type VerdictTextContext,
} from "./request-arr-status-view";

type Loaded = LoadedArrStatus;

// The check reads Radarr/Sonarr live (a few reads, each bounded by arrFetch's
// 30 s): past this the panel says it couldn't check, and Recheck tries again.
const STATUS_TIMEOUT_MS = 90_000;

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
    // The route's own reason when it refused (not configured, no longer
    // approved, rate limited); a body the panel can't read, no answer or the
    // timeout read "couldn't check".
    const res = await fetchJson(withBasePath(`/api/requests/${encodeURIComponent(requestId)}/arr-status`), {
      schema: ARR_STATUS_ANSWER,
      timeoutMs: STATUS_TIMEOUT_MS,
      fallbackError: tRef.current("adminQueue.arrStatus.loadFailed"),
    });
    if (mine !== seq.current) return;
    setLoading(false);
    if (!res.ok) {
      setError(res.error);
      return;
    }
    setStatus(res.data);
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
  const text: VerdictTextContext = {
    t,
    service,
    fmt,
    calendarDay: (iso) => {
      const ms = iso === null ? Number.NaN : Date.parse(iso);
      return Number.isFinite(ms) ? calendarDate.format(ms) : null;
    },
  };

  const actionButton = "h-6 px-2 text-[11px] border-zinc-700 text-zinc-400 hover:text-zinc-100 gap-1";
  // Each derived list once per render, not once per use in the markup below.
  const detailLines: string[] = status ? verdictDetails(status, text) : [];
  const actions: readonly NextAction[] = status ? actionsFor(status) : [];

  return (
    <div
      id={id}
      role="group"
      aria-label={t("adminQueue.arrStatus.panelLabel")}
      className="w-full sm:w-80 rounded-md p-2.5 text-left"
      style={{ border: "1px solid var(--ds-border)", background: "var(--ds-bg-2)" }}
    >
      <StatusHeader status={status} service={service} loading={loading} onRecheck={() => void load()} onClose={onClose} />

      <div aria-live="polite" aria-busy={loading}>
        {error && (
          <p role="alert" className="mt-1.5 flex items-start gap-1 text-[11px] text-amber-400">
            <AlertTriangle className="w-3 h-3 shrink-0 mt-px" />{error}
          </p>
        )}
        {status && (
          <>
            <p className="mt-1.5 text-xs text-zinc-100 break-words">{verdictExplanation(status, text)}</p>

            {/* No stable id to key on: the coarse answer carries none (guardrail
                5g keeps a download id from a delegate), and a recheck replaces
                the whole list. */}
            {status.downloads.map((d, i) => <DownloadProgress key={i} download={d} text={text} />)}

            {status.verdict === "downloadFailed" && status.failures.message && (
              <p className="mt-1 flex items-start gap-1 text-[11px] text-amber-400 break-words">
                <AlertTriangle className="w-3 h-3 shrink-0 mt-px" />{status.failures.message}
              </p>
            )}

            {detailLines.length > 0 && (
              <ul className="mt-1.5 space-y-0.5 text-[11px] text-zinc-400">
                {detailLines.map((line) => <li key={line}>{line}</li>)}
              </ul>
            )}

            {status.verdict === "importBlocked" && <ImportBlockedNote status={status} />}

            {actions.length > 0 && (
              <div className="mt-2 flex flex-wrap items-center justify-end gap-1.5">
                {actions.includes("search") && (
                  <Button size="sm" variant="outline" onClick={() => thenRecheck(onSearch)} disabled={busy || stale} className={actionButton}>
                    <Search className="w-3 h-3" />{t("adminQueue.actions.search")}
                  </Button>
                )}
                {actions.includes("pick") && (
                  <Button size="sm" variant="outline" onClick={onPickRelease} disabled={busy || stale} className={actionButton}>
                    <Download className="w-3 h-3" />{t("adminQueue.actions.pickRelease")}
                  </Button>
                )}
                {actions.includes("repush") && (
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

// One download: its progress bar, the meta line, and what the arr says is
// wrong with it (scrubbed server-side).
function DownloadProgress({ download: d, text }: { download: StatusDownload; text: VerdictTextContext }) {
  const { t } = text;
  const pct = Math.round(d.progress * 100);
  return (
    <div className="mt-2">
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
      <p className="ds-mono mt-1 text-[11px] text-zinc-400 break-words">{downloadMeta(d, text).join(" · ")}</p>
      {/* The arr can repeat a message: the position keeps the keys apart. */}
      {d.messages.map((m, i) => (
        <p key={`${i}:${m}`} className="mt-0.5 flex items-start gap-1 text-[11px] text-amber-400 break-words">
          <AlertTriangle className="w-3 h-3 shrink-0 mt-px" />{m}
        </p>
      ))}
    </div>
  );
}

// The verdict chip (or "Checking…" before the first answer), Recheck and Close.
function StatusHeader({
  status,
  service,
  loading,
  onRecheck,
  onClose,
}: {
  status: Loaded | null;
  service: string;
  loading: boolean;
  onRecheck: () => void;
  onClose: () => void;
}) {
  const t = useT();
  return (
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
          onClick={onRecheck}
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
  );
}

// A blocked import is an admin's to fix in the Download Queue: the link for an
// admin (the route says so in `canOpenQueue`), a pointer to one otherwise.
function ImportBlockedNote({ status }: { status: Loaded }) {
  const t = useT();
  return (
    <p className="mt-1.5 text-[11px]">
      {status.canOpenQueue ? (
        <Link href={status.queue ? queueTitleHref(status.queue) : QUEUE_ATTENTION_HREF} className="inline-flex items-center gap-1 hover:underline" style={{ color: "var(--ds-accent-text)" }}>
          {t("adminQueue.arrStatus.openQueue")}<ExternalLink className="w-3 h-3" />
        </Link>
      ) : (
        <span className="text-zinc-400">{t("adminQueue.arrStatus.askAdmin")}</span>
      )}
    </p>
  );
}
