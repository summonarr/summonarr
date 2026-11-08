import { NextResponse, type NextRequest } from "next/server";
import { createPlexPin, plexDeviceValue, WEB_PLEX_DEVICE } from "@/lib/plex-pin";
import {
  buildPlexFlowSetCookie,
  signPlexFlowCookie,
} from "@/lib/plex-flow-state";
import { readOptionalJsonCapped } from "@/lib/body-size";
import { checkRateLimit, getClientIpKey } from "@/lib/rate-limit";
import { hasNativeClientHeader, NATIVE_CLIENT_HEADER } from "@/lib/mobile-auth";
import { translatorForRequest } from "@/lib/i18n/server-locale";
import { isSecureCookieContext } from "@/lib/session-cookie";

// Server-side PIN creation for the Plex sign-in flow. Returns the PIN id +
// code AND sets a short-lived signed cookie binding the pinId to this
// browser. /api/auth/sign-in/plex refuses any submission whose body pinId
// does not match the cookie's pinId, so a phished/attacker-created PIN
// cannot be redeemed against the wrong browser.

const MAX_START_BODY_BYTES = 4 * 1024;

export async function POST(req: NextRequest) {
  const t = translatorForRequest(req);
  const ipKey = getClientIpKey(req.headers);
  if (!checkRateLimit(`plex-start:${ipKey}`, 20, 5 * 60 * 1000)) {
    return NextResponse.json({ error: t("apiAuth.common.tooManyRequests") }, { status: 429 });
  }

  // An empty body reads as {} and is refused below for its missing clientId;
  // malformed JSON or a non-object (`null`, a bare number, an array) is a 400
  // and an oversized body a 413, never a property read that 500s.
  const parsed = await readOptionalJsonCapped<Record<string, unknown>>(req, MAX_START_BODY_BYTES, {});
  if (parsed instanceof NextResponse) return parsed;
  const body = parsed;

  const clientId =
    typeof body.clientId === "string" && /^[a-f0-9-]{8,64}$/i.test(body.clientId)
      ? body.clientId
      : null;
  if (!clientId) {
    return NextResponse.json({ error: t("apiAuth.plex.clientIdRequired") }, { status: 400 });
  }

  // The app's own device strings, made header-safe (plexDeviceValue).
  const pin = await createPlexPin(clientId, {
    platform: plexDeviceValue(body.platform, WEB_PLEX_DEVICE.platform),
    device: plexDeviceValue(body.device, WEB_PLEX_DEVICE.device),
    model: plexDeviceValue(body.model, WEB_PLEX_DEVICE.model),
  }, "auth/plex/start");
  if (pin.kind === "failed") {
    return NextResponse.json({ error: t("apiAuth.plex.pinCreateFailed") }, { status: 502 });
  }
  if (pin.kind === "malformed") {
    return NextResponse.json({ error: t("apiAuth.plex.pinMalformed") }, { status: 502 });
  }

  const cookieValue = await signPlexFlowCookie({
    pinId: pin.id,
    clientId,
  });

  // Native clients can't receive the HttpOnly flow cookie, so hand them the
  // signed flow-state token in the body to submit back at sign-in.
  const isNative = hasNativeClientHeader(req.headers.get(NATIVE_CLIENT_HEADER));
  const response = NextResponse.json({
    pinId: pin.id,
    code: pin.code,
    ...(isNative ? { flowState: cookieValue } : {}),
  });
  response.headers.append(
    "Set-Cookie",
    buildPlexFlowSetCookie(cookieValue, isSecureCookieContext()),
  );
  return response;
}
