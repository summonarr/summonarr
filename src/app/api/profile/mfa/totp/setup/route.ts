import { NextResponse } from "next/server";
import { withAuth } from "@/lib/api-auth";
import { maintenanceGuard } from "@/lib/maintenance";
import { readJsonCapped } from "@/lib/body-size";
import { beginTotpEnrollment, getMfaState } from "@/lib/mfa/mfa-store";
import { mfaReauthStepUp, mfaSecondFactorStepUp } from "@/lib/mfa/step-up";
import { buildOtpauthUri } from "@/lib/mfa/totp";
import { translatorForRequest } from "@/lib/i18n/server-locale";

// POST /api/profile/mfa/totp/setup — issues a PENDING authenticator-app secret.
// Body: { password, secondFactor? }. When the account already has an active
// factor (e.g. a passkey) adding an authenticator app is an enrollment change
// and also needs a fresh second factor (step-up.ts); the very first factor is
// password-only. Returns { secret, otpauthUri } — the ONLY time the secret
// leaves the server (it is encrypted at rest by the Prisma extension). Nothing
// changes for sign-in until POST /api/profile/mfa/totp/enable confirms a code.
// Calling it again before confirming re-issues a fresh secret.
export const POST = withAuth(async (req, _ctx, session) => {
  const t = translatorForRequest(req);
  const maint = await maintenanceGuard(session);
  if (maint) return maint;
  const parsed = await readJsonCapped<{ password?: unknown; secondFactor?: unknown }>(req, 64 * 1024);
  if (parsed instanceof NextResponse) return parsed;
  const user = await mfaReauthStepUp(session, parsed.password, t);
  if (user instanceof NextResponse) return user;

  // Checked before the second factor so a 409 never spends a recovery code.
  const state = await getMfaState(user.id);
  if (state.totpEnabled) return NextResponse.json({ error: t("apiAuth.mfa.totpAlreadySetReplace") }, { status: 409 });
  const proof = await mfaSecondFactorStepUp(req, session, user, parsed.secondFactor, state);
  if (proof instanceof NextResponse) return proof;

  const result = await beginTotpEnrollment(user.id);
  if (result === "already-enabled") {
    return NextResponse.json({ error: t("apiAuth.mfa.totpAlreadySetReplace") }, { status: 409 });
  }
  return NextResponse.json(
    {
      secret: result.secret,
      otpauthUri: buildOtpauthUri({ secret: result.secret, accountName: user.email }),
    },
    { headers: { "Cache-Control": "no-store" } },
  );
});
