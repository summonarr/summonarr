import { NextResponse, type NextRequest } from "next/server";
import { AccountDeactivatedError, authorizeWithJellyfin, signInAndMintSession } from "@/lib/auth";
import { DEFAULT_MEDIA_INSTANCE, isValidMediaInstanceSlug } from "@/lib/media-instances";
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

  // `instance` is optional so older single-server clients that never send it
  // keep signing into the default server exactly as before.
  // The config check below needs only the server URL (not the API key, which
  // getSyncableMediaInstances would also require): sign-in itself never uses
  // the API key. Only the best-effort email backfill in findOrCreateJellyfinUser
  // does, and that already copes when it's missing.
  const instance = typeof body.instance === "string" ? body.instance : DEFAULT_MEDIA_INSTANCE;
  // Validate the slug like every other route that takes an instance. Setting
  // keys only upper-case the slug's first letter, so "Remote" would load the
  // SAME config as "remote" and pass the check below, while the membership
  // lookup later searches `serverInstance: "Remote"` and finds no row — wrongly
  // refusing a real user of that server.
  if (!isValidMediaInstanceSlug(instance)) {
    return NextResponse.json({ error: "Invalid server" }, { status: 400 });
  }
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
