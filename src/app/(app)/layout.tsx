import type { Metadata } from "next";
import { Sidebar } from "@/components/layout/sidebar";
import { Header } from "@/components/layout/header";
import { MobileNav } from "@/components/layout/mobile-nav";
import { MotdModal } from "@/components/layout/motd-modal";
import { DiscordJoinModal } from "@/components/layout/discord-join-modal";
import { NavigationProgress } from "@/components/layout/navigation-progress";
import { MaintenancePage } from "@/components/layout/maintenance-page";
import { MaintenanceBanner } from "@/components/layout/maintenance-banner";
import { prisma } from "@/lib/prisma";
import { authActive } from "@/lib/auth";
import { redirect } from "next/navigation";
import { getFeatureFlags, type FeatureFlags } from "@/lib/features";
import { DONATION_SETTING_KEYS, hasDonationLinks } from "@/lib/donations";

export async function generateMetadata(): Promise<Metadata> {
  try {
    const row = await prisma.setting.findUnique({ where: { key: "siteTitle" } });
    if (row?.value) return { title: row.value };
  } catch { }
  return {};
}

export default async function AppLayout({ children }: { children: React.ReactNode }) {
  // DB-checked login gate. The proxy enforces auth on normal navigations, but its
  // matcher (src/proxy.ts) deliberately skips prefetch requests (next-router-prefetch
  // / purpose=prefetch), and the (app) pages carry no own login guard — so without
  // this a forged prefetch could render them unauthenticated. Next's own guidance is
  // to verify auth close to the data rather than rely on the proxy alone (proxy.md /
  // data-security.md). authActive() is DB-checked, so a revoked session or role
  // demotion is honored here too, not just the JWT signature + expiry.
  const session = await authActive();
  if (!session) redirect("/login");
  const isAdmin = session.user.role === "ADMIN";

  let motdBody  = "";
  let motdTitle = "";
  let siteTitle = "";
  let discordInviteUrl = "";
  let userDiscordId: string | null = null;
  let maintenanceEnabled = false;
  let maintenanceMessage = "";
  let featureFlags: FeatureFlags | undefined;
  try {
    const [rows, flags] = await Promise.all([
      prisma.setting.findMany({ where: { key: { in: ["motdEnabled", "motdTitle", "motdBody", "siteTitle", "discordInviteUrl", "maintenanceEnabled", "maintenanceMessage", ...DONATION_SETTING_KEYS] } } }),
      getFeatureFlags(),
    ]);
    const cfg = Object.fromEntries(rows.map((r) => [r.key, r.value]));
    motdBody            = cfg.motdEnabled === "true" ? (cfg.motdBody ?? "") : "";
    motdTitle           = cfg.motdTitle            ?? "";
    siteTitle           = cfg.siteTitle           ?? "";
    discordInviteUrl    = cfg.discordInviteUrl    ?? "";
    maintenanceEnabled  = cfg.maintenanceEnabled === "true";
    maintenanceMessage  = cfg.maintenanceMessage  ?? "";
    // Auto-hide the Donate nav link when no donation methods are configured —
    // nothing to link to, regardless of the feature toggle.
    featureFlags        = hasDonationLinks(cfg) ? flags : { ...flags, "feature.page.donate": false };
    if (discordInviteUrl && session.user.id) {
      const user = await prisma.user.findUnique({ where: { id: session.user.id }, select: { discordId: true } });
      userDiscordId = user?.discordId ?? null;
    }
  } catch {

  }

  // Admins bypass maintenance mode so they can still manage settings during downtime
  if (maintenanceEnabled && !isAdmin) {
    return <MaintenancePage message={maintenanceMessage} />;
  }

  return (
    <div
      className="flex h-screen overflow-hidden"
      style={{ background: "var(--ds-bg)", color: "var(--ds-fg)" }}
    >
      {/* Skip link: focusable on Tab from the page top, jumps past the sidebar/header to main content */}
      <a
        href="#main-content"
        className="sr-only focus:not-sr-only focus:fixed focus:top-2 focus:left-2 focus:z-50 focus:px-3 focus:py-2 focus:rounded focus:outline-none focus:ring-2 focus:ring-[var(--ds-accent-ring)]"
        style={{ background: "var(--ds-bg-2)", color: "var(--ds-fg)", border: "1px solid var(--ds-border)" }}
      >
        Skip to main content
      </a>
      <NavigationProgress />
      <Sidebar siteTitle={siteTitle} featureFlags={featureFlags} />
      <div className="flex flex-col flex-1 min-w-0 overflow-hidden">
        <Header />
        <MobileNav featureFlags={featureFlags} />
        {maintenanceEnabled && isAdmin && (
          <MaintenanceBanner message={maintenanceMessage} />
        )}
        {discordInviteUrl && !userDiscordId && (
          <DiscordJoinModal inviteUrl={discordInviteUrl} />
        )}
        <main id="main-content" tabIndex={-1} className="flex-1 min-h-0 overflow-y-auto px-4 py-4 pb-24 pb-safe-bottom-20 lg:px-7 lg:py-6 lg:pb-10">
          {children}
        </main>
      </div>
      {motdBody && <MotdModal title={motdTitle} body={motdBody} />}
    </div>
  );
}
