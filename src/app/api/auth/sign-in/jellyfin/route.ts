import { NextResponse, type NextRequest } from "next/server";
import { authorizeWithJellyfin, signInAndMintSession } from "@/lib/auth";
import { getConfiguredJellyfinUrl } from "@/lib/jellyfin-config";
import { buildSignInResponse } from "@/lib/sign-in-response";
import { readJsonCapped } from "@/lib/body-size";

// Jellyfin sign-in body carries username/password/rememberMe — 16 KB cap
// protects this unauthenticated surface against memory-exhaustion DoS.
const MAX_SIGNIN_BODY_BYTES = 16 * 1024;

export async function POST(req: NextRequest) {
  if (!(await getConfiguredJellyfinUrl())) {
    return NextResponse.json({ error: "Jellyfin sign-in is not configured" }, { status: 503 });
  }

  const parsed = await readJsonCapped<Record<string, unknown>>(req, MAX_SIGNIN_BODY_BYTES);
  if (parsed instanceof NextResponse) return parsed;
  const body = parsed;

  if (typeof body.username !== "string" || typeof body.password !== "string") {
    return NextResponse.json({ error: "Username and password required" }, { status: 400 });
  }

  const user = await authorizeWithJellyfin(
    {
      username: body.username,
      password: body.password,
      rememberMe: typeof body.rememberMe === "string" ? body.rememberMe : undefined,
    },
    req,
  );
  if (!user) {
    return NextResponse.json({ error: "Invalid Jellyfin credentials" }, { status: 401 });
  }

  const result = await signInAndMintSession({ user, providerId: "jellyfin" });
  return buildSignInResponse(req, result);
}
