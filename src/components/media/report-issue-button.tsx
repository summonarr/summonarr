"use client";

import { useState } from "react";
import { AlertTriangle, Loader2, X, ChevronDown } from "lucide-react";
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
      <button
        type="button"
        onClick={openDialog}
        className="ds-tap inline-flex items-center gap-1.5 font-medium transition-colors"
        style={{
          padding: "6px 12px",
          height: 32,
          borderRadius: 6,
          fontSize: 12,
          background: "var(--ds-bg-2)",
          color: "var(--ds-fg-muted)",
          border: "1px solid var(--ds-border)",
        }}
        onMouseEnter={(e) => {
          e.currentTarget.style.color = "var(--ds-warning)";
          e.currentTarget.style.borderColor =
            "color-mix(in oklab, var(--ds-warning) 40%, transparent)";
        }}
        onMouseLeave={(e) => {
          e.currentTarget.style.color = "var(--ds-fg-muted)";
          e.currentTarget.style.borderColor = "var(--ds-border)";
        }}
      >
        <AlertTriangle style={{ width: 14, height: 14 }} />
        Report Issue
      </button>

      {dialogState !== "idle" && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center p-4"
          style={{ background: "rgba(0,0,0,0.7)" }}
          onClick={(e) => {
            if (e.target === e.currentTarget) closeDialog();
          }}
        >
          <div
            className="w-full max-w-md"
            style={{
              background: "var(--ds-bg-1)",
              border: "1px solid var(--ds-border)",
              borderRadius: 12,
              boxShadow: "var(--ds-shadow-lg)",
            }}
          >
            <div
              className="flex items-center justify-between"
              style={{
                padding: "14px 20px",
                borderBottom: "1px solid var(--ds-border)",
              }}
            >
              <div>
                <h2
                  className="font-semibold"
                  style={{ fontSize: 15, color: "var(--ds-fg)", margin: 0 }}
                >
                  Report an Issue
                </h2>
                <p
                  className="ds-mono truncate max-w-72"
                  style={{
                    fontSize: 11,
                    color: "var(--ds-fg-subtle)",
                    margin: "2px 0 0",
                  }}
                >
                  {title}
                </p>
              </div>
              <button
                type="button"
                onClick={closeDialog}
                disabled={
                  dialogState === "submitting" || dialogState === "loading"
                }
                className="inline-flex items-center justify-center rounded-full transition-colors disabled:opacity-40"
                style={{
                  width: 28,
                  height: 28,
                  background: "transparent",
                  border: 0,
                  color: "var(--ds-fg-muted)",
                }}
              >
                <X style={{ width: 14, height: 14 }} />
              </button>
            </div>

            {dialogState === "loading" && (
              <div
                className="ds-mono flex items-center justify-center"
                style={{
                  gap: 8,
                  padding: "32px 20px",
                  fontSize: 12,
                  color: "var(--ds-fg-subtle)",
                }}
              >
                <Loader2
                  className="animate-spin"
                  style={{
                    width: 14,
                    height: 14,
                    color: "var(--ds-accent)",
                  }}
                />
                Loading library info…
              </div>
            )}

            {dialogState === "submitted" && (
              <div
                className="text-center"
                style={{ padding: "32px 20px" }}
              >
                <div
                  className="mx-auto flex items-center justify-center rounded-full"
                  style={{
                    width: 40,
                    height: 40,
                    marginBottom: 12,
                    background:
                      "color-mix(in oklab, var(--ds-warning) 12%, transparent)",
                  }}
                >
                  <AlertTriangle
                    style={{
                      width: 20,
                      height: 20,
                      color: "var(--ds-warning)",
                    }}
                  />
                </div>
                <p
                  className="font-medium"
                  style={{ fontSize: 13, color: "var(--ds-fg)", margin: "0 0 4px" }}
                >
                  Issue reported
                </p>
                <p
                  style={{ fontSize: 12, color: "var(--ds-fg-muted)", margin: 0 }}
                >
                  An admin will review it shortly.
                </p>
                <button
                  type="button"
                  onClick={closeDialog}
                  className="ds-tap inline-flex items-center justify-center font-medium transition-colors"
                  style={{
                    marginTop: 18,
                    padding: "6px 14px",
                    height: 30,
                    borderRadius: 6,
                    fontSize: 12,
                    background: "var(--ds-bg-2)",
                    color: "var(--ds-fg)",
                    border: "1px solid var(--ds-border)",
                  }}
                >
                  Close
                </button>
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
                  <button
                    type="button"
                    onClick={closeDialog}
                    disabled={isSubmitting}
                    className="inline-flex items-center justify-center font-medium transition-colors disabled:opacity-50"
                    style={{
                      padding: "6px 12px",
                      height: 30,
                      borderRadius: 6,
                      fontSize: 12,
                      background: "transparent",
                      color: "var(--ds-fg-muted)",
                      border: "1px solid var(--ds-border)",
                    }}
                  >
                    Cancel
                  </button>
                  <button
                    type="submit"
                    disabled={isSubmitting}
                    className="inline-flex items-center justify-center gap-1.5 font-medium transition-colors disabled:opacity-50"
                    style={{
                      padding: "6px 14px",
                      height: 30,
                      borderRadius: 6,
                      fontSize: 12,
                      background: "var(--ds-warning)",
                      color: "oklch(0.18 0 0)",
                      border: "1px solid transparent",
                    }}
                  >
                    {isSubmitting && (
                      <Loader2
                        className="animate-spin"
                        style={{ width: 12, height: 12 }}
                      />
                    )}
                    Submit Report
                  </button>
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
