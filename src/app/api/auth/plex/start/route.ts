import { NextResponse, type NextRequest } from "next/server";
import { safeFetchTrusted } from "@/lib/safe-fetch";
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

const PLEX_TV_HOSTS = ["plex.tv"];

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

  const platform = typeof body.platform === "string" ? body.platform.slice(0, 32) : "Web";
  const device = typeof body.device === "string" ? body.device.slice(0, 32) : "Web";
  const model = typeof body.model === "string" ? body.model.slice(0, 32) : "hosted";

  const res = await safeFetchTrusted("https://plex.tv/api/v2/pins", {
    allowedHosts: PLEX_TV_HOSTS,
    method: "POST",
    headers: {
      "X-Plex-Client-Identifier": clientId,
      "X-Plex-Product": "Summonarr",
      "X-Plex-Version": "1.0",
      "X-Plex-Model": model,
      "X-Plex-Device": device,
      "X-Plex-Device-Name": "Summonarr",
      "X-Plex-Platform": platform,
      "Content-Type": "application/x-www-form-urlencoded",
      Accept: "application/json",
    },
    body: "strong=true",
    timeoutMs: 15_000,
  }).catch((err: unknown) => {
    // A thrown SafeFetchError (DNS failure, non-public resolved address,
    // timeout) is an operator-side egress problem; log it so a "Plex PIN
    // create failed" on the login page can be diagnosed from the server log.
    console.error(
      "[auth/plex/start] PIN create failed:",
      err instanceof Error ? err.message : String(err),
    );
    return null;
  });

  if (!res) {
    return NextResponse.json({ error: t("apiAuth.plex.pinCreateFailed") }, { status: 502 });
  }
  if (!res.ok) {
    console.error("[auth/plex/start] plex.tv returned", res.status);
    return NextResponse.json({ error: t("apiAuth.plex.pinCreateFailed") }, { status: 502 });
  }
  // A 2xx proxy page, an empty body or a JSON `null` is malformed, not a 500.
  const data = (await res.json().catch(() => null)) as { id?: unknown; code?: unknown } | null;
  if (
    data === null ||
    typeof data !== "object" ||
    typeof data.id !== "number" ||
    !Number.isInteger(data.id) ||
    data.id <= 0 ||
    typeof data.code !== "string"
  ) {
    return NextResponse.json({ error: t("apiAuth.plex.pinMalformed") }, { status: 502 });
  }

  const cookieValue = await signPlexFlowCookie({
    pinId: data.id,
    clientId,
  });

  // Native clients can't receive the HttpOnly flow cookie, so hand them the
  // signed flow-state token in the body to submit back at sign-in.
  const isNative = hasNativeClientHeader(req.headers.get(NATIVE_CLIENT_HEADER));
  const response = NextResponse.json({
    pinId: data.id,
    code: data.code,
    ...(isNative ? { flowState: cookieValue } : {}),
  });
  response.headers.append(
    "Set-Cookie",
    buildPlexFlowSetCookie(cookieValue, isSecureCookieContext()),
  );
  return response;
}
