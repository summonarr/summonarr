import { NextResponse } from "next/server";
import { withAuth } from "@/lib/api-auth";
import { maintenanceGuard } from "@/lib/maintenance";
import { readJsonCapped } from "@/lib/body-size";
import { beginTotpEnrollment } from "@/lib/mfa/mfa-store";
import { mfaPasswordStepUp } from "@/lib/mfa/step-up";
import { buildOtpauthUri } from "@/lib/mfa/totp";

// POST /api/profile/mfa/totp/setup — issues a PENDING authenticator-app secret.
// Body: { password }. Returns { secret, otpauthUri } — the ONLY time the secret
// leaves the server (it is encrypted at rest by the Prisma extension). Nothing
// changes for sign-in until POST /api/profile/mfa/totp/enable confirms a code.
// Calling it again before confirming re-issues a fresh secret.
export const POST = withAuth(async (req, _ctx, session) => {
  const maint = await maintenanceGuard(session);
  if (maint) return maint;
  const parsed = await readJsonCapped<{ password?: unknown }>(req, 16384);
  if (parsed instanceof NextResponse) return parsed;
  const user = await mfaPasswordStepUp(session, parsed.password);
  if (user instanceof NextResponse) return user;

  const result = await beginTotpEnrollment(user.id);
  if (result === "already-enabled") {
    return NextResponse.json(
      { error: "An authenticator app is already set up. Remove it first to replace it." },
      { status: 409 },
    );
  }
  return NextResponse.json(
    {
      secret: result.secret,
      otpauthUri: buildOtpauthUri({ secret: result.secret, accountName: user.email }),
    },
    { headers: { "Cache-Control": "no-store" } },
  );
});
