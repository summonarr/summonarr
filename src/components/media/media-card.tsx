"use client";

import Image from "next/image";
import Link from "next/link";
import { useRouter } from "next/navigation";
import {
  Film,
  Tv2,
  CheckCircle,
  Loader2,
  Plus,
  Check,
  X,
  Ban,
} from "@/components/icons";
import { posterUrl, type TmdbMedia } from "@/lib/tmdb-types";
import { RatingsBar } from "@/components/media/ratings-bar";
import { AvailabilityChips } from "@/components/media/availability-chips";
import { mergeRatings } from "@/components/media/ratings-merge";
import { cn } from "@/lib/utils";
import { useState, useEffect, memo } from "react";
import { requestRatings, type RatingsPayload } from "@/lib/client/ratings-batcher";
import { postMediaRequest } from "@/lib/client/media-request";
import { useToast } from "@/components/ui/toast";
import { useT } from "@/components/i18n/i18n-provider";

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
  /** When false, hide the HD Request overlay (the viewer cannot request this
      media type on the default instance). View / Blocked still render — those
      are not the request CTA. Same gate as the detail-page HD button. */
  canRequest?: boolean;
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
  canRequest = true,
}: MediaCardProps) {
  const router = useRouter();
  const { toast } = useToast();
  const t = useT();
  const poster = posterUrl(media.posterPath, "w342");
  const [reqState, setReqState] = useState<RequestState>("idle");
  const [liveRatings, setLiveRatings] = useState<LiveRatings | null>(null);
  // Grids key cards by id, but a reused instance (person filmography filter,
  // a parent that forgets the key) must not keep the previous title's request
  // overlay. Ratings live-state is title-scoped too.
  const [seenId, setSeenId] = useState(media.id);
  const titleChanged = seenId !== media.id;
  if (titleChanged) {
    setSeenId(media.id);
    setReqState("idle");
    setLiveRatings(null);
  }

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
  ) || (!titleChanged && reqState === "available");
  // Only the viewer's OWN request blocks re-requesting. A title queued by
  // someone else (arrPending) stays requestable — the server mirrors the
  // approved status so this user gets the "now available" notification.
  const uiReqState = titleChanged ? "idle" : reqState;
  const isRequested = !!media.requestedByMe || uiReqState === "requested";
  const blacklisted = !!media.blacklisted;
  // "Ghost" bubble: the title is already available, already requested by this
  // viewer, or blocked — the bubble opens the detail page instead of requesting.
  const ghost = isAvailable || isRequested || blacklisted;
  // Hide the Request overlay when the viewer cannot request this type. Keep
  // View / Blocked / in-flight confirm — "already requested" is not the CTA.
  const showRequestOverlay =
    canRequest ||
    ghost ||
    uiReqState === "confirm" ||
    uiReqState === "loading" ||
    uiReqState === "error";

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
      // Fetches a token when no prop carries one, and refreshes a prop token
      // (person pages mint it at render) that expired while the tab sat open.
      // A failed token fetch comes back as its own non-ok answer and lands in
      // the error branch below without posting anything.
      const res = await postMediaRequest({ tmdbId: media.id, mediaType: mt }, requestToken);
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
          title: data?.error ?? t("media.card.requestFailed", { title: media.title }),
          variant: "error",
        });
        const transient = res.status >= 500 || res.status === 429;
        setReqState(transient ? "error" : "idle");
      }
    } catch {
      toast({ title: t("media.networkError"), variant: "error" });
      setReqState("error");
    }
  }

  function handleBubbleClick(e: React.MouseEvent) {
    e.stopPropagation();
    if (onClick) {
      onClick(media);
      return;
    }
    if (ghost) {
      router.push(detailPath);
    } else if (!canRequest) {
      return;
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
        {showRequestOverlay && (
          <RequestOverlay
            title={media.title}
            uiReqState={uiReqState}
            isAvailable={isAvailable}
            isRequested={isRequested}
            blacklisted={blacklisted}
            ghost={ghost}
            onPoster={!!poster}
            onBubble={handleBubbleClick}
            onCancel={cancelConfirm}
          />
        )}

        <CardBadges
          media={media}
          showPlex={showPlex}
          showJellyfin={showJellyfin}
          isAvailable={isAvailable}
          isRequested={isRequested}
          blacklisted={blacklisted}
          uiReqState={uiReqState}
          overlayAction={overlayAction}
        />
      </div>

      {/* Card body */}
      <div
        className={cn(
          // grow + the ratings row's mt-auto pin the ratings to the card's
          // bottom edge, so a row of cards whose bodies differ in height (a
          // one-line title, a caption) still lines its ratings up.
          "flex flex-col gap-1.5 grow shrink-0",
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
          <span>{media.mediaType === "movie" ? t("media.type.movie") : t("media.type.tv")}</span>
          {media.certification && (
            <>
              <span>·</span>
              <span>{media.certification}</span>
            </>
          )}
        </div>
        {caption}
        <div
          className={size === "md" ? "flex flex-col gap-1 mt-auto" : "min-h-[34px] flex items-start mt-auto"}
        >
          <RatingsBar
            {...mergeRatings(media, liveRatings)}
            voteAverage={media.voteAverage}
            size="sm"
            compact={size !== "md"}
          />
        </div>
      </div>
    </div>
  );
}

// The poster's hover / confirm overlay: the request bubble, or the confirm
// prompt once it was clicked. Only rendered while MediaCard's
// showRequestOverlay holds.
function RequestOverlay({
  title,
  uiReqState,
  isAvailable,
  isRequested,
  blacklisted,
  ghost,
  onPoster,
  onBubble,
  onCancel,
}: {
  title: string;
  uiReqState: RequestState;
  isAvailable: boolean;
  isRequested: boolean;
  blacklisted: boolean;
  ghost: boolean;
  onPoster: boolean;
  onBubble: (e: React.MouseEvent) => void;
  onCancel: (e: React.MouseEvent) => void;
}) {
  const t = useT();

  // Accessible names for the overlay controls: each card's buttons read as
  // "Request <title>" rather than a page full of identical "Request"s.
  const bubbleLabel = () => {
    if (isAvailable || isRequested) return t("media.card.viewLabel", { title });
    // The button navigates (router.push), so name the action, not a status.
    if (blacklisted) return t("media.card.viewBlockedLabel", { title });
    if (uiReqState === "loading") return t("media.card.requestingLabel", { title });
    if (uiReqState === "error") return t("media.card.retryLabel", { title });
    return t("media.card.requestLabel", { title });
  };

  // Over a poster the scrim is black and the overlay text white — an image is
  // always dark-compatible. With no poster the placeholder is a flat surface
  // that is near-white in light mode, so the gradient (a black smear there) is
  // dropped and the translucent-white ghost button reads off the theme instead.
  const overlayFg = onPoster ? "#fff" : "var(--ds-fg)";
  const overlayGhostBg = onPoster ? "rgba(255,255,255,0.14)" : "var(--ds-bg-2)";
  const overlayCancelBg = onPoster ? "rgba(255,255,255,0.12)" : "var(--ds-bg-2)";
  const overlayGhostBorder = onPoster
    ? "1px solid rgba(255,255,255,0.28)"
    : "1px solid var(--ds-border)";

  const bubbleContent = () => {
    if (isAvailable) return <span>{t("media.card.view")}</span>;
    if (isRequested) return <span>{t("media.card.view")}</span>;
    if (blacklisted)
      return (
        <span className="flex items-center gap-1">
          <Ban className="w-3.5 h-3.5" />
          {t("media.card.blocked")}
        </span>
      );
    if (uiReqState === "loading") return <Loader2 className="w-3.5 h-3.5 animate-spin" />;
    if (uiReqState === "error") return <span>{t("media.card.retry")}</span>;
    return (
      <span className="flex items-center gap-1">
        <Plus className="w-3.5 h-3.5" />
        {t("media.card.request")}
      </span>
    );
  };

  return (
    <div
      className={cn(
        "absolute inset-0 flex items-end justify-center pointer-events-none transition-opacity",
        uiReqState === "confirm"
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
      {uiReqState === "confirm" ? (
        <div className="pointer-events-auto flex flex-col items-center gap-2 px-3 pb-2">
          <span
            className="text-center leading-tight font-semibold"
            style={{ fontSize: 11, color: overlayFg }}
          >
            {t("media.card.confirmPrompt")}
          </span>
          <div className="flex items-center gap-2">
            <button
              onClick={onBubble}
              type="button"
              aria-label={t("media.card.confirmLabel", { title })}
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
              {t("media.card.confirm")}
            </button>
            <button
              onClick={onCancel}
              type="button"
              aria-label={t("media.card.cancelLabel", { title })}
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
              {t("media.card.cancel")}
            </button>
          </div>
        </div>
      ) : (
        <button
          onClick={onBubble}
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
            background: ghost ? overlayGhostBg : "var(--ds-accent)",
            color: ghost ? overlayFg : "var(--ds-accent-fg)",
            border: ghost ? overlayGhostBorder : "0",
            fontSize: 12,
          }}
        >
          {bubbleContent()}
        </button>
      )}
    </div>
  );
}

// The poster's corner badges: availability chips (+ the caller's overlay
// action) top-left, request state bottom-left, the TMDB score top-right.
function CardBadges({
  media,
  showPlex,
  showJellyfin,
  isAvailable,
  isRequested,
  blacklisted,
  uiReqState,
  overlayAction,
}: {
  media: TmdbMedia;
  showPlex: boolean;
  showJellyfin: boolean;
  isAvailable: boolean;
  isRequested: boolean;
  blacklisted: boolean;
  uiReqState: RequestState;
  overlayAction?: React.ReactNode;
}) {
  const t = useT();
  return (
    <>
      {/* Top-left: availability chips. `data-media-chips` lets a caller that
          puts its own overlay in this corner shift them clear — /popular's
          rank badge sits at exactly these coordinates (top-1.5/left-1.5 is
          6px, the same inset it uses) and, being z-10, covered the Plex
          glyph on every ranked card. See .ds-ranked-card in globals.css.
          An overlayAction shares this corner too and rides at the END of
          the stack, so the chips keep the corner and the control follows
          whatever is above it (or takes the corner when there are none). */}
      <div
        data-media-chips
        className="absolute top-1.5 left-1.5 flex flex-col gap-1"
      >
        <AvailabilityChips
          media={media}
          showPlex={showPlex}
          showJellyfin={showJellyfin}
          isAvailable={isAvailable}
        />
        {/* Caller-supplied action (e.g. /for-you's "not interested").
            Fades in with hover like the request overlay, but stays visible
            while focused so it is reachable by keyboard and always present
            on any device without hover. Keyed on (hover: none), NOT a width:
            an iPad in landscape is wider than any breakpoint and still has
            no hover, so a width gate left the control transparent but
            tappable there. mt-0.5 keeps its 5px hit-area outset clear of
            the chip above. */}
        {overlayAction && (
          <div className="mt-0.5 self-start opacity-0 transition-opacity group-hover:opacity-100 focus-within:opacity-100 [@media(hover:none)]:opacity-100">
            {overlayAction}
          </div>
        )}
      </div>

      {/* Bottom-left: request state — "Requested" (a pending request, anyone's)
          and "Blocked" (admin blacklist, which never touches the request rows,
          so both can hold at once). One stack like the top-left chips, so they
          no longer paint on top of each other at the same corner.
          pointer-events-none: the chip sat over the revealed bubble's corner
          on ordinary card widths and a click there bubbled to the card (→ the
          detail page) instead of the bubble. It fades whenever the overlay is
          revealed for the same reason — the two share the poster's bottom
          edge — and stays hidden while the confirm prompt is up. */}
      {!isAvailable &&
        ((media.requested || uiReqState === "requested") || (!isRequested && blacklisted)) && (
        <div
          className={cn(
            "absolute bottom-1.5 left-1.5 flex flex-col items-start gap-1 pointer-events-none transition-opacity",
            uiReqState === "confirm"
              ? "opacity-0"
              : "group-hover:opacity-0 group-focus-within:opacity-0",
          )}
        >
          {(media.requested || uiReqState === "requested") && (
            <span
              className="ds-chip ds-chip-accent"
              style={{ paddingLeft: 5, paddingRight: 6 }}
            >
              <CheckCircle style={{ width: 9, height: 9 }} />
              {t("media.badge.requested")}
            </span>
          )}
          {!isRequested && blacklisted && (
            <span
              className="ds-chip"
              style={{
                paddingLeft: 5,
                paddingRight: 6,
                background: "color-mix(in oklab, var(--ds-bg-inset) 80%, transparent)",
                color: "var(--ds-fg-muted)",
                border: "1px solid var(--ds-border)",
              }}
            >
              <Ban style={{ width: 9, height: 9 }} />
              {t("media.card.blocked")}
            </span>
          )}
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
          {/* Brand name, not a catalog string. Without it the badge read as a
              bare "7.8" between the poster alt and the chips. */}
          <span className="sr-only">TMDB </span>
          {media.voteAverage.toFixed(1)}
        </div>
      )}
    </>
  );
}

export const MediaCard = memo(MediaCardImpl);
