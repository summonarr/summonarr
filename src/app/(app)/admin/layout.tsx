import { redirect } from "next/navigation";
import { readActiveSummonarrSession } from "@/lib/session-server";

export default async function AdminLayout({ children }: { children: React.ReactNode }) {
  // DB-checked read (revocation + role-rotation honored), not a JWT-only auth():
  // the admin subtree is reachable on the prefetch-header path that proxy.ts's
  // matcher skips, so a revoked or role-demoted session must be re-validated
  // against the DB here too. verifyAndRefreshSession already rejects expired JWTs.
  const claims = await readActiveSummonarrSession();

  // ISSUE_ADMIN has access to the admin subtree (including fix-match) — not just ADMIN
  if (!claims || (claims.role !== "ADMIN" && claims.role !== "ISSUE_ADMIN")) {
    redirect("/");
  }

  return <>{children}</>;
}
