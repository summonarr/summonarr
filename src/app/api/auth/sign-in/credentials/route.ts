import { NextResponse, type NextRequest } from "next/server";
import { authorizeWithCredentials, signInAndMintSession } from "@/lib/auth";
import { buildSignInResponse } from "@/lib/sign-in-response";
import { assertBodyBytesUnderCap, checkBodySize } from "@/lib/body-size";

// Summonarr-native credentials sign-in. Hits the same authorize() body that
// next-auth's Credentials provider uses, then mints a Summonarr JWT we own.

// Sign-in bodies carry only email/password/rememberMe — 16 KB is overkill
// and protects this unauthenticated surface against memory-exhaustion DoS.
const MAX_SIGNIN_BODY_BYTES = 16 * 1024;

export async function POST(req: NextRequest) {
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
  return buildSignInResponse(req, result);
}
