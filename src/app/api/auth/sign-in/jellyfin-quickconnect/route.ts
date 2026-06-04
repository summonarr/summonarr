import { NextResponse, type NextRequest } from "next/server";
import { authorizeWithJellyfinQuickConnect, signInAndMintSession } from "@/lib/auth";
import { getConfiguredJellyfinUrl } from "@/lib/jellyfin-config";
import { serializeSessionCookie } from "@/lib/session-cookie";
import { assertBodyBytesUnderCap, checkBodySize } from "@/lib/body-size";
import {
  buildQcFlowClearedSetCookie,
  hashQuickConnectSecret,
  readQcFlowCookie,
  verifyQcFlowCookie,
} from "@/lib/jellyfin-flow-state";

// QuickConnect sign-in body carries secret/rememberMe — 16 KB cap protects
// this unauthenticated surface against memory-exhaustion DoS.
const MAX_SIGNIN_BODY_BYTES = 16 * 1024;

export async function POST(req: NextRequest) {
  if (!(await getConfiguredJellyfinUrl())) {
    return NextResponse.json({ error: "Jellyfin sign-in is not configured" }, { status: 503 });
  }

  const headerCheck = checkBodySize(req, MAX_SIGNIN_BODY_BYTES);
  if (headerCheck) return headerCheck;

  const raw = new Uint8Array(await req.arrayBuffer());
  const sizeCheck = assertBodyBytesUnderCap(raw, MAX_SIGNIN_BODY_BYTES);
  if (sizeCheck) return sizeCheck;

  let body: Record<string, unknown>;
  try {
    body = JSON.parse(new TextDecoder().decode(raw)) as Record<string, unknown>;
  } catch {
    return NextResponse.json({ error: "Invalid request body" }, { status: 400 });
  }

  if (typeof body.secret !== "string") {
    return NextResponse.json({ error: "QuickConnect secret required" }, { status: 400 });
  }

  // Verify the QC secret was issued by THIS server to THIS browser. Without
  // this, an attacker who phishes a secret can redeem it from their own
  // browser and end up with a Summonarr session as the approving user.
  const cookieToken = readQcFlowCookie(req.headers.get("cookie"));
  if (!cookieToken) {
    return NextResponse.json({ error: "QuickConnect flow expired" }, { status: 400 });
  }
  const flowState = await verifyQcFlowCookie(cookieToken);
  if (!flowState) {
    return NextResponse.json({ error: "QuickConnect flow expired" }, { status: 400 });
  }
  if (flowState.secretHash !== hashQuickConnectSecret(body.secret)) {
    return NextResponse.json({ error: "QuickConnect flow mismatch" }, { status: 400 });
  }

  const user = await authorizeWithJellyfinQuickConnect(
    {
      secret: body.secret,
      rememberMe: typeof body.rememberMe === "string" ? body.rememberMe : undefined,
    },
    req,
  );
  if (!user) {
    const failRes = NextResponse.json({ error: "QuickConnect authentication failed" }, { status: 401 });
    failRes.headers.append("Set-Cookie", buildQcFlowClearedSetCookie());
    return failRes;
  }

  const result = await signInAndMintSession({ user, providerId: "jellyfin-quickconnect" });
  const res = NextResponse.json({ ok: true, user: result.user });
  res.headers.append(
    "Set-Cookie",
    serializeSessionCookie(result.token, { maxAgeSeconds: result.expiresInSeconds }),
  );
  // Best-effort clear of the flow cookie. This is NOT a server-side one-shot —
  // a client that ignores the Set-Cookie can resubmit until the 10-min TTL. True
  // single-use is enforced one layer up: Jellyfin invalidates the QuickConnect
  // secret on first redemption, so a replayed (cookie, secret) pair fails at
  // authorizeWithJellyfinQuickConnect().
  res.headers.append("Set-Cookie", buildQcFlowClearedSetCookie());
  return res;
}
