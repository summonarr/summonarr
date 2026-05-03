import { prisma } from "@/lib/prisma";
import { redirect } from "next/navigation";
import { Film, Wrench } from "lucide-react";
import { LoginForm } from "./login-form";
import { getMaintenanceStatus } from "@/lib/maintenance";

export const dynamic = "force-dynamic";

export default async function LoginPage() {

  const count = await prisma.user.count();
  // Fresh install: empty user table always lands on /setup. No exceptions for external providers —
  // the admin account is created locally first; Jellyfin/OIDC are wired up from Settings afterwards.
  if (count === 0) redirect("/setup");

  const [plexRow, jellyfinKeyRow, siteTitleRow, siteUrlRow, disableLocalRow] = await Promise.all([
    prisma.setting.findUnique({ where: { key: "plexAdminToken" } }),
    prisma.setting.findUnique({ where: { key: "jellyfinApiKey" } }),
    prisma.setting.findUnique({ where: { key: "siteTitle" } }),
    prisma.setting.findUnique({ where: { key: "siteUrl" } }),
    prisma.setting.findUnique({ where: { key: "disableLocalLogin" } }),
  ]);
  const plexEnabled = !!plexRow?.value;
  // Mirror Plex: the env var is necessary but not sufficient — the Jellyfin tab appears only
  // after an admin has completed the Jellyfin wiring in Admin → Settings (API key stored).
  const jellyfinEnabled = !!process.env.JELLYFIN_URL && !!jellyfinKeyRow?.value;
  const oidcEnabled = !!(process.env.OIDC_ISSUER && process.env.OIDC_CLIENT_ID && process.env.OIDC_CLIENT_SECRET);
  const oidcName = process.env.OIDC_DISPLAY_NAME || "SSO";
  const localLoginDisabled = disableLocalRow?.value === "true";
  const siteTitle = siteTitleRow?.value || "Summonarr";
  const siteUrl = siteUrlRow?.value || process.env.NEXTAUTH_URL || "";
  const maintenance = await getMaintenanceStatus();

  return (
    <div
      className="min-h-screen flex items-start md:items-center justify-center px-4 pt-16 md:pt-0"
      style={{ background: "var(--ds-bg)", color: "var(--ds-fg)" }}
    >
      <div
        className="w-full max-w-sm"
        style={{
          background: "var(--ds-bg-1)",
          border: "1px solid var(--ds-border)",
          borderRadius: "var(--ds-r-xl)",
          padding: 28,
          boxShadow: "var(--ds-shadow-md)",
        }}
      >
        {maintenance.enabled && (
          <div
            className="flex items-start gap-2.5 mb-5"
            style={{
              background: "color-mix(in oklab, var(--ds-warning) 12%, transparent)",
              border: "1px solid color-mix(in oklab, var(--ds-warning) 28%, transparent)",
              borderRadius: "var(--ds-r-md)",
              padding: "10px 12px",
            }}
          >
            <Wrench style={{ width: 14, height: 14, marginTop: 2, color: "var(--ds-warning)", flexShrink: 0 }} />
            <p className="text-sm" style={{ color: "var(--ds-fg)", margin: 0 }}>
              {maintenance.message || "We're performing some maintenance. Please check back shortly."}
            </p>
          </div>
        )}

        <div className="flex flex-col items-center" style={{ marginBottom: 24 }}>
          <p
            className="m-0"
            style={{
              fontFamily: "var(--font-playfair)",
              fontSize: 28,
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
            className="m-0 font-semibold"
            style={{ fontSize: 18, color: "var(--ds-fg)", letterSpacing: "-0.01em" }}
          >
            {siteTitle}
          </h1>
          <p
            className="ds-mono m-0"
            style={{ fontSize: 12, color: "var(--ds-fg-subtle)", marginTop: 4 }}
          >
            Sign in to your account
          </p>
        </div>

        <LoginForm plexEnabled={plexEnabled} jellyfinEnabled={jellyfinEnabled} oidcEnabled={oidcEnabled} oidcName={oidcName} localLoginDisabled={localLoginDisabled} siteUrl={siteUrl} />
      </div>
    </div>
  );
}
