import { NextResponse, type NextRequest } from "next/server";
import { AccountDeactivatedError, authorizeWithJellyfin, signInAndMintSession } from "@/lib/auth";
import { DEFAULT_MEDIA_INSTANCE } from "@/lib/media-instances";
import { getConfiguredJellyfinUrl } from "@/lib/jellyfin-config";
import { buildSignInResponse, disabledAccountResponse } from "@/lib/sign-in-response";
import { readJsonCapped } from "@/lib/body-size";

// Jellyfin sign-in body carries username/password/rememberMe/instance — 16 KB
// cap protects this unauthenticated surface against memory-exhaustion DoS.
const MAX_SIGNIN_BODY_BYTES = 16 * 1024;

export async function POST(req: NextRequest) {
  const parsed = await readJsonCapped<Record<string, unknown>>(req, MAX_SIGNIN_BODY_BYTES);
  if (parsed instanceof NextResponse) return parsed;
  const body = parsed;

  if (typeof body.username !== "string" || typeof body.password !== "string") {
    return NextResponse.json({ error: "Username and password required" }, { status: 400 });
  }

  // `instance` is optional so existing (older, single-server) clients that
  // never send it keep signing into the default server exactly as before.
  // URL-only check (not getSyncableMediaInstances, which also requires an API
  // key) — sign-in has never needed the API key, only the best-effort email
  // backfill in findOrCreateJellyfinUser does, and that already degrades
  // gracefully when it's absent. Requiring it here too would 503 a deployment
  // that pre-Phase-1.5 could sign into just fine.
  const instance = typeof body.instance === "string" ? body.instance : DEFAULT_MEDIA_INSTANCE;
  if (!(await getConfiguredJellyfinUrl(instance))) {
    return NextResponse.json({ error: "Jellyfin sign-in is not configured for this server" }, { status: 503 });
  }

  const user = await authorizeWithJellyfin(
    {
      username: body.username,
      password: body.password,
      rememberMe: typeof body.rememberMe === "string" ? body.rememberMe : undefined,
    },
    req,
    instance,
  );
  if (!user) {
    return NextResponse.json({ error: "Invalid Jellyfin credentials" }, { status: 401 });
  }

  let result;
  try {
    result = await signInAndMintSession({ user, providerId: "jellyfin" });
  } catch (err) {
    if (err instanceof AccountDeactivatedError) return disabledAccountResponse();
    throw err;
  }
  return buildSignInResponse(req, result);
}
