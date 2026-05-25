import { NextResponse, type NextRequest } from "next/server";
import { authorizeWithJellyfin, signInAndMintSession } from "@/lib/auth";
import { serializeSessionCookie } from "@/lib/session-cookie";
import { assertBodyBytesUnderCap, checkBodySize } from "@/lib/body-size";

// Jellyfin sign-in body carries username/password/rememberMe — 16 KB cap
// protects this unauthenticated surface against memory-exhaustion DoS.
const MAX_SIGNIN_BODY_BYTES = 16 * 1024;

export async function POST(req: NextRequest) {
  if (!process.env.JELLYFIN_URL) {
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
  const res = NextResponse.json({ ok: true, user: result.user });
  res.headers.append(
    "Set-Cookie",
    serializeSessionCookie(result.token, { maxAgeSeconds: result.expiresInSeconds }),
  );
  return res;
}
