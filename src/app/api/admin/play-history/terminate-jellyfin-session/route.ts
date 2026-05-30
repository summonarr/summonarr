import { NextResponse } from "next/server";
import { withAdmin } from "@/lib/api-auth";
import { prisma } from "@/lib/prisma";
import { logAuditOrFail, auditContext } from "@/lib/audit";
import { getJellyfinSessions, terminateJellyfinSession } from "@/lib/jellyfin";

// Admin terminate-playback endpoint for Jellyfin. Mirrors the Plex route: it
// sends the "Stop" playstate command (POST /Sessions/{id}/Playing/Stop), which
// tears the stream down. The session removal surfaces as an SSE state="stopped"
// event within ~1s; the normal finalize path writes the PlayHistory row, so we
// don't write one inline.
//
// Body: { sessionKey: string, reason?: string }
// ActiveSession.sessionKey for Jellyfin holds the PlaySessionId, but Jellyfin's
// Stop endpoint addresses sessions by the session UUID (Sessions[].Id). We
// resolve sessionKey → session UUID via a live /Sessions snapshot — which also
// confirms the session exists and is owned by an account we recognize, so an
// admin can't POST an arbitrary identifier at the upstream server.
export const POST = withAdmin(async (req, _ctx, session) => {
  let body: { sessionKey?: unknown; reason?: unknown };
  try {
    body = (await req.json()) as { sessionKey?: unknown; reason?: unknown };
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const sessionKey = typeof body.sessionKey === "string" ? body.sessionKey.trim() : "";
  const reason = typeof body.reason === "string" && body.reason.trim().length > 0
    ? body.reason.trim().slice(0, 500)
    : "Session terminated by an administrator.";

  if (!sessionKey) {
    return NextResponse.json({ error: "sessionKey is required" }, { status: 400 });
  }

  const [serverUrlRow, apiKeyRow] = await Promise.all([
    prisma.setting.findUnique({ where: { key: "jellyfinUrl" } }),
    prisma.setting.findUnique({ where: { key: "jellyfinApiKey" } }),
  ]);
  const serverUrl = serverUrlRow?.value?.replace(/\/$/, "") ?? null;
  const apiKey = apiKeyRow?.value ?? null;

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
  // the raw session UUID for robustness against webhook/poll keying differences.
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

  await logAuditOrFail({
    userId: session.user.id,
    userName: session.user.name ?? session.user.email ?? null,
    action: "JELLYFIN_SESSION_TERMINATE",
    target: sessionKey,
    details: {
      sessionKey,
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
