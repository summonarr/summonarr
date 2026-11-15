import "server-only";
import { NextResponse, type NextRequest } from "next/server";
import type { SummonarrSession } from "@/lib/api-auth";
import { mfaSecondFactorStepUp } from "@/lib/mfa/step-up";

// The second half of the step-up for a route that PLANTS something which
// outlives the account's sessions — a Discord link, a Trakt connection
// (guardrail 6g). Call it AFTER requireStepUp passed, and before anything is
// minted or sent.
//
// The password alone is what a phishing relay holds: a session minted by
// relaying it plus ONE code could otherwise link the relay's own Discord or
// Trakt account, and that link survives the owner's password change and
// sign-out-everywhere. So an account with an active second factor must present
// a FRESH one, exactly as a password change does (guardrail 6i): the same
// `secondFactor` body field and the same `400 { error, secondFactorRequired,
// methods }` refusal as the enrollment routes (mfa/step-up.ts). Checked only
// after the password, so a wrong password never burns a code.
//
// "Has a factor" is the factor ROWS (guardrail 6d), never the session's
// provider or the password hash. An account without one — every SSO-only
// account, which can't enrol — passes with no proof and its responses are
// unchanged. A failed factor lookup throws (500); it never reads as "no 2FA".
//
// Returns null when the caller passed, otherwise the response to send.
export async function requireStepUpSecondFactor(opts: {
  req: NextRequest;
  session: SummonarrSession;
  secondFactor: unknown;
  // Names the action in a lockout's audit row (mfa/lockout.ts).
  context: "discord-link" | "discord-merge" | "trakt-connect";
}): Promise<NextResponse | null> {
  const { session } = opts;
  const proof = await mfaSecondFactorStepUp(
    opts.req,
    session,
    { id: session.user.id, name: session.user.name ?? null, email: session.user.email ?? "" },
    opts.secondFactor,
    undefined,
    { context: opts.context },
  );
  return proof instanceof NextResponse ? proof : null;
}
