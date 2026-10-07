import { prisma } from "@/lib/prisma";
import { redirect } from "next/navigation";
import { Film } from "@/components/icons";
import { getTranslator } from "@/lib/i18n/server";

export const dynamic = "force-dynamic";
import { SetupShell } from "./setup-shell";

const MIN_BACKUP_PASSWORD_LEN = 12;

// First-run wizard; inaccessible once any user exists so the admin account can't be hijacked
export default async function SetupPage() {
  const count = await prisma.user.count();
  if (count > 0) redirect("/login");

  const siteTitleRow = await prisma.setting.findUnique({ where: { key: "siteTitle" } });
  const siteTitle = siteTitleRow?.value || "Summonarr";

  const backupPassword = process.env.BACKUP_DB_PASSWORD ?? "";
  const importAvailable = backupPassword.length >= MIN_BACKUP_PASSWORD_LEN;
  const t = await getTranslator();

  // Header + card shape mirror login/page.tsx (Playfair wordmark, accent Film
  // tile, max-w-sm, token card): the restore path redirects straight from here
  // to /login, so the two consecutive auth screens must read as one surface.
  // The setup card itself is rendered by SetupShell with the same recipe.
  return (
    <div
      className="min-h-screen flex items-start md:items-center justify-center px-4 pt-16 md:pt-0"
      style={{ background: "var(--ds-bg)", color: "var(--ds-fg)" }}
    >
      <div className="w-full max-w-sm">
        <div className="flex flex-col items-center" style={{ marginBottom: 24 }}>
          <p
            className="m-0"
            style={{
              fontFamily: "var(--font-playfair)",
              fontSize: 28,
              fontWeight: 400,
              color: "var(--ds-fg)",
              letterSpacing: "0.02em",
              marginBottom: 14,
            }}
          >
            Summonarr
          </p>
          <div
            className="flex items-center justify-center"
            style={{
              width: 44,
              height: 44,
              borderRadius: 10,
              background: "var(--ds-accent)",
              color: "var(--ds-accent-fg)",
              boxShadow:
                "0 0 0 1px color-mix(in oklab, var(--ds-accent) 40%, transparent), inset 0 -1px 0 rgba(0,0,0,.15)",
              marginBottom: 12,
            }}
          >
            <Film style={{ width: 22, height: 22 }} />
          </div>
          <h1
            className="m-0 font-semibold text-center"
            style={{ fontSize: 18, color: "var(--ds-fg)", letterSpacing: "-0.01em" }}
          >
            {t("auth.setup.welcome", { siteTitle })}
          </h1>
          <p className="m-0 text-sm text-center" style={{ color: "var(--ds-fg-muted)", marginTop: 4 }}>
            {t("auth.setup.subtitle")}
          </p>
        </div>

        <SetupShell importAvailable={importAvailable} />
      </div>
    </div>
  );
}
