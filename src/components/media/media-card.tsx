"use client";

import Image from "next/image";
import { useRouter } from "next/navigation";
import { Film, Tv2, Star, PlayCircle, MonitorPlay, Clock, CheckCircle, Loader2, Plus, Check, X } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { posterUrl, type TmdbMedia } from "@/lib/tmdb-types";
import { RatingsBar } from "@/components/media/ratings-bar";
import { cn } from "@/lib/utils";
import { useState, useEffect, memo } from "react";
import { requestRatings, type RatingsPayload } from "@/lib/client/ratings-batcher";

type LiveRatings = RatingsPayload;

interface MediaCardProps {
  media: TmdbMedia;
  onClick?: (media: TmdbMedia) => void;
  className?: string;
  size?: "sm" | "md";
  showPlex?: boolean;
  showJellyfin?: boolean;

  requestToken?: string;
}

type RequestState = "idle" | "confirm" | "loading" | "requested" | "error";

function MediaCardImpl({ media, onClick, className, size = "sm", showPlex = true, showJellyfin = true, requestToken }: MediaCardProps) {
  const router = useRouter();
  const poster = posterUrl(media.posterPath, "w342");
  const [reqState, setReqState] = useState<RequestState>("idle");
  const [liveRatings, setLiveRatings] = useState<LiveRatings | null>(null);

  useEffect(() => {
    if (media.imdbRating !== undefined || media.rottenTomatoes !== undefined) return;
    let cancelled = false;
    requestRatings(media.id, media.mediaType, media.releaseDate ?? null).then((data) => {
      if (!cancelled && data) setLiveRatings(data);
    });
    return () => { cancelled = true; };
  }, [media.id, media.mediaType, media.releaseDate, media.imdbRating, media.rottenTomatoes]);

  const isAvailable = !!(
    (showPlex && media.plexAvailable) ||
    (showJellyfin && media.jellyfinAvailable)
  );

  const isRequested = !!(media.requestedByMe || media.arrPending) || reqState === "requested";

  const detailPath = media.mediaType === "movie" ? `/movie/${media.id}` : `/tv/${media.id}`;

  function handleCardClick() {
    if (onClick) { onClick(media); return; }
    router.push(detailPath);
  }

  async function submitRequest(e: React.MouseEvent) {
    e.stopPropagation();
    if (reqState !== "idle" && reqState !== "confirm") return;
    setReqState("loading");
    try {
      const mt = media.mediaType === "movie" ? "MOVIE" : "TV";
      let token = requestToken;
      if (!token) {
        const tokenRes = await fetch(`/api/requests/token?tmdbId=${media.id}&mediaType=${mt}`);
        if (tokenRes.ok) token = (await tokenRes.json()).token;
      }
      const res = await fetch("/api/requests", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ tmdbId: media.id, mediaType: mt, _token: token }),
      });
      setReqState(res.ok || res.status === 409 ? "requested" : "error");
    } catch {
      setReqState("error");
    }
  }

  function handleBubbleClick(e: React.MouseEvent) {
    e.stopPropagation();
    if (onClick) { onClick(media); return; }

    if (isAvailable || media.arrPending || isRequested) {
      router.push(detailPath);
    } else if (reqState === "idle" || reqState === "error") {
      setReqState("confirm");
    } else if (reqState === "confirm") {
      submitRequest(e);
    }
  }

  function cancelConfirm(e: React.MouseEvent) {
    e.stopPropagation();
    setReqState("idle");
  }

  const bubbleContent = () => {
    if (isAvailable) return <span>View</span>;
    if (media.arrPending) return <span>View</span>;
    if (isRequested) return <span>View</span>;
    if (reqState === "loading") return <Loader2 className="w-4 h-4 animate-spin" />;
    if (reqState === "error") return <span>Retry</span>;
    return (
      <span className="flex items-center gap-1">
        <Plus className="w-3.5 h-3.5" />
        Request
      </span>
    );
  };

  return (
    <button
      onClick={handleCardClick}
      className={cn(
        "group relative flex flex-col w-full rounded-lg overflow-hidden bg-zinc-800 text-left transition-transform hover:scale-[1.03] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500",
        className
      )}
    >
      <div className="relative aspect-[2/3] w-full bg-zinc-700">
        {poster ? (
          <Image
            src={poster}
            alt={media.title}
            fill
            sizes="(max-width: 640px) 50vw, (max-width: 1024px) 33vw, (max-width: 1536px) 20vw, 16vw"
            className="object-cover"
          />
        ) : (
          <div className="absolute inset-0 flex items-center justify-center text-zinc-600">
            {media.mediaType === "movie" ? <Film className="w-10 h-10" /> : <Tv2 className="w-10 h-10" />}
          </div>
        )}

        {}
        <div className={cn(
          "absolute inset-0 bg-black/60 transition-opacity flex items-center justify-center pointer-events-none",
          reqState === "confirm" ? "opacity-100" : "opacity-0 group-hover:opacity-100"
        )}>
          {reqState === "confirm" ? (
            <div className="pointer-events-auto flex flex-col items-center gap-2 px-3">
              <span className="text-white text-xs font-semibold text-center leading-tight">Request this?</span>
              <div className="flex items-center gap-2">
                <button
                  onClick={handleBubbleClick}
                  className="text-white text-xs font-semibold px-2.5 py-1 rounded-full bg-indigo-600/90 hover:bg-indigo-500 flex items-center gap-1 transition-colors"
                >
                  <Check className="w-3 h-3" />
                  Confirm
                </button>
                <button
                  onClick={cancelConfirm}
                  className="text-white text-xs font-semibold px-2.5 py-1 rounded-full border border-white/30 bg-white/10 hover:bg-white/20 flex items-center gap-1 transition-colors"
                >
                  <X className="w-3 h-3" />
                  Cancel
                </button>
              </div>
            </div>
          ) : (
            <button
              onClick={handleBubbleClick}
              className="pointer-events-auto text-white text-sm font-semibold px-3 py-1.5 rounded-full border border-white/30 bg-white/10 hover:bg-white/20 flex items-center gap-1.5 transition-colors"
            >
              {bubbleContent()}
            </button>
          )}
        </div>

        <div className="absolute top-2 left-2 flex flex-col gap-1">
          {showPlex && media.plexAvailable && (
            <div className="flex items-center gap-1 bg-[#e5a00d]/90 rounded-full px-2 py-0.5 text-xs text-black font-semibold">
              <PlayCircle className="w-3 h-3" />
              On Plex
            </div>
          )}
          {showJellyfin && media.jellyfinAvailable && (
            <div className="flex items-center gap-1 bg-[#00a4dc]/90 rounded-full px-2 py-0.5 text-xs text-white font-semibold">
              <MonitorPlay className="w-3 h-3" />
              On Jellyfin
            </div>
          )}
          {!isAvailable && media.arrPending && (
            <div className="flex items-center gap-1 bg-orange-500/90 rounded-full px-2 py-0.5 text-xs text-white font-semibold">
              <Clock className="w-3 h-3" />
              Approved in Queue
            </div>
          )}
        </div>

        {!isAvailable && (media.requested || reqState === "requested") && (
          <div className="absolute bottom-2 left-2 flex items-center gap-1 bg-indigo-600/90 rounded-full px-2 py-0.5 text-xs text-white font-semibold">
            <CheckCircle className="w-3 h-3" />
            Requested
          </div>
        )}

        {media.voteAverage > 0 && (
          <div className="absolute top-2 right-2 flex items-center gap-1 bg-black/70 rounded-full px-2 py-0.5 text-xs text-yellow-400 font-medium">
            <Star className="w-3 h-3 fill-yellow-400" />
            {media.voteAverage.toFixed(1)}
          </div>
        )}
      </div>

      <div className={cn("flex flex-col gap-1.5 shrink-0", size === "md" ? "p-3 pb-4" : "p-2.5")}>
        <p className={cn("font-medium text-white leading-tight line-clamp-2", size === "md" ? "text-base h-10" : "text-sm h-8")}>{media.title}</p>
        <div className="flex items-center gap-1.5 flex-wrap">
          {media.releaseYear && (
            <span className={cn("text-zinc-400", size === "md" ? "text-sm" : "text-xs")}>{media.releaseYear}</span>
          )}
          <Badge variant="secondary" className={cn("px-1.5 py-0 bg-zinc-700 text-zinc-300 border-0", size === "md" ? "text-xs h-5" : "text-[10px] h-4")}>
            {media.mediaType === "movie" ? "Movie" : "TV"}
          </Badge>
          {media.certification && (
            <Badge variant="secondary" className={cn("px-1.5 py-0 bg-zinc-600 text-zinc-200 border border-zinc-500", size === "md" ? "text-xs h-5" : "text-[10px] h-4")}>
              {media.certification}
            </Badge>
          )}
        </div>
        {size === "md" ? (
          <div className="flex flex-col gap-1 mt-0.5">
            <RatingsBar
              imdbRating={liveRatings?.imdbRating ?? media.imdbRating}
              imdbId={liveRatings?.imdbId ?? media.imdbId}
              rottenTomatoes={liveRatings?.rottenTomatoes ?? media.rottenTomatoes}
              rtAudienceScore={liveRatings?.rtAudienceScore ?? media.rtAudienceScore}
              metacritic={liveRatings?.metacritic ?? media.metacritic}
              traktRating={liveRatings?.traktRating ?? media.traktRating}
              letterboxdRating={liveRatings?.letterboxdRating ?? media.letterboxdRating}
              mdblistScore={liveRatings?.mdblistScore ?? media.mdblistScore}
              malRating={liveRatings?.malRating ?? media.malRating}
              rogerEbertRating={liveRatings?.rogerEbertRating ?? media.rogerEbertRating}
              voteAverage={media.voteAverage}
              size="sm"
            />
          </div>
        ) : (
          <div className="min-h-[34px] flex items-start">
            <RatingsBar
              imdbRating={liveRatings?.imdbRating ?? media.imdbRating}
              imdbId={liveRatings?.imdbId ?? media.imdbId}
              rottenTomatoes={liveRatings?.rottenTomatoes ?? media.rottenTomatoes}
              rtAudienceScore={liveRatings?.rtAudienceScore ?? media.rtAudienceScore}
              metacritic={liveRatings?.metacritic ?? media.metacritic}
              traktRating={liveRatings?.traktRating ?? media.traktRating}
              letterboxdRating={liveRatings?.letterboxdRating ?? media.letterboxdRating}
              mdblistScore={liveRatings?.mdblistScore ?? media.mdblistScore}
              malRating={liveRatings?.malRating ?? media.malRating}
              rogerEbertRating={liveRatings?.rogerEbertRating ?? media.rogerEbertRating}
              voteAverage={media.voteAverage}
              size="sm"
              compact
            />
          </div>
        )}
      </div>
    </button>
  );
}

export const MediaCard = memo(MediaCardImpl);
