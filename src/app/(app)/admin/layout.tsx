import { redirect } from "next/navigation";
import { readActiveSummonarrSession } from "@/lib/session-server";
import { hasPermission, Permission, effectivePermissions, parsePermissions } from "@/lib/permissions";
import { adminMustEnrollMfa, MFA_ENROLL_PATH } from "@/lib/mfa/policy";

export default async function AdminLayout({ children }: { children: React.ReactNode }) {
  // DB-checked read (revocation + role-rotation honored), not a JWT-only auth():
  // the admin subtree is reachable on the prefetch-header path that proxy.ts's
  // matcher skips, so a revoked or role-demoted session must be re-validated
  // against the DB here too. verifyAndRefreshSession already rejects expired JWTs.
  const claims = await readActiveSummonarrSession();

  // Any management bit grants access to the admin subtree (per-route guards + page
  // guards do the finer work). ADMIN superbit always passes.
  const allowed = claims && hasPermission(
    effectivePermissions(claims.role, parsePermissions(claims.permissions)),
    [Permission.MANAGE_USERS, Permission.MANAGE_REQUESTS, Permission.MANAGE_ISSUES, Permission.ADMIN],
  );
  if (!allowed) {
    redirect("/");
  }

  // "Require two-factor for administrators" (src/lib/mfa/policy.ts): a
  // local-credentials ADMIN without a second factor is sent to enroll. A policy
  // nudge on entering the admin pages, not an authz boundary — it never blocks
  // signing in, and SUMMONARR_DISABLE_MFA_ENFORCEMENT=true switches it off.
  // redirect() throws NEXT_REDIRECT, so this stays outside any try/catch.
  if (await adminMustEnrollMfa(claims)) {
    redirect(MFA_ENROLL_PATH);
  }

  return <>{children}</>;
}
