"use client";

import { useState, useEffect, useCallback } from "react";
import Image from "next/image";
import { useRouter } from "next/navigation";
import { X, User, Film, Tv2, PlayCircle, MonitorPlay, Clock, CheckCircle, Plus, Loader2, Check } from "lucide-react";
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
      <section style={{ padding: "0 16px 32px" }}>
        <h2
          className="section-title font-semibold"
          style={{
            fontSize: 15,
            letterSpacing: "-0.01em",
            color: "var(--ds-fg)",
            margin: "0 0 12px",
          }}
        >
          Cast
        </h2>
        <div className="grid grid-cols-3 sm:grid-cols-4 md:grid-cols-6 lg:grid-cols-8 xl:grid-cols-12 2xl:grid-cols-16 gap-3">
          {cast.map((member) => (
            <button
              key={member.id}
              type="button"
              onClick={() => openActor(member)}
              className="flex flex-col items-center text-center group rounded-lg focus-visible:outline-none focus-visible:ring-2"
              style={{
                gap: 6,
                padding: 4,
                background: "transparent",
                border: 0,
                color: "var(--ds-fg)",
              }}
            >
              <div
                className="relative shrink-0 overflow-hidden rounded-full transition-all"
                style={{
                  width: 56,
                  height: 56,
                  background: "var(--ds-bg-3)",
                  boxShadow: "0 0 0 2px transparent",
                }}
              >
                {member.profilePath ? (
                  <Image
                    src={`https://image.tmdb.org/t/p/w185${member.profilePath}`}
                    alt={member.name}
                    fill
                    sizes="56px"
                    className="object-cover"
                  />
                ) : (
                  <div
                    className="absolute inset-0 flex items-center justify-center"
                    style={{ color: "var(--ds-fg-subtle)" }}
                  >
                    <User style={{ width: 22, height: 22 }} />
                  </div>
                )}
              </div>
              <div>
                <p
                  className="font-medium leading-tight line-clamp-2 transition-colors group-hover:text-[var(--ds-accent)]"
                  style={{ fontSize: 12, color: "var(--ds-fg)" }}
                >
                  {member.name}
                </p>
                {member.character && (
                  <p
                    className="leading-tight line-clamp-1"
                    style={{
                      fontSize: 10,
                      color: "var(--ds-fg-subtle)",
                      marginTop: 2,
                    }}
                  >
                    {member.character}
                  </p>
                )}
              </div>
            </button>
          ))}
        </div>
      </section>

      {selectedActor && (
        <div
          className="fixed inset-0 z-50 flex items-end sm:items-center justify-center"
          role="dialog"
          aria-modal="true"
          aria-label={`Credits for ${selectedActor.name}`}
        >
          <div
            className="absolute inset-0 backdrop-blur-sm"
            style={{ background: "rgba(0,0,0,0.7)" }}
            onClick={close}
          />

          <div
            className="relative z-10 w-full sm:max-w-2xl xl:max-w-5xl 2xl:max-w-6xl max-h-[85vh] overflow-hidden flex flex-col"
            style={{
              background: "var(--ds-bg-1)",
              border: "1px solid var(--ds-border)",
              borderTopLeftRadius: 16,
              borderTopRightRadius: 16,
              borderBottomLeftRadius: 0,
              borderBottomRightRadius: 0,
              boxShadow: "var(--ds-shadow-lg)",
            }}
          >
            <div
              className="flex items-center gap-4"
              style={{
                padding: 18,
                borderBottom: "1px solid var(--ds-border)",
              }}
            >
              <div
                className="relative rounded-full overflow-hidden shrink-0"
                style={{
                  width: 56,
                  height: 56,
                  background: "var(--ds-bg-3)",
                  border: "1px solid var(--ds-border)",
                }}
              >
                {selectedActor.profilePath ? (
                  <Image
                    src={`https://image.tmdb.org/t/p/w185${selectedActor.profilePath}`}
                    alt={selectedActor.name}
                    fill
                    sizes="56px"
                    className="object-cover"
                  />
                ) : (
                  <div
                    className="absolute inset-0 flex items-center justify-center"
                    style={{ color: "var(--ds-fg-subtle)" }}
                  >
                    <User style={{ width: 28, height: 28 }} />
                  </div>
                )}
              </div>
              <div className="flex-1 min-w-0">
                <h3
                  className="font-bold"
                  style={{
                    fontSize: 18,
                    letterSpacing: "-0.01em",
                    color: "var(--ds-fg)",
                    margin: 0,
                  }}
                >
                  {selectedActor.name}
                </h3>
                <p
                  style={{
                    fontSize: 13,
                    color: "var(--ds-fg-muted)",
                    margin: "2px 0 0",
                  }}
                >
                  as{" "}
                  <span className="italic" style={{ color: "var(--ds-fg)" }}>
                    {selectedActor.character}
                  </span>
                </p>
                {personData && (
                  <p
                    className="ds-mono"
                    style={{
                      fontSize: 10.5,
                      color: "var(--ds-fg-subtle)",
                      marginTop: 2,
                    }}
                  >
                    {personData.knownForDepartment}
                  </p>
                )}
              </div>
              <button
                type="button"
                onClick={close}
                className="ds-tap rounded-full transition-colors shrink-0 inline-flex items-center justify-center"
                style={{
                  width: 32,
                  height: 32,
                  background: "transparent",
                  color: "var(--ds-fg-muted)",
                  border: 0,
                }}
                onMouseEnter={(e) => {
                  e.currentTarget.style.background = "var(--ds-bg-3)";
                  e.currentTarget.style.color = "var(--ds-fg)";
                }}
                onMouseLeave={(e) => {
                  e.currentTarget.style.background = "transparent";
                  e.currentTarget.style.color = "var(--ds-fg-muted)";
                }}
              >
                <X style={{ width: 18, height: 18 }} />
              </button>
            </div>

            <div
              className="overflow-y-auto flex-1"
              style={{ padding: 18 }}
            >
              {loading && (
                <div className="flex flex-col gap-3">
                  <p
                    className="ds-mono"
                    style={{ fontSize: 12, color: "var(--ds-fg-subtle)" }}
                  >
                    Loading filmography…
                  </p>
                  <div className="grid grid-cols-3 sm:grid-cols-4 lg:grid-cols-5 xl:grid-cols-6 2xl:grid-cols-7 gap-3">
                    {Array.from({ length: 8 }).map((_, i) => (
                      <div
                        // biome-ignore lint/suspicious/noArrayIndexKey: placeholder skeletons never reorder
                        key={i}
                        className="aspect-[2/3] rounded-lg animate-pulse"
                        style={{ background: "var(--ds-bg-2)" }}
                      />
                    ))}
                  </div>
                </div>
              )}

              {!loading && personData && personData.credits.length === 0 && (
                <p
                  className="ds-mono"
                  style={{ fontSize: 12, color: "var(--ds-fg-subtle)" }}
                >
                  No recent credits found.
                </p>
              )}

              {!loading && personData && personData.credits.length > 0 && (
                <>
                  <p
                    className="ds-mono uppercase font-medium"
                    style={{
                      fontSize: 10.5,
                      color: "var(--ds-fg-subtle)",
                      marginBottom: 10,
                      letterSpacing: "0.08em",
                    }}
                  >
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
                          className="group flex flex-col overflow-hidden text-left cursor-pointer ds-card-lift focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--ds-accent-ring)]"
                          style={{
                            background: "var(--ds-bg-2)",
                            border: "1px solid var(--ds-border)",
                            borderRadius: 8,
                          }}
                        >
                          <div
                            className="relative aspect-[2/3] w-full"
                            style={{ background: "var(--ds-bg-3)" }}
                          >
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

                          <div className="flex flex-col" style={{ padding: 8, gap: 4 }}>
                            <p
                              className="font-medium leading-tight line-clamp-2"
                              style={{ fontSize: 11.5, color: "var(--ds-fg)" }}
                            >
                              {credit.title}
                            </p>
                            <div
                              className="ds-mono flex items-center flex-wrap"
                              style={{ gap: 4, fontSize: 10, color: "var(--ds-fg-subtle)" }}
                            >
                              {credit.releaseYear && <span>{credit.releaseYear}</span>}
                              {credit.releaseYear && <span>·</span>}
                              <span>{credit.mediaType === "movie" ? "MOVIE" : "TV"}</span>
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
