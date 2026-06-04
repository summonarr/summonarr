import { NextResponse } from "next/server";
import { withAdmin } from "@/lib/api-auth";
import { prisma } from "@/lib/prisma";
import { logAuditOrFail, auditContext } from "@/lib/audit";
import { getPlexSessions, terminatePlexSession } from "@/lib/plex";

// Admin terminate-playback endpoint. POSTs to Plex's
// /status/sessions/terminate, which prompts the client's player with `reason`
// and tears the playback down. The actual session removal will surface as an
// SSE state="stopped" event within ~1s; we don't write a PlayHistory row
// inline — the normal finalize path handles it. Tautulli uses the same
// endpoint (pmsconnect.py:108).
//
// Body: { sessionKey: string, reason?: string }
// The sessionKey is the short integer Plex assigns per playback. Plex's
// terminate endpoint actually wants Session.id (the long GUID); we resolve
// sessionKey → Session.id via a snapshot of /status/sessions because storing
// the GUID on ActiveSession would be a single-purpose column.
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

  const [serverUrlRow, tokenRow] = await Promise.all([
    prisma.setting.findUnique({ where: { key: "plexServerUrl" } }),
    prisma.setting.findUnique({ where: { key: "plexAdminToken" } }),
  ]);
  const serverUrl = serverUrlRow?.value?.replace(/\/$/, "") ?? null;
  const token = tokenRow?.value ?? null;

  if (!serverUrl || !token) {
    return NextResponse.json(
      { error: "Plex server is not configured" },
      { status: 400 },
    );
  }

  // Cross-check that the session currently exists in /status/sessions and is
  // owned by an account we recognize — without this anyone with admin can
  // POST an arbitrary sessionKey at the upstream Plex server. The snapshot
  // also gives us the Session.id (GUID) the terminate endpoint expects.
  let sessions;
  try {
    sessions = await getPlexSessions(serverUrl, token);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ error: `Plex unreachable: ${msg}` }, { status: 502 });
  }

  const match = sessions.find((s) => s.sessionKey === sessionKey);
  if (!match) {
    return NextResponse.json(
      { error: "Session not found in /status/sessions (already stopped?)" },
      { status: 404 },
    );
  }

  // Plex's terminate endpoint addresses sessions by the Session.id GUID, not
  // the short sessionKey (passing the key 404s). Use the GUID from the snapshot;
  // fall back to the key only if Plex omitted it (shouldn't happen on a live
  // session).
  const result = await terminatePlexSession(
    serverUrl,
    token,
    match.sessionId ?? sessionKey,
    reason,
  );

  await logAuditOrFail({
    userId: session.user.id,
    userName: session.user.name ?? session.user.email ?? null,
    action: "PLEX_SESSION_TERMINATE",
    target: sessionKey,
    details: {
      sessionKey,
      reason,
      mediaTitle: match.title,
      accountName: match.accountName,
      plexStatus: result.status,
    },
    ...auditContext(req, session),
  });

  if (!result.ok) {
    return NextResponse.json(
      { error: `Plex rejected terminate request (status ${result.status})` },
      { status: 502 },
    );
  }

  return NextResponse.json({ ok: true });
});
