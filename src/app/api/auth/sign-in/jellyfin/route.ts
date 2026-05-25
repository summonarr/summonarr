import { NextResponse, type NextRequest } from "next/server";
import { authorizeWithJellyfin, signInAndMintSession } from "@/lib/auth";
import { serializeSessionCookie } from "@/lib/session-cookie";

export async function POST(req: NextRequest) {
  if (!process.env.JELLYFIN_URL) {
    return NextResponse.json({ error: "Jellyfin sign-in is not configured" }, { status: 503 });
  }

  let body: Record<string, unknown>;
  try {
    body = (await req.json()) as Record<string, unknown>;
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
