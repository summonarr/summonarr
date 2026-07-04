"use client";

import Image from "next/image";
import Link from "next/link";
import { useEffect, useState } from "react";
import {
  Film,
  Tv2,
  PlayCircle,
  MonitorPlay,
  Clock,
  CheckCircle,
  Play,
  ChevronRight,
} from "@/components/icons";
import { posterUrl, type TmdbMedia } from "@/lib/tmdb-types";
import { RatingsBar } from "@/components/media/ratings-bar";
import { requestRatings, type RatingsPayload } from "@/lib/client/ratings-batcher";

interface DiscoverHeroProps {
  media: TmdbMedia;
  showPlex?: boolean;
  showJellyfin?: boolean;
  label?: string;
}

/* Featured #1-trending block. Mirrors the prototype's `.discover-hero`:
   poster column + content (TRENDING #1 chip, big title, mono meta,
   ratings, overview, View details / Trailer). Lazily enriches ratings
   the same way MediaCard does, since trending list items arrive bare. */
export function DiscoverHero({
  media,
  showPlex = true,
  showJellyfin = true,
  label = "TRENDING #1",
}: DiscoverHeroProps) {
  const poster = posterUrl(media.posterPath, "w500");
  const [liveRatings, setLiveRatings] = useState<RatingsPayload | null>(null);

  useEffect(() => {
    if (media.imdbRating !== undefined || media.rottenTomatoes !== undefined)
      return;
    let cancelled = false;
    requestRatings(media.id, media.mediaType, media.releaseDate ?? null).then(
      (data) => {
        if (!cancelled && data) setLiveRatings(data);
      },
    );
    return () => {
      cancelled = true;
    };
  }, [
    media.id,
    media.mediaType,
    media.releaseDate,
    media.imdbRating,
    media.rottenTomatoes,
  ]);

  const detailPath =
    media.mediaType === "movie" ? `/movie/${media.id}` : `/tv/${media.id}`;
  const trailerHref =
    media.trailerUrl ??
    (media.trailerKey
      ? `https://www.youtube.com/watch?v=${media.trailerKey}`
      : null);

  return (
    <section
      className="ds-discover-hero"
      style={{
        background: "var(--ds-bg-2)",
        border: "1px solid var(--ds-border)",
        borderRadius: 12,
        padding: 20,
        marginBottom: 28,
        position: "relative",
        overflow: "hidden",
      }}
    >
      {/* Accent glow */}
      <div
        aria-hidden="true"
        style={{
          position: "absolute",
          inset: 0,
          opacity: 0.35,
          background:
            "radial-gradient(ellipse at top right, var(--ds-accent-soft), transparent 60%)",
          pointerEvents: "none",
        }}
      />

      {/* Poster */}
      <div
        className="relative"
        style={{
          aspectRatio: "2 / 3",
          borderRadius: 8,
          overflow: "hidden",
          background: "var(--ds-bg-3)",
        }}
      >
        {poster ? (
          <Image
            src={poster}
            alt={media.title}
            fill
            sizes="180px"
            className="object-cover"
            priority
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
      </div>

      {/* Content */}
      <div
        className="relative flex flex-col"
        style={{ gap: 10, minWidth: 0 }}
      >
        <div className="flex flex-wrap items-center" style={{ gap: 6 }}>
          <span className="ds-chip ds-chip-accent">{label}</span>
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
          {!media.plexAvailable &&
            !media.jellyfinAvailable &&
            media.arrPending && (
              <span
                className="ds-chip ds-chip-pending"
                style={{ paddingLeft: 5, paddingRight: 6 }}
              >
                <Clock style={{ width: 9, height: 9 }} />
                Queued
              </span>
            )}
          {/* 4K chips — arr4k* are only populated when the viewer has 4K access (enrichment gate) */}
          {media.arr4kAvailable && (
            <span
              className="ds-chip"
              style={{
                paddingLeft: 5,
                paddingRight: 6,
                background: "var(--ds-accent-soft)",
                color: "var(--ds-accent)",
                border: "1px solid var(--ds-accent-ring)",
              }}
            >
              <CheckCircle style={{ width: 9, height: 9 }} />
              4K
            </span>
          )}
          {!media.arr4kAvailable && media.arr4kPending && (
            <span
              className="ds-chip ds-chip-pending"
              style={{ paddingLeft: 5, paddingRight: 6 }}
            >
              <Clock style={{ width: 9, height: 9 }} />
              4K Queued
            </span>
          )}
          {!media.plexAvailable &&
            !media.jellyfinAvailable &&
            media.requested && (
              <span
                className="ds-chip ds-chip-accent"
                style={{ paddingLeft: 5, paddingRight: 6 }}
              >
                <CheckCircle style={{ width: 9, height: 9 }} />
                Requested
              </span>
            )}
        </div>

        <h2
          style={{
            fontSize: 28,
            fontWeight: 600,
            margin: 0,
            letterSpacing: "-0.025em",
            color: "var(--ds-fg)",
            lineHeight: 1.15,
          }}
        >
          {media.title}
        </h2>

        <div
          className="ds-mono flex items-center flex-wrap"
          style={{ fontSize: 11.5, color: "var(--ds-fg-subtle)", gap: 8 }}
        >
          {media.releaseYear && <span>{media.releaseYear}</span>}
          {media.certification && (
            <>
              <span>·</span>
              <span>{media.certification}</span>
            </>
          )}
          {media.runtime ? (
            <>
              <span>·</span>
              <span>{media.runtime}m</span>
            </>
          ) : null}
          <span>·</span>
          <span>{media.mediaType === "movie" ? "MOVIE" : "TV"}</span>
        </div>

        <RatingsBar
          imdbRating={liveRatings?.imdbRating ?? media.imdbRating}
          imdbId={liveRatings?.imdbId ?? media.imdbId}
          imdbVotes={liveRatings?.imdbVotes ?? media.imdbVotes}
          rottenTomatoes={liveRatings?.rottenTomatoes ?? media.rottenTomatoes}
          rtAudienceScore={
            liveRatings?.rtAudienceScore ?? media.rtAudienceScore
          }
          metacritic={liveRatings?.metacritic ?? media.metacritic}
          traktRating={liveRatings?.traktRating ?? media.traktRating}
          letterboxdRating={
            liveRatings?.letterboxdRating ?? media.letterboxdRating
          }
          mdblistScore={liveRatings?.mdblistScore ?? media.mdblistScore}
          malRating={liveRatings?.malRating ?? media.malRating}
          rogerEbertRating={
            liveRatings?.rogerEbertRating ?? media.rogerEbertRating
          }
          voteAverage={media.voteAverage}
          size="sm"
        />

        {media.overview && (
          <p
            className="line-clamp-4"
            style={{
              fontSize: 13,
              color: "var(--ds-fg-muted)",
              lineHeight: 1.55,
              maxWidth: 560,
              margin: 0,
            }}
          >
            {media.overview}
          </p>
        )}

        <div className="flex flex-wrap" style={{ gap: 8, marginTop: 6 }}>
          <Link
            href={detailPath}
            className="ds-tap inline-flex items-center justify-center gap-1.5 font-medium transition-colors"
            style={{
              height: 32,
              padding: "0 14px",
              borderRadius: "var(--ds-r-md)",
              background: "var(--ds-accent)",
              color: "var(--ds-accent-fg)",
              fontSize: 13,
              border: 0,
            }}
          >
            <Play style={{ width: 14, height: 14 }} />
            View details
          </Link>
          {trailerHref && (
            <a
              href={trailerHref}
              target="_blank"
              rel="noopener noreferrer"
              className="ds-tap inline-flex items-center justify-center gap-1.5 font-medium transition-colors"
              style={{
                height: 32,
                padding: "0 14px",
                borderRadius: "var(--ds-r-md)",
                background: "var(--ds-bg-2)",
                color: "var(--ds-fg)",
                fontSize: 13,
                border: "1px solid var(--ds-border)",
              }}
            >
              <Play style={{ width: 14, height: 14 }} />
              Trailer
            </a>
          )}
          <Link
            href={detailPath}
            className="ds-tap ml-auto inline-flex items-center gap-1 font-medium transition-colors self-center"
            style={{ fontSize: 12, color: "var(--ds-fg-muted)" }}
          >
            More info
            <ChevronRight style={{ width: 12, height: 12 }} />
          </Link>
        </div>
      </div>
    </section>
  );
}
