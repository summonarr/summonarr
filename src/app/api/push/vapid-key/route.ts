import { NextResponse } from "next/server";
import { withAuth } from "@/lib/api-auth";
import { getOrCreateVapidPublicKey } from "@/lib/push";

// Authenticated-only: the lazy keypair-init path on first call shouldn't be
// reachable by anonymous flood. Any signed-in user needs the public key to
// register a push subscription, so withAuth is the correct level.
export const GET = withAuth(async () => {
  const publicKey = await getOrCreateVapidPublicKey();
  return NextResponse.json({ publicKey });
});
