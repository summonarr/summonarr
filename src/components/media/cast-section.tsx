"use client";

import { useState, useEffect, useCallback } from "react";
import Image from "next/image";
import { useRouter } from "next/navigation";
import { X, User, Film, Tv2, PlayCircle, MonitorPlay, Clock, CheckCircle, Plus, Loader2, Check } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { RatingsBar } from "@/components/media/ratings-bar";
import { cn } from "@/lib/utils";
import type { CastMember, PersonDetails, PersonCredit } from "@/lib/tmdb-types";

type CreditReqState = "idle" | "confirm" | "loading" | "requested" | "error";

function creditKey(credit: PersonCredit) {
  return `${credit.mediaType}-${credit.id}`;
}

interface CastSectionProps {
  cast: CastMember[];
}

export function CastSection({ cast }: CastSectionProps) {
  const [selectedActor, setSelectedActor] = useState<CastMember | null>(null);
  const [personData, setPersonData] = useState<PersonDetails | null>(null);
  const [loading, setLoading] = useState(false);
  const [reqStates, setReqStates] = useState<Map<string, CreditReqState>>(new Map());
  const router = useRouter();

  function getReqState(credit: PersonCredit): CreditReqState {
    return reqStates.get(creditKey(credit)) ?? "idle";
  }

  async function submitCreditRequest(credit: PersonCredit) {
    const key = creditKey(credit);
    setReqStates((prev) => new Map(prev).set(key, "loading"));
    try {
      const mt = credit.mediaType === "movie" ? "MOVIE" : "TV";
      let token = (credit as unknown as Record<string, unknown>).requestToken as string | undefined;
      if (!token) {
        const tokenRes = await fetch(`/api/requests/token?tmdbId=${credit.id}&mediaType=${mt}`);
        if (tokenRes.ok) token = (await tokenRes.json()).token;
      }
      const res = await fetch("/api/requests", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ tmdbId: credit.id, mediaType: mt, _token: token }),
      });
      setReqStates((prev) => new Map(prev).set(key, res.ok || res.status === 409 ? "requested" : "error"));
    } catch {
      setReqStates((prev) => new Map(prev).set(key, "error"));
    }
  }

  function handleCreditClick(credit: PersonCredit) {
    close();
    router.push(credit.mediaType === "movie" ? `/movie/${credit.id}` : `/tv/${credit.id}`);
  }

  function handleCreditBubbleClick(e: React.MouseEvent, credit: PersonCredit) {
    e.stopPropagation();
    const isAvailable = !!(credit.plexAvailable || credit.jellyfinAvailable);
    const rs = getReqState(credit);

    const isRequested = !!(credit.requestedByMe || credit.arrPending) || rs === "requested";

    if (isAvailable) {
      close();
      router.push(credit.mediaType === "movie" ? `/movie/${credit.id}` : `/tv/${credit.id}`);
    } else if (credit.arrPending || isRequested) {
      close();
      router.push("/requests");
    } else if (rs === "idle" || rs === "error") {
      setReqStates((prev) => new Map(prev).set(creditKey(credit), "confirm"));
    } else if (rs === "confirm") {
      submitCreditRequest(credit);
    }
  }

  function cancelCreditConfirm(e: React.MouseEvent, credit: PersonCredit) {
    e.stopPropagation();
    setReqStates((prev) => new Map(prev).set(creditKey(credit), "idle"));
  }

  const openActor = useCallback(async (member: CastMember) => {
    setSelectedActor(member);
    setPersonData(null);
    setLoading(true);
    try {
      const res = await fetch(`/api/person/${member.id}`);
      if (res.ok) setPersonData(await res.json());
    } finally {
      setLoading(false);
    }
  }, []);

  const close = useCallback(() => {
    setSelectedActor(null);
    setPersonData(null);
  }, []);

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") close();
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [close]);

  useEffect(() => {
    if (selectedActor) {
      document.body.style.overflow = "hidden";
    } else {
      document.body.style.overflow = "";
    }
    return () => { document.body.style.overflow = ""; };
  }, [selectedActor]);

  return (
    <>
      <div className="px-6 pb-10">
        <h2 className="text-lg font-semibold text-white mb-4">Cast</h2>
        <div className="grid grid-cols-3 sm:grid-cols-4 md:grid-cols-6 lg:grid-cols-8 xl:grid-cols-12 2xl:grid-cols-16 gap-3">
          {cast.map((member) => (
            <button
              key={member.id}
              onClick={() => openActor(member)}
              className="flex flex-col items-center gap-1.5 text-center group focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500 rounded-lg p-1"
            >
              <div className="relative w-14 h-14 rounded-full overflow-hidden bg-zinc-700 shrink-0 ring-2 ring-transparent group-hover:ring-indigo-500 transition-all">
                {member.profilePath ? (
                  <Image
                    src={`https://image.tmdb.org/t/p/w185${member.profilePath}`}
                    alt={member.name}
                    fill
                    sizes="56px"
                    className="object-cover"
                  />
                ) : (
                  <div className="absolute inset-0 flex items-center justify-center text-zinc-500">
                    <User className="w-6 h-6" />
                  </div>
                )}
              </div>
              <div>
                <p className="text-xs font-medium text-white leading-tight line-clamp-2 group-hover:text-indigo-400 transition-colors">
                  {member.name}
                </p>
                {member.character && (
                  <p className="text-[10px] text-zinc-400 leading-tight line-clamp-1 mt-0.5">
                    {member.character}
                  </p>
                )}
              </div>
            </button>
          ))}
        </div>
      </div>

      {selectedActor && (
        <div
          className="fixed inset-0 z-50 flex items-end sm:items-center justify-center"
          role="dialog"
          aria-modal="true"
          aria-label={`Credits for ${selectedActor.name}`}
        >
          <div
            className="absolute inset-0 bg-black/70 backdrop-blur-sm"
            onClick={close}
          />

          <div className="relative z-10 w-full sm:max-w-2xl xl:max-w-5xl 2xl:max-w-6xl max-h-[85vh] bg-zinc-900 rounded-t-2xl sm:rounded-2xl overflow-hidden flex flex-col shadow-2xl border border-zinc-700/50">
            <div className="flex items-center gap-4 p-5 border-b border-zinc-800">
              <div className="relative w-16 h-16 rounded-full overflow-hidden bg-zinc-700 shrink-0">
                {selectedActor.profilePath ? (
                  <Image
                    src={`https://image.tmdb.org/t/p/w185${selectedActor.profilePath}`}
                    alt={selectedActor.name}
                    fill
                    sizes="64px"
                    className="object-cover"
                  />
                ) : (
                  <div className="absolute inset-0 flex items-center justify-center text-zinc-500">
                    <User className="w-8 h-8" />
                  </div>
                )}
              </div>
              <div className="flex-1 min-w-0">
                <h3 className="text-lg font-bold text-white">{selectedActor.name}</h3>
                <p className="text-sm text-zinc-400">
                  as <span className="text-zinc-300 italic">{selectedActor.character}</span>
                </p>
                {personData && (
                  <p className="text-xs text-zinc-500 mt-0.5">{personData.knownForDepartment}</p>
                )}
              </div>
              <button
                onClick={close}
                className="p-2 rounded-full text-zinc-400 hover:text-white hover:bg-zinc-700 transition-colors shrink-0"
              >
                <X className="w-5 h-5" />
              </button>
            </div>

            <div className="overflow-y-auto flex-1 p-5">
              {loading && (
                <div className="flex flex-col gap-3">
                  <p className="text-sm text-zinc-400">Loading filmography…</p>
                  <div className="grid grid-cols-3 sm:grid-cols-4 lg:grid-cols-5 xl:grid-cols-6 2xl:grid-cols-7 gap-3">
                    {Array.from({ length: 8 }).map((_, i) => (
                      <div key={i} className="aspect-[2/3] rounded-lg bg-zinc-800 animate-pulse" />
                    ))}
                  </div>
                </div>
              )}

              {!loading && personData && personData.credits.length === 0 && (
                <p className="text-sm text-zinc-400">No recent credits found.</p>
              )}

              {!loading && personData && personData.credits.length > 0 && (
                <>
                  <p className="text-xs text-zinc-500 mb-3 uppercase tracking-wide font-medium">
                    Recent filmography
                  </p>
                  <div className="grid grid-cols-3 sm:grid-cols-4 lg:grid-cols-5 xl:grid-cols-6 2xl:grid-cols-7 gap-3">
                    {personData.credits.map((credit) => {
                      const isAvailable = !!(credit.plexAvailable || credit.jellyfinAvailable);
                      const rs = getReqState(credit);

                      const isRequested = !!(credit.requestedByMe || credit.arrPending) || rs === "requested";

                      const overlayLabel = isAvailable
                        ? "View"
                        : credit.arrPending && !isAvailable
                        ? "Pending"
                        : isRequested
                        ? "View Request"
                        : rs === "loading"
                        ? null
                        : "Request";

                      return (
                        <div
                          key={creditKey(credit)}
                          onClick={() => handleCreditClick(credit)}
                          role="button"
                          tabIndex={0}
                          onKeyDown={(e) => e.key === "Enter" && handleCreditClick(credit)}
                          className="group flex flex-col rounded-lg overflow-hidden bg-zinc-800 text-left hover:scale-[1.03] transition-transform cursor-pointer focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500"
                        >
                          <div className="relative aspect-[2/3] w-full bg-zinc-700">
                            {credit.posterPath ? (
                              <Image
                                src={`https://image.tmdb.org/t/p/w342${credit.posterPath}`}
                                alt={credit.title}
                                fill
                                sizes="(max-width: 640px) 33vw, (max-width: 1024px) 25vw, (max-width: 1536px) 16vw, 14vw"
                                className="object-cover"
                              />
                            ) : (
                              <div className="absolute inset-0 flex items-center justify-center text-zinc-600">
                                {credit.mediaType === "movie" ? <Film className="w-8 h-8" /> : <Tv2 className="w-8 h-8" />}
                              </div>
                            )}

                            {}
                            <div className={cn(
                              "absolute inset-0 bg-black/60 transition-opacity flex items-center justify-center pointer-events-none",
                              rs === "confirm" ? "opacity-100" : "opacity-0 group-hover:opacity-100"
                            )}>
                              {rs === "confirm" ? (
                                <div className="pointer-events-auto flex flex-col items-center gap-2 px-2">
                                  <span className="text-white text-[10px] font-semibold text-center leading-tight">Request this?</span>
                                  <div className="flex items-center gap-1.5">
                                    <button
                                      onClick={(e) => handleCreditBubbleClick(e, credit)}
                                      className="text-white text-[10px] font-semibold px-2 py-1 rounded-full bg-indigo-600/90 hover:bg-indigo-500 flex items-center gap-1 transition-colors"
                                    >
                                      <Check className="w-2.5 h-2.5" />
                                      Confirm
                                    </button>
                                    <button
                                      onClick={(e) => cancelCreditConfirm(e, credit)}
                                      className="text-white text-[10px] font-semibold px-2 py-1 rounded-full border border-white/30 bg-white/10 hover:bg-white/20 flex items-center gap-1 transition-colors"
                                    >
                                      <X className="w-2.5 h-2.5" />
                                      Cancel
                                    </button>
                                  </div>
                                </div>
                              ) : (
                                <button
                                  onClick={(e) => handleCreditBubbleClick(e, credit)}
                                  className="pointer-events-auto text-white text-[10px] font-semibold px-2 py-1 rounded-full border border-white/30 bg-white/10 hover:bg-white/20 flex items-center gap-1 transition-colors"
                                >
                                  {rs === "loading"
                                    ? <Loader2 className="w-3 h-3 animate-spin" />
                                    : overlayLabel === "Request"
                                    ? <><Plus className="w-2.5 h-2.5" />{overlayLabel}</>
                                    : overlayLabel}
                                </button>
                              )}
                            </div>

                            <div className="absolute top-1.5 left-1.5 flex flex-col gap-0.5">
                              {credit.plexAvailable && (
                                <div className="flex items-center gap-0.5 bg-[#e5a00d]/90 rounded-full px-1.5 py-0.5 text-[9px] text-black font-semibold">
                                  <PlayCircle className="w-2.5 h-2.5" />Plex
                                </div>
                              )}
                              {credit.jellyfinAvailable && (
                                <div className="flex items-center gap-0.5 bg-[#00a4dc]/90 rounded-full px-1.5 py-0.5 text-[9px] text-white font-semibold">
                                  <MonitorPlay className="w-2.5 h-2.5" />Jellyfin
                                </div>
                              )}
                              {!isAvailable && credit.arrPending && (
                                <div className="flex items-center gap-0.5 bg-orange-500/90 rounded-full px-1.5 py-0.5 text-[9px] text-white font-semibold">
                                  <Clock className="w-2.5 h-2.5" />In Queue
                                </div>
                              )}
                            </div>

                            {!isAvailable && (credit.requested || rs === "requested") && (
                              <div className="absolute bottom-1.5 left-1.5 flex items-center gap-0.5 bg-indigo-600/90 rounded-full px-1.5 py-0.5 text-[9px] text-white font-semibold">
                                <CheckCircle className="w-2.5 h-2.5" />Requested
                              </div>
                            )}
                          </div>

                          <div className="p-2 flex flex-col gap-1">
                            <p className="text-xs font-medium text-white leading-tight line-clamp-2">{credit.title}</p>
                            <div className="flex items-center gap-1 flex-wrap">
                              {credit.releaseYear && (
                                <span className="text-[10px] text-zinc-400">{credit.releaseYear}</span>
                              )}
                              <Badge variant="secondary" className="text-[9px] px-1 py-0 h-3.5 bg-zinc-700 text-zinc-300 border-0">
                                {credit.mediaType === "movie" ? "Movie" : "TV"}
                              </Badge>
                            </div>
                            <div className="min-h-[34px] flex items-start">
                              <RatingsBar
                                imdbRating={credit.imdbRating}
                                rottenTomatoes={credit.rottenTomatoes}
                                rtAudienceScore={credit.rtAudienceScore}
                                metacritic={credit.metacritic}
                                traktRating={credit.traktRating}
                                letterboxdRating={credit.letterboxdRating}
                                mdblistScore={credit.mdblistScore}
                                malRating={credit.malRating}
                                rogerEbertRating={credit.rogerEbertRating}
                                voteAverage={credit.voteAverage}
                                size="sm"
                                compact
                              />
                            </div>
                          </div>
                        </div>
                      );
                    })}
                  </div>
                </>
              )}
            </div>
          </div>
        </div>
      )}
    </>
  );
}
