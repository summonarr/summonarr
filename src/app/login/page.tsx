import { prisma } from "@/lib/prisma";
import { getSyncableMediaInstances } from "@/lib/media-instance-registry";
import { signInServerOptions } from "@/lib/sign-in-servers";
import { redirect } from "next/navigation";
import { CheckCircle, Smartphone, Wrench } from "@/components/icons";
import { AuthBrandHeader } from "@/components/auth/auth-brand-header";
import { IOS_APP_STORE_URL } from "@/lib/ios-app";
import { LoginForm } from "./login-form";
import { getMaintenanceStatus } from "@/lib/maintenance";
import { getTranslator } from "@/lib/i18n/server";
import { isOidcConfigured } from "@/lib/oidc";
import { first, type PageSearchParams } from "@/lib/search-params";

export const dynamic = "force-dynamic";

// The three plain settings the page reads, in one query.
const LOGIN_SETTING_KEYS = ["siteTitle", "siteUrl", "disableLocalLogin"] as const;

export default async function LoginPage({ searchParams }: { searchParams: Promise<PageSearchParams> }) {
  // Fresh install: empty user table always lands on /setup. No exceptions for external providers —
  // the admin account is created locally first; Jellyfin/OIDC are wired up from Settings afterwards.
  // An existence probe, not a count: this public page is hit on every visit.
  const anyUser = await prisma.user.findFirst({ select: { id: true } });
  if (!anyUser) redirect("/setup");

  // Independent reads, one round of them. getMaintenanceStatus keeps its own
  // fail-closed catch.
  const [plexInstances, jellyfinInstances, settingRows, maintenance, t] = await Promise.all([
    getSyncableMediaInstances("plex"),
    getSyncableMediaInstances("jellyfin"),
    prisma.setting.findMany({ where: { key: { in: [...LOGIN_SETTING_KEYS] } }, select: { key: true, value: true } }),
    getMaintenanceStatus(),
    getTranslator(),
  ]);
  const setting = (key: (typeof LOGIN_SETTING_KEYS)[number]) => settingRows.find((row) => row.key === key)?.value;
  // Fully DB-configured, like Jellyfin below: the Plex tab appears once at least
  // one instance has BOTH its ServerUrl and AdminToken stored. Deliberately
  // tighter than the old plexAdminToken-only check — a token-without-URL
  // deployment used to show the tab while every attempt refused
  // (plex_server_not_configured); now the tab hides instead. No instance list
  // reaches the client: Plex OAuth carries no server picker.
  const plexEnabled = plexInstances.length > 0;
  // Mirror Plex: fully DB-configured. The Jellyfin tab appears only after an admin has
  // completed the Jellyfin wiring (server URL + API key stored) for at least one
  // instance — getSyncableMediaInstances already requires both per instance, so
  // this is byte-for-byte the same gate a single-server deployment had before.
  const jellyfinEnabled = jellyfinInstances.length > 0;
  // The same predicate the three OIDC routes gate on — it also refuses a
  // non-https issuer, which openid-client can never complete a sign-in against,
  // so the tab hides instead of failing on every click.
  const oidcEnabled = isOidcConfigured();
  const oidcName = process.env.OIDC_DISPLAY_NAME || "SSO";
  const localLoginDisabled = setting("disableLocalLogin") === "true";
  const siteTitle = setting("siteTitle") || "Summonarr";
  const siteUrl = setting("siteUrl") || process.env.AUTH_URL || "";
  // The Playfair wordmark above the icon already says "Summonarr"; repeating it
  // as the h1 read as a stutter on every default install. When the title IS the
  // default, the wordmark becomes the page's h1 instead so the heading outline
  // never loses its top level.
  const isDefaultTitle = siteTitle.trim().toLowerCase() === "summonarr";
  const WordmarkTag = isDefaultTitle ? "h1" : "p";
  // /setup sends the new admin here when its automatic sign-in didn't go
  // through, so the account it just created doesn't look like a failure.
  const accountCreated = first((await searchParams).created) === "1";

  return (
    <div
      className="min-h-screen flex items-start md:items-center justify-center px-4 pt-16 md:pt-0"
      style={{ background: "var(--ds-bg)", color: "var(--ds-fg)" }}
    >
      <div className="w-full max-w-sm">
        <div
          className="w-full"
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
                {maintenance.message || t("auth.login.maintenanceDefault")}
              </p>
            </div>
          )}

          {accountCreated && (
            <div
              role="status"
              className="flex items-start gap-2.5 mb-5"
              style={{
                background: "color-mix(in oklab, var(--ds-success) 12%, transparent)",
                border: "1px solid color-mix(in oklab, var(--ds-success) 28%, transparent)",
                borderRadius: "var(--ds-r-md)",
                padding: "10px 12px",
              }}
            >
              <CheckCircle style={{ width: 14, height: 14, marginTop: 2, color: "var(--ds-success)", flexShrink: 0 }} />
              <p className="text-sm" style={{ color: "var(--ds-fg)", margin: 0 }}>
                {t("auth.setup.error.createdSignIn")}
              </p>
            </div>
          )}

          <AuthBrandHeader wordmarkAs={WordmarkTag}>
            {!isDefaultTitle && (
              <h1
                className="m-0 font-semibold"
                style={{ fontSize: 18, color: "var(--ds-fg)", letterSpacing: "-0.01em" }}
              >
                {siteTitle}
              </h1>
            )}
            <p
              className="ds-mono m-0"
              style={{ fontSize: 12, color: "var(--ds-fg-subtle)", marginTop: 4 }}
            >
              {t("auth.login.subtitle")}
            </p>
          </AuthBrandHeader>

          <LoginForm plexEnabled={plexEnabled} jellyfinEnabled={jellyfinEnabled} jellyfinInstances={signInServerOptions(jellyfinInstances)} oidcEnabled={oidcEnabled} oidcName={oidcName} localLoginDisabled={localLoginDisabled} siteUrl={siteUrl} />
        </div>

        <div className="flex flex-col items-center text-center" style={{ marginTop: 18, gap: 4 }}>
          <a
            href={IOS_APP_STORE_URL}
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex items-center gap-1.5 text-sm hover:underline"
            style={{ color: "var(--ds-accent-text)" }}
          >
            <Smartphone style={{ width: 14, height: 14 }} />
            {t("auth.login.iosApp.link")}
          </a>
          {siteUrl && (
            <p className="m-0 text-xs" style={{ color: "var(--ds-fg-subtle)" }}>
              {t("auth.login.iosApp.server")} <span className="ds-mono">{siteUrl}</span>
            </p>
          )}
        </div>
      </div>
    </div>
  );
}
