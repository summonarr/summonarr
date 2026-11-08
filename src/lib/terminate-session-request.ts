// The body both admin terminate-playback routes read (Plex and Jellyfin), and
// what an upstream failure may say back to the admin. Pure: the routes own the
// translation, the media-server calls and the audit.
import { SafeFetchError } from "@/lib/safe-fetch";
import { DEFAULT_MEDIA_INSTANCE, isValidMediaInstanceSlug } from "@/lib/media-instances";

// A Plex sessionKey is a short integer and a Jellyfin PlaySessionId a 32-hex
// id, so this bounds a junk value (it becomes the audit target) without
// guessing at a client's own id format.
export const SESSION_KEY_MAX_LEN = 256;
// The reason shows on the viewer's player.
export const TERMINATE_REASON_MAX_LEN = 500;

export interface TerminateRequest {
  sessionKey: string;
  serverInstance: string;
  /** The admin's reason, or null to use the instance-language default. */
  reason: string | null;
}

export type TerminateRequestError = "sessionKeyRequired" | "sessionKeyInvalid" | "invalidServerInstance";

export type TerminateParse =
  | { ok: true; value: TerminateRequest }
  | { ok: false; error: TerminateRequestError };

const CONTROL_CHARS = /[\u0000-\u001f\u007f]/;

export function parseTerminateRequest(body: { sessionKey?: unknown; serverInstance?: unknown; reason?: unknown }): TerminateParse {
  const sessionKey = typeof body.sessionKey === "string" ? body.sessionKey.trim() : "";
  if (!sessionKey) return { ok: false, error: "sessionKeyRequired" };
  if (sessionKey.length > SESSION_KEY_MAX_LEN || CONTROL_CHARS.test(sessionKey)) {
    return { ok: false, error: "sessionKeyInvalid" };
  }
  // Absent ⇒ the default server, so older admin UI builds keep working.
  if (body.serverInstance !== undefined && (typeof body.serverInstance !== "string" || !isValidMediaInstanceSlug(body.serverInstance))) {
    return { ok: false, error: "invalidServerInstance" };
  }
  const serverInstance = typeof body.serverInstance === "string" ? body.serverInstance : DEFAULT_MEDIA_INSTANCE;
  const reason = typeof body.reason === "string" && body.reason.trim().length > 0
    ? body.reason.trim().slice(0, TERMINATE_REASON_MAX_LEN)
    : null;
  return { ok: true, value: { sessionKey, serverInstance, reason } };
}

// What the admin is told about a failed media-server call: the coarse kind,
// never the error's text. A fetch-layer message can name the server's internal
// address or the resolver's view of it; the route logs the full error instead.
export function upstreamFailureDetail(err: unknown): string {
  if (err instanceof SafeFetchError) return err.reason;
  if (err instanceof Error && (err.name === "TimeoutError" || err.name === "AbortError")) return "timeout";
  // The media-server helpers throw "<Server> sessions: <status>" for a non-2xx.
  const status = err instanceof Error ? /:\s(\d{3})$/.exec(err.message)?.[1] : undefined;
  if (status) return `HTTP ${status}`;
  return "error";
}
