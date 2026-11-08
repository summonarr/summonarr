import { NextResponse } from "next/server";
import { withAdmin } from "@/lib/api-auth";
import { createPlexPin, fetchPlexPin, WEB_PLEX_DEVICE } from "@/lib/plex-pin";
import { logAudit } from "@/lib/audit";
import { getClientIp } from "@/lib/rate-limit";
import { savePlexAdminToken } from "@/lib/plex-admin-connect";
import {
  buildPlexConnectClearedSetCookie,
  buildPlexConnectSetCookie,
  newPlexConnectClientId,
  readPlexConnectCookie,
  signPlexConnectCookie,
  verifyPlexConnectCookie,
} from "@/lib/plex-flow-state";
import { translatorForRequest } from "@/lib/i18n/server-locale";
import { isSecureCookieContext } from "@/lib/session-cookie";

// The admin "Connect Plex" flow (Settings → Media → Plex).
//
//   POST   creates a PIN under a FRESH random client identifier and binds
//          (pinId, clientId, admin id) into a signed HttpOnly cookie.
//   PATCH  polls THAT pin — from the cookie, never from the request — and once
//          the admin approves it, validates and stores the owner token
//          server-side. The token never reaches the browser.
//
// plex.tv hands a PIN's authToken to whoever presents the pin id and the client
// identifier that created it. This used to be the constant `summonarr-server`
// for every install, and the poll took any `?id=`, so the pair was guessable by
// anyone: see plex-flow-state.ts.

export const POST = withAdmin(async (req, _ctx, session) => {
  const t = translatorForRequest(req);
  const clientId = newPlexConnectClientId();
  const pin = await createPlexPin(clientId, WEB_PLEX_DEVICE, "auth/plex/pin");
  if (pin.kind === "failed") {
    return NextResponse.json({ error: t("apiAuth.plex.pinCreateFailedLower") }, { status: 502 });
  }
  if (pin.kind === "malformed") {
    return NextResponse.json({ error: t("apiAuth.plex.pinMalformedLower") }, { status: 502 });
  }

  const cookie = await signPlexConnectCookie({ pinId: pin.id, clientId, uid: session.user.id });
  // The browser needs clientId for the app.plex.tv approval URL (Plex matches it
  // against the PIN). Giving it to the admin who started the flow is fine — the
  // secret is that NOBODY ELSE can assemble (pinId, clientId).
  const out = NextResponse.json(
    { id: pin.id, code: pin.code, clientId },
    { headers: { "Cache-Control": "no-store" } },
  );
  out.headers.append("Set-Cookie", buildPlexConnectSetCookie(cookie, isSecureCookieContext()));
  return out;
});

export const PATCH = withAdmin(async (req, _ctx, session) => {
  const t = translatorForRequest(req);
  const raw = readPlexConnectCookie(req.headers.get("cookie"));
  const state = raw ? await verifyPlexConnectCookie(raw) : null;
  // A missing/forged/expired cookie, or one another admin's session started,
  // never reaches plex.tv.
  if (!state || state.uid !== session.user.id) {
    const res = NextResponse.json({ error: t("apiAuth.plex.flowExpired") }, { status: 400 });
    res.headers.append("Set-Cookie", buildPlexConnectClearedSetCookie());
    return res;
  }

  const res = await fetchPlexPin(state.pinId, state.clientId, "auth/plex/pin");
  if (!res?.ok) {
    return NextResponse.json({ error: t("apiAuth.plex.pinPollFailed") }, { status: 502 });
  }

  const data = (await res.json().catch(() => undefined)) as { authToken?: unknown } | null | undefined;
  // Unparseable is a failed poll; valid JSON without a token is still pending.
  if (data === undefined || data === null || typeof data !== "object") {
    return NextResponse.json({ error: t("apiAuth.plex.pinPollFailed") }, { status: 502 });
  }
  if (typeof data.authToken !== "string" || data.authToken.length === 0) {
    return NextResponse.json({ status: "pending" }, { headers: { "Cache-Control": "no-store" } });
  }

  const plexUser = await savePlexAdminToken(data.authToken, "plex/pin");
  if (!plexUser) {
    return NextResponse.json({ error: t("apiAdmin.settings.plexTokenInvalid") }, { status: 422 });
  }

  void logAudit({
    userId: session.user.id,
    userName: session.user.name ?? session.user.email ?? null,
    action: "SETTINGS_CHANGE",
    target: "settings:plex",
    details: { keys: ["plexAdminToken", "plexAdminEmail"], operation: "rotate" },
    ipAddress: getClientIp(req.headers),
    userAgent: req.headers.get("user-agent"),
    provider: session.user.provider ?? null,
  });

  const done = NextResponse.json(
    { status: "connected", email: plexUser.email, username: plexUser.username },
    { headers: { "Cache-Control": "no-store" } },
  );
  done.headers.append("Set-Cookie", buildPlexConnectClearedSetCookie());
  return done;
});
