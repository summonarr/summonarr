"use client";

import Image from "next/image";
import { useRouter } from "next/navigation";
import {
  Film,
  Tv2,
  PlayCircle,
  MonitorPlay,
  Clock,
  CheckCircle,
  Loader2,
  Plus,
  Check,
  X,
} from "lucide-react";
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

function MediaCardImpl({
  media,
  onClick,
  className,
  size = "sm",
  showPlex = true,
  showJellyfin = true,
  requestToken,
}: MediaCardProps) {
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
    return () => {
      cancelled = true;
    };
  }, [media.id, media.mediaType, media.releaseDate, media.imdbRating, media.rottenTomatoes]);

  const isAvailable = !!(
    (showPlex && media.plexAvailable) ||
    (showJellyfin && media.jellyfinAvailable)
  );
  const isRequested =
    !!(media.requestedByMe || media.arrPending) || reqState === "requested";

  const detailPath =
    media.mediaType === "movie" ? `/movie/${media.id}` : `/tv/${media.id}`;

  function handleCardClick() {
    if (onClick) {
      onClick(media);
      return;
    }
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
        const tokenRes = await fetch(
          `/api/requests/token?tmdbId=${media.id}&mediaType=${mt}`,
        );
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
    if (onClick) {
      onClick(media);
      return;
    }
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
    if (reqState === "loading") return <Loader2 className="w-3.5 h-3.5 animate-spin" />;
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
        "group relative flex flex-col w-full overflow-hidden text-left",
        "ds-card-lift focus-visible:outline-none",
        "focus-visible:ring-2 focus-visible:ring-[var(--ds-accent-ring)]",
        className,
      )}
      style={{
        background: "var(--ds-bg-2)",
        border: "1px solid var(--ds-border)",
        borderRadius: 8,
        color: "var(--ds-fg)",
      }}
    >
      <div
        className="relative aspect-[2/3] w-full"
        style={{ background: "var(--ds-bg-3)" }}
      >
        {poster ? (
          <Image
            src={poster}
            alt={media.title}
            fill
            sizes="(max-width: 640px) 50vw, (max-width: 1024px) 33vw, (max-width: 1536px) 20vw, 16vw"
            className="object-cover"
          />
        ) : (
          <div
            className="absolute inset-0 flex items-center justify-center"
            style={{ color: "var(--ds-fg-subtle)" }}
          >
            {media.mediaType === "movie" ? (
              <Film className="w-10 h-10" />
            ) : (
              <Tv2 className="w-10 h-10" />
            )}
          </div>
        )}

        {/* Hover / confirm overlay */}
        <div
          className={cn(
            "absolute inset-0 flex items-end justify-center pointer-events-none transition-opacity",
            reqState === "confirm"
              ? "opacity-100"
              : "opacity-0 group-hover:opacity-100",
          )}
          style={{
            background:
              "linear-gradient(180deg, transparent 40%, rgba(0,0,0,0.72) 100%)",
            padding: 10,
          }}
        >
          {reqState === "confirm" ? (
            <div className="pointer-events-auto flex flex-col items-center gap-2 px-3 pb-2">
              <span
                className="text-center leading-tight font-semibold"
                style={{ fontSize: 11, color: "#fff" }}
              >
                Request this?
              </span>
              <div className="flex items-center gap-2">
                <button
                  onClick={handleBubbleClick}
                  type="button"
                  className="ds-tap inline-flex items-center gap-1 font-semibold transition-colors"
                  style={{
                    padding: "4px 10px",
                    borderRadius: 999,
                    background: "var(--ds-accent)",
                    color: "var(--ds-accent-fg)",
                    fontSize: 11,
                    border: 0,
                  }}
                >
                  <Check className="w-3 h-3" />
                  Confirm
                </button>
                <button
                  onClick={cancelConfirm}
                  type="button"
                  className="ds-tap inline-flex items-center gap-1 font-semibold transition-colors"
                  style={{
                    padding: "4px 10px",
                    borderRadius: 999,
                    background: "rgba(255,255,255,0.12)",
                    color: "#fff",
                    fontSize: 11,
                    border: "1px solid rgba(255,255,255,0.28)",
                  }}
                >
                  <X className="w-3 h-3" />
                  Cancel
                </button>
              </div>
            </div>
          ) : (
            <button
              onClick={handleBubbleClick}
              type="button"
              className="ds-tap pointer-events-auto inline-flex items-center gap-1.5 font-semibold transition-colors"
              style={{
                padding: "5px 12px",
                borderRadius: 999,
                background:
                  isAvailable || isRequested
                    ? "rgba(255,255,255,0.14)"
                    : "var(--ds-accent)",
                color:
                  isAvailable || isRequested
                    ? "#fff"
                    : "var(--ds-accent-fg)",
                border:
                  isAvailable || isRequested
                    ? "1px solid rgba(255,255,255,0.28)"
                    : "0",
                fontSize: 12,
              }}
            >
              {bubbleContent()}
            </button>
          )}
        </div>

        {/* Top-left: availability chips */}
        <div className="absolute top-1.5 left-1.5 flex flex-col gap-1">
          {showPlex && media.plexAvailable && (
            <span
              className="ds-chip ds-chip-plex"
              style={{ paddingLeft: 5, paddingRight: 6 }}
            >
              <PlayCircle style={{ width: 9, height: 9 }} />
              Plex
            </span>
          )}
          {showJellyfin && media.jellyfinAvailable && (
            <span
              className="ds-chip ds-chip-jellyfin"
              style={{ paddingLeft: 5, paddingRight: 6 }}
            >
              <MonitorPlay style={{ width: 9, height: 9 }} />
              Jellyfin
            </span>
          )}
          {!isAvailable && media.arrPending && (
            <span
              className="ds-chip ds-chip-pending"
              style={{ paddingLeft: 5, paddingRight: 6 }}
            >
              <Clock style={{ width: 9, height: 9 }} />
              Queued
            </span>
          )}
        </div>

        {/* Bottom-left: requested indicator */}
        {!isAvailable && (media.requested || reqState === "requested") && (
          <span
            className="ds-chip ds-chip-accent absolute bottom-1.5 left-1.5"
            style={{ paddingLeft: 5, paddingRight: 6 }}
          >
            <CheckCircle style={{ width: 9, height: 9 }} />
            Requested
          </span>
        )}

        {/* Top-right: score chip (IMDb-style) */}
        {media.voteAverage > 0 && (
          <div
            className="ds-mono absolute top-1.5 right-1.5 inline-flex items-center gap-1"
            style={{
              fontSize: 10.5,
              fontWeight: 600,
              padding: "2px 6px",
              borderRadius: 4,
              background:
                "color-mix(in oklab, var(--ds-bg-inset) 80%, transparent)",
              backdropFilter: "blur(6px)",
              border: "1px solid var(--ds-border)",
              color: "var(--ds-fg)",
            }}
          >
            <span
              className="ds-mono"
              style={{
                fontSize: 7.5,
                fontWeight: 800,
                letterSpacing: "-0.02em",
                background: "#f5c518",
                color: "#000",
                padding: "1px 2.5px",
                borderRadius: 2,
                lineHeight: 1,
              }}
            >
              IMDb
            </span>
            {media.imdbRating
              ? Number.parseFloat(media.imdbRating).toFixed(1)
              : media.voteAverage.toFixed(1)}
          </div>
        )}
      </div>

      {/* Card body */}
      <div
        className={cn(
          "flex flex-col gap-1.5 shrink-0",
          size === "md" ? "p-3 pb-4" : "p-2.5",
        )}
      >
        <p
          className={cn(
            "font-medium line-clamp-2",
            size === "md" ? "text-[15px] h-10" : "text-[13px] h-8",
          )}
          style={{ color: "var(--ds-fg)", lineHeight: 1.3 }}
        >
          {media.title}
        </p>
        <div
          className="ds-mono flex items-center gap-1.5 flex-wrap"
          style={{ fontSize: 10.5, color: "var(--ds-fg-subtle)" }}
        >
          {media.releaseYear && <span>{media.releaseYear}</span>}
          {media.releaseYear && <span>·</span>}
          <span>{media.mediaType === "movie" ? "MOVIE" : "TV"}</span>
          {media.certification && (
            <>
              <span>·</span>
              <span>{media.certification}</span>
            </>
          )}
        </div>
        <div
          className={size === "md" ? "flex flex-col gap-1 mt-0.5" : "min-h-[34px] flex items-start"}
        >
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
            compact={size !== "md"}
          />
        </div>
      </div>
    </button>
  );
}

export const MediaCard = memo(MediaCardImpl);
