"use client";

import Image from "next/image";
import Link from "next/link";
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
  Ban,
} from "@/components/icons";
import { posterUrl, type TmdbMedia } from "@/lib/tmdb-types";
import { RatingsBar } from "@/components/media/ratings-bar";
import { cn } from "@/lib/utils";
import { useState, useEffect, memo } from "react";
import { requestRatings, type RatingsPayload } from "@/lib/client/ratings-batcher";
import { withBasePath } from "@/lib/base-path";
import { useToast } from "@/components/ui/toast";

type LiveRatings = RatingsPayload;

interface MediaCardProps {
  media: TmdbMedia;
  onClick?: (media: TmdbMedia) => void;
  className?: string;
  size?: "sm" | "md";
  showPlex?: boolean;
  showJellyfin?: boolean;
  /** Preload this card's poster (next/image priority). Only the first row of
      the initially-rendered browse grid should set it — see browse-grid.tsx. */
  priority?: boolean;

  requestToken?: string;

  /** Small explanatory line under the title — /for-you uses it for "Because you
      watched X". Purely presentational; omitted everywhere else, which is how a
      shared card stays identical on every other grid. */
  caption?: React.ReactNode;
  /** Node pinned to the poster's top-left, revealed on hover/focus like the
      request overlay. /for-you passes its "not interested" control here. Kept as
      a node rather than a boolean flag so this component never learns about the
      hidden-items API. */
  overlayAction?: React.ReactNode;
}

type RequestState = "idle" | "confirm" | "loading" | "requested" | "available" | "error";

function MediaCardImpl({
  media,
  onClick,
  className,
  size = "sm",
  showPlex = true,
  showJellyfin = true,
  priority = false,
  requestToken,
  caption,
  overlayAction,
}: MediaCardProps) {
  const router = useRouter();
  const { toast } = useToast();
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
  ) || reqState === "available";
  // Only the viewer's OWN request blocks re-requesting. A title queued by
  // someone else (arrPending) stays requestable — the server mirrors the
  // approved status so this user gets the "now available" notification.
  const isRequested = !!media.requestedByMe || reqState === "requested";
  const blacklisted = !!media.blacklisted;

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
          withBasePath(`/api/requests/token?tmdbId=${media.id}&mediaType=${mt}`),
        );
        if (tokenRes.ok) token = (await tokenRes.json()).token;
      }
      const res = await fetch(withBasePath("/api/requests"), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ tmdbId: media.id, mediaType: mt, _token: token }),
      });
      if (res.ok) {
        const body = (await res.json().catch(() => null)) as { alreadyAvailable?: boolean } | null;
        if (body?.alreadyAvailable) {
          // The item was already in a library — no request row was created.
          // Reflect availability and let the server re-render the badges.
          setReqState("available");
          router.refresh();
        } else {
          setReqState("requested");
        }
      } else if (res.status === 409) {
        setReqState("requested");
      } else {
        // Surface the server's reason (quota, permission, instance errors) —
        // the bubble alone only ever said "Retry", and only on hover. A 4xx is
        // a decision, not a blip, so the card returns to idle instead of
        // offering a retry that will fail the same way; only a 5xx/429 keeps
        // the "Retry" state.
        const data = (await res.json().catch(() => null)) as { error?: string } | null;
        toast({
          title: data?.error ?? `Couldn’t request ${media.title} — try again`,
          variant: "error",
        });
        const transient = res.status >= 500 || res.status === 429;
        setReqState(transient ? "error" : "idle");
      }
    } catch {
      toast({ title: "Network error — please try again", variant: "error" });
      setReqState("error");
    }
  }

  function handleBubbleClick(e: React.MouseEvent) {
    e.stopPropagation();
    if (onClick) {
      onClick(media);
      return;
    }
    if (isAvailable || isRequested || blacklisted) {
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

  // Accessible names for the overlay controls: each card's buttons read as
  // "Request <title>" rather than a page full of identical "Request"s.
  const bubbleLabel = () => {
    if (isAvailable || isRequested) return `View ${media.title}`;
    // The button navigates (router.push), so name the action, not a status.
    if (blacklisted) return `View ${media.title} (not available to request)`;
    if (reqState === "loading") return `Requesting ${media.title}`;
    if (reqState === "error") return `Retry request for ${media.title}`;
    return `Request ${media.title}`;
  };

  // Over a poster the scrim is black and the overlay text white — an image is
  // always dark-compatible. With no poster the placeholder is a flat surface
  // that is near-white in light mode, so the gradient (a black smear there) is
  // dropped and the translucent-white ghost button reads off the theme instead.
  const onPoster = !!poster;
  const overlayFg = onPoster ? "#fff" : "var(--ds-fg)";
  const overlayGhostBg = onPoster ? "rgba(255,255,255,0.14)" : "var(--ds-bg-2)";
  const overlayCancelBg = onPoster ? "rgba(255,255,255,0.12)" : "var(--ds-bg-2)";
  const overlayGhostBorder = onPoster
    ? "1px solid rgba(255,255,255,0.28)"
    : "1px solid var(--ds-border)";

  const bubbleContent = () => {
    if (isAvailable) return <span>View</span>;
    if (isRequested) return <span>View</span>;
    if (blacklisted)
      return (
        <span className="flex items-center gap-1">
          <Ban className="w-3.5 h-3.5" />
          Blocked
        </span>
      );
    if (reqState === "loading") return <Loader2 className="w-3.5 h-3.5 animate-spin" />;
    if (reqState === "error") return <span>Retry</span>;
    return (
      <span className="flex items-center gap-1">
        <Plus className="w-3.5 h-3.5" />
        Request
      </span>
    );
  };

  // The card is a plain <div>, NOT a <button> and NOT role="button": it
  // contains nested interactive controls (Request/Confirm/Cancel/View, the
  // overlay action, the IMDb link). A real <button> can't nest buttons (the
  // HTML parser auto-closes it — the canonical React #418 source on /movies,
  // /tv, /, /popular, /upcoming and /tv/[id]), and role="button" makes every
  // child presentational, so screen readers flattened the card to one button
  // and the nested controls became unreachable. The mouse click-anywhere
  // target stays on the div; keyboard and assistive tech reach the detail page
  // through the real link on the title below.
  return (
    <div
      onClick={handleCardClick}
      className={cn(
        "group relative flex flex-col w-full overflow-hidden text-left cursor-pointer",
        "ds-card-lift",
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
            priority={priority}
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
              : "opacity-0 group-hover:opacity-100 focus-within:opacity-100",
          )}
          style={{
            background: onPoster
              ? "linear-gradient(180deg, transparent 40%, rgba(0,0,0,0.72) 100%)"
              : "none",
            padding: 10,
          }}
        >
          {reqState === "confirm" ? (
            <div className="pointer-events-auto flex flex-col items-center gap-2 px-3 pb-2">
              <span
                className="text-center leading-tight font-semibold"
                style={{ fontSize: 11, color: overlayFg }}
              >
                Request this?
              </span>
              <div className="flex items-center gap-2">
                <button
                  onClick={handleBubbleClick}
                  type="button"
                  aria-label={`Confirm request for ${media.title}`}
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
                  aria-label={`Cancel request for ${media.title}`}
                  className="ds-tap inline-flex items-center gap-1 font-semibold transition-colors"
                  style={{
                    padding: "4px 10px",
                    borderRadius: 999,
                    background: overlayCancelBg,
                    color: overlayFg,
                    fontSize: 11,
                    border: overlayGhostBorder,
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
              aria-label={bubbleLabel()}
              // Clickable only while the overlay is revealed. The overlay is
              // opacity-0 until hover/focus, and a transparent-but-live button
              // swallowed touch taps on the poster's bottom-centre (no hover
              // on touch to reveal it first — Tailwind gates group-hover on
              // `(hover: hover)`), opening a request prompt nobody saw.
              // Keyboard focus is unaffected by pointer-events.
              className="ds-tap pointer-events-none group-hover:pointer-events-auto group-focus-within:pointer-events-auto inline-flex items-center gap-1.5 font-semibold transition-colors"
              style={{
                padding: "5px 12px",
                borderRadius: 999,
                background:
                  isAvailable || isRequested || blacklisted
                    ? overlayGhostBg
                    : "var(--ds-accent)",
                color:
                  isAvailable || isRequested || blacklisted
                    ? overlayFg
                    : "var(--ds-accent-fg)",
                border:
                  isAvailable || isRequested || blacklisted
                    ? overlayGhostBorder
                    : "0",
                fontSize: 12,
              }}
            >
              {bubbleContent()}
            </button>
          )}
        </div>

        {/* Top-left: availability chips. `data-media-chips` lets a caller that
            puts its own overlay in this corner shift them clear — /popular's
            rank badge sits at exactly these coordinates (top-1.5/left-1.5 is
            6px, the same inset it uses) and, being z-10, covered the Plex
            glyph on every ranked card. See .ds-ranked-card in globals.css.
            An overlayAction shares this corner too, so with one present the
            stack starts below it (26px control + its 36px hit area + inset). */}
        <div
          data-media-chips
          className="absolute top-1.5 left-1.5 flex flex-col gap-1"
          style={overlayAction ? { top: 38 } : undefined}
        >
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
          {/* 4K chips — arr4k* are only populated when the viewer has 4K access (enrichment gate) */}
          {media.arr4kAvailable && (
            <span
              className="ds-chip"
              style={{
                paddingLeft: 5,
                paddingRight: 6,
                background: "var(--ds-accent-soft)",
                color: "var(--ds-accent-text)",
                border: "1px solid var(--ds-accent-ring)",
              }}
            >
              <CheckCircle style={{ width: 9, height: 9 }} />
              4K
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
          {!media.arr4kAvailable && media.arr4kPending && (
            <span
              className="ds-chip ds-chip-pending"
              style={{ paddingLeft: 5, paddingRight: 6 }}
            >
              <Clock style={{ width: 9, height: 9 }} />
              4K Queued
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

        {/* Bottom-left: admin-blacklisted indicator (shown but unrequestable) */}
        {!isAvailable && !isRequested && blacklisted && (
          <span
            className="ds-chip absolute bottom-1.5 left-1.5"
            style={{
              paddingLeft: 5,
              paddingRight: 6,
              background: "color-mix(in oklab, var(--ds-bg-inset) 80%, transparent)",
              color: "var(--ds-fg-muted)",
              border: "1px solid var(--ds-border)",
            }}
          >
            <Ban style={{ width: 9, height: 9 }} />
            Blocked
          </span>
        )}

        {/* Top-left: caller-supplied action (e.g. /for-you's "not interested").
            Fades in with hover like the request overlay, but stays visible while
            focused so it is reachable by keyboard and always present on touch,
            where there is no hover state to reveal it. */}
        {overlayAction && (
          <div className="absolute top-1.5 left-1.5 opacity-0 transition-opacity group-hover:opacity-100 focus-within:opacity-100 max-[1024px]:opacity-100">
            {overlayAction}
          </div>
        )}

        {/* Top-right: TMDB community score (at-a-glance). Detailed ratings live in the RatingsBar below. */}
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
              aria-hidden="true"
              style={{
                fontSize: 9,
                lineHeight: 1,
                color: "var(--ds-warning)",
              }}
            >
              ★
            </span>
            {media.voteAverage.toFixed(1)}
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
          {/* The card's keyboard / screen-reader entry point (see the root
              comment). stopPropagation: the root div's click handler would
              otherwise navigate a second time. */}
          {onClick ? (
            <button
              type="button"
              onClick={(e) => {
                e.stopPropagation();
                onClick(media);
              }}
              className="text-left rounded-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--ds-accent-ring)]"
              style={{ font: "inherit", color: "inherit", background: "none", border: 0, padding: 0 }}
            >
              {media.title}
            </button>
          ) : (
            <Link
              href={detailPath}
              onClick={(e) => e.stopPropagation()}
              className="rounded-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--ds-accent-ring)]"
              style={{ color: "inherit" }}
            >
              {media.title}
            </Link>
          )}
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
        {caption}
        <div
          className={size === "md" ? "flex flex-col gap-1 mt-0.5" : "min-h-[34px] flex items-start"}
        >
          <RatingsBar
            imdbRating={liveRatings?.imdbRating ?? media.imdbRating}
            imdbId={liveRatings?.imdbId ?? media.imdbId}
            imdbVotes={liveRatings?.imdbVotes ?? media.imdbVotes}
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
    </div>
  );
}

export const MediaCard = memo(MediaCardImpl);
