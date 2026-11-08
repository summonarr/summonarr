import type { LiveEvent } from "@/hooks/use-live-events";
import { INBOX_LIVE_EVENT_TYPES, isInboxLiveEventType } from "@/lib/inbox-live-event-types";

// The live events the server sends alongside a new in-app notification row for
// this user, so the shared notification store re-fetches on them for a
// near-instant badge. `request:comment` is the one the comment route emits next
// to the requester's REQUEST_COMMENT inbox row. The list is the server's own
// (inbox-live-event-types.ts); kept in a plain .ts module so the unit suite can
// pin it (the store itself is a .tsx client component).
// Compile-time only: every listed type must be a LiveEvent, so a renamed event
// fails to compile here.
export const INBOX_EVENT_TYPES: readonly LiveEvent["type"][] = INBOX_LIVE_EVENT_TYPES;

export function reloadsInbox(event: LiveEvent): boolean {
  if (!isInboxLiveEventType(event.type)) return false;
  // An admin or a request/issue manager receives everyone's request:* and
  // issue:* frames, but the inbox only has a row for the event's own user;
  // /api/events marks which (`own`). Absent (an older server) reloads, as before.
  return !("own" in event && event.own === false);
}
