import { prisma } from "@/lib/prisma";
import { redirect } from "next/navigation";
import { getTranslator } from "@/lib/i18n/server";
import { isBackupPasswordReady } from "@/lib/backup-password";
import { AuthBrandHeader } from "@/components/auth/auth-brand-header";

export const dynamic = "force-dynamic";
import { SetupShell } from "./setup-shell";

// First-run wizard; inaccessible once any user exists so the admin account can't be hijacked
export default async function SetupPage() {
  const count = await prisma.user.count();
  if (count > 0) redirect("/login");

  const siteTitleRow = await prisma.setting.findUnique({ where: { key: "siteTitle" } });
  const siteTitle = siteTitleRow?.value || "Summonarr";

  // The restore tab needs the same BACKUP_DB_PASSWORD the setup restore routes
  // require (they answer 503 without it). Only the boolean leaves the server.
  const importAvailable = isBackupPasswordReady();
  const t = await getTranslator();

  // Header + card shape mirror login/page.tsx (AuthBrandHeader, max-w-sm, token
  // card): the restore path redirects straight from here to /login, so the two
  // consecutive auth screens must read as one surface. The setup card itself is
  // rendered by SetupShell with the same recipe.
  return (
    <div
      className="min-h-screen flex items-start md:items-center justify-center px-4 pt-16 md:pt-0"
      style={{ background: "var(--ds-bg)", color: "var(--ds-fg)" }}
    >
      <div className="w-full max-w-sm">
        <AuthBrandHeader>
          <h1
            className="m-0 font-semibold text-center"
            style={{ fontSize: 18, color: "var(--ds-fg)", letterSpacing: "-0.01em" }}
          >
            {t("auth.setup.welcome", { siteTitle })}
          </h1>
          <p className="m-0 text-sm text-center" style={{ color: "var(--ds-fg-muted)", marginTop: 4 }}>
            {t("auth.setup.subtitle")}
          </p>
        </AuthBrandHeader>

        <SetupShell importAvailable={importAvailable} />
      </div>
    </div>
  );
}
