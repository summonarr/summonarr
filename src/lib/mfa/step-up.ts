import "server-only";

// Password step-up shared by every two-factor ENROLLMENT change under
// /api/profile/mfa — the same shape as the existing step-ups on password change
// (PATCH /api/profile/password) and self-delete (DELETE /api/profile): a
// per-user throttle, then the account's current password in the body.
//
// A hijacked or borrowed session therefore can't add its own authenticator to
// the account, strip the owner's, or read out fresh recovery codes.
//
// Two-factor is offered ONLY to local-credentials accounts: Plex / Jellyfin /
// OIDC users authenticate at their provider, which owns MFA there, and a local
// password-less account has nothing for a second factor to sit behind.

import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { checkRateLimit } from "@/lib/rate-limit";
import { verifyPassword, MAX_PASSWORD_LENGTH } from "@/lib/password-hash";
import type { SummonarrSession } from "@/lib/api-auth";

export const MFA_UNAVAILABLE_MESSAGE =
  "Two-factor authentication is available only for accounts that sign in with a password.";

export interface StepUpUser {
  id: string;
  name: string | null;
  email: string;
}

// The non-password half: is this session's account eligible at all?
export async function mfaEligibleUser(session: SummonarrSession): Promise<StepUpUser | NextResponse> {
  const user = await prisma.user.findUnique({
    where: { id: session.user.id },
    select: { id: true, name: true, email: true, passwordHash: true },
  });
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  if (session.user.provider !== "credentials" || !user.passwordHash) {
    return NextResponse.json({ error: MFA_UNAVAILABLE_MESSAGE }, { status: 403 });
  }
  return { id: user.id, name: user.name, email: user.email };
}

export async function mfaPasswordStepUp(session: SummonarrSession, password: unknown): Promise<StepUpUser | NextResponse> {
  if (!checkRateLimit(`mfa-stepup:${session.user.id}`, 10, 15 * 60 * 1000)) {
    return NextResponse.json(
      { error: "Too many attempts — please wait 15 minutes before trying again." },
      { status: 429 },
    );
  }
  const user = await prisma.user.findUnique({
    where: { id: session.user.id },
    select: { id: true, name: true, email: true, passwordHash: true },
  });
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  if (session.user.provider !== "credentials" || !user.passwordHash) {
    return NextResponse.json({ error: MFA_UNAVAILABLE_MESSAGE }, { status: 403 });
  }
  if (typeof password !== "string" || password.length === 0) {
    return NextResponse.json({ error: "Your current password is required" }, { status: 400 });
  }
  if (password.length > MAX_PASSWORD_LENGTH) {
    return NextResponse.json({ error: "Invalid password" }, { status: 400 });
  }
  if (!(await verifyPassword(password, user.passwordHash))) {
    return NextResponse.json({ error: "Invalid password" }, { status: 400 });
  }
  return { id: user.id, name: user.name, email: user.email };
}
