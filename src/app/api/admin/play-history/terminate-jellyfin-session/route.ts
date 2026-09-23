import { NextResponse } from "next/server";
import { readJsonCapped } from "@/lib/body-size";
import { withAdmin } from "@/lib/api-auth";
import { logAudit, auditContext } from "@/lib/audit";
import { getJellyfinSessions, terminateJellyfinSession } from "@/lib/jellyfin";
import { getJellyfinConfig } from "@/lib/jellyfin-config";
import { DEFAULT_MEDIA_INSTANCE, isValidMediaInstanceSlug } from "@/lib/media-instances";

// Admin terminate-playback endpoint for Jellyfin. Mirrors the Plex route: it
// sends the "Stop" playstate command (POST /Sessions/{id}/Playing/Stop), which
// tears the stream down. The 5s play-history poller then notices the session is
// gone and its normal finalize path writes the PlayHistory row, so we don't
// write one here.
//
// Body: { sessionKey: string, serverInstance?: string, reason?: string }
// ActiveSession.sessionKey for Jellyfin holds the PlaySessionId, but Jellyfin's
// Stop endpoint addresses sessions by the session UUID (Sessions[].Id). We
// look the key up in a live /Sessions snapshot to get that UUID — which also
// confirms the session really exists, so an admin can't POST an arbitrary
// identifier at the upstream server. serverInstance picks which configured
// Jellyfin server to use (multi-server support); when omitted it falls back to
// the default server so older admin UI builds keep working.
export const POST = withAdmin(async (req, _ctx, session) => {
  const parsed = await readJsonCapped<{ sessionKey?: unknown; serverInstance?: unknown; reason?: unknown }>(req, 16384);
  if (parsed instanceof NextResponse) return parsed;
  const body = parsed;

  const sessionKey = typeof body.sessionKey === "string" ? body.sessionKey.trim() : "";
  const reason = typeof body.reason === "string" && body.reason.trim().length > 0
    ? body.reason.trim().slice(0, 500)
    : "Session terminated by an administrator.";

  if (!sessionKey) {
    return NextResponse.json({ error: "sessionKey is required" }, { status: 400 });
  }

  if (body.serverInstance !== undefined && (typeof body.serverInstance !== "string" || !isValidMediaInstanceSlug(body.serverInstance))) {
    return NextResponse.json({ error: `invalid serverInstance: ${String(body.serverInstance)}` }, { status: 400 });
  }
  const serverInstance = typeof body.serverInstance === "string" ? body.serverInstance : DEFAULT_MEDIA_INSTANCE;

  const jellyfinConfig = await getJellyfinConfig(serverInstance);
  const serverUrl = jellyfinConfig.url?.replace(/\/$/, "") ?? null;
  const apiKey = jellyfinConfig.apiKey;

  if (!serverUrl || !apiKey) {
    return NextResponse.json(
      { error: "Jellyfin server is not configured" },
      { status: 400 },
    );
  }

  let sessions;
  try {
    sessions = await getJellyfinSessions(serverUrl, apiKey);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ error: `Jellyfin unreachable: ${msg}` }, { status: 502 });
  }

  // The card's sessionKey is the PlaySessionId; match on that, but also accept
  // the raw session UUID in case a caller sends that instead.
  const match = sessions.find(
    (s) => s.playSessionId === sessionKey || s.sessionId === sessionKey,
  );
  if (!match || !match.sessionId) {
    return NextResponse.json(
      { error: "Session not found in /Sessions (already stopped?)" },
      { status: 404 },
    );
  }

  const result = await terminateJellyfinSession(serverUrl, apiKey, match.sessionId, reason);

  // Session already terminated on Jellyfin; a failed audit write must not 500 it.
  void logAudit({
    userId: session.user.id,
    userName: session.user.name ?? session.user.email ?? null,
    action: "JELLYFIN_SESSION_TERMINATE",
    target: sessionKey,
    details: {
      sessionKey,
      serverInstance,
      sessionId: match.sessionId,
      reason,
      mediaTitle: match.title,
      accountName: match.userName,
      jellyfinStatus: result.status,
    },
    ...auditContext(req, session),
  });

  if (!result.ok) {
    return NextResponse.json(
      { error: `Jellyfin rejected terminate request (status ${result.status})` },
      { status: 502 },
    );
  }

  return NextResponse.json({ ok: true });
});
