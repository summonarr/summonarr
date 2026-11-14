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
import { useState, useEffect, useRef, memo } from "react";
import { useToast } from "@/components/ui/toast";
import { useT } from "@/components/i18n/i18n-provider";
import type { Translator } from "@/lib/i18n/translate";
import { useAsyncAction } from "@/hooks/use-async-action";
import { useFocusReturn } from "@/hooks/use-focus-return";
import { cardView, requestStateAfterRefresh, submitCardRequest, type CardRequestState, type CardView } from "./media-card-state";
import { mediaDetailPath } from "./media-links";
import { useLiveRatings } from "./use-live-ratings";

interface MediaCardProps {
  media: TmdbMedia;
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
  /** When true, show the HD Request overlay (the viewer can request this media
      type on the default instance). View / Blocked render either way — those
      are not the request CTA. Same gate as the detail-page HD button. Off
      unless a caller says so: a forgotten prop must not offer a request the
      server will refuse. */
  canRequest?: boolean;
}

// The viewer's request from this card: idle → confirm → loading → requested /
// available, or back to idle / error with a toast. An answer that lands after
// the card went away (another title, another page) is dropped with it.
function useCardRequest(media: TmdbMedia, requestToken: string | undefined) {
  const router = useRouter();
  const { toast } = useToast();
  const t = useT();
  const action = useAsyncAction();
  const [state, setState] = useState<CardRequestState>("idle");
  // The viewer's request going away (declined or deleted, then a live refresh
  // re-rendered this card) must clear a "Requested" this card set itself —
  // cardView ORs the local state in. Judged on each NEW `media` object (a new
  // server render; every caller passes the server's object through), not on a
  // requestedByMe true→false flip: /for-you does not refresh on the viewer's
  // own request:new, so the flag never went true there and a declined title
  // kept its Requested chip until a reload. A render that arrives while the
  // request is still in flight is ignored — the state is not "requested" yet.
  const [seenMedia, setSeenMedia] = useState(media);
  if (seenMedia !== media) {
    setSeenMedia(media);
    const next = requestStateAfterRefresh(state, !!media.requestedByMe);
    if (next !== state) setState(next);
  }

  async function submit() {
    if (state !== "idle" && state !== "confirm") return;
    setState("loading");
    const outcome = await action.run("request", (signal) => submitCardRequest(media, requestToken, signal), { ifBusy: "skip" });
    if (!outcome) return;
    switch (outcome.kind) {
      case "available":
        // The item was already in a library — no request row was created.
        // Reflect availability and let the server re-render the badges.
        setState("available");
        router.refresh();
        return;
      case "requested":
        setState("requested");
        return;
      case "refused":
        // Surface the server's reason (quota, permission, instance errors) —
        // the bubble alone only ever said "Retry", and only on hover.
        toast({ title: outcome.message ?? t("media.card.requestFailed", { title: media.title }), variant: "error" });
        setState(outcome.transient ? "error" : "idle");
        return;
      case "no-answer":
        toast({ title: t("media.networkError"), variant: "error" });
        setState("error");
        return;
    }
  }

  return {
    state,
    ask: () => setState("confirm"),
    cancel: () => setState("idle"),
    submit,
  };
}

function MediaCardImpl({
  media,
  className,
  size = "sm",
  showPlex = true,
  showJellyfin = true,
  priority = false,
  requestToken,
  caption,
  overlayAction,
  canRequest = false,
}: MediaCardProps) {
  const router = useRouter();
  const t = useT();
  const poster = posterUrl(media.posterPath, "w342");
  const liveRatings = useLiveRatings(media);
  const request = useCardRequest(media, requestToken);
  const view = cardView(media, { showPlex, showJellyfin, canRequest, state: request.state });
  const detailPath = mediaDetailPath(media);

  function handleBubbleClick() {
    if (view.ghost) {
      router.push(detailPath);
    } else if (!canRequest) {
      return;
    } else if (request.state === "idle" || request.state === "error") {
      request.ask();
    }
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
      onClick={() => router.push(detailPath)}
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
        {view.showRequestOverlay && (
          <RequestOverlay
            title={media.title}
            state={request.state}
            view={view}
            onPoster={!!poster}
            onBubble={handleBubbleClick}
            onConfirm={() => void request.submit()}
            onCancel={request.cancel}
          />
        )}

        <CardBadges
          media={media}
          showPlex={showPlex}
          showJellyfin={showJellyfin}
          view={view}
          confirming={request.state === "confirm"}
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
          <Link
            href={detailPath}
            onClick={(e) => e.stopPropagation()}
            className="rounded-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--ds-accent-ring)]"
            style={{ color: "inherit" }}
          >
            {media.title}
          </Link>
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

const POSTER_SCRIM = "linear-gradient(180deg, transparent 40%, rgba(0,0,0,0.72) 100%)";

// Where keyboard focus goes back to when the confirm prompt closes.
const BUBBLE = "bubble";

// The poster's hover / confirm overlay: the request bubble, or the confirm
// prompt once it was clicked. Only rendered while the card's
// showRequestOverlay holds.
function RequestOverlay({
  title,
  state,
  view,
  onPoster,
  onBubble,
  onConfirm,
  onCancel,
}: {
  title: string;
  state: CardRequestState;
  view: CardView;
  onPoster: boolean;
  onBubble: () => void;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  const t = useT();
  const focus = useFocusReturn();
  const rootRef = useRef<HTMLDivElement>(null);
  const confirming = state === "confirm";

  // Over a poster the scrim is black and the overlay text white — an image is
  // always dark-compatible. With no poster the placeholder is a flat surface
  // that is near-white in light mode, so the gradient (a black smear there) is
  // dropped and the translucent-white ghost button reads off the theme instead.
  const overlayFg = onPoster ? "#fff" : "var(--ds-fg)";
  const overlayGhostBg = onPoster ? "rgba(255,255,255,0.14)" : "var(--ds-bg-2)";
  const overlayGhostBorder = onPoster
    ? "1px solid rgba(255,255,255,0.28)"
    : "1px solid var(--ds-border)";

  // Revealed on hover or when anything in the card has focus; always while
  // the confirm prompt is up.
  const reveal = confirming
    ? "opacity-100"
    : "opacity-0 group-hover:opacity-100 group-focus-within:opacity-100";
  // A touch screen has no hover to reveal the bubble, so a REQUEST bubble
  // (not a "View" one — a tap on the card already opens the title) stays
  // visible and live there, as a compact "+" in the bottom-right corner, clear
  // of the bottom-left status chips.
  const touchCta = !view.ghost;

  const cancel = () => {
    focus.returnTo(BUBBLE);
    onCancel();
  };

  // The prompt is a step in one card: a click anywhere else (another card's
  // bubble included) dismisses it, so only one card is ever asking.
  const cancelRef = useRef(onCancel);
  useEffect(() => {
    cancelRef.current = onCancel;
  });
  useEffect(() => {
    if (!confirming) return;
    const onPointerDown = (e: PointerEvent) => {
      if (e.target instanceof Node && rootRef.current?.contains(e.target)) return;
      cancelRef.current();
    };
    document.addEventListener("pointerdown", onPointerDown);
    return () => document.removeEventListener("pointerdown", onPointerDown);
  }, [confirming]);

  return (
    <div
      ref={rootRef}
      className={cn(
        "absolute inset-0 flex items-end justify-center pointer-events-none",
        !confirming && touchCta && "[@media(hover:none)]:justify-end",
      )}
      style={{ padding: 10 }}
    >
      {onPoster && (
        <div
          aria-hidden="true"
          className={cn("absolute inset-0 transition-opacity", reveal)}
          style={{ background: POSTER_SCRIM }}
        />
      )}
      {confirming ? (
        <div
          className="pointer-events-auto relative flex flex-col items-center gap-2 px-3 pb-2"
          onKeyDown={(e) => {
            if (e.key !== "Escape") return;
            e.stopPropagation();
            cancel();
          }}
        >
          <span
            className="text-center leading-tight font-semibold"
            style={{ fontSize: 11, color: overlayFg }}
          >
            {t("media.card.confirmPrompt")}
          </span>
          <div className="flex items-center gap-2">
            <button
              // The bubble that opened the prompt is gone: focus moves here, so
              // a keyboard user keeps their place.
              autoFocus
              onClick={(e) => {
                e.stopPropagation();
                focus.returnTo(BUBBLE);
                onConfirm();
              }}
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
              onClick={(e) => {
                e.stopPropagation();
                cancel();
              }}
              type="button"
              aria-label={t("media.card.cancelLabel", { title })}
              className="ds-tap inline-flex items-center gap-1 font-semibold transition-colors"
              style={{
                padding: "4px 10px",
                borderRadius: 999,
                background: onPoster ? "rgba(255,255,255,0.12)" : "var(--ds-bg-2)",
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
          ref={focus.refFor(BUBBLE)}
          onClick={(e) => {
            e.stopPropagation();
            onBubble();
          }}
          type="button"
          aria-label={bubbleLabel(t, title, view, state)}
          // Clickable only while revealed. A transparent-but-live button
          // swallowed touch taps on the poster's bottom-centre (no hover on
          // touch to reveal it first — Tailwind gates group-hover on
          // `(hover: hover)`), opening a request prompt nobody saw; the touch
          // CTA is visible whenever it is live. Keyboard focus is unaffected
          // by pointer-events.
          className={cn(
            "ds-tap relative inline-flex items-center gap-1.5 font-semibold transition",
            reveal,
            "pointer-events-none group-hover:pointer-events-auto group-focus-within:pointer-events-auto",
            touchCta && "[@media(hover:none)]:opacity-100 [@media(hover:none)]:pointer-events-auto",
          )}
          style={{
            padding: "5px 12px",
            borderRadius: 999,
            background: view.ghost ? overlayGhostBg : "var(--ds-accent)",
            color: view.ghost ? overlayFg : "var(--ds-accent-fg)",
            border: view.ghost ? overlayGhostBorder : "0",
            fontSize: 12,
          }}
        >
          <BubbleContent view={view} state={state} />
        </button>
      )}
    </div>
  );
}

// Accessible names for the bubble: each card's reads as "Request <title>"
// rather than a page full of identical "Request"s.
function bubbleLabel(t: Translator, title: string, view: CardView, state: CardRequestState): string {
  if (view.isAvailable || view.isRequested) return t("media.card.viewLabel", { title });
  // The button navigates (router.push), so name the action, not a status.
  if (view.blacklisted) return t("media.card.viewBlockedLabel", { title });
  if (state === "loading") return t("media.card.requestingLabel", { title });
  if (state === "error") return t("media.card.retryLabel", { title });
  return t("media.card.requestLabel", { title });
}

function BubbleContent({ view, state }: { view: CardView; state: CardRequestState }) {
  const t = useT();
  if (view.isAvailable || view.isRequested) return <span>{t("media.card.view")}</span>;
  if (view.blacklisted)
    return (
      <span className="flex items-center gap-1">
        <Ban className="w-3.5 h-3.5" />
        {t("media.card.blocked")}
      </span>
    );
  if (state === "loading") return <Loader2 className="w-3.5 h-3.5 animate-spin" />;
  if (state === "error") return <span>{t("media.card.retry")}</span>;
  return (
    <span className="flex items-center gap-1">
      <Plus className="w-3.5 h-3.5" />
      {/* Icon-only on a touch screen, where the CTA sits in the corner. */}
      <span className="[@media(hover:none)]:hidden">{t("media.card.request")}</span>
    </span>
  );
}

// The poster's corner badges: availability chips (+ the caller's overlay
// action) top-left, request state bottom-left, the TMDB score top-right.
function CardBadges({
  media,
  showPlex,
  showJellyfin,
  view,
  confirming,
  overlayAction,
}: {
  media: TmdbMedia;
  showPlex: boolean;
  showJellyfin: boolean;
  view: CardView;
  confirming: boolean;
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
          isAvailable={view.isAvailable}
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
          and "Blocked" (admin blacklist). One stack like the top-left chips,
          so they never paint on top of each other at the same corner.
          pointer-events-none: the chip sat over the revealed bubble's corner
          on ordinary card widths and a click there bubbled to the card (→ the
          detail page) instead of the bubble. It fades whenever the overlay is
          revealed for the same reason — the two share the poster's bottom
          edge — and stays hidden while the confirm prompt is up. */}
      {(view.requestedChip || view.blockedChip) && (
        <div
          className={cn(
            "absolute bottom-1.5 left-1.5 flex flex-col items-start gap-1 pointer-events-none transition-opacity",
            confirming
              ? "opacity-0"
              : "group-hover:opacity-0 group-focus-within:opacity-0",
          )}
        >
          {view.requestedChip && (
            <span
              className="ds-chip ds-chip-accent"
              style={{ paddingLeft: 5, paddingRight: 6 }}
            >
              <CheckCircle style={{ width: 9, height: 9 }} />
              {t("media.badge.requested")}
            </span>
          )}
          {view.blockedChip && (
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

// Keyed on the title, so a reused instance (a parent that forgets the key, a
// list that swaps titles in place) starts fresh: no request overlay, ratings
// or answer in flight from the previous title carries across.
function MediaCardForTitle(props: MediaCardProps) {
  return <MediaCardImpl key={`${props.media.mediaType}:${props.media.id}`} {...props} />;
}

// memo pays off under a CLIENT parent: BrowseGrid re-renders every card on each
// filter transition (isPending) with the same props. Cards a server component
// renders (For You, the home rails) get new props only with a new RSC payload,
// where every prop is new anyway.
export const MediaCard = memo(MediaCardForTitle);
