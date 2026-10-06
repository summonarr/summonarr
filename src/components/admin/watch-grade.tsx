"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { AlertCircle, Film, Loader2, Tv2, X } from "@/components/icons";
import { withBasePath } from "@/lib/base-path";
import { useModalA11y } from "@/hooks/use-modal-a11y";
import {
  hasWatchGradeSignal,
  watchGradeBands,
  watchGradeVolume,
  type RequestWatchVerdict,
  type WatchGradeDetail,
  type WatchGradeLetter,
  type WatchGradeSettings,
  type WatchGradeSummary,
} from "@/lib/watch-grade";
import { useLocale, useT } from "@/components/i18n/i18n-provider";
import type { Translator } from "@/lib/i18n/translate";

// Admin-only request watch grade: a chip beside a user (Users page, request
// queue) that opens the per-request breakdown. Display-only — see
// src/lib/watch-grade.ts for the rules and why nothing enforces the grade.

const LETTER_CHIP: Record<WatchGradeLetter, string> = {
  A: "ds-chip-approved",
  B: "ds-chip-approved",
  C: "ds-chip-pending",
  D: "ds-chip-declined",
  F: "ds-chip-declined",
};

const LETTER_COLOR: Record<WatchGradeLetter, string> = {
  A: "var(--ds-success)",
  B: "var(--ds-success)",
  C: "var(--ds-warning)",
  D: "var(--ds-danger)",
  F: "var(--ds-danger)",
};

// Translated twin of describeWatchGrade (src/lib/watch-grade.ts) — same
// branches, so the two must change together. The lib copy stays English for
// its tests and any non-UI caller.
function describeGrade(t: Translator, summary: WatchGradeSummary, settings?: WatchGradeSettings): string {
  switch (summary.status) {
    case "graded": {
      const byOthers =
        summary.byOthers > 0 ? t("adminQueue.grade.describe.byOthers", { count: summary.byOthers }) : "";
      return t("adminQueue.grade.describe.graded", {
        letter: summary.letter ?? "—",
        score: summary.score ?? 0,
        fulfilled: t("adminQueue.grade.describe.fulfilled", { count: summary.graded }),
        watched: summary.watched,
        byOthers,
        partial: summary.partial,
        unwatched: summary.unwatched,
      });
    }
    case "insufficient":
      if (summary.graded === 0 && summary.inGrace > 0) {
        const grace = settings
          ? t("adminQueue.grade.describe.graceDays", { days: settings.graceDays })
          : t("adminQueue.grade.describe.grace");
        return t("adminQueue.grade.describe.inGrace", {
          fulfilled: t("adminQueue.grade.describe.fulfilled", { count: summary.inGrace }),
          grace,
        });
      }
      if (summary.graded === 0 && summary.untracked > 0) {
        return t("adminQueue.grade.describe.predates", { count: summary.untracked });
      }
      return t("adminQueue.grade.describe.needs", { min: summary.minGradedRequests, graded: summary.graded });
    case "unlinked":
      return t("adminQueue.grade.describe.unlinked");
    case "untracked":
      return t("adminQueue.grade.describe.untracked");
  }
}

export function WatchGradeChip({
  userId,
  userLabel,
  summary,
  compact = false,
}: {
  userId: string;
  userLabel: string;
  summary: WatchGradeSummary | null | undefined;
  // Letter and volume (the request queue); the Users page also shows the score.
  compact?: boolean;
}) {
  const t = useT();
  const [open, setOpen] = useState(false);
  const close = useCallback(() => setOpen(false), []);
  if (!hasWatchGradeSignal(summary)) return null;

  const letter = summary.letter;
  // "watched/scored" rides along whenever anything was scored, so a letter from
  // three requests and one from sixty read differently at a glance.
  const volume = summary.graded > 0 ? ` · ${watchGradeVolume(summary)}` : "";
  const text = letter
    ? compact
      ? t("adminQueue.grade.chipCompact", { letter, volume })
      : t("adminQueue.grade.chip", { letter, score: summary.score ?? 0, volume })
    : compact
      ? t("adminQueue.grade.chipCompact", { letter: "—", volume })
      : t("adminQueue.grade.chipNone", { volume });
  const description = describeGrade(t, summary);

  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        title={description}
        aria-label={t("adminQueue.grade.chipAria", { description, user: userLabel })}
        aria-haspopup="dialog"
        // The pseudo-element widens the hit area to ~32px tall without
        // changing the chip's 16px visual size (it sits in dense rows).
        className={`ds-chip relative after:absolute after:-inset-2 ${letter ? LETTER_CHIP[letter] : ""}`}
        style={{ padding: "0 6px", fontSize: 10, lineHeight: "16px" }}
      >
        {text}
      </button>
      {open && <WatchGradeModal userId={userId} userLabel={userLabel} onClose={close} />}
    </>
  );
}

type Filter = "all" | "unwatched" | "partial" | "others" | "watched" | "grace" | "untracked";

// Mirrors the summary's buckets, so each filter's rows match its count.
function matchesFilter(v: RequestWatchVerdict, filter: Filter): boolean {
  switch (filter) {
    case "all":
      return true;
    case "grace":
    case "untracked":
      return v.scoring === filter;
    case "others":
      return v.scoring === "scored" && v.watchedByOthers;
    default:
      return v.scoring === "scored" && !v.watchedByOthers && v.watch === filter;
  }
}

// Only ever set on a scored request the requester didn't fully watch.
function othersText(v: RequestWatchVerdict, t: Translator): string {
  if (!v.otherViewers) return "";
  return t("adminQueue.grade.progress.others", { count: v.otherViewers });
}

function duplicatesText(v: RequestWatchVerdict, t: Translator): string {
  if (v.duplicates <= 0) return "";
  return t("adminQueue.grade.progress.duplicates", { count: v.duplicates });
}

function progressText(v: RequestWatchVerdict, t: Translator): string {
  if (v.watch === null) return t("adminQueue.grade.progress.untrackable");
  const tail = othersText(v, t) + duplicatesText(v, t);
  if (v.episodes) {
    const e = v.episodes;
    const started = e.started > 0 ? t("adminQueue.grade.progress.started", { started: e.started }) : "";
    // The best season is what the credit comes from.
    const season = e.season !== null ? t("adminQueue.grade.progress.season", { season: e.season }) : "";
    return (
      (e.library > 0
        ? t("adminQueue.grade.progress.episodesOf", { season, watched: e.watched, library: e.library, started, required: e.required })
        : t("adminQueue.grade.progress.episodesUnknown", { season, count: e.watched, started })) + tail
    );
  }
  if (v.watch === "watched") return t("adminQueue.grade.state.watched") + tail;
  return (v.watch === "partial" ? t("adminQueue.grade.progress.partial") : t("adminQueue.grade.progress.notPlayed")) + tail;
}

function StateChip({ v }: { v: RequestWatchVerdict }) {
  const t = useT();
  if (v.scoring === "grace") {
    return (
      <span className="ds-chip" title={t("adminQueue.grade.state.graceTitle")}>
        {t("adminQueue.grade.state.grace", { days: v.graceDaysLeft ?? 0 })}
      </span>
    );
  }
  if (v.scoring === "untracked") {
    return (
      <span className="ds-chip" title={t("adminQueue.grade.state.untrackedTitle")}>
        {t("adminQueue.grade.state.untracked")}
      </span>
    );
  }
  if (v.watch === "watched") return <span className="ds-chip ds-chip-approved">{t("adminQueue.grade.state.watched")}</span>;
  if (v.watchedByOthers) {
    return (
      <span className="ds-chip ds-chip-approved" title={t("adminQueue.grade.state.othersTitle")}>
        {t("adminQueue.grade.state.others")}
      </span>
    );
  }
  if (v.watch === "partial") {
    return <span className="ds-chip ds-chip-pending">{t("adminQueue.grade.state.partial", { percent: Math.round(v.credit * 100) })}</span>;
  }
  return <span className="ds-chip ds-chip-declined">{t("adminQueue.grade.state.unwatched")}</span>;
}

export function WatchGradeModal({
  userId,
  userLabel,
  onClose,
}: {
  userId: string;
  userLabel: string;
  onClose: () => void;
}) {
  const t = useT();
  const locale = useLocale();
  const [data, setData] = useState<WatchGradeDetail | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [filter, setFilter] = useState<Filter>("all");
  const dialogRef = useRef<HTMLDivElement>(null);
  const closeBtnRef = useRef<HTMLButtonElement>(null);
  const titleId = `watch-grade-title-${userId}`;

  useModalA11y(dialogRef, onClose, closeBtnRef);

  useEffect(() => {
    let cancelled = false;
    fetch(withBasePath(`/api/admin/users/${encodeURIComponent(userId)}/watch-grade`))
      .then(async (res) => {
        if (!res.ok) {
          const body = (await res.json().catch(() => null)) as { error?: string } | null;
          throw new Error(body?.error ?? t("adminQueue.grade.loadFailedStatus", { status: res.status }));
        }
        return (await res.json()) as WatchGradeDetail;
      })
      .then((detail) => {
        if (!cancelled) setData(detail);
      })
      .catch((err: unknown) => {
        if (!cancelled) setError(err instanceof Error ? err.message : t("adminQueue.grade.loadFailed"));
      });
    return () => {
      cancelled = true;
    };
  }, [userId, t]);

  const grade = data?.grade ?? null;
  const settings = data?.settings ?? null;
  const verdicts = data?.requests ?? [];
  const shown = verdicts.filter((v) => matchesFilter(v, filter));
  const filters: { id: Filter; label: string; count: number }[] = grade
    ? [
        { id: "all", label: t("requests.filter.all"), count: verdicts.length },
        { id: "unwatched", label: t("adminQueue.grade.state.unwatched"), count: grade.unwatched },
        { id: "partial", label: t("adminQueue.grade.filter.partial"), count: grade.partial },
        { id: "others", label: t("adminQueue.grade.state.others"), count: grade.byOthers },
        { id: "watched", label: t("adminQueue.grade.state.watched"), count: grade.watched },
        { id: "grace", label: t("adminQueue.grade.filter.grace"), count: grade.inGrace },
        { id: "untracked", label: t("adminQueue.grade.state.untracked"), count: grade.untracked },
      ]
    : [];

  const overlay = (
    <div
      role="presentation"
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60"
      onClick={onClose}
    >
      <div
        ref={dialogRef}
        tabIndex={-1}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        className="bg-zinc-900 border border-zinc-800 rounded-xl p-5 w-[92vw] max-w-[560px] shadow-2xl flex flex-col max-h-[85vh] outline-none"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between mb-1">
          <h3 id={titleId} className="text-sm font-semibold text-zinc-100">
            {t("adminQueue.grade.title")}
          </h3>
          <button
            ref={closeBtnRef}
            type="button"
            aria-label={t("adminQueue.common.close")}
            onClick={onClose}
            className="p-1.5 -m-1.5 rounded text-zinc-500 hover:text-zinc-100 transition-colors"
          >
            <X className="w-4 h-4" />
          </button>
        </div>
        <p className="text-xs text-zinc-500 mb-4 truncate">{userLabel}</p>

        {error ? (
          <p className="flex items-center gap-2 text-xs text-red-400">
            <AlertCircle className="w-3.5 h-3.5 shrink-0" />
            {error}
          </p>
        ) : !data ? (
          <div className="flex justify-center py-8">
            <Loader2 className="w-5 h-5 animate-spin text-zinc-500" />
          </div>
        ) : !data.enabled ? (
          <p className="text-xs text-zinc-400">
            {data.reason === "feature-off"
              ? t("adminQueue.grade.featureOff")
              : t("adminQueue.grade.needsHistory")}
          </p>
        ) : grade && settings ? (
          <>
            <div className="flex items-center gap-4 mb-3">
              <div
                aria-hidden="true"
                className="flex items-center justify-center shrink-0 font-bold"
                style={{
                  width: 52,
                  height: 52,
                  borderRadius: 999,
                  fontSize: 24,
                  border: `2px solid ${grade.letter ? LETTER_COLOR[grade.letter] : "var(--ds-border)"}`,
                  color: grade.letter ? LETTER_COLOR[grade.letter] : "var(--ds-fg-subtle)",
                }}
              >
                {grade.letter ?? "—"}
              </div>
              <div className="min-w-0">
                <p className="text-sm text-zinc-200">
                  {grade.score !== null ? t("adminQueue.grade.watchRate", { score: grade.score }) : t("adminQueue.grade.noScored")}
                </p>
                <p className="text-xs text-zinc-500 mt-0.5">{describeGrade(t, grade, settings)}</p>
              </div>
            </div>

            <p className="text-[11px] leading-relaxed text-zinc-500 mb-3">
              {t("adminQueue.grade.rules.counting", {
                window:
                  settings.windowDays > 0
                    ? t("adminQueue.grade.rules.window", { days: settings.windowDays })
                    : t("adminQueue.grade.rules.anyTime"),
                grace: settings.graceDays,
              })}{" "}
              {t("adminQueue.grade.rules.thresholds", {
                movie: settings.watchedThresholdPercent,
                tv: settings.tvEpisodePercent,
              })}{" "}
              {settings.otherViewers > 0
                ? `${t("adminQueue.grade.rules.others", { count: settings.otherViewers })} `
                : ""}
              {t("adminQueue.grade.rules.bands", {
                min: settings.minGradedRequests,
                bands: watchGradeBands(settings).filter((b) => b.letter !== "F")
                  .map((b) => `${b.letter} ${b.min}%+`)
                  .join(", "),
              })}
            </p>

            {verdicts.length > 0 && (
              <div className="flex flex-wrap gap-1.5 mb-3" role="group" aria-label={t("adminQueue.grade.filterAria")}>
                {filters
                  .filter((f) => f.id === "all" || f.count > 0)
                  .map((f) => (
                    <button
                      key={f.id}
                      type="button"
                      onClick={() => setFilter(f.id)}
                      aria-pressed={filter === f.id}
                      className={`rounded-md px-2 py-0.5 text-[11px] border transition-colors ${
                        filter === f.id
                          ? "border-indigo-500/60 bg-indigo-500/15 text-indigo-300"
                          : "border-zinc-800 text-zinc-400 hover:text-zinc-100"
                      }`}
                    >
                      {f.label} {f.count}
                    </button>
                  ))}
              </div>
            )}

            <div className="overflow-y-auto -mx-1 px-1 flex flex-col gap-1.5">
              {verdicts.length === 0 ? (
                <p className="text-xs text-zinc-500 py-4 text-center">
                  {settings.windowDays > 0
                    ? t("adminQueue.grade.emptyWindow", { days: settings.windowDays })
                    : t("adminQueue.grade.empty")}
                </p>
              ) : shown.length === 0 ? (
                <p className="text-xs text-zinc-500 py-4 text-center">{t("adminQueue.grade.emptyFilter")}</p>
              ) : (
                shown.map((v) => (
                  <div
                    key={v.requestId}
                    className="flex items-center gap-3 rounded-lg border border-zinc-800 bg-zinc-950/40 px-3 py-2"
                  >
                    {v.mediaType === "MOVIE" ? (
                      <Film className="w-3.5 h-3.5 shrink-0 text-zinc-500" />
                    ) : (
                      <Tv2 className="w-3.5 h-3.5 shrink-0 text-zinc-500" />
                    )}
                    <div className="min-w-0 flex-1">
                      <p className="text-xs text-zinc-200 truncate">
                        {v.title}
                        {v.releaseYear ? <span className="text-zinc-500"> ({v.releaseYear})</span> : null}
                      </p>
                      <p className="text-[11px] text-zinc-500 truncate" title={progressText(v, t)}>
                        {t("adminQueue.grade.availableOn", { date: new Date(v.fulfilledAt).toLocaleDateString(locale) })} · {progressText(v, t)}
                      </p>
                    </div>
                    <StateChip v={v} />
                  </div>
                ))
              )}
              {data.truncated && (
                <p className="text-[11px] text-zinc-500 text-center py-1">
                  {t("adminQueue.grade.truncated", { count: verdicts.length })}
                </p>
              )}
            </div>
          </>
        ) : null}
      </div>
    </div>
  );

  // Portaled to <body>: the chip sits inside inline text (the Users page meta
  // line is a <p>), where a block-level dialog is invalid markup.
  return createPortal(overlay, document.body);
}
