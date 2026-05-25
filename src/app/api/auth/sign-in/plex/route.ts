import { NextResponse, type NextRequest } from "next/server";
import { authorizeWithPlex, signInAndMintSession } from "@/lib/auth";
import { serializeSessionCookie } from "@/lib/session-cookie";

export async function POST(req: NextRequest) {
  let body: Record<string, unknown>;
  try {
    body = (await req.json()) as Record<string, unknown>;
  } catch {
    return NextResponse.json({ error: "Invalid request body" }, { status: 400 });
  }

  if (typeof body.plexToken !== "string") {
    return NextResponse.json({ error: "Plex token required" }, { status: 400 });
  }

  const user = await authorizeWithPlex(
    {
      plexToken: body.plexToken,
      plexClientId: typeof body.plexClientId === "string" ? body.plexClientId : undefined,
      rememberMe: typeof body.rememberMe === "string" ? body.rememberMe : undefined,
    },
    req,
  );
  if (!user) {
    return NextResponse.json({ error: "Invalid Plex credentials" }, { status: 401 });
  }

  const result = await signInAndMintSession({ user, providerId: "plex" });
  const res = NextResponse.json({ ok: true, user: result.user });
  res.headers.append(
    "Set-Cookie",
    serializeSessionCookie(result.token, { maxAgeSeconds: result.expiresInSeconds }),
  );
  return res;
}
