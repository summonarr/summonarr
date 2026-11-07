import type { LiveEvent } from "@/hooks/use-live-events";
import { INBOX_LIVE_EVENT_TYPES } from "@/lib/inbox-live-event-types";

// The live events the server sends alongside a new in-app notification row for
// this user, so the shared notification store re-fetches on them for a
// near-instant badge. `request:comment` is the one the comment route emits next
// to the requester's REQUEST_COMMENT inbox row. Kept in a plain .ts module so
// the unit suite can pin it (the store itself is a .tsx client component).
// Typed against LiveEvent so a renamed event fails to compile here.
const INBOX_EVENT_TYPES: ReadonlySet<LiveEvent["type"]> = new Set<LiveEvent["type"]>(INBOX_LIVE_EVENT_TYPES);

export function reloadsInbox(event: LiveEvent): boolean {
  if (!INBOX_EVENT_TYPES.has(event.type)) return false;
  // An admin or a request/issue manager receives everyone's request:* and
  // issue:* frames, but the inbox only has a row for the event's own user;
  // /api/events marks which (`own`). Absent (an older server) reloads, as before.
  return (event as { own?: boolean }).own !== false;
}
