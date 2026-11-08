import { redirect } from "next/navigation";
import { readActiveSummonarrSession } from "@/lib/session-server";
import { effectivePermissions, parsePermissions } from "@/lib/permissions";
import { hasAdminAreaAccess } from "@/lib/admin-access";
import { FixMatchTray } from "@/components/admin/fix-match-tray";
import { adminMustEnrollMfa, MFA_ENROLL_PATH } from "@/lib/mfa/policy";

export default async function AdminLayout({ children }: { children: React.ReactNode }) {
  // DB-checked read (revocation + role-rotation honored), not a JWT-only auth():
  // the admin subtree is reachable on the prefetch-header path that proxy.ts's
  // matcher skips, so a revoked or role-demoted session must be re-validated
  // against the DB here too. verifyAndRefreshSession already rejects expired JWTs.
  const claims = await readActiveSummonarrSession();

  // Any management bit grants access to the admin subtree (per-route guards + page
  // guards do the finer work). ADMIN superbit always passes. The same rule as
  // the proxy's admin gates (admin-access.ts), so the two can't drift.
  const allowed = claims && hasAdminAreaAccess(
    effectivePermissions(claims.role, parsePermissions(claims.permissions)),
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

  return (
    <>
      {children}
      {/* Outcome of fix-match jobs, reachable after leaving the page that started one. */}
      <FixMatchTray />
    </>
  );
}
