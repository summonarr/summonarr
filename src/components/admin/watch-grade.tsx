"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { AlertCircle, Film, Loader2, Tv2, X } from "@/components/icons";
import { withBasePath } from "@/lib/base-path";
import { useModalA11y } from "@/hooks/use-modal-a11y";
import {
  describeWatchGrade,
  hasWatchGradeSignal,
  watchGradeBands,
  watchGradeVolume,
  type RequestWatchVerdict,
  type WatchGradeDetail,
  type WatchGradeLetter,
  type WatchGradeSummary,
} from "@/lib/watch-grade";

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
  const [open, setOpen] = useState(false);
  const close = useCallback(() => setOpen(false), []);
  if (!hasWatchGradeSignal(summary)) return null;

  const letter = summary.letter;
  // "watched/scored" rides along whenever anything was scored, so a letter from
  // three requests and one from sixty read differently at a glance.
  const volume = summary.graded > 0 ? ` · ${watchGradeVolume(summary)}` : "";
  const text = letter
    ? compact
      ? `Watch ${letter}${volume}`
      : `Watch grade ${letter} · ${summary.score}%${volume}`
    : compact
      ? `Watch —${volume}`
      : `Watch grade —${volume}`;
  const description = describeWatchGrade(summary);

  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        title={description}
        aria-label={`${description}. Show the breakdown for ${userLabel}`}
        aria-haspopup="dialog"
        className={`ds-chip ${letter ? LETTER_CHIP[letter] : ""}`}
        style={{ cursor: "pointer", padding: "0 6px", fontSize: 10, lineHeight: "16px" }}
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
function othersText(v: RequestWatchVerdict): string {
  if (!v.otherViewers) return "";
  return ` · watched by ${v.otherViewers} other${v.otherViewers === 1 ? "" : "s"}`;
}

function duplicatesText(v: RequestWatchVerdict): string {
  if (v.duplicates <= 0) return "";
  return ` · also requested on ${v.duplicates} other instance${v.duplicates === 1 ? "" : "s"}`;
}

function progressText(v: RequestWatchVerdict): string {
  if (v.watch === null) return "Watches can't be tracked";
  const tail = othersText(v) + duplicatesText(v);
  if (v.episodes) {
    const e = v.episodes;
    const started = e.started > 0 ? `, ${e.started} started` : "";
    // The best season is what the credit comes from.
    const season = e.season !== null ? `S${e.season}: ` : "";
    return (
      (e.library > 0
        ? `${season}${e.watched} of ${e.library} episodes watched${started} · ${e.required} needed`
        : `${season}${e.watched} episode${e.watched === 1 ? "" : "s"} watched${started} · episode count unknown`) + tail
    );
  }
  if (v.watch === "watched") return `Watched${tail}`;
  return (v.watch === "partial" ? "Started, not finished" : "Not played since the request") + tail;
}

function StateChip({ v }: { v: RequestWatchVerdict }) {
  if (v.scoring === "grace") {
    return (
      <span className="ds-chip" title="Doesn't count toward the grade until the grace period ends">
        Counts in {v.graceDaysLeft}d
      </span>
    );
  }
  if (v.scoring === "untracked") {
    return (
      <span className="ds-chip" title="Fulfilled before play history was tracking this user's media servers — never counted">
        Not counted
      </span>
    );
  }
  if (v.watch === "watched") return <span className="ds-chip ds-chip-approved">Watched</span>;
  if (v.watchedByOthers) {
    return (
      <span className="ds-chip ds-chip-approved" title="The requester didn't watch it, but enough other people did, so it counts as watched">
        Others watched
      </span>
    );
  }
  if (v.watch === "partial") {
    return <span className="ds-chip ds-chip-pending">Partly · {Math.round(v.credit * 100)}%</span>;
  }
  return <span className="ds-chip ds-chip-declined">Not watched</span>;
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
          throw new Error(body?.error ?? `Could not load the watch grade (${res.status})`);
        }
        return (await res.json()) as WatchGradeDetail;
      })
      .then((detail) => {
        if (!cancelled) setData(detail);
      })
      .catch((err: unknown) => {
        if (!cancelled) setError(err instanceof Error ? err.message : "Could not load the watch grade");
      });
    return () => {
      cancelled = true;
    };
  }, [userId]);

  const grade = data?.grade ?? null;
  const settings = data?.settings ?? null;
  const verdicts = data?.requests ?? [];
  const shown = verdicts.filter((v) => matchesFilter(v, filter));
  const filters: { id: Filter; label: string; count: number }[] = grade
    ? [
        { id: "all", label: "All", count: verdicts.length },
        { id: "unwatched", label: "Not watched", count: grade.unwatched },
        { id: "partial", label: "Partly", count: grade.partial },
        { id: "others", label: "Others watched", count: grade.byOthers },
        { id: "watched", label: "Watched", count: grade.watched },
        { id: "grace", label: "Grace period", count: grade.inGrace },
        { id: "untracked", label: "Not counted", count: grade.untracked },
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
          <h3 id={titleId} className="text-sm font-semibold text-white">
            Request watch grade
          </h3>
          <button
            ref={closeBtnRef}
            type="button"
            aria-label="Close"
            onClick={onClose}
            className="text-zinc-500 hover:text-white transition-colors"
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
              ? "Watch grades are turned off. Enable “Request watch grades” in Settings → Features."
              : "Watch grades need play history tracking. Turn it on for at least one media server in Settings → Media → Play History."}
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
                  {grade.score !== null ? `${grade.score}% watch rate` : "No scored requests yet"}
                </p>
                <p className="text-xs text-zinc-500 mt-0.5">{describeWatchGrade(grade, settings)}</p>
              </div>
            </div>

            <p className="text-[11px] leading-relaxed text-zinc-500 mb-3">
              Approved requests fulfilled {settings.windowDays > 0 ? `in the last ${settings.windowDays} days` : "at any time"} count{" "}
              {settings.graceDays} days after they became available — approving a title counts for everyone who requested it; pending, declined and never-approved requests don&apos;t. A movie counts once it&apos;s{" "}
              {settings.watchedThresholdPercent}% played (half credit once a quarter of it is played); a show once{" "}
              {settings.tvEpisodePercent}% of one season&apos;s episodes are watched — the best season counts.{" "}
              {settings.otherViewers > 0
                ? `A request the requester skipped also counts once ${settings.otherViewers} other ${settings.otherViewers === 1 ? "person has" : "people have"} watched it. `
                : ""}
              Grades need{" "}
              {settings.minGradedRequests}+ counted requests —{" "}
              {watchGradeBands(settings).filter((b) => b.letter !== "F")
                .map((b) => `${b.letter} ${b.min}%+`)
                .join(", ")}
              , otherwise F.
            </p>

            {verdicts.length > 0 && (
              <div className="flex flex-wrap gap-1.5 mb-3" role="group" aria-label="Filter requests">
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
                          : "border-zinc-800 text-zinc-400 hover:text-white"
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
                  No approved requests fulfilled {settings.windowDays > 0 ? `in the last ${settings.windowDays} days` : "yet"}.
                </p>
              ) : shown.length === 0 ? (
                <p className="text-xs text-zinc-500 py-4 text-center">Nothing in this filter.</p>
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
                      <p className="text-[11px] text-zinc-500 truncate" title={progressText(v)}>
                        Available {new Date(v.fulfilledAt).toLocaleDateString()} · {progressText(v)}
                      </p>
                    </div>
                    <StateChip v={v} />
                  </div>
                ))
              )}
              {data.truncated && (
                <p className="text-[11px] text-zinc-500 text-center py-1">
                  Showing the newest {verdicts.length} requests; the grade covers all of them.
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
