// The frames the browser reads from /api/events (src/hooks/use-live-events.ts):
// their types, and the one runtime check each frame passes before any
// subscriber sees it. Zero imports beyond the shape checker, so the client hook
// and the unit suite share it.
//
// The server's own event union is SSEEvent (src/lib/sse-emitter.ts); a frame is
// that event without its `userId`, plus `own` on the inbox kinds
// (sseClientFrame in sse-delivery.ts). A frame whose type the client doesn't
// know, or whose fields don't match, is dropped instead of dispatched — a
// renamed field fails here, not inside a consumer.
import { check, v, type Schema } from "./validate";

export interface ActiveSessionLive {
  id: string;
  source: string;
  state: string;
  mediaServerUserId: string;
  serverUsername: string;
  title: string;
  tmdbId: number | null;
  mediaType: string | null;
  year: string | null;
  seasonNumber: number | null;
  episodeNumber: number | null;
  episodeTitle: string | null;
  progressPercent: number;
  progressMs: number;
  durationMs: number;
  startedAt: string | null;
  platform: string | null;
  player: string | null;
  device: string | null;
  ipAddress: string | null;
  playMethod: string | null;
  videoCodec: string | null;
  audioCodec: string | null;
  resolution: string | null;
  bitrate: number | null;
  videoDecision: string | null;
  audioDecision: string | null;
  container: string | null;
  posterUrl: string | null;
  // Network metadata from /status/sessions Session + Player sub-objects.
  location: string | null;
  bandwidth: number | null;
  secure: boolean | null;
  relayed: boolean | null;
  // Intro/credits marker offsets in ms, from /library/metadata?includeMarkers=1.
  introStartMs: number | null;
  introEndMs: number | null;
  creditsStartMs: number | null;
  creditsEndMs: number | null;
}

export type LiveEvent =
  | { type: "connected" }
  // Client-synthesized (never sent by the server): the shared stream errored.
  | { type: "disconnected" }
  | { type: "request:new"; requestId: string }
  // `own`: the event is about this viewer (set by /api/events on the frames
  // that come with an inbox row — see inbox-live-events.ts).
  | { type: "request:updated"; requestId: string; status: string; own?: boolean }
  | { type: "request:deleted"; requestId: string }
  | { type: "request:comment"; requestId: string; own?: boolean }
  | { type: "issue:new"; issueId: string }
  | { type: "issue:updated"; issueId: string; status: string; own?: boolean }
  | { type: "issue:deleted"; issueId: string }
  | { type: "issuemessage:created"; issueId: string; messageId?: string; own?: boolean }
  | { type: "activity:sessions"; sessions: ActiveSessionLive[] }
  | { type: "activity:history-updated" }
  | { type: "plex:reachability"; reachable: boolean; instance: string }
  // The admin nav's arr badges; the consumer runs them through parseNavBadges.
  | { type: "nav:badges"; badges: Record<string, unknown> };

type ServerFrameType = Exclude<LiveEvent["type"], "disconnected">;

const own = v.optional(v.boolean());

// Every type the server sends. A session row is checked to be an object; its
// fields are the server's own projection of ActiveSession, typed above.
const FRAME_SCHEMAS: { [K in ServerFrameType]: Schema<unknown> } = {
  connected: v.object({ type: v.literal("connected") }),
  "request:new": v.object({ type: v.literal("request:new"), requestId: v.string() }),
  "request:updated": v.object({ type: v.literal("request:updated"), requestId: v.string(), status: v.string(), own }),
  "request:deleted": v.object({ type: v.literal("request:deleted"), requestId: v.string() }),
  "request:comment": v.object({ type: v.literal("request:comment"), requestId: v.string(), own }),
  "issue:new": v.object({ type: v.literal("issue:new"), issueId: v.string() }),
  "issue:updated": v.object({ type: v.literal("issue:updated"), issueId: v.string(), status: v.string(), own }),
  "issue:deleted": v.object({ type: v.literal("issue:deleted"), issueId: v.string() }),
  "issuemessage:created": v.object({ type: v.literal("issuemessage:created"), issueId: v.string(), messageId: v.optional(v.string()), own }),
  "activity:sessions": v.object({ type: v.literal("activity:sessions"), sessions: v.array(v.record(v.unknown())) }),
  "activity:history-updated": v.object({ type: v.literal("activity:history-updated") }),
  "plex:reachability": v.object({ type: v.literal("plex:reachability"), reachable: v.boolean(), instance: v.string() }),
  "nav:badges": v.object({ type: v.literal("nav:badges"), badges: v.record(v.unknown()) }),
};

function isServerFrameType(type: unknown): type is ServerFrameType {
  return typeof type === "string" && Object.hasOwn(FRAME_SCHEMAS, type);
}

/** One SSE `data:` payload → the event, or null when it isn't a frame this client knows. */
export function parseLiveEvent(data: string): LiveEvent | null {
  let raw: unknown;
  try {
    raw = JSON.parse(data);
  } catch {
    return null;
  }
  const type = raw && typeof raw === "object" ? (raw as { type?: unknown }).type : undefined;
  if (!isServerFrameType(type)) return null;
  const parsed = check(FRAME_SCHEMAS[type], raw);
  // The schema for `type` accepted it, so it is that member of the union (the
  // session rows' own fields are the server's projection, not re-checked here).
  return parsed.ok ? (parsed.value as LiveEvent) : null;
}
