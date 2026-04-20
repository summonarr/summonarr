"use client";

import { useState, useCallback } from "react";
import Image from "next/image";
import { ChevronDown, CheckCircle, Circle, Loader2, Tv2, Calendar } from "lucide-react";
import { cn } from "@/lib/utils";
import { posterUrl, stillUrl, type TmdbSeason, type TmdbEpisode } from "@/lib/tmdb-types";

interface TVSeasonsProps {
  tmdbId: number;
  seasons: TmdbSeason[];

  ownedBySeason: Record<number, number[]>;
}

type LoadState = "idle" | "loading" | "ready" | "error";

interface SeasonState {
  expanded: boolean;
  loadState: LoadState;
  episodes: TmdbEpisode[];

  owned: Set<number>;
}

function formatAirDate(iso: string | null): string | null {
  if (!iso) return null;
  try {
    return new Date(iso).toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" });
  } catch {
    return iso;
  }
}

function formatRuntime(min: number | null): string | null {
  if (!min || min <= 0) return null;
  if (min < 60) return `${min}m`;
  const h = Math.floor(min / 60);
  const m = min % 60;
  return m === 0 ? `${h}h` : `${h}h ${m}m`;
}

export function TVSeasons({ tmdbId, seasons, ownedBySeason }: TVSeasonsProps) {
  const [state, setState] = useState<Record<number, SeasonState>>(() => {
    const init: Record<number, SeasonState> = {};
    for (const s of seasons) {
      init[s.seasonNumber] = {
        expanded: false,
        loadState: "idle",
        episodes: [],
        owned: new Set(ownedBySeason[s.seasonNumber] ?? []),
      };
    }
    return init;
  });

  const toggleSeason = useCallback(
    async (seasonNumber: number) => {
      const current = state[seasonNumber];
      if (!current) return;

      if (current.expanded) {
        setState((prev) => ({ ...prev, [seasonNumber]: { ...prev[seasonNumber], expanded: false } }));
        return;
      }

      if (current.loadState === "ready") {
        setState((prev) => ({ ...prev, [seasonNumber]: { ...prev[seasonNumber], expanded: true } }));
        return;
      }

      setState((prev) => ({
        ...prev,
        [seasonNumber]: { ...prev[seasonNumber], expanded: true, loadState: "loading" },
      }));
      try {
        const res = await fetch(`/api/tv/${tmdbId}/season/${seasonNumber}`);
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const data = (await res.json()) as { episodes: TmdbEpisode[]; owned: number[] };
        setState((prev) => ({
          ...prev,
          [seasonNumber]: {
            ...prev[seasonNumber],
            loadState: "ready",
            episodes: data.episodes ?? [],
            owned: new Set(data.owned ?? []),
          },
        }));
      } catch {
        setState((prev) => ({
          ...prev,
          [seasonNumber]: { ...prev[seasonNumber], loadState: "error" },
        }));
      }
    },
    [state, tmdbId],
  );

  if (seasons.length === 0) return null;

  return (
    <div className="px-6 pb-10">
      <h2 className="text-lg font-semibold text-white mb-4">Seasons</h2>
      <div className="space-y-2">
        {seasons.map((season) => {
          const s = state[season.seasonNumber];
          const ownedCount = s?.owned.size ?? 0;
          const ownershipLabel =
            ownedCount === 0
              ? null
              : ownedCount >= season.episodeCount
              ? "Complete"
              : `${ownedCount} / ${season.episodeCount}`;

          return (
            <div
              key={season.seasonNumber}
              className="rounded-lg border border-zinc-800 bg-zinc-900/60 overflow-hidden"
            >
              <button
                type="button"
                onClick={() => toggleSeason(season.seasonNumber)}
                className="w-full flex items-center gap-4 p-3 text-left hover:bg-zinc-800/50 transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500"
                aria-expanded={s?.expanded ?? false}
                aria-controls={`season-${season.seasonNumber}-panel`}
              >
                <div className="relative w-12 h-18 shrink-0 rounded overflow-hidden bg-zinc-800">
                  {season.posterPath ? (
                    <Image
                      src={posterUrl(season.posterPath, "w342") ?? ""}
                      alt={season.name}
                      fill
                      sizes="48px"
                      className="object-cover"
                    />
                  ) : (
                    <div className="absolute inset-0 flex items-center justify-center text-zinc-600">
                      <Tv2 className="w-5 h-5" />
                    </div>
                  )}
                </div>
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2 flex-wrap">
                    <h3 className="font-semibold text-white truncate">{season.name}</h3>
                    <span className="text-xs text-zinc-500">
                      {season.episodeCount} {season.episodeCount === 1 ? "episode" : "episodes"}
                    </span>
                    {season.airDate && (
                      <span className="flex items-center gap-1 text-xs text-zinc-500">
                        <Calendar className="w-3 h-3" />
                        {new Date(season.airDate).getFullYear()}
                      </span>
                    )}
                  </div>
                  {ownershipLabel && (
                    <div
                      className={cn(
                        "inline-flex items-center gap-1 mt-1 text-[11px] font-semibold px-2 py-0.5 rounded-full",
                        ownedCount >= season.episodeCount
                          ? "bg-emerald-500/10 text-emerald-400 border border-emerald-500/30"
                          : "bg-indigo-500/10 text-indigo-300 border border-indigo-500/30",
                      )}
                    >
                      <CheckCircle className="w-3 h-3" />
                      {ownershipLabel} owned
                    </div>
                  )}
                </div>
                <ChevronDown
                  className={cn(
                    "w-5 h-5 text-zinc-500 shrink-0 transition-transform",
                    s?.expanded && "rotate-180",
                  )}
                />
              </button>

              {s?.expanded && (
                <div id={`season-${season.seasonNumber}-panel`} className="border-t border-zinc-800 p-3">
                  {s.loadState === "loading" && (
                    <div className="flex items-center gap-2 text-sm text-zinc-400 py-4 justify-center">
                      <Loader2 className="w-4 h-4 animate-spin" />
                      Loading episodes…
                    </div>
                  )}

                  {s.loadState === "error" && (
                    <div className="text-sm text-red-400 py-4 text-center">
                      Failed to load episodes.{" "}
                      <button
                        type="button"
                        onClick={() => toggleSeason(season.seasonNumber)}
                        className="underline hover:text-red-300"
                      >
                        Retry
                      </button>
                    </div>
                  )}

                  {s.loadState === "ready" && s.episodes.length === 0 && (
                    <p className="text-sm text-zinc-500 py-4 text-center">No episodes found.</p>
                  )}

                  {s.loadState === "ready" && s.episodes.length > 0 && (
                    <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-3">
                      {s.episodes.map((ep) => {
                        const owned = s.owned.has(ep.episodeNumber);
                        const still = stillUrl(ep.stillPath, "w300");
                        const runtime = formatRuntime(ep.runtime);
                        const aired = formatAirDate(ep.airDate);
                        return (
                          <div
                            key={ep.episodeNumber}
                            className={cn(
                              "group relative flex gap-3 rounded-lg p-2 transition-colors",
                              owned
                                ? "bg-emerald-500/5 border border-emerald-500/20"
                                : "bg-zinc-900 border border-zinc-800",
                            )}
                          >
                            {}
                            <div className="pointer-events-none absolute bottom-full left-0 z-50 mb-2 w-72 opacity-0 transition-opacity duration-150 group-hover:opacity-100">
                              <div className="rounded-lg border border-zinc-700 bg-zinc-900 p-3 shadow-2xl">
                                <div className="mb-2 flex items-start justify-between gap-2">
                                  <p className="text-sm font-semibold leading-snug text-white">{ep.name}</p>
                                  {owned ? (
                                    <CheckCircle className="mt-0.5 h-4 w-4 shrink-0 text-emerald-400" />
                                  ) : (
                                    <Circle className="mt-0.5 h-4 w-4 shrink-0 text-zinc-600" />
                                  )}
                                </div>
                                <div className="mb-2 flex flex-wrap items-center gap-x-2 gap-y-0.5 text-[11px] text-zinc-400">
                                  <span className="font-medium text-zinc-300">E{ep.episodeNumber}</span>
                                  {aired && <><span className="text-zinc-600">·</span><span>{aired}</span></>}
                                  {runtime && <><span className="text-zinc-600">·</span><span>{runtime}</span></>}
                                  {owned && <><span className="text-zinc-600">·</span><span className="text-emerald-400">In library</span></>}
                                </div>
                                {ep.overview && (
                                  <p className="text-xs leading-relaxed text-zinc-300">{ep.overview}</p>
                                )}
                              </div>
                            </div>

                            <div className="relative w-28 aspect-video rounded overflow-hidden bg-zinc-800 shrink-0">
                              {still ? (
                                <Image
                                  src={still}
                                  alt={ep.name}
                                  fill
                                  sizes="112px"
                                  className="object-cover"
                                />
                              ) : (
                                <div className="absolute inset-0 flex items-center justify-center text-zinc-600">
                                  <Tv2 className="w-5 h-5" />
                                </div>
                              )}
                              <div className="absolute top-1 left-1 bg-black/70 rounded px-1.5 py-0.5 text-[10px] font-bold text-white">
                                E{ep.episodeNumber}
                              </div>
                            </div>
                            <div className="flex-1 min-w-0">
                              <div className="flex items-start gap-2">
                                <p className="text-sm font-semibold text-white line-clamp-2 flex-1">
                                  {ep.name}
                                </p>
                                {owned ? (
                                  <CheckCircle
                                    className="w-4 h-4 text-emerald-400 shrink-0 mt-0.5"
                                    aria-label="In library"
                                  />
                                ) : (
                                  <Circle
                                    className="w-4 h-4 text-zinc-600 shrink-0 mt-0.5"
                                    aria-label="Not in library"
                                  />
                                )}
                              </div>
                              <div className="flex items-center gap-2 text-[11px] text-zinc-500 mt-0.5">
                                {aired && <span>{aired}</span>}
                                {aired && runtime && <span className="text-zinc-700">·</span>}
                                {runtime && <span>{runtime}</span>}
                              </div>
                              {ep.overview && (
                                <p className="text-xs text-zinc-400 mt-1 line-clamp-2">{ep.overview}</p>
                              )}
                            </div>
                          </div>
                        );
                      })}
                    </div>
                  )}
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}
