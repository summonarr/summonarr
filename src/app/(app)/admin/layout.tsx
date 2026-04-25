import { redirect } from "next/navigation";
import { auth, isTokenExpired } from "@/lib/auth";
import { AdminSubNav } from "@/components/layout/admin-sub-nav";

export default async function AdminLayout({ children }: { children: React.ReactNode }) {
  const session = await auth();

  // ISSUE_ADMIN has access to the admin subtree (including fix-match) — not just ADMIN
  if (!session || isTokenExpired(session) || (session.user.role !== "ADMIN" && session.user.role !== "ISSUE_ADMIN")) {
    redirect("/");
  }

  return (
    <>
      <AdminSubNav role={session.user.role} />
      {children}
    </>
  );
}
