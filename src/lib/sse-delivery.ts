// Who receives which /api/events frame, and what the frame carries. Pure, so
// the delivery rules are unit-testable apart from the stream (the route,
// src/app/api/events/route.ts, owns the connection lifecycle).
import { hasPermission, Permission } from "./permissions";
import { isInboxLiveEventType } from "./inbox-live-event-types";

/**
 * The permission bits delivery reads, refreshed on every re-auth tick so a
 * demotion narrows a live connection without a reconnect. Bitmask-
 * authoritative, never the role label: a demoted ISSUE_ADMIN with
 * MANAGE_ISSUES cleared stops receiving other users' issue frames.
 */
export interface SseDeliveryScope {
  isSystemAdmin: boolean;
  isIssueAdmin: boolean;
  /**
   * The admin request queue (/admin admits MANAGE_REQUESTS alone) refreshes
   * ONLY from request:* frames, so a delegated manager needs other users'
   * request frames too. They carry only requestId/status (userId is stripped).
   */
  canManageRequests: boolean;
}

export function sseDeliveryScope(permissions: bigint): SseDeliveryScope {
  return {
    isSystemAdmin: hasPermission(permissions, Permission.ADMIN),
    isIssueAdmin: hasPermission(permissions, Permission.MANAGE_ISSUES),
    canManageRequests: hasPermission(permissions, Permission.MANAGE_REQUESTS),
  };
}

// Server-wide activity: admins only, whoever the frame is about.
const ADMIN_ONLY_EVENT_TYPES = new Set(["activity:sessions", "activity:history-updated", "plex:reachability", "nav:badges"]);

/**
 * Per-event-type delivery rules:
 *   activity:sessions, activity:history-updated, plex:reachability, nav:badges — system admin only
 *   issue:* / issuemessage:* — system admin OR MANAGE_ISSUES bypasses the per-user filter
 *   request:* — system admin OR MANAGE_REQUESTS bypasses the per-user filter
 *   everything else (votes:*, push:*, settings:*) — only a system admin bypasses;
 *     an issue admin or a request manager goes through the same per-user filter as a USER.
 * Without the split, an issue admin could observe every user's request, settings
 * and push events.
 */
export function shouldDeliverSseEvent(
  scope: SseDeliveryScope,
  viewerId: string,
  eventType: string,
  eventUserId: string | undefined,
): boolean {
  if (ADMIN_ONLY_EVENT_TYPES.has(eventType)) return scope.isSystemAdmin;
  const bypassesUserFilter =
    eventType.startsWith("issue:") || eventType.startsWith("issuemessage:")
      ? scope.isSystemAdmin || scope.isIssueAdmin
      : eventType.startsWith("request:")
        ? scope.isSystemAdmin || scope.canManageRequests
        : scope.isSystemAdmin;
  if (bypassesUserFilter) return true;
  return eventUserId === viewerId;
}

/**
 * The frame a viewer is sent: the event without its `userId` (another user's
 * id is never sent). The bypasses above deliver other users' request/issue
 * frames, and the inbox only has a row for the event's own user, so an inbox
 * event says which it is — `own`, a boolean — and the store does not re-fetch
 * the inbox for every one of them.
 */
export function sseClientFrame<E extends { type: string; userId?: string }>(
  event: E,
  viewerId: string,
): Omit<E, "userId"> | (Omit<E, "userId"> & { own: boolean }) {
  const { userId: evtUserId, ...clientEvent } = event;
  return isInboxLiveEventType(event.type) ? { ...clientEvent, own: evtUserId === viewerId } : clientEvent;
}
