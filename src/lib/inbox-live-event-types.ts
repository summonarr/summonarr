// The live event types the server sends beside a new in-app notification row.
// Every one of those rows belongs to the event's own user (requester or
// reporter), so /api/events marks these frames `own` for the viewer, and the
// shared notification store re-fetches the inbox only on its own ones
// (src/components/notifications/inbox-live-events.ts). Zero-import, so the
// server route and the client module share one list.
export const INBOX_LIVE_EVENT_TYPES = [
  "request:updated",
  "request:comment",
  "issue:updated",
  "issuemessage:created",
] as const;

const TYPES: ReadonlySet<string> = new Set(INBOX_LIVE_EVENT_TYPES);

export function isInboxLiveEventType(type: string): boolean {
  return TYPES.has(type);
}
