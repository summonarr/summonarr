"use client";

import { useState, useEffect, useCallback } from "react";
import { createPortal } from "react-dom";
import { useRouter } from "next/navigation";
import { posterUrl } from "@/lib/tmdb-types";
import type { PlexCandidate, CandidateMatch, CandidatesResponse } from "@/app/api/admin/fix-match/candidates/route";

type Phase = "idle" | "fetching" | "selecting" | "applying" | "success" | "conflated" | "error";

interface Props {
  server:        "plex" | "jellyfin";
  tmdbId:        number;
  mediaType:     "MOVIE" | "TV";
  correctTmdbId: number;
  label:         string;

  arrTmdbId?:    number | null;
}

const LEVEL_STYLES: Record<CandidateMatch, { border: string; bg: string; badge: string; label: string }> = {
  exact:   { border: "border-l-2 border-green-500",       bg: "bg-green-500/5 hover:bg-green-500/10",    badge: "bg-green-500/20 text-green-400 border-green-500/40",    label: "Exact" },
  strong:  { border: "border-l-2 border-emerald-500/70",  bg: "bg-emerald-500/5 hover:bg-emerald-500/10", badge: "bg-emerald-500/20 text-emerald-400 border-emerald-500/40", label: "Strong" },
  likely:  { border: "border-l-2 border-yellow-500/70",   bg: "bg-yellow-500/5 hover:bg-yellow-500/10",  badge: "bg-yellow-500/20 text-yellow-400 border-yellow-500/40",  label: "Likely" },
  possible:{ border: "border-l-2 border-zinc-500/50",     bg: "hover:bg-zinc-800",                       badge: "bg-zinc-700 text-zinc-400 border-zinc-600",              label: "Possible" },
  wrong:   { border: "border-l-2 border-red-500/70",      bg: "bg-red-500/5 hover:bg-red-500/10",        badge: "bg-red-500/20 text-red-400 border-red-500/40",           label: "Wrong" },
  unknown: { border: "border-l-2 border-transparent",     bg: "hover:bg-zinc-800",                       badge: "bg-zinc-800 text-zinc-500 border-zinc-700",              label: "Unknown" },
};

interface ModalProps {
  data:          CandidatesResponse;
  correctTmdbId: number;
  arrTmdbId:     number | null;
  onSelect:      (guid: string) => void;
  onCancel:      () => void;
  applying:      boolean;
}

function PlexCandidatesModal({ data, correctTmdbId, arrTmdbId, onSelect, onCancel, applying }: ModalProps) {
  const {
    candidates, targetTitle, targetYear, targetImdbId, targetPosterPath,
    targetOverview, targetReleaseDate, targetVoteAverage, targetRuntime, targetGenres,
    arrConfirmedTmdbId, arrConfirmedTitle, plexFilePath, jellyfinFilePath,
  } = data;
  const tmdbPoster = posterUrl(targetPosterPath, "w342");

  const resolvedArrTmdbId = arrTmdbId ?? arrConfirmedTmdbId;

  const plexFileName     = plexFilePath     ? plexFilePath.replace(/\\/g, "/").split("/").pop()     ?? plexFilePath     : null;
  const jellyfinFileName = jellyfinFilePath ? jellyfinFilePath.replace(/\\/g, "/").split("/").pop() ?? jellyfinFilePath : null;

  useEffect(() => {
    const handler = (e: KeyboardEvent) => { if (e.key === "Escape" && !applying) onCancel(); };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [applying, onCancel]);

  return createPortal(
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 backdrop-blur-sm p-4"
      onClick={(e) => { if (e.target === e.currentTarget && !applying) onCancel(); }}
    >
      <div className="bg-zinc-900 border border-zinc-700 rounded-xl shadow-2xl w-full max-w-3xl max-h-[90vh] flex flex-col">

        <div className="px-6 pt-5 pb-4 border-b border-zinc-700 flex-shrink-0 flex gap-4 items-start">
          {tmdbPoster && (
            <div className="flex-shrink-0 w-16 h-[96px] rounded overflow-hidden">
              {}
              <img src={tmdbPoster} alt={targetTitle || "poster"} className="w-full h-full object-cover" />
            </div>
          )}
          <div className="flex-1 min-w-0">
            <p className="text-xs font-medium text-zinc-500 uppercase tracking-wide mb-1">
              Target — TMDB #{correctTmdbId}
              {resolvedArrTmdbId === correctTmdbId && (
                <span className="ml-2 text-emerald-400">· Radarr/Sonarr confirmed ✓</span>
              )}
              {resolvedArrTmdbId !== null && resolvedArrTmdbId !== correctTmdbId && (
                <span className="ml-2 text-yellow-400">· Arr says TMDB #{resolvedArrTmdbId}</span>
              )}
            </p>
            <p className="text-base font-semibold text-zinc-100 leading-tight">{targetTitle || `TMDB #${correctTmdbId}`}</p>
            <div className="flex items-center gap-3 mt-1 flex-wrap">
              {(targetReleaseDate ?? targetYear) && (
                <span className="text-sm text-zinc-400">{targetReleaseDate?.slice(0, 10) ?? targetYear}</span>
              )}
              {targetRuntime && (
                <span className="text-sm text-zinc-500">{targetRuntime} min</span>
              )}
              {targetVoteAverage != null && targetVoteAverage > 0 && (
                <span className="text-sm text-zinc-500">★ {targetVoteAverage.toFixed(1)}</span>
              )}
              {targetImdbId && (
                <span className="text-sm text-zinc-500 font-mono">{targetImdbId}</span>
              )}
            </div>
            {(targetGenres?.length ?? 0) > 0 && (
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

        {(plexFileName || jellyfinFileName) && (
          <div className="mx-6 mt-3 flex-shrink-0 space-y-1.5">
            {plexFileName && (
              <div className="flex items-center gap-2">
                <span className="text-xs font-semibold text-yellow-500/70 w-16 shrink-0">Plex</span>
                <p className="text-xs font-mono text-zinc-500 truncate" title={plexFilePath ?? undefined}>{plexFileName}</p>
              </div>
            )}
            {jellyfinFileName && (
              <div className="flex items-center gap-2">
                <span className="text-xs font-semibold text-purple-500/70 w-16 shrink-0">Jellyfin</span>
                <p className="text-xs font-mono text-zinc-500 truncate" title={jellyfinFilePath ?? undefined}>{jellyfinFileName}</p>
              </div>
            )}
          </div>
        )}

        {resolvedArrTmdbId !== null && resolvedArrTmdbId !== correctTmdbId && (
          <div className="mx-6 mt-3 flex-shrink-0 px-4 py-3 rounded border bg-yellow-500/8 border-yellow-500/25 text-yellow-300 space-y-2">
            <div className="flex items-center gap-2 text-xs">
              <span>⚠</span>
              <span className="font-semibold">Radarr/Sonarr recommends a different match:</span>
            </div>
            <div className="flex items-center justify-between gap-2">
              <div>
                {arrConfirmedTitle && (
                  <p className="text-sm font-semibold text-yellow-200 leading-tight">{arrConfirmedTitle}</p>
                )}
                <p className="text-xs font-mono text-yellow-400/70">TMDB #{resolvedArrTmdbId}</p>
              </div>
            </div>
          </div>
        )}
        {resolvedArrTmdbId !== null && resolvedArrTmdbId === correctTmdbId && (
          <div className="mx-6 mt-3 flex-shrink-0 px-4 py-3 rounded border bg-emerald-500/8 border-emerald-500/25 text-xs text-emerald-300 flex items-center gap-2">
            <span>✓</span>
            <span><span className="font-semibold">Radarr/Sonarr</span> confirms TMDB #{resolvedArrTmdbId} — matching candidates highlighted below.</span>
          </div>
        )}

        <div className="px-6 py-3 flex-shrink-0 flex items-center justify-between">
          <p className="text-xs font-medium text-zinc-500 uppercase tracking-wide">
            Plex candidates — select the correct match
          </p>
          <p className="text-xs text-zinc-600">{candidates.length} found</p>
        </div>

        <div className="overflow-y-auto flex-1 divide-y divide-zinc-800/60">
          {candidates.length === 0 ? (
            <p className="px-6 py-8 text-sm text-zinc-500 text-center">No candidates found in Plex.</p>
          ) : (
            candidates.map((c) => (
              <CandidateRow key={c.guid} candidate={c} onSelect={onSelect} disabled={applying}
                targetImdbId={targetImdbId} targetRuntime={targetRuntime} targetGenres={targetGenres}
                arrTmdbId={resolvedArrTmdbId} />
            ))
          )}
        </div>

        <div className="px-6 py-4 border-t border-zinc-700 flex justify-end flex-shrink-0">
          <button
            onClick={onCancel}
            disabled={applying}
            className="text-sm px-4 py-2 rounded border border-zinc-600 text-zinc-400
              hover:bg-zinc-800 hover:text-zinc-200 disabled:opacity-50 transition-colors"
          >
            Cancel
          </button>
        </div>
      </div>
    </div>,
    document.body,
  );
}

function CandidateRow({
  candidate, onSelect, disabled, targetImdbId, targetRuntime, targetGenres, arrTmdbId,
}: {
  candidate:     PlexCandidate;
  onSelect:      (guid: string) => void;
  disabled:      boolean;
  targetImdbId:  string;
  targetRuntime: number | null;
  targetGenres:  string[];
  arrTmdbId:     number | null;
}) {
  const hash     = candidate.guid.split("/").pop() ?? candidate.guid;
  const thumbSrc = candidate.thumb
    ? `/api/admin/fix-match/thumb?path=${encodeURIComponent(candidate.thumb)}`
    : posterUrl(candidate.tmdbPosterPath, "w342");
  const arrMatch = arrTmdbId !== null && candidate.tmdbId === String(arrTmdbId);

  const effectiveLevel: CandidateMatch = arrMatch ? "exact" : candidate.matchLevel;
  const style    = LEVEL_STYLES[effectiveLevel];
  const isSuggested = candidate.suggested || arrMatch;

  return (
    <button
      onClick={() => onSelect(candidate.guid)}
      disabled={disabled}
      className={`w-full text-left px-5 py-3.5 flex items-start gap-4 transition-colors
        disabled:opacity-50 disabled:cursor-not-allowed
        ${style.border} ${style.bg}`}
    >
      <div className="flex-shrink-0 w-14 h-[84px] rounded overflow-hidden bg-zinc-800 flex items-center justify-center mt-0.5">
        {thumbSrc ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img src={thumbSrc} alt={candidate.name || "thumb"} className="w-full h-full object-cover" />
        ) : (
          <span className="text-zinc-600 text-xs">?</span>
        )}
      </div>

      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2 flex-wrap">
          <span className="text-base font-medium text-zinc-200 leading-tight">
            {(candidate.tmdbTitle ?? candidate.name) || "(untitled)"}
          </span>
          {candidate.year && (
            <span className="text-sm text-zinc-500">({candidate.year})</span>
          )}
          {arrMatch ? (
            <span className="text-xs px-1.5 py-0.5 rounded border font-semibold bg-emerald-500/20 text-emerald-300 border-emerald-500/40">
              Radarr/Sonarr ✓
            </span>
          ) : (
            <span className={`text-xs px-1.5 py-0.5 rounded border font-medium ${style.badge}`}>
              {candidate.radarrConfirmed ? "Arr ✓" : style.label}
            </span>
          )}
          {isSuggested && !arrMatch && (
            <span className="text-xs px-1.5 py-0.5 rounded bg-orange-500/20 text-orange-400 border border-orange-500/30 font-medium">
              Suggested
            </span>
          )}
          {candidate.confidence > 0 && candidate.matchLevel !== "exact" && (
            <span className="text-xs text-zinc-600">{candidate.confidence}%</span>
          )}
        </div>

        <div className="flex items-center gap-3 mt-1 flex-wrap">
          {candidate.tmdbRuntime && (
            <span className={`text-xs ${targetRuntime && Math.abs(candidate.tmdbRuntime - targetRuntime) <= 5 ? "text-green-500" : "text-zinc-500"}`}>
              {candidate.tmdbRuntime} min
              {targetRuntime && ` (${candidate.tmdbRuntime > targetRuntime ? "+" : ""}${candidate.tmdbRuntime - targetRuntime})`}
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
            <span className="text-xs font-mono text-zinc-700 truncate" title={candidate.guid}>{hash}</span>
          )}
        </div>

        {(candidate.tmdbGenres?.length ?? 0) > 0 && (
          <div className="flex gap-1.5 mt-1.5 flex-wrap">
            {candidate.tmdbGenres.slice(0, 4).map((g) => (
              <span
                key={g}
                className={`text-xs px-1.5 py-0.5 rounded border
                  ${(targetGenres ?? []).includes(g)
                    ? "bg-emerald-500/10 text-emerald-400 border-emerald-500/30"
                    : "bg-zinc-800 text-zinc-500 border-zinc-700"
                  }`}
              >
                {g}
              </span>
            ))}
          </div>
        )}

        {candidate.tmdbOverview && candidate.matchLevel !== "wrong" && (
          <p className="text-xs text-zinc-600 mt-1.5 leading-snug line-clamp-2">{candidate.tmdbOverview}</p>
        )}
      </div>

      <div className="flex-shrink-0 text-xs text-zinc-500 mt-1">Apply →</div>
    </button>
  );
}

export function FixMatchButton({ server, tmdbId, mediaType, correctTmdbId, label, arrTmdbId = null }: Props) {
  const router = useRouter();
  const [phase, setPhase]       = useState<Phase>("idle");
  const [errorMsg, setErrorMsg] = useState("");
  const [candidates, setCandidates] = useState<CandidatesResponse | null>(null);

  const reset = useCallback(() => {
    setPhase("idle");
    setErrorMsg("");
    setCandidates(null);
  }, []);

  async function handleClick() {
    // Jellyfin has no candidate-picker UI; apply the fix directly with the correct TMDB ID
    if (server === "jellyfin") { await applyFix(undefined); return; }
    setPhase("fetching");
    setErrorMsg("");
    try {
      const params = new URLSearchParams({ server, tmdbId: String(tmdbId), mediaType, correctTmdbId: String(correctTmdbId) });
      if (arrTmdbId) params.set("arrTmdbId", String(arrTmdbId));
      const res = await fetch(`/api/admin/fix-match/candidates?${params}`);
      const json = await res.json() as CandidatesResponse & { error?: string };
      if (!res.ok) throw new Error(json.error ?? `HTTP ${res.status}`);
      setCandidates(json);
      setPhase("selecting");
    } catch (err) {
      setErrorMsg(err instanceof Error ? err.message : "Unknown error");
      setPhase("error");
    }
  }

  async function applyFix(canonicalGuid: string | undefined) {
    setPhase("applying");
    setErrorMsg("");
    try {
      const res = await fetch("/api/admin/fix-match", {
        method:  "POST",
        headers: { "Content-Type": "application/json" },
        body:    JSON.stringify({ server, tmdbId, mediaType, correctTmdbId, canonicalGuid }),
      });
      let json: { ok?: boolean; error?: string; warning?: string } = {};
      try { json = await res.json() as { ok?: boolean; error?: string; warning?: string }; } catch { }
      if (!res.ok || !json.ok) throw new Error(json.error ?? `HTTP ${res.status}`);
      setCandidates(null);
      if (json.warning) {
        setErrorMsg(json.warning);
        setPhase("conflated");
      } else {
        setPhase("success");
      }
      router.refresh();
    } catch (err) {
      setErrorMsg(err instanceof Error ? err.message : "Unknown error");
      setPhase("error");
    }
  }

  if (phase === "success") {
    return <span className="text-[10px] text-green-400 font-medium">Fixed — re-sync to confirm</span>;
  }

  if (phase === "conflated") {
    return (
      <div className="flex flex-col gap-0.5">
        <span className="text-[10px] text-yellow-400 font-medium">DB updated — Plex display unchanged</span>
        <span className="text-[9px] text-zinc-500 leading-tight max-w-[200px]">{errorMsg}</span>
      </div>
    );
  }

  return (
    <>
      {(phase === "selecting" || phase === "applying") && candidates && (
        <PlexCandidatesModal
          data={candidates}
          correctTmdbId={correctTmdbId}
          arrTmdbId={arrTmdbId}
          onSelect={(guid) => applyFix(guid)}
          onCancel={reset}
          applying={phase === "applying"}
        />
      )}

      <div className="flex flex-col gap-0.5">
        <button
          onClick={handleClick}
          disabled={phase === "fetching" || phase === "applying"}
          className="text-[10px] px-2 py-1 rounded border font-medium transition-colors
            bg-orange-500/10 border-orange-600/30 text-orange-400
            hover:bg-orange-500/20 hover:border-orange-500/50
            disabled:opacity-50 disabled:cursor-not-allowed"
        >
          {phase === "fetching" ? "Loading…" : phase === "applying" ? "Applying…" : label}
        </button>
        {phase === "error" && (
          <>
            <span className="text-[9px] text-red-400 leading-tight">{errorMsg}</span>
            <button onClick={reset} className="text-[9px] text-zinc-500 hover:text-zinc-300 text-left">Dismiss</button>
          </>
        )}
      </div>
    </>
  );
}
