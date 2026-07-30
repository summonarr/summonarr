import { NextResponse, type NextRequest } from "next/server";
import { AccountDeactivatedError, authorizeWithJellyfinQuickConnect, signInAndMintSession } from "@/lib/auth";
import { buildSignInResponse, disabledAccountResponse } from "@/lib/sign-in-response";
import { readJsonCapped } from "@/lib/body-size";
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
  // No up-front "is Jellyfin configured" gate here — which instance this
  // request is even for isn't known until the flow cookie is verified below,
  // and authorizeWithJellyfinQuickConnect already 401s (via the !user branch)
  // when that instance turns out to be unconfigured.
  const parsed = await readJsonCapped<Record<string, unknown>>(req, MAX_SIGNIN_BODY_BYTES);
  if (parsed instanceof NextResponse) return parsed;
  const body = parsed;

  if (typeof body.secret !== "string") {
    return NextResponse.json({ error: "QuickConnect secret required" }, { status: 400 });
  }

  // Verify the QC secret was issued by THIS server to THIS browser. Without
  // this, an attacker who phishes a secret can redeem it from their own
  // browser and end up with a Summonarr session as the approving user.
  // Native clients have no cookie jar — fall back to the flowState the QC
  // initiation route returns in the body for them (CORS-sound: a cross-origin
  // page can't read that body). Web keeps using the HttpOnly cookie.
  const cookieToken = readQcFlowCookie(req.headers.get("cookie"))
    ?? (typeof body.flowState === "string" ? body.flowState : null);
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

  // The instance comes ONLY from the verified flow cookie — never from a
  // client-supplied body field — so a caller can't claim a secret belongs to a
  // different server than the one that actually issued it. See
  // jellyfin-flow-state.ts.
  const user = await authorizeWithJellyfinQuickConnect(
    {
      secret: body.secret,
      rememberMe: typeof body.rememberMe === "string" ? body.rememberMe : undefined,
    },
    req,
    flowState.instance,
  );
  if (!user) {
    const failRes = NextResponse.json({ error: "QuickConnect authentication failed" }, { status: 401 });
    failRes.headers.append("Set-Cookie", buildQcFlowClearedSetCookie());
    return failRes;
  }

  let result;
  try {
    result = await signInAndMintSession({ user, providerId: "jellyfin-quickconnect" });
  } catch (err) {
    if (err instanceof AccountDeactivatedError) {
      const disabled = disabledAccountResponse();
      disabled.headers.append("Set-Cookie", buildQcFlowClearedSetCookie());
      return disabled;
    }
    throw err;
  }
  // Best-effort clear of the flow cookie. This is NOT a server-side one-shot —
  // a client that ignores the Set-Cookie can resubmit until the 10-min TTL. True
  // single-use is enforced one layer up: Jellyfin invalidates the QuickConnect
  // secret on first redemption, so a replayed (cookie, secret) pair fails at
  // authorizeWithJellyfinQuickConnect().
  return buildSignInResponse(req, result, {
    extraSetCookies: [buildQcFlowClearedSetCookie()],
  });
}
