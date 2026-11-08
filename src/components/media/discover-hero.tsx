"use client";

import Image from "next/image";
import Link from "next/link";
import { Fragment } from "react";
import { Film, Tv2, Play, ChevronRight } from "@/components/icons";
import { posterUrl, type TmdbMedia } from "@/lib/tmdb-types";
import { safeExternalHref } from "@/lib/safe-url";
import { RatingsBar } from "@/components/media/ratings-bar";
import { AvailabilityChips } from "@/components/media/availability-chips";
import { mergeRatings } from "@/components/media/ratings-merge";
import { useT } from "@/components/i18n/i18n-provider";
import type { Translator } from "@/lib/i18n/translate";
import { isVisiblyAvailable } from "./availability-rules";
import { mediaDetailPath, youtubeTrailerUrl } from "./media-links";
import { useLiveRatings } from "./use-live-ratings";

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
  label,
}: DiscoverHeroProps) {
  const t = useT();
  const liveRatings = useLiveRatings(media);
  // Same "available" reading as MediaCard/AvailabilityBadges: a copy on a
  // server whose badges this viewer doesn't see must not suppress the Queued /
  // Requested chips (the raw flags hid them while showing no Plex chip either).
  const isAvailable = isVisiblyAvailable(media, showPlex, showJellyfin);
  const metaParts = heroMetaParts(media, t);

  return (
    <section
      className="ds-discover-hero"
      style={{
        background: "var(--ds-bg-2)",
        border: "1px solid var(--ds-border)",
        borderRadius: 12,
        padding: 20,
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

      <HeroPoster media={media} />

      {/* Content */}
      <div
        className="relative flex flex-col"
        style={{ gap: 10, minWidth: 0 }}
      >
        <div className="flex flex-wrap items-center" style={{ gap: 6 }}>
          <span className="ds-chip ds-chip-accent">{label ?? t("media.hero.trendingFirst")}</span>
          <AvailabilityChips
            media={media}
            showPlex={showPlex}
            showJellyfin={showJellyfin}
            isAvailable={isAvailable}
            queuedBefore4k
            showRequested
          />
        </div>

        {/* 24px (20px on phones) — under the 22px page h1, which this used to
            outrank at 28px. overflowWrap keeps an unbroken title inside the
            column instead of pushing the poster/content grid wider. */}
        <h2
          className="text-[20px] sm:text-[24px]"
          style={{
            fontWeight: 600,
            margin: 0,
            letterSpacing: "-0.025em",
            color: "var(--ds-fg)",
            lineHeight: 1.15,
            overflowWrap: "anywhere",
          }}
        >
          {media.title}
        </h2>

        <div
          className="ds-mono flex items-center flex-wrap"
          style={{ fontSize: 11.5, color: "var(--ds-fg-subtle)", gap: 8 }}
        >
          {metaParts.map((part, i) => (
            // biome-ignore lint/suspicious/noArrayIndexKey: a fixed, ordered list of parts
            <Fragment key={i}>
              {i > 0 && <span aria-hidden="true">·</span>}
              <span>{part}</span>
            </Fragment>
          ))}
        </div>

        <RatingsBar
          {...mergeRatings(media, liveRatings)}
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

        <HeroActions media={media} />
      </div>
    </section>
  );
}

// Only the parts present, so the meta line never starts with a stray separator.
function heroMetaParts(media: TmdbMedia, t: Translator): string[] {
  return [
    media.releaseYear || null,
    media.certification || null,
    media.runtime ? t("media.runtimeMinutes", { minutes: media.runtime }) : null,
    media.mediaType === "movie" ? t("media.type.movie") : t("media.type.tv"),
  ].filter((part): part is string => !!part);
}

function HeroPoster({ media }: { media: TmdbMedia }) {
  const poster = posterUrl(media.posterPath, "w500");
  return (
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
  );
}

// media.trailerUrl is UNTRUSTED (MDBList `raw.trailer`) — gated through
// safeExternalHref so a `javascript:`/`data:` URL can't become a clickable
// href (XSS). Matches the sibling TrailerButton. The YouTube fallback is a
// fixed https host with the key as one query value.
function trailerHref(media: TmdbMedia): string | null {
  return safeExternalHref(media.trailerUrl) ?? (media.trailerKey ? youtubeTrailerUrl(media.trailerKey) : null);
}

// View details, and the trailer when there is one.
function HeroActions({ media }: { media: TmdbMedia }) {
  const t = useT();
  const trailer = trailerHref(media);
  return (
    <div className="flex flex-wrap" style={{ gap: 8, marginTop: 6 }}>
      <Link
        href={mediaDetailPath(media)}
        className="ds-tap ds-hover-tint inline-flex items-center justify-center gap-1.5 font-medium"
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
        {t("media.hero.viewDetails")}
        <ChevronRight style={{ width: 14, height: 14 }} />
      </Link>
      {trailer && (
        <a
          href={trailer}
          target="_blank"
          rel="noopener noreferrer"
          className="ds-tap ds-hover-tint inline-flex items-center justify-center gap-1.5 font-medium"
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
          {t("media.hero.trailer")}
          <span className="sr-only"> {t("media.opensInNewTab")}</span>
        </a>
      )}
    </div>
  );
}
