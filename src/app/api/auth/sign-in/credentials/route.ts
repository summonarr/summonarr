import { NextResponse, type NextRequest } from "next/server";
import { authorizeWithCredentials, signInAndMintSession } from "@/lib/auth";
import { serializeSessionCookie } from "@/lib/session-cookie";

// Summonarr-native credentials sign-in. Hits the same authorize() body that
// next-auth's Credentials provider uses, then mints a Summonarr JWT we own.
//
// Dead in prod until PR 5 swaps the client's signIn() call from
// next-auth/react to fetch('/api/auth/sign-in/credentials').
export async function POST(req: NextRequest) {
  let body: Record<string, unknown>;
  try {
    body = (await req.json()) as Record<string, unknown>;
  } catch {
    return NextResponse.json({ error: "Invalid request body" }, { status: 400 });
  }

  if (typeof body.email !== "string" || typeof body.password !== "string") {
    return NextResponse.json({ error: "Email and password required" }, { status: 400 });
  }

  const user = await authorizeWithCredentials(
    {
      email: body.email,
      password: body.password,
      rememberMe: typeof body.rememberMe === "string" ? body.rememberMe : undefined,
    },
    req,
  );
  if (!user) {
    return NextResponse.json({ error: "Invalid credentials" }, { status: 401 });
  }

  const result = await signInAndMintSession({ user, providerId: "credentials" });
  const res = NextResponse.json({ ok: true, user: result.user });
  res.headers.append(
    "Set-Cookie",
    serializeSessionCookie(result.token, { maxAgeSeconds: result.expiresInSeconds }),
  );
  return res;
}
