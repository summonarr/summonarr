import { NextResponse } from "next/server";
import { withAdmin } from "@/lib/api-auth";
import { safeFetchTrusted } from "@/lib/safe-fetch";
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

function plexPinHeaders(clientId: string): Record<string, string> {
  return {
    "X-Plex-Client-Identifier": clientId,
    "X-Plex-Product": "Summonarr",
    "X-Plex-Version": "1.0",
    "X-Plex-Model": "hosted",
    "X-Plex-Device": "Web",
    "X-Plex-Device-Name": "Summonarr",
    "X-Plex-Platform": "Web",
    Accept: "application/json",
  };
}

function isSecureCookieContext(): boolean {
  const url = process.env.AUTH_URL ?? "";
  if (url.startsWith("https://")) return true;
  if (url.startsWith("http://")) return false;
  return process.env.NODE_ENV === "production";
}

export const POST = withAdmin(async (req, _ctx, session) => {
  const t = translatorForRequest(req);
  const clientId = newPlexConnectClientId();
  const res = await safeFetchTrusted("https://plex.tv/api/v2/pins", {
    allowedHosts: ["plex.tv"],
    method: "POST",
    headers: {
      ...plexPinHeaders(clientId),
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: "strong=true",
    timeoutMs: 15_000,
  });

  if (!res.ok) {
    return NextResponse.json({ error: t("apiAuth.plex.pinCreateFailedLower") }, { status: 502 });
  }

  const data = (await res.json()) as { id?: number; code?: string };
  if (typeof data.id !== "number" || !Number.isInteger(data.id) || data.id <= 0 || typeof data.code !== "string") {
    return NextResponse.json({ error: t("apiAuth.plex.pinMalformedLower") }, { status: 502 });
  }

  const cookie = await signPlexConnectCookie({ pinId: data.id, clientId, uid: session.user.id });
  // The browser needs clientId for the app.plex.tv approval URL (Plex matches it
  // against the PIN). Giving it to the admin who started the flow is fine — the
  // secret is that NOBODY ELSE can assemble (pinId, clientId).
  const out = NextResponse.json(
    { id: data.id, code: data.code, clientId },
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

  const res = await safeFetchTrusted(`https://plex.tv/api/v2/pins/${state.pinId}`, {
    allowedHosts: ["plex.tv"],
    headers: plexPinHeaders(state.clientId),
    timeoutMs: 15_000,
  });
  if (!res.ok) {
    return NextResponse.json({ error: t("apiAuth.plex.pinPollFailed") }, { status: 502 });
  }

  const data = (await res.json()) as { authToken?: string | null };
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
