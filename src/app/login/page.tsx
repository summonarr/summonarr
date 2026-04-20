import { prisma } from "@/lib/prisma";
import { redirect } from "next/navigation";
import { Film, Wrench } from "lucide-react";
import { LoginForm } from "./login-form";
import { getMaintenanceStatus } from "@/lib/maintenance";

export const dynamic = "force-dynamic";

export default async function LoginPage() {

  const count = await prisma.user.count();
  // When no users exist and no external provider is configured, redirect to the first-run setup wizard
  const hasExternalProvider = !!process.env.OIDC_ISSUER || !!process.env.JELLYFIN_URL;
  if (count === 0 && !hasExternalProvider) redirect("/setup");

  const [plexRow, siteTitleRow, siteUrlRow, disableLocalRow] = await Promise.all([
    prisma.setting.findUnique({ where: { key: "plexAdminToken" } }),
    prisma.setting.findUnique({ where: { key: "siteTitle" } }),
    prisma.setting.findUnique({ where: { key: "siteUrl" } }),
    prisma.setting.findUnique({ where: { key: "disableLocalLogin" } }),
  ]);
  const plexEnabled = !!plexRow?.value;
  const jellyfinEnabled = !!process.env.JELLYFIN_URL;
  const oidcEnabled = !!(process.env.OIDC_ISSUER && process.env.OIDC_CLIENT_ID && process.env.OIDC_CLIENT_SECRET);
  const oidcName = process.env.OIDC_DISPLAY_NAME || "SSO";
  const localLoginDisabled = disableLocalRow?.value === "true";
  const siteTitle = siteTitleRow?.value || "Summonarr";
  const siteUrl = siteUrlRow?.value || process.env.NEXTAUTH_URL || "";
  const maintenance = await getMaintenanceStatus();

  return (
    <div className="min-h-screen flex items-center justify-center bg-zinc-950 px-4">
      <div className="w-full max-w-sm bg-zinc-900 border border-zinc-800 rounded-xl p-8">
        {maintenance.enabled && (
          <div className="flex items-start gap-2.5 bg-yellow-900/20 border border-yellow-800/30 rounded-lg p-3 mb-6">
            <Wrench className="w-4 h-4 text-yellow-400 shrink-0 mt-0.5" />
            <p className="text-sm text-yellow-300">
              {maintenance.message || "We're performing some maintenance. Please check back shortly."}
            </p>
          </div>
        )}
        <div className="flex flex-col items-center mb-8">
          <p className="text-3xl text-white mb-4 tracking-wide" style={{ fontFamily: "var(--font-playfair)" }}>Summonarr</p>
          <div className="w-12 h-12 rounded-xl bg-indigo-600 flex items-center justify-center mb-3">
            <Film className="w-6 h-6 text-white" />
          </div>
          <h1 className="text-xl font-bold text-white">{siteTitle}</h1>
          <p className="text-zinc-400 text-sm mt-1">Sign in to your account</p>
        </div>

        {count === 0 && (
          <div className="flex items-center gap-2 mb-6 px-3 py-2.5 rounded-lg bg-indigo-600/10 border border-indigo-500/20">
            <span className="text-indigo-400 text-xs font-medium">
              First sign-in automatically becomes administrator
            </span>
          </div>
        )}

        <LoginForm plexEnabled={plexEnabled} jellyfinEnabled={jellyfinEnabled} oidcEnabled={oidcEnabled} oidcName={oidcName} localLoginDisabled={localLoginDisabled} siteUrl={siteUrl} />
      </div>
    </div>
  );
}
