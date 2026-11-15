"use client";

import { useState, useCallback, useEffect, useId, useRef, type KeyboardEvent } from "react";
import { useRouter } from "next/navigation";
import { Check } from "@/components/icons";
import { posterUrl } from "@/lib/tmdb-types";
import { Dialog, DialogBackdrop, DialogClose, DialogPopup, DialogPortal, DialogTitle } from "@/components/ui/dialog";
import type { PlexCandidate, CandidateMatch, CandidatesResponse } from "@/lib/fix-match-candidates";
import { withBasePath } from "@/lib/base-path";
import { runFixMatch, fixMatchErrorMessage, fixMatchWarningMessage, type FixMatchProgressView } from "@/lib/client/fix-match";
import { candidatesErrorText, fetchFixMatchCandidates } from "@/lib/client/fix-match-candidates";
import { useAsyncAction } from "@/hooks/use-async-action";
import { DEFAULT_MEDIA_INSTANCE, mediaInstanceLabel } from "@/lib/media-instances";
import { rich } from "@/components/settings/forms/rich";
import { useT } from "@/components/i18n/i18n-provider";
import type { Translator } from "@/lib/i18n/translate";
import { fixMatchRunningLabel, formatElapsed, copyOfSuffix } from "@/components/admin/fix-match-labels";
import { mediaServerName } from "@/lib/media-server-name";

// One state per step, each carrying only what that step has: the candidates
// exist while picking and applying, the progress and the hidden flag only while
// applying, a message only once it settled. Separate flags allowed "applying"
// with no candidates, or a stale progress under "selecting".
type State =
  | { phase: "idle" }
  | { phase: "fetching" }
  | { phase: "selecting"; data: CandidatesResponse }
  | { phase: "applying"; data: CandidatesResponse; progress: FixMatchProgressView | null; hidden: boolean }
  | { phase: "success" }
  | { phase: "conflated"; note: string }
  | { phase: "error"; message: string };

interface Props {
  server:        "plex" | "jellyfin";
  tmdbId:        number;
  mediaType:     "MOVIE" | "TV";
  correctTmdbId: number;
  label:         string;

  arrTmdbId?:    number | null;

  // Which configured server's library row this button rewrites. "" (the default)
  // keeps the exact pre-multi-server request shape; a named slug is threaded into
  // both the candidates query and the POST body so the remote rewrite lands on
  // the same server the row (and its ratingKey) came from.
  serverInstance?: string;
}

const LEVEL_STYLES: Record<CandidateMatch, { border: string; bg: string; badge: string }> = {
  exact:   { border: "border-l-2 border-green-500",       bg: "bg-green-500/5 hover:bg-green-500/10",    badge: "bg-green-500/20 text-green-400 border-green-500/40" },
  strong:  { border: "border-l-2 border-emerald-500/70",  bg: "bg-emerald-500/5 hover:bg-emerald-500/10", badge: "bg-emerald-500/20 text-emerald-400 border-emerald-500/40" },
  likely:  { border: "border-l-2 border-yellow-500/70",   bg: "bg-yellow-500/5 hover:bg-yellow-500/10",  badge: "bg-yellow-500/20 text-yellow-400 border-yellow-500/40" },
  possible:{ border: "border-l-2 border-zinc-500/50",     bg: "hover:bg-zinc-800",                       badge: "bg-zinc-700 text-zinc-400 border-zinc-600" },
  wrong:   { border: "border-l-2 border-red-500/70",      bg: "bg-red-500/5 hover:bg-red-500/10",        badge: "bg-red-500/20 text-red-400 border-red-500/40" },
  unknown: { border: "border-l-2 border-transparent",     bg: "hover:bg-zinc-800",                       badge: "bg-zinc-800 text-zinc-500 border-zinc-700" },
};

// "TMDB #123" — the catalog owns the wording.
const tmdbRef = (id: number | string, t: Translator) => t("adminQueue.fixMatch.tmdbRef", { id });

// The file name at the end of a library path (either separator).
const fileNameOf = (path: string | null) => (path ? path.replace(/\\/g, "/").split("/").pop() ?? path : null);

interface ModalProps {
  server:        "plex" | "jellyfin";
  data:          CandidatesResponse;
  // The library row's current (wrong) id — shown in the Jellyfin confirmation
  // card so the admin sees the direction of the remap, not just the destination.
  currentTmdbId: number;
  correctTmdbId: number;
  arrTmdbId:     number | null;
  // "plex:<slug>"/"jellyfin:<slug>" for a named server, empty for the default one
  // — surfaced so the admin can see WHICH server this modal is about to rewrite.
  instanceLabel: string;
  // Plex mode: applies the candidate the admin picked. A row click only PICKS
  // it; the footer's Apply sends it, so a misclick while scrolling the list
  // never rematches the item.
  onSelect:      (guid: string) => void;
  // Jellyfin mode only: fires the single-target apply from the confirm footer.
  onConfirm:     () => void;
  onCancel:      () => void;
  // Closes the modal while the apply keeps running — the row keeps tracking it.
  onHide:        () => void;
  applying:      boolean;
  progress:      FixMatchProgressView | null;
}

function FixMatchModal({ server, data, currentTmdbId, correctTmdbId, arrTmdbId, instanceLabel, onSelect, onConfirm, onCancel, onHide, applying, progress }: ModalProps) {
  const t = useT();
  // Plex: the candidate picked in the list, applied from the footer.
  const [pickedGuid, setPickedGuid] = useState<string | null>(null);
  const resolvedArrTmdbId = arrTmdbId ?? data.arrConfirmedTmdbId;
  const targetName = data.targetTitle || tmdbRef(correctTmdbId, t);

  return (
    <Dialog open onOpenChange={(open) => { if (!open) (applying ? onHide : onCancel)(); }}>
      <DialogPortal>
        <DialogBackdrop />
        <DialogPopup className="max-w-3xl">
          <DialogTitle className="sr-only">
            {server === "jellyfin"
              ? t("adminQueue.fixMatch.srConfirm", { title: targetName })
              : t("adminQueue.fixMatch.srSelect", { title: targetName })}
          </DialogTitle>

        <TargetHeader data={data} correctTmdbId={correctTmdbId} instanceLabel={instanceLabel} resolvedArrTmdbId={resolvedArrTmdbId} />
        <CurrentMatchLine data={data} currentTmdbId={currentTmdbId} />
        <FileNames plexFilePath={data.plexFilePath} jellyfinFilePath={data.jellyfinFilePath} />
        <ArrVerdict resolvedArrTmdbId={resolvedArrTmdbId} correctTmdbId={correctTmdbId} arrConfirmedTitle={data.arrConfirmedTitle} />

        {server === "jellyfin" ? (
          <JellyfinConfirmBody currentTmdbId={currentTmdbId} correctTmdbId={correctTmdbId} instanceLabel={instanceLabel} />
        ) : (
          <PlexCandidateList
            data={data}
            instanceLabel={instanceLabel}
            pickedGuid={pickedGuid}
            onPick={setPickedGuid}
            disabled={applying}
            arrTmdbId={resolvedArrTmdbId}
          />
        )}

        {applying && <ApplyProgress server={server} progress={progress} />}

        <div className="px-6 py-4 border-t border-zinc-700 flex justify-end gap-2 flex-shrink-0">
          <DialogClose
            className="text-sm px-4 py-2 rounded border border-zinc-600 text-zinc-400
              hover:bg-zinc-800 hover:text-zinc-200 transition-colors"
          >
            {applying ? t("adminQueue.fixMatch.hide") : t("shared.common.cancel")}
          </DialogClose>
          <button
            onClick={server === "jellyfin" ? onConfirm : () => { if (pickedGuid) onSelect(pickedGuid); }}
            disabled={applying || (server === "plex" && pickedGuid === null)}
            className="text-sm px-4 py-2 rounded border font-medium transition-colors
              bg-orange-500/10 border-orange-600/30 text-orange-400
              hover:bg-orange-500/20 hover:border-orange-500/50
              disabled:opacity-50 disabled:cursor-not-allowed"
          >
            {applying ? t("adminQueue.fixMatch.applying") : t("adminQueue.fixMatch.applyMatch")}
          </button>
        </div>
        </DialogPopup>
      </DialogPortal>
    </Dialog>
  );
}

// The CORRECT title: poster, id (and which server / what the arr says), year,
// runtime, rating, IMDb id, genres and overview.
function TargetHeader({ data, correctTmdbId, instanceLabel, resolvedArrTmdbId }: {
  data: CandidatesResponse;
  correctTmdbId: number;
  instanceLabel: string;
  resolvedArrTmdbId: number | null;
}) {
  const t = useT();
  const { targetTitle, targetYear, targetImdbId, targetPosterPath, targetOverview, targetReleaseDate, targetVoteAverage, targetRuntime, targetGenres } = data;
  const tmdbPoster = posterUrl(targetPosterPath, "w342");
  return (
    <div className="px-6 pt-5 pb-4 border-b border-zinc-700 flex-shrink-0 flex gap-4 items-start">
      {tmdbPoster && (
        <div className="flex-shrink-0 w-16 h-[96px] rounded overflow-hidden">
          {/* eslint-disable-next-line @next/next/no-img-element -- tiny 64×96 modal thumbnail; next/image optimizer round-trip isn't worth it for a one-shot picker */}
          <img src={tmdbPoster} alt={targetTitle || t("adminQueue.fixMatch.poster")} className="w-full h-full object-cover" />
        </div>
      )}
      <div className="flex-1 min-w-0">
        <p className="text-xs font-medium text-zinc-500 uppercase tracking-wide mb-1">
          {t("adminQueue.fixMatch.target", { id: correctTmdbId })}
          {instanceLabel && (
            <span className="ml-2 text-orange-400 normal-case">· {t("adminQueue.fixMatch.onInstance", { instance: instanceLabel })}</span>
          )}
          {resolvedArrTmdbId === correctTmdbId && (
            <span className="ml-2 text-emerald-400">· {t("adminQueue.fixMatch.arrConfirmedShort")}</span>
          )}
          {resolvedArrTmdbId !== null && resolvedArrTmdbId !== correctTmdbId && (
            <span className="ml-2 text-yellow-400">· {t("adminQueue.fixMatch.arrSays", { id: resolvedArrTmdbId })}</span>
          )}
        </p>
        <p className="text-base font-semibold text-zinc-100 leading-tight">{targetTitle || tmdbRef(correctTmdbId, t)}</p>
        <div className="flex items-center gap-3 mt-1 flex-wrap">
          {(targetReleaseDate ?? targetYear) && (
            <span className="text-sm text-zinc-400">{targetReleaseDate?.slice(0, 10) ?? targetYear}</span>
          )}
          {/* TMDB answers runtime 0 for many unreleased titles: a bare
              `0 &&` would render the digit. */}
          {targetRuntime != null && targetRuntime > 0 && (
            <span className="text-sm text-zinc-500">{t("adminQueue.fixMatch.minutes", { minutes: targetRuntime })}</span>
          )}
          {targetVoteAverage != null && targetVoteAverage > 0 && (
            <span className="text-sm text-zinc-500">★ {targetVoteAverage.toFixed(1)}</span>
          )}
          {targetImdbId && (
            <span className="text-sm text-zinc-500 font-mono">{targetImdbId}</span>
          )}
        </div>
        {targetGenres.length > 0 && (
          <div className="flex gap-1.5 mt-1.5 flex-wrap">
            {targetGenres.slice(0, 4).map((g) => (
              <span key={g} className="text-xs px-2 py-0.5 rounded bg-zinc-800 text-zinc-400 border border-zinc-700">{g}</span>
            ))}
          </div>
        )}
        {targetOverview && (
          <p className="text-xs text-zinc-500 mt-2 leading-snug line-clamp-3">{targetOverview}</p>
        )}
      </div>
    </div>
  );
}

// What the library row is matched to NOW, so the admin reads "X → Y".
function CurrentMatchLine({ data, currentTmdbId }: { data: CandidatesResponse; currentTmdbId: number }) {
  const t = useT();
  return (
    <div className="mx-6 mt-3 flex-shrink-0 flex items-baseline gap-2 flex-wrap text-xs">
      <span className="text-zinc-500">{t("adminQueue.fixMatch.currentlyMatched")}</span>
      <span className="font-medium text-zinc-200">
        {data.currentTitle ?? tmdbRef(currentTmdbId, t)}{data.currentYear ? ` (${data.currentYear})` : ""}
      </span>
      <span className="font-mono text-zinc-500">{tmdbRef(currentTmdbId, t)}</span>
    </div>
  );
}

// The file each server holds for the row (its name; the full path is the tooltip).
function FileNames({ plexFilePath, jellyfinFilePath }: { plexFilePath: string | null; jellyfinFilePath: string | null }) {
  const plexFileName = fileNameOf(plexFilePath);
  const jellyfinFileName = fileNameOf(jellyfinFilePath);
  if (!plexFileName && !jellyfinFileName) return null;
  return (
    <div className="mx-6 mt-3 flex-shrink-0 space-y-1.5">
      {plexFileName && (
        <div className="flex items-center gap-2">
          {/* Brand identity as TEXT takes the per-theme text token, never
              the warning colour (guardrail 42) — one colour per brand. */}
          <span className="text-xs font-semibold text-[var(--ds-plex-text)] w-16 shrink-0">{mediaServerName("plex")}</span>
          <p className="text-xs font-mono text-zinc-500 truncate" title={plexFilePath ?? undefined}>{plexFileName}</p>
        </div>
      )}
      {jellyfinFileName && (
        <div className="flex items-center gap-2">
          <span className="text-xs font-semibold text-[var(--ds-jellyfin-text)] w-16 shrink-0">{mediaServerName("jellyfin")}</span>
          <p className="text-xs font-mono text-zinc-500 truncate" title={jellyfinFilePath ?? undefined}>{jellyfinFileName}</p>
        </div>
      )}
    </div>
  );
}

// What Radarr/Sonarr says the folder is: a different title (a warning naming
// it), or the target itself (a confirmation). Nothing when it can't say.
function ArrVerdict({ resolvedArrTmdbId, correctTmdbId, arrConfirmedTitle }: {
  resolvedArrTmdbId: number | null;
  correctTmdbId: number;
  arrConfirmedTitle: string | null;
}) {
  const t = useT();
  if (resolvedArrTmdbId === null) return null;
  if (resolvedArrTmdbId !== correctTmdbId) {
    return (
          <div className="mx-6 mt-3 flex-shrink-0 px-4 py-3 rounded border bg-yellow-500/8 border-yellow-500/25 text-yellow-400 space-y-2">
            <div className="flex items-center gap-2 text-xs">
              <span>⚠</span>
              <span className="font-semibold">{t("adminQueue.fixMatch.arrRecommends")}</span>
            </div>
            <div className="flex items-center justify-between gap-2">
              <div>
                {arrConfirmedTitle && (
                  <p className="text-sm font-semibold text-zinc-100 leading-tight">{arrConfirmedTitle}</p>
                )}
                <p className="text-xs font-mono text-yellow-400">{tmdbRef(resolvedArrTmdbId, t)}</p>
              </div>
            </div>
          </div>
    );
  }
  return (
    <div className="mx-6 mt-3 flex-shrink-0 px-4 py-3 rounded border bg-emerald-500/8 border-emerald-500/25 text-xs text-emerald-400 flex items-center gap-2">
      <span>✓</span>
      <span>{t("adminQueue.fixMatch.arrConfirmsHighlighted", { id: resolvedArrTmdbId })}</span>
    </div>
  );
}

// Jellyfin: the one exact remap, spelled out — there is nothing to pick.
function JellyfinConfirmBody({ currentTmdbId, correctTmdbId, instanceLabel }: { currentTmdbId: number; correctTmdbId: number; instanceLabel: string }) {
  const t = useT();
  return (
    <div className="px-6 py-4 flex-1 overflow-y-auto">
      <p className="text-sm text-zinc-300 leading-snug">
        {/* One sentence with an {instance} slot and its full stop INSIDE
            the translation, so each language places the server phrase
            (and its own terminal punctuation — "。" in zh) itself. The
            slot is a React node via rich(); interpolate leaves an
            unsupplied placeholder intact for it. Empty on the default
            server. */}
        {rich(t("adminQueue.fixMatch.reidentify", { from: currentTmdbId, to: correctTmdbId }), {
          instance: instanceLabel
            ? <span className="text-orange-400"> {t("adminQueue.fixMatch.onInstance", { instance: instanceLabel })}</span>
            : null,
        })}
      </p>
      <p className="text-xs text-zinc-500 mt-2 leading-snug">
        {t("adminQueue.fixMatch.jellyfinNote")}
      </p>
    </div>
  );
}

// Plex: the server's own candidates as ONE choice (a radio group): arrows move
// the pick, Tab leaves the list. Picking never applies (the footer does).
function PlexCandidateList({ data, instanceLabel, pickedGuid, onPick, disabled, arrTmdbId }: {
  data: CandidatesResponse;
  instanceLabel: string;
  pickedGuid: string | null;
  onPick: (guid: string) => void;
  disabled: boolean;
  arrTmdbId: number | null;
}) {
  const t = useT();
  const headingId = useId();
  const listRef = useRef<HTMLDivElement>(null);
  const { candidates } = data;
  // The roving tab stop: the picked row, else the first.
  const tabGuid = pickedGuid ?? candidates[0]?.guid ?? null;

  function onListKey(e: KeyboardEvent<HTMLDivElement>) {
    const step = e.key === "ArrowDown" || e.key === "ArrowRight" ? 1 : e.key === "ArrowUp" || e.key === "ArrowLeft" ? -1 : 0;
    const edge = e.key === "Home" ? 0 : e.key === "End" ? candidates.length - 1 : -1;
    if ((step === 0 && edge < 0) || disabled || candidates.length === 0) return;
    e.preventDefault();
    const at = Math.max(0, candidates.findIndex((c) => c.guid === tabGuid));
    const next = edge >= 0 ? edge : (at + step + candidates.length) % candidates.length;
    onPick(candidates[next].guid);
    listRef.current?.querySelectorAll<HTMLElement>('[role="radio"]')[next]?.focus();
  }

  return (<>
        <div className="px-6 py-3 flex-shrink-0 flex items-center justify-between">
          <p id={headingId} className="text-xs font-medium text-zinc-500 uppercase tracking-wide">
            {t("adminQueue.fixMatch.plexCandidatesHeading")}
            {instanceLabel && (
              <span className="ml-1.5 text-orange-400 normal-case">{t("adminQueue.fixMatch.onInstance", { instance: instanceLabel })}</span>
            )}
          </p>
          <p className="text-xs text-zinc-500">{t("adminQueue.fixMatch.found", { count: candidates.length })}</p>
        </div>

        <div
          ref={listRef}
          className="overflow-y-auto flex-1 divide-y divide-zinc-800/60"
          {...(candidates.length > 0 ? { role: "radiogroup", "aria-labelledby": headingId, onKeyDown: onListKey } : {})}
        >
          {candidates.length === 0 ? (
            <p className="px-6 py-8 text-sm text-zinc-500 text-center">{t("adminQueue.fixMatch.noCandidates")}</p>
          ) : (
            candidates.map((c) => (
              <CandidateRow key={c.guid} candidate={c} onPick={onPick} picked={c.guid === pickedGuid} disabled={disabled}
                tabbable={c.guid === tabGuid}
                targetImdbId={data.targetImdbId} targetRuntime={data.targetRuntime} targetGenres={data.targetGenres}
                arrTmdbId={arrTmdbId} serverInstance={data.serverInstance} />
            ))
          )}
        </div>
  </>);
}

// While the job runs: what the server said last, the clock, and the copy.
function ApplyProgress({ server, progress }: { server: "plex" | "jellyfin"; progress: FixMatchProgressView | null }) {
  const t = useT();
  return (
    <div className="mx-6 mb-3 flex-shrink-0 px-4 py-3 rounded border bg-zinc-800/60 border-zinc-700 text-xs text-zinc-300 space-y-1">
      <p>
        {progress?.remoteApplied
          ? t("adminQueue.fixMatch.accepted", { server: mediaServerName(server) })
          : t("adminQueue.fixMatch.applyingOn", { server: mediaServerName(server) })}
        <span className="ml-2 font-mono text-zinc-500">{formatElapsed(progress?.elapsedMs ?? 0)}</span>
        {(progress?.copies ?? 0) > 1 && (
          <span className="ml-2 text-zinc-500">{copyOfSuffix(progress, t).trimStart()}</span>
        )}
      </p>
      <p className="text-zinc-500">
        {t("adminQueue.fixMatch.slowNote")}
      </p>
      {(progress?.readFailures ?? 0) > 0 && (
        <p className="text-yellow-400">{t("adminQueue.fixMatch.notAnswering")}</p>
      )}
    </div>
  );
}

// A candidate's runtime minus the target's, in minutes; null when either is unknown
// (TMDB answers 0 for many unreleased titles).
function runtimeDelta(candidate: number | null, target: number | null): number | null {
  if (candidate == null || candidate <= 0 || target == null || target <= 0) return null;
  return candidate - target;
}

// The row's badge: the arr's own pick wins, then the scorer's level (or "Arr ✓").
function candidateBadge(candidate: PlexCandidate, arrMatch: boolean, level: CandidateMatch, t: Translator): { text: string; className: string } {
  if (arrMatch) return { text: t("adminQueue.fixMatch.arrBadge"), className: "font-semibold bg-emerald-500/20 text-emerald-400 border-emerald-500/40" };
  return {
    text: candidate.radarrConfirmed ? t("adminQueue.fixMatch.arrShort") : t(`adminQueue.fixMatch.level.${level}`),
    className: `font-medium ${LEVEL_STYLES[level].badge}`,
  };
}

function CandidateRow({
  candidate, onPick, picked, disabled, tabbable, targetImdbId, targetRuntime, targetGenres, arrTmdbId, serverInstance,
}: {
  candidate:      PlexCandidate;
  onPick:         (guid: string) => void;
  picked:         boolean;
  disabled:       boolean;
  /** The group's one tab stop (roving tabindex). */
  tabbable:       boolean;
  targetImdbId:   string;
  targetRuntime:  number | null;
  targetGenres:   string[];
  arrTmdbId:      number | null;
  serverInstance: string;
}) {
  const t = useT();
  // A relative Plex thumb path is server-local like the ratingKey, so the proxy
  // needs the same instance the candidates came from. Omitted when default.
  const thumbSrc = candidate.thumb
    ? withBasePath(`/api/admin/fix-match/thumb?${new URLSearchParams({
        path: candidate.thumb,
        ...(serverInstance ? { serverInstance } : {}),
      })}`)
    : posterUrl(candidate.tmdbPosterPath, "w342");
  const arrMatch = arrTmdbId !== null && candidate.tmdbId === String(arrTmdbId);

  const effectiveLevel: CandidateMatch = arrMatch ? "exact" : candidate.matchLevel;
  const style    = LEVEL_STYLES[effectiveLevel];
  const badge    = candidateBadge(candidate, arrMatch, effectiveLevel, t);
  const isSuggested = candidate.suggested || arrMatch;

  // A radio in the candidates' group; phrasing content only (spans), which is
  // all a <button> may hold.
  return (
    <button
      type="button"
      role="radio"
      onClick={() => onPick(candidate.guid)}
      disabled={disabled}
      aria-checked={picked}
      tabIndex={tabbable ? 0 : -1}
      className={`w-full text-left px-5 py-3.5 flex items-start gap-4 transition-colors
        disabled:opacity-50 disabled:cursor-not-allowed
        ${style.border} ${style.bg}`}
      style={picked ? { boxShadow: "inset 0 0 0 2px var(--ds-accent-ring)" } : undefined}
    >
      <span className="flex-shrink-0 w-14 h-[84px] rounded overflow-hidden bg-zinc-800 flex items-center justify-center mt-0.5">
        {thumbSrc ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img src={thumbSrc} alt={candidate.name || t("adminQueue.fixMatch.thumb")} className="w-full h-full object-cover" />
        ) : (
          <span className="text-zinc-500 text-xs">?</span>
        )}
      </span>

      <span className="block flex-1 min-w-0">
        <span className="flex items-center gap-2 flex-wrap">
          <span className="text-base font-medium text-zinc-200 leading-tight">
            {(candidate.tmdbTitle ?? candidate.name) || t("adminQueue.fixMatch.untitled")}
          </span>
          {candidate.year && (
            <span className="text-sm text-zinc-500">({candidate.year})</span>
          )}
          <span className={`text-xs px-1.5 py-0.5 rounded border ${badge.className}`}>{badge.text}</span>
          {isSuggested && !arrMatch && (
            <span className="text-xs px-1.5 py-0.5 rounded bg-orange-500/20 text-orange-400 border border-orange-500/30 font-medium">
              {t("adminQueue.fixMatch.suggested")}
            </span>
          )}
          {candidate.confidence > 0 && candidate.matchLevel !== "exact" && (
            <span className="text-xs text-zinc-500">{candidate.confidence}%</span>
          )}
        </span>

        <CandidateFacts candidate={candidate} targetImdbId={targetImdbId} targetRuntime={targetRuntime} />

        {candidate.tmdbGenres.length > 0 && <CandidateGenres genres={candidate.tmdbGenres} targetGenres={targetGenres} />}

        {candidate.tmdbOverview && candidate.matchLevel !== "wrong" && (
          <span className="block text-xs text-zinc-500 mt-1.5 leading-snug line-clamp-2">{candidate.tmdbOverview}</span>
        )}
      </span>

      <span className="flex-shrink-0 text-xs text-zinc-500 mt-1">
        {picked ? <Check aria-hidden className="w-4 h-4 text-[var(--ds-accent-text)]" /> : t("adminQueue.fixMatch.select")}
      </span>
    </button>
  );
}

// Runtime (against the target's), rating and ids; the guid's tail when it has neither id.
function CandidateFacts({ candidate, targetImdbId, targetRuntime }: { candidate: PlexCandidate; targetImdbId: string; targetRuntime: number | null }) {
  const t = useT();
  const hash = candidate.guid.split("/").pop() ?? candidate.guid;
  const delta = runtimeDelta(candidate.tmdbRuntime, targetRuntime);
  return (
    <span className="flex items-center gap-3 mt-1 flex-wrap">
      {candidate.tmdbRuntime != null && candidate.tmdbRuntime > 0 && (
        <span className={`text-xs ${delta !== null && Math.abs(delta) <= 5 ? "text-green-500" : "text-zinc-500"}`}>
          {t("adminQueue.fixMatch.minutes", { minutes: candidate.tmdbRuntime })}
          {delta !== null ? ` (${delta > 0 ? "+" : ""}${delta})` : null}
        </span>
      )}
      {candidate.tmdbVoteAvg != null && candidate.tmdbVoteAvg > 0 && (
        <span className="text-xs text-zinc-500">★ {candidate.tmdbVoteAvg.toFixed(1)}</span>
      )}
      {candidate.tmdbId && (
        <span className="text-xs font-mono text-zinc-500">tmdb:{candidate.tmdbId}</span>
      )}
      {candidate.imdbId && (
        <span className={`text-xs font-mono ${candidate.imdbId === targetImdbId ? "text-green-500" : "text-zinc-500"}`}>
          {candidate.imdbId}
        </span>
      )}
      {!candidate.tmdbId && !candidate.imdbId && (
        <span className="text-xs font-mono text-zinc-500 truncate" title={candidate.guid}>{hash}</span>
      )}
    </span>
  );
}

// The candidate's first genres, those it shares with the target marked.
function CandidateGenres({ genres, targetGenres }: { genres: string[]; targetGenres: string[] }) {
  return (
    <span className="flex gap-1.5 mt-1.5 flex-wrap">
      {genres.slice(0, 4).map((g) => (
        <span
          key={g}
          className={`text-xs px-1.5 py-0.5 rounded border
            ${targetGenres.includes(g)
              ? "bg-emerald-500/10 text-emerald-400 border-emerald-500/30"
              : "bg-zinc-800 text-zinc-500 border-zinc-700"
            }`}
        >
          {g}
        </span>
      ))}
    </span>
  );
}

// Admin control to correct a wrong library→TMDB match. Plex opens a candidate
// picker (fetch → select → apply); Jellyfin opens a confirmation card for the
// exact target (fetch → confirm → apply) — there are no candidates to choose
// from because the apply is deterministic by TMDB id.
export function FixMatchButton({
  server, tmdbId, mediaType, correctTmdbId, label, arrTmdbId = null,
  serverInstance = DEFAULT_MEDIA_INSTANCE,
}: Props) {
  const router = useRouter();
  const t = useT();
  const [state, setState] = useState<State>({ phase: "idle" });
  const { phase } = state;
  // The candidates read: aborted on unmount, its late answer dropped.
  const reads = useAsyncAction();
  // Aborts the runFixMatch poll loop on unmount; the server-side job runs on.
  const applyAbort = useRef<AbortController | null>(null);
  useEffect(() => () => applyAbort.current?.abort(), []);

  // Two library rows can share a tmdbId once a second server is configured, so a
  // bare "Fix match" is ambiguous — name the server on both the button and the
  // picker. Empty for the default instance (single-server deployments unchanged).
  const instanceLabel = serverInstance === DEFAULT_MEDIA_INSTANCE
    ? ""
    : mediaInstanceLabel(server, serverInstance);

  const reset = useCallback(() => setState({ phase: "idle" }), []);

  async function handleClick() {
    // A run whose window was hidden comes back instead of starting another.
    if (state.phase === "applying") {
      setState((s) => (s.phase === "applying" ? { ...s, hidden: false } : s));
      return;
    }
    // Both servers fetch first and open the modal: Plex gets the candidate
    // picker, Jellyfin gets a confirmation card (its target is already exact, so
    // there is nothing to pick — but the admin sees WHAT will be applied before
    // a heavyweight full refresh fires). The default instance is left out of
    // the query, so it is byte-identical to the pre-multi-server one.
    setState({ phase: "fetching" });
    const res = await reads.run("candidates", (signal) =>
      fetchFixMatchCandidates({ server, tmdbId, mediaType, correctTmdbId, arrTmdbId, serverInstance }, signal));
    if (!res) return;
    setState(res.ok ? { phase: "selecting", data: res.data } : { phase: "error", message: candidatesErrorText(res, t) });
  }

  async function applyFix(data: CandidatesResponse, canonicalGuid: string | undefined) {
    setState({ phase: "applying", data, progress: null, hidden: false });
    const ac = new AbortController();
    applyAbort.current = ac;
    try {
      // Background job + status poll (guardrail 37a): a series remap can take
      // minutes on the media server — longer than a reverse proxy keeps one
      // request open — so the old single POST came back as a 502 while the
      // remap quietly succeeded. serverInstance omitted when default — same
      // byte-identical rationale as the candidates query above.
      const outcome = await runFixMatch({
        server, tmdbId, mediaType, correctTmdbId, canonicalGuid,
        ...(serverInstance ? { serverInstance } : {}),
      }, {
        onProgress: (progress) => setState((s) => (s.phase === "applying" ? { ...s, progress } : s)),
        signal: ac.signal,
      });
      // The server's partial-remap note and/or the translated "joined" notice;
      // the helper never returns English of its own (the lib only hands back
      // codes).
      const warning = fixMatchWarningMessage(outcome, t);
      setState(warning ? { phase: "conflated", note: warning } : { phase: "success" });
      router.refresh();
    } catch (err) {
      if (err instanceof DOMException && err.name === "AbortError") return; // unmounted; job runs on
      // A refusal is the server's own translated reason: a 409 for another fix
      // of the same item still running, a locked item, and so on.
      setState({ phase: "error", message: fixMatchErrorMessage(err, t) });
    }
  }

  // The row can outlive the refresh (no re-sync yet, or a partial remap whose
  // failed copies stay on the old row — guardrail 37), so the settled states
  // offer the way back to the button, like the error state does.
  const dismiss = (
    <button onClick={reset} className="text-[11px] text-zinc-500 hover:text-zinc-300 text-left">{t("shared.common.dismiss")}</button>
  );

  if (phase === "success") {
    return (
      <div className="flex flex-col gap-0.5">
        <span className="text-[10px] text-green-400 font-medium">{t("adminQueue.fixMatch.fixedResync")}</span>
        {dismiss}
      </div>
    );
  }

  if (phase === "conflated") {
    return (
      <div className="flex flex-col gap-0.5">
        {/* A Jellyfin job warns too (some copies of the title failed to
            re-match, or an identical job was already running) — the Plex
            metadata-merge headline would misdescribe it. */}
        <span className="text-[10px] text-yellow-400 font-medium">
          {server === "plex" ? t("adminQueue.fixMatch.dbUpdatedPlex") : t("adminQueue.fixMatch.dbUpdatedNote")}
        </span>
        <span className="text-[9px] text-zinc-500 leading-tight max-w-[200px]">{state.note}</span>
        {dismiss}
      </div>
    );
  }

  const modal = state.phase === "selecting" || (state.phase === "applying" && !state.hidden) ? state : null;
  return (
    <>
      {modal && (
        <FixMatchModal
          server={server}
          data={modal.data}
          currentTmdbId={tmdbId}
          correctTmdbId={correctTmdbId}
          arrTmdbId={arrTmdbId}
          instanceLabel={instanceLabel}
          onSelect={(guid) => void applyFix(modal.data, guid)}
          onConfirm={() => void applyFix(modal.data, undefined)}
          onCancel={reset}
          onHide={() => setState((s) => (s.phase === "applying" ? { ...s, hidden: true } : s))}
          applying={modal.phase === "applying"}
          progress={modal.phase === "applying" ? modal.progress : null}
        />
      )}

      <div className="flex flex-col gap-0.5">
        <button
          onClick={handleClick}
          disabled={state.phase === "fetching" || (state.phase === "applying" && !state.hidden)}
          className="text-[10px] px-2 py-1 rounded border font-medium transition-colors
            bg-orange-500/10 border-orange-600/30 text-orange-400
            hover:bg-orange-500/20 hover:border-orange-500/50
            disabled:opacity-50 disabled:cursor-not-allowed"
        >
          {state.phase === "fetching"
            ? t("adminQueue.fixMatch.loading")
            : state.phase === "applying"
              ? fixMatchRunningLabel(state.progress, t)
              : instanceLabel ? `${label} · ${instanceLabel}` : label}
        </button>
        {state.phase === "error" && (
          <>
            <span role="alert" className="text-[11px] text-red-400 leading-tight">{state.message}</span>
            {dismiss}
          </>
        )}
      </div>
    </>
  );
}
