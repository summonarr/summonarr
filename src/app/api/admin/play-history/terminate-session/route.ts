import { NextResponse } from "next/server";
import { readJsonCapped } from "@/lib/body-size";
import { withAdmin } from "@/lib/api-auth";
import { logAudit, auditContext } from "@/lib/audit";
import { getPlexSessions, terminatePlexSession } from "@/lib/plex";
import { getPlexConfig } from "@/lib/plex-config";
import { parseTerminateRequest, upstreamFailureDetail } from "@/lib/terminate-session-request";
import { instanceDefaultLocale, translatorFor, translatorForRequest } from "@/lib/i18n/server-locale";

// Admin terminate-playback endpoint for Plex. POSTs to Plex's
// /status/sessions/terminate, which shows `reason` on the viewer's player and
// stops playback. The session removal then reaches us as an SSE state="stopped"
// event within ~1s, and the normal finalize path writes the PlayHistory row, so
// we don't write one here. Tautulli uses the same Plex endpoint.
//
// Body: { sessionKey: string, serverInstance?: string, reason?: string }
// The sessionKey is the short integer Plex assigns per playback, but the
// terminate endpoint wants Session.id (the long GUID). We look the key up in a
// /status/sessions snapshot to get the GUID, rather than storing a GUID column
// on ActiveSession just for this. serverInstance picks which configured Plex
// server to use (multi-server support); when omitted it falls back to the
// default server so older admin UI builds keep working.
export const POST = withAdmin(async (req, _ctx, session) => {
  const t = translatorForRequest(req);
  const parsed = await readJsonCapped<{ sessionKey?: unknown; serverInstance?: unknown; reason?: unknown }>(req, 16384);
  if (parsed instanceof NextResponse) return parsed;
  const body = parsed;

  const request = parseTerminateRequest(body);
  if (!request.ok) {
    const error = request.error === "invalidServerInstance"
      ? t("apiAdmin.common.invalidServerInstance", { slug: String(body.serverInstance) })
      : t(`apiAdmin.terminate.${request.error}`);
    return NextResponse.json({ error }, { status: 400 });
  }
  const { sessionKey, serverInstance } = request.value;
  // The fallback reason is shown on the VIEWER's player, so it is written in the
  // instance default language like every other message to viewers (guardrail
  // 14c), not the admin's request language. The web UI always sends a reason;
  // this fires for API callers without one (the native client).
  const reason = request.value.reason ?? translatorFor(instanceDefaultLocale())("adminActivity.terminate.defaultReason");

  const plexConfig = await getPlexConfig(serverInstance);
  const serverUrl = plexConfig.url?.replace(/\/$/, "") ?? null;
  const token = plexConfig.token;

  if (!serverUrl || !token) {
    return NextResponse.json(
      { error: t("apiAdmin.terminate.plexNotConfigured") },
      { status: 400 },
    );
  }

  // Cross-check that the session currently exists in /status/sessions, so an
  // admin can't POST an arbitrary identifier at the upstream Plex server. The
  // snapshot also gives us the Session.id (GUID) the terminate endpoint expects.
  let sessions;
  try {
    sessions = await getPlexSessions(serverUrl, token);
  } catch (err) {
    // The admin gets the coarse kind; the full error (it can name the server's
    // internal address) goes to the log.
    console.error("[terminate-session] session snapshot failed:", err);
    return NextResponse.json({ error: t("apiAdmin.terminate.plexUnreachable", { detail: upstreamFailureDetail(err) }) }, { status: 502 });
  }

  const match = sessions.find((s) => s.sessionKey === sessionKey);
  if (!match) {
    return NextResponse.json(
      { error: t("apiAdmin.terminate.plexSessionNotFound") },
      { status: 404 },
    );
  }

  // Plex's terminate endpoint addresses sessions by the Session.id GUID, not
  // the short sessionKey (passing the key 404s). Use the GUID from the snapshot;
  // fall back to the key only if Plex omitted it (shouldn't happen on a live
  // session).
  // Same translated 502 as the snapshot above: Plex can answer /status/sessions
  // and then time out on the terminate POST, and an unwrapped throw is a bodiless
  // 500 the dialog cannot explain. Nothing happened upstream, so no audit row.
  let result;
  try {
    result = await terminatePlexSession(
      serverUrl,
      token,
      match.sessionId ?? sessionKey,
      reason,
    );
  } catch (err) {
    console.error("[terminate-session] terminate request failed:", err);
    return NextResponse.json({ error: t("apiAdmin.terminate.plexUnreachable", { detail: upstreamFailureDetail(err) }) }, { status: 502 });
  }

  // Session already terminated on Plex; a failed audit write must not 500 it.
  void logAudit({
    userId: session.user.id,
    userName: session.user.name ?? session.user.email ?? null,
    action: "PLEX_SESSION_TERMINATE",
    target: sessionKey,
    details: {
      sessionKey,
      serverInstance,
      reason,
      mediaTitle: match.title,
      accountName: match.accountName,
      plexStatus: result.status,
    },
    ...auditContext(req, session),
  });

  if (!result.ok) {
    return NextResponse.json(
      { error: t("apiAdmin.terminate.plexRejected", { status: String(result.status) }) },
      { status: 502 },
    );
  }

  return NextResponse.json({ ok: true });
});
