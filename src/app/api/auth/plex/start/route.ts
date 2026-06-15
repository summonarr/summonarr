import { NextResponse, type NextRequest } from "next/server";
import { safeFetchTrusted } from "@/lib/safe-fetch";
import {
  buildPlexFlowSetCookie,
  signPlexFlowCookie,
} from "@/lib/plex-flow-state";
import { assertBodyBytesUnderCap, checkBodySize } from "@/lib/body-size";
import { checkRateLimit, getClientIp } from "@/lib/rate-limit";
import { hasNativeClientHeader, NATIVE_CLIENT_HEADER } from "@/lib/mobile-auth";

// Server-side PIN creation for the Plex sign-in flow. Returns the PIN id +
// code AND sets a short-lived signed cookie binding the pinId to this
// browser. /api/auth/sign-in/plex refuses any submission whose body pinId
// does not match the cookie's pinId, so a phished/attacker-created PIN
// cannot be redeemed against the wrong browser.

const MAX_START_BODY_BYTES = 4 * 1024;

const PLEX_TV_HOSTS = ["plex.tv"];

function isSecureCookieContext(): boolean {
  const url = process.env.AUTH_URL ?? "";
  if (url.startsWith("https://")) return true;
  if (url.startsWith("http://")) return false;
  return process.env.NODE_ENV === "production";
}

export async function POST(req: NextRequest) {
  const ip = getClientIp(req.headers);
  if (!checkRateLimit(`plex-start:${ip}`, 20, 5 * 60 * 1000)) {
    return NextResponse.json({ error: "Too many requests" }, { status: 429 });
  }

  const headerCheck = checkBodySize(req, MAX_START_BODY_BYTES);
  if (headerCheck) return headerCheck;
  const raw = new Uint8Array(await req.arrayBuffer());
  const sizeCheck = assertBodyBytesUnderCap(raw, MAX_START_BODY_BYTES);
  if (sizeCheck) return sizeCheck;

  let body: Record<string, unknown> = {};
  if (raw.byteLength > 0) {
    try {
      body = JSON.parse(new TextDecoder().decode(raw)) as Record<string, unknown>;
    } catch {
      return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
    }
  }

  const clientId =
    typeof body.clientId === "string" && /^[a-f0-9-]{8,64}$/i.test(body.clientId)
      ? body.clientId
      : null;
  if (!clientId) {
    return NextResponse.json({ error: "clientId required" }, { status: 400 });
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
  }).catch(() => null);

  if (!res?.ok) {
    return NextResponse.json({ error: "Plex PIN create failed" }, { status: 502 });
  }
  const data = (await res.json()) as { id?: number; code?: string };
  if (typeof data.id !== "number" || typeof data.code !== "string") {
    return NextResponse.json({ error: "Plex PIN response malformed" }, { status: 502 });
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
