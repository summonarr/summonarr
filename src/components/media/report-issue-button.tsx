"use client";

import { useState } from "react";
import { AlertTriangle, Loader2, X, ChevronDown } from "lucide-react";
import { Button } from "@/components/ui/button";
import type { TVAvailabilityResponse, TVSeasonInfo } from "@/app/api/tv-availability/route";

type IssueType = "BAD_VIDEO" | "WRONG_AUDIO" | "MISSING_SUBTITLES" | "WRONG_MATCH" | "OTHER";
type IssueScope = "FULL" | "SEASON" | "EPISODE";

const ISSUE_TYPE_LABELS: Record<IssueType, string> = {
  BAD_VIDEO: "Bad video quality / corrupted file",
  WRONG_AUDIO: "Wrong or missing audio track",
  MISSING_SUBTITLES: "Missing subtitles",
  WRONG_MATCH: "Wrong movie / show matched",
  OTHER: "Other",
};

const SCOPE_LABELS: Record<IssueScope, string> = {
  FULL: "Entire show",
  SEASON: "Specific season",
  EPISODE: "Specific episode",
};

interface ReportIssueButtonProps {
  tmdbId: number;
  tvdbId?: number | null;
  mediaType: "MOVIE" | "TV";
  title: string;
  posterPath?: string | null;
}

type DialogState = "idle" | "loading" | "open" | "submitting" | "submitted" | "error";

export function ReportIssueButton({ tmdbId, tvdbId, mediaType, title, posterPath }: ReportIssueButtonProps) {
  const [dialogState, setDialogState] = useState<DialogState>("idle");
  const [issueType, setIssueType] = useState<IssueType>("BAD_VIDEO");
  const [scope, setScope] = useState<IssueScope>("FULL");
  const [note, setNote] = useState("");
  const [errorMsg, setErrorMsg] = useState("");

  const [tvSeasons, setTvSeasons] = useState<TVSeasonInfo[]>([]);
  const [availabilitySource, setAvailabilitySource] = useState<TVAvailabilityResponse["source"]>(null);
  const [selectedSeason, setSelectedSeason] = useState<number | null>(null);
  const [selectedEpisode, setSelectedEpisode] = useState<number | null>(null);
  const [availabilityFailed, setAvailabilityFailed] = useState(false);

  const [manualSeason, setManualSeason] = useState("");
  const [manualEpisode, setManualEpisode] = useState("");

  // Reset season/episode selections when scope changes (setState-during-render avoids useEffect cascade)
  const [prevScope, setPrevScope] = useState(scope);
  if (scope !== prevScope) {
    setPrevScope(scope);
    setSelectedSeason(tvSeasons.length > 0 ? tvSeasons[0].seasonNumber : null);
    setSelectedEpisode(null);
    setManualSeason("");
    setManualEpisode("");
  }

  const isTV = mediaType === "TV";
  const useManualInputs = isTV && (availabilityFailed || (dialogState === "open" && tvSeasons.length === 0));

  async function openDialog() {
    setDialogState("loading");
    setIssueType("BAD_VIDEO");
    setScope("FULL");
    setNote("");
    setErrorMsg("");
    setSelectedSeason(null);
    setSelectedEpisode(null);
    setManualSeason("");
    setManualEpisode("");
    setAvailabilityFailed(false);

    if (isTV) {
      try {
        const res = await fetch(`/api/tv-availability?tmdbId=${tmdbId}`);
        if (res.ok) {
          const data: TVAvailabilityResponse = await res.json();
          setTvSeasons(data.seasons);
          setAvailabilitySource(data.source);
          if (data.seasons.length > 0) {
            setSelectedSeason(data.seasons[0].seasonNumber);
            setSelectedEpisode(data.seasons[0].episodes[0] ?? null);
          }
        } else {
          setAvailabilityFailed(true);
        }
      } catch {
        setAvailabilityFailed(true);
      }
    }

    setDialogState("open");
  }

  function closeDialog() {
    if (dialogState === "submitting") return;
    setDialogState("idle");
  }

  function handleSeasonChange(seasonNum: number) {
    setSelectedSeason(seasonNum);
    const season = tvSeasons.find((s) => s.seasonNumber === seasonNum);
    setSelectedEpisode(season?.episodes[0] ?? null);
  }

  function resolveNumbers(): { season: number | undefined; episode: number | undefined } {
    if (!isTV || scope === "FULL") return { season: undefined, episode: undefined };

    if (useManualInputs) {
      return {
        season: manualSeason ? parseInt(manualSeason, 10) : undefined,
        episode: scope === "EPISODE" && manualEpisode ? parseInt(manualEpisode, 10) : undefined,
      };
    }

    return {
      season: selectedSeason ?? undefined,
      episode: scope === "EPISODE" ? (selectedEpisode ?? undefined) : undefined,
    };
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setDialogState("submitting");
    setErrorMsg("");

    const { season, episode } = resolveNumbers();

    try {
      const res = await fetch("/api/issues", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          tmdbId,
          tvdbId: tvdbId ?? undefined,
          mediaType,
          title,
          posterPath,
          issueType,
          scope: mediaType === "MOVIE" ? "FULL" : scope,
          seasonNumber: season,
          episodeNumber: episode,
          note: note.trim() || undefined,
        }),
      });

      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        setErrorMsg(data.error ?? "Something went wrong");
        setDialogState("open");
        return;
      }

      setDialogState("submitted");
    } catch {
      setErrorMsg("Network error — please try again");
      setDialogState("open");
    }
  }

  const isSubmitting = dialogState === "submitting";
  const currentSeason = tvSeasons.find((s) => s.seasonNumber === selectedSeason);

  const sourceLabel = availabilitySource === "plex"
    ? "Plex"
    : availabilitySource === "jellyfin"
    ? "Jellyfin"
    : availabilitySource === "both"
    ? "Plex & Jellyfin"
    : null;

  return (
    <>
      <Button
        variant="outline"
        size="sm"
        onClick={openDialog}
        className="gap-1.5 border-zinc-700 text-zinc-400 hover:text-amber-400 hover:border-amber-500/50"
      >
        <AlertTriangle className="w-3.5 h-3.5" />
        Report Issue
      </Button>

      {dialogState !== "idle" && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/70"
          onClick={(e) => { if (e.target === e.currentTarget) closeDialog(); }}
        >
          <div className="bg-zinc-900 border border-zinc-800 rounded-xl shadow-2xl w-full max-w-md">
            <div className="flex items-center justify-between px-5 py-4 border-b border-zinc-800">
              <div>
                <h2 className="font-semibold text-white text-base">Report an Issue</h2>
                <p className="text-xs text-zinc-500 mt-0.5 truncate max-w-72">{title}</p>
              </div>
              <button
                onClick={closeDialog}
                disabled={dialogState === "submitting" || dialogState === "loading"}
                className="text-zinc-500 hover:text-zinc-300 disabled:opacity-40"
              >
                <X className="w-4 h-4" />
              </button>
            </div>

            {dialogState === "loading" && (
              <div className="px-5 py-8 flex items-center justify-center gap-2 text-zinc-500 text-sm">
                <Loader2 className="w-4 h-4 animate-spin" />
                Loading library info…
              </div>
            )}

            {dialogState === "submitted" && (
              <div className="px-5 py-8 text-center">
                <div className="w-10 h-10 rounded-full bg-amber-500/10 flex items-center justify-center mx-auto mb-3">
                  <AlertTriangle className="w-5 h-5 text-amber-400" />
                </div>
                <p className="font-medium text-white mb-1">Issue reported</p>
                <p className="text-sm text-zinc-400">An admin will review it shortly.</p>
                <Button onClick={closeDialog} size="sm" variant="outline" className="mt-5 border-zinc-700 text-zinc-400">
                  Close
                </Button>
              </div>
            )}

            {(dialogState === "open" || dialogState === "submitting") && (
              <form onSubmit={handleSubmit} className="px-5 py-4 space-y-4">
                {isTV && sourceLabel && (
                  <p className="text-[11px] text-zinc-500">
                    Showing episodes from your <span className="text-zinc-400 font-medium">{sourceLabel}</span> library
                  </p>
                )}
                {isTV && availabilityFailed && (
                  <p className="text-[11px] text-amber-500/80">
                    Could not load library data — enter season/episode manually
                  </p>
                )}

                <div className="space-y-1.5">
                  <label className="text-xs font-medium text-zinc-400 uppercase tracking-wide">Issue type</label>
                  <SelectField
                    value={issueType}
                    onChange={(v) => setIssueType(v as IssueType)}
                    disabled={isSubmitting}
                    options={Object.entries(ISSUE_TYPE_LABELS).map(([k, v]) => ({ value: k, label: v }))}
                  />
                </div>

                {isTV && (
                  <div className="space-y-1.5">
                    <label className="text-xs font-medium text-zinc-400 uppercase tracking-wide">Affects</label>
                    <SelectField
                      value={scope}
                      onChange={(v) => setScope(v as IssueScope)}
                      disabled={isSubmitting}
                      options={Object.entries(SCOPE_LABELS).map(([k, v]) => ({ value: k, label: v }))}
                    />
                  </div>
                )}

                {isTV && scope !== "FULL" && (
                  <div className="flex gap-3">
                    <div className="flex-1 space-y-1.5">
                      <label className="text-xs font-medium text-zinc-400 uppercase tracking-wide">Season</label>
                      {!useManualInputs ? (
                        <SelectField
                          value={String(selectedSeason ?? "")}
                          onChange={(v) => handleSeasonChange(Number(v))}
                          disabled={isSubmitting}
                          options={tvSeasons.map((s) => ({
                            value: String(s.seasonNumber),
                            label: `Season ${s.seasonNumber}`,
                          }))}
                        />
                      ) : (
                        <NumberInput
                          value={manualSeason}
                          onChange={setManualSeason}
                          placeholder="e.g. 2"
                          required
                          disabled={isSubmitting}
                        />
                      )}
                    </div>

                    {scope === "EPISODE" && (
                      <div className="flex-1 space-y-1.5">
                        <label className="text-xs font-medium text-zinc-400 uppercase tracking-wide">Episode</label>
                        {!useManualInputs && currentSeason ? (
                          <SelectField
                            value={String(selectedEpisode ?? "")}
                            onChange={(v) => setSelectedEpisode(Number(v))}
                            disabled={isSubmitting}
                            options={currentSeason.episodes.map((ep) => ({
                              value: String(ep),
                              label: `Episode ${ep}`,
                            }))}
                          />
                        ) : (
                          <NumberInput
                            value={manualEpisode}
                            onChange={setManualEpisode}
                            placeholder="e.g. 4"
                            required
                            disabled={isSubmitting}
                          />
                        )}
                      </div>
                    )}
                  </div>
                )}

                <div className="space-y-1.5">
                  <label className="text-xs font-medium text-zinc-400 uppercase tracking-wide">
                    Additional details <span className="text-zinc-600 normal-case">(optional)</span>
                  </label>
                  <textarea
                    value={note}
                    onChange={(e) => setNote(e.target.value)}
                    placeholder={issueType === "WRONG_MATCH" ? "What is this actually matched to? Link to correct TMDB page if known." : "Describe the issue…"}
                    maxLength={1000}
                    rows={3}
                    disabled={isSubmitting}
                    className="w-full rounded-lg border border-zinc-700 bg-zinc-800 px-3 py-2 text-sm text-white placeholder-zinc-600 focus:outline-none focus:border-zinc-500 disabled:opacity-50 resize-none"
                  />
                </div>

                {errorMsg && (
                  <p className="text-xs text-red-400">{errorMsg}</p>
                )}

                <div className="flex justify-end gap-2 pt-1">
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    onClick={closeDialog}
                    disabled={isSubmitting}
                    className="border-zinc-700 text-zinc-400"
                  >
                    Cancel
                  </Button>
                  <Button
                    type="submit"
                    size="sm"
                    disabled={isSubmitting}
                    className="bg-amber-600 hover:bg-amber-500 gap-1.5"
                  >
                    {isSubmitting && <Loader2 className="w-3.5 h-3.5 animate-spin" />}
                    Submit Report
                  </Button>
                </div>
              </form>
            )}
          </div>
        </div>
      )}
    </>
  );
}

function SelectField({
  value, onChange, disabled, options,
}: {
  value: string;
  onChange: (v: string) => void;
  disabled: boolean;
  options: { value: string; label: string }[];
}) {
  return (
    <div className="relative">
      <select
        value={value}
        onChange={(e) => onChange(e.target.value)}
        disabled={disabled}
        className="w-full appearance-none rounded-lg border border-zinc-700 bg-zinc-800 px-3 py-2 text-sm text-white focus:outline-none focus:border-zinc-500 disabled:opacity-50 pr-8"
      >
        {options.map((o) => (
          <option key={o.value} value={o.value}>{o.label}</option>
        ))}
      </select>
      <ChevronDown className="pointer-events-none absolute right-2.5 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-zinc-500" />
    </div>
  );
}

function NumberInput({
  value, onChange, placeholder, required, disabled,
}: {
  value: string;
  onChange: (v: string) => void;
  placeholder: string;
  required: boolean;
  disabled: boolean;
}) {
  return (
    <input
      type="number"
      min={1}
      value={value}
      onChange={(e) => onChange(e.target.value)}
      placeholder={placeholder}
      required={required}
      disabled={disabled}
      className="w-full rounded-lg border border-zinc-700 bg-zinc-800 px-3 py-2 text-sm text-white placeholder-zinc-600 focus:outline-none focus:border-zinc-500 disabled:opacity-50"
    />
  );
}
