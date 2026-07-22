import { NextResponse, type NextRequest } from "next/server";
import { authorizeWithPlex, signInAndMintSession } from "@/lib/auth";
import { buildSignInResponse } from "@/lib/sign-in-response";
import { readJsonCapped } from "@/lib/body-size";
import {
  buildPlexFlowClearedSetCookie,
  readPlexFlowCookie,
  verifyPlexFlowCookie,
} from "@/lib/plex-flow-state";

// Plex sign-in body carries plexToken/plexClientId/pinId/rememberMe — 16 KB
// cap protects this unauthenticated surface against memory-exhaustion DoS.
const MAX_SIGNIN_BODY_BYTES = 16 * 1024;

export async function POST(req: NextRequest) {
  const parsed = await readJsonCapped<Record<string, unknown>>(req, MAX_SIGNIN_BODY_BYTES);
  if (parsed instanceof NextResponse) return parsed;
  const body = parsed;

  if (typeof body.plexToken !== "string") {
    return NextResponse.json({ error: "Plex token required" }, { status: 400 });
  }
  if (typeof body.pinId !== "number" || !Number.isFinite(body.pinId)) {
    return NextResponse.json({ error: "pinId required" }, { status: 400 });
  }

  // Verify the PIN was issued by THIS server for THIS browser. Without this
  // an attacker who phishes a Plex user into approving an attacker-created
  // PIN can submit the resulting token directly from their own browser and
  // end up with a Summonarr session as that user.
  // Cookie for browsers; native clients submit the flow-state token in the body
  // (they can't carry the HttpOnly cookie set at /start).
  const cookieToken =
    readPlexFlowCookie(req.headers.get("cookie")) ??
    (typeof body.flowState === "string" ? body.flowState : null);
  if (!cookieToken) {
    return NextResponse.json({ error: "Plex sign-in flow expired" }, { status: 400 });
  }
  const flowState = await verifyPlexFlowCookie(cookieToken);
  if (!flowState) {
    return NextResponse.json({ error: "Plex sign-in flow expired" }, { status: 400 });
  }
  if (flowState.pinId !== body.pinId) {
    return NextResponse.json({ error: "Plex sign-in flow mismatch" }, { status: 400 });
  }
  // Bind clientId too — caller must submit the same client id used at /start.
  if (typeof body.plexClientId === "string" && body.plexClientId !== flowState.clientId) {
    return NextResponse.json({ error: "Plex sign-in flow mismatch" }, { status: 400 });
  }

  const user = await authorizeWithPlex(
    {
      plexToken: body.plexToken,
      plexClientId: flowState.clientId,
      rememberMe: typeof body.rememberMe === "string" ? body.rememberMe : undefined,
    },
    req,
  );
  if (!user) {
    const failRes = NextResponse.json({ error: "Invalid Plex credentials" }, { status: 401 });
    failRes.headers.append("Set-Cookie", buildPlexFlowClearedSetCookie());
    return failRes;
  }

  const result = await signInAndMintSession({ user, providerId: "plex" });
  // Best-effort clear of the flow cookie. This is NOT a server-side one-shot —
  // a client that ignores the Set-Cookie can resubmit until the 10-min TTL. True
  // single-use is enforced one layer up: Plex invalidates the PIN token on first
  // redemption, so a replayed (cookie, token) pair fails at authorizeWithPlex().
  return buildSignInResponse(req, result, {
    extraSetCookies: [buildPlexFlowClearedSetCookie()],
  });
}
