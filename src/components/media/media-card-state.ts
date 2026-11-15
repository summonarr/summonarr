// MediaCard's request state and what the card shows for it, apart from the
// markup: the view rules are pure, and the request is one function over the
// shared POST (postMediaRequest). The unit suite covers both
// (tests/media-card-state.test.mts).
import type { TmdbMedia } from "@/lib/tmdb-types";
import { postMediaRequest } from "@/lib/client/media-request";
import { check, v } from "@/lib/validate";
import { isVisiblyAvailable } from "./availability-rules";

export type CardRequestState = "idle" | "confirm" | "loading" | "requested" | "available" | "error";

export interface CardView {
  /** On a server this viewer sees, or the card's own request found it already there. */
  isAvailable: boolean;
  /** THIS viewer's request. A title queued by someone else stays requestable — the
      server mirrors the approved status so this user also gets the "now available"
      notification. */
  isRequested: boolean;
  blacklisted: boolean;
  /** The bubble opens the detail page instead of requesting. */
  ghost: boolean;
  /** Hidden when the viewer cannot request this type; View / Blocked / an in-flight
      confirm still show — "already requested" is not the CTA. */
  showRequestOverlay: boolean;
  /** Bottom-left "Requested" (a pending request, anyone's). */
  requestedChip: boolean;
  /** Bottom-left "Blocked" (admin blacklist, which never touches the request rows,
      so both chips can hold at once). */
  blockedChip: boolean;
}

export function cardView(
  media: Pick<TmdbMedia, "plexAvailable" | "jellyfinAvailable" | "requested" | "requestedByMe" | "blacklisted">,
  o: { showPlex: boolean; showJellyfin: boolean; canRequest: boolean; state: CardRequestState },
): CardView {
  const isAvailable = isVisiblyAvailable(media, o.showPlex, o.showJellyfin) || o.state === "available";
  const isRequested = !!media.requestedByMe || o.state === "requested";
  const blacklisted = !!media.blacklisted;
  const ghost = isAvailable || isRequested || blacklisted;
  return {
    isAvailable,
    isRequested,
    blacklisted,
    ghost,
    showRequestOverlay: o.canRequest || ghost || o.state === "confirm" || o.state === "loading" || o.state === "error",
    requestedChip: !isAvailable && (!!media.requested || o.state === "requested"),
    blockedChip: !isAvailable && !isRequested && blacklisted,
  };
}

/**
 * The card's own request state once a fresh server render of the title
 * arrives: a "Requested" the card set itself holds only while the server still
 * reports the viewer's request. Without one the request was declined or
 * deleted, and the card offers Request again.
 */
export function requestStateAfterRefresh(state: CardRequestState, requestedByMe: boolean): CardRequestState {
  return state === "requested" && !requestedByMe ? "idle" : state;
}

export type CardRequestOutcome =
  /** Created, or this viewer had already requested it (409). */
  | { kind: "requested" }
  /** Already in a library: no request row was made. */
  | { kind: "available" }
  /** The route refused. A 4xx is a decision (quota, permission, an instance
      error), so the card returns to idle; a 5xx or 429 may pass, so it offers
      Retry. `message` is the route's own reason, when it gave one. */
  | { kind: "refused"; transient: boolean; message: string | null }
  /** No answer: the network, or no answer within CARD_REQUEST_TIMEOUT_MS. */
  | { kind: "no-answer" };

// A request can run the token fetch, the POST and one token refresh + resend.
export const CARD_REQUEST_TIMEOUT_MS = 30_000;

const CreatedBody = v.nullable(v.object({ alreadyAvailable: v.optional(v.boolean()) }));
const ErrorBody = v.object({ error: v.string() });

/** How the card reads the request route's answer. */
export function readCardRequestAnswer(status: number, body: unknown): CardRequestOutcome {
  if (status >= 200 && status < 300) {
    const parsed = check(CreatedBody, body);
    return parsed.ok && parsed.value?.alreadyAvailable ? { kind: "available" } : { kind: "requested" };
  }
  if (status === 409) return { kind: "requested" };
  const reason = check(ErrorBody, body);
  return {
    kind: "refused",
    transient: status >= 500 || status === 429,
    message: reason.ok && reason.value.error ? reason.value.error : null,
  };
}

// The caller's signal plus the request's own deadline.
function withDeadline(signal: AbortSignal, ms: number): AbortSignal {
  return typeof AbortSignal.any === "function" && typeof AbortSignal.timeout === "function"
    ? AbortSignal.any([signal, AbortSignal.timeout(ms)])
    : signal;
}

/**
 * Requests the title on the default instance. Fetches a token when the card
 * has none, and refreshes a page-minted one that expired (postMediaRequest). A
 * failed token fetch comes back as its own refusal without posting anything.
 * Aborting `signal` (the card unmounting) ends the wait with "no-answer",
 * which the card never applies.
 */
export async function submitCardRequest(
  media: Pick<TmdbMedia, "id" | "mediaType">,
  requestToken: string | undefined,
  signal: AbortSignal,
): Promise<CardRequestOutcome> {
  const mediaType = media.mediaType === "movie" ? "MOVIE" : "TV";
  try {
    const res = await postMediaRequest({ tmdbId: media.id, mediaType }, requestToken, {
      signal: withDeadline(signal, CARD_REQUEST_TIMEOUT_MS),
    });
    const body: unknown = await res.json().catch(() => null);
    return readCardRequestAnswer(res.status, body);
  } catch {
    return { kind: "no-answer" };
  }
}
