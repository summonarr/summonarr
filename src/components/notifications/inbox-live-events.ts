import type { LiveEvent } from "@/hooks/use-live-events";

// The live events the server sends alongside a new in-app notification row for
// this user, so the shared notification store re-fetches on them for a
// near-instant badge. `request:comment` is the one the comment route emits next
// to the requester's REQUEST_COMMENT inbox row. Kept in a plain .ts module so
// the unit suite can pin it (the store itself is a .tsx client component).
const INBOX_LIVE_EVENT_TYPES: ReadonlySet<LiveEvent["type"]> = new Set<LiveEvent["type"]>([
  "request:updated",
  "request:comment",
  "issue:updated",
  "issuemessage:created",
]);

export function reloadsInbox(event: LiveEvent): boolean {
  return INBOX_LIVE_EVENT_TYPES.has(event.type);
}
