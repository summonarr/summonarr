import { NextResponse } from "next/server";
import { withAuth } from "@/lib/api-auth";
import { getOrCreateVapidPublicKey } from "@/lib/push";

// Authenticated-only: the lazy keypair-init path on first call shouldn't be
// reachable by anonymous flood. Any signed-in user needs the public key to
// register a push subscription, so withAuth is the correct level.
export const GET = withAuth(async () => {
  const publicKey = await getOrCreateVapidPublicKey();
  // An empty key means the stored keypair is INCOMPLETE — exactly one half
  // present, which the generator refuses to repair because overwriting the
  // surviving half would invalidate every existing subscription. Returning it
  // as a 200 handed the client an empty applicationServerKey, which fails
  // inside the browser's own subscribe() with a message that says nothing about
  // the server's config. 503 says the right thing: push is unavailable here,
  // and it is the operator's Settings that need repairing.
  if (!publicKey) {
    return NextResponse.json(
      { error: "Web push is not configured on this server" },
      { status: 503 },
    );
  }
  return NextResponse.json({ publicKey });
});
