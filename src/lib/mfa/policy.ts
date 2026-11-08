import "server-only";

// "Prompt administrators to set up two-factor" (Setting requireMfaForAdmins,
// formerly labelled "Require two-factor for administrators") — the admin-area
// enrollment nudge.
//
// When the `requireMfaForAdmins` Setting is "true", an ADMIN whose session came
// from LOCAL CREDENTIALS and who has no active second factor is redirected from
// the /admin pages to the profile page's two-factor section. It never blocks
// SIGNING IN — locking an admin out of the only place they could enroll would
// be self-defeating — and it is a policy nudge on the page tree, not an
// authorization boundary (the account is already a fully authenticated ADMIN).
//
// SUMMONARR_DISABLE_MFA_ENFORCEMENT=true is the operator's escape hatch: it
// switches the redirect off regardless of the Setting, so a misconfigured policy
// (e.g. no working WebAuthn origin and no authenticator app to hand) can never
// strand the instance's admins. It does NOT disable anyone's existing 2FA at
// sign-in — that is per-account and only the account owner or an admin reset
// (DELETE /api/admin/users/[id]/mfa) removes it.

import { prisma } from "@/lib/prisma";
import { getMfaState } from "./mfa-store";

export const REQUIRE_MFA_FOR_ADMINS_KEY = "requireMfaForAdmins";
export const MFA_ENFORCEMENT_ESCAPE_ENV = "SUMMONARR_DISABLE_MFA_ENFORCEMENT";
export const MFA_ENROLL_PATH = "/profile?mfa=required#two-factor";

export function mfaEnforcementDisabledByEnv(env: Record<string, string | undefined> = process.env): boolean {
  return env[MFA_ENFORCEMENT_ESCAPE_ENV] === "true";
}

// Pure rule, setting aside the Setting: could the policy apply to this session
// at all? The cheap gate adminMustEnrollMfa checks before reading the Setting.
function sessionEligibleForAdminMfaPolicy(
  role: string | undefined,
  provider: string | undefined,
  env?: Record<string, string | undefined>,
): boolean {
  return !mfaEnforcementDisabledByEnv(env) && role === "ADMIN" && provider === "credentials";
}

// Pure rule: does the policy apply to this session at all (before looking at
// whether the account has enrolled)?
export function adminMfaPolicyApplies(opts: {
  role: string | undefined;
  provider: string | undefined;
  settingValue: string | null | undefined;
  env?: Record<string, string | undefined>;
}): boolean {
  return opts.settingValue === "true" && sessionEligibleForAdminMfaPolicy(opts.role, opts.provider, opts.env);
}

export async function adminMustEnrollMfa(claims: { id: string; role?: string; provider?: string }): Promise<boolean> {
  // Cheap gate first: most sessions never reach the Setting read.
  if (!sessionEligibleForAdminMfaPolicy(claims.role, claims.provider)) return false;
  const row = await prisma.setting.findUnique({ where: { key: REQUIRE_MFA_FOR_ADMINS_KEY } });
  if (row?.value !== "true") return false;
  const state = await getMfaState(claims.id);
  return !state.enabled;
}
