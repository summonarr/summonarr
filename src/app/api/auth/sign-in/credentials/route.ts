import { NextResponse, type NextRequest } from "next/server";
import { authorizeWithCredentials, signInAndMintSession } from "@/lib/auth";
import { buildSignInResponse } from "@/lib/sign-in-response";
import { readJsonCapped } from "@/lib/body-size";

// Summonarr-native credentials sign-in: authorize(), then mint a Summonarr JWT we own.

// Sign-in bodies carry only email/password/rememberMe — 16 KB cap protects
// this unauthenticated surface against memory-exhaustion DoS.
const MAX_SIGNIN_BODY_BYTES = 16 * 1024;

export async function POST(req: NextRequest) {
  const parsed = await readJsonCapped<Record<string, unknown>>(req, MAX_SIGNIN_BODY_BYTES);
  if (parsed instanceof NextResponse) return parsed;
  const body = parsed;

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
