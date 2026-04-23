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
import { auth } from "@/lib/auth";
import { getFeatureFlags, type FeatureFlags } from "@/lib/features";

export async function generateMetadata(): Promise<Metadata> {
  try {
    const row = await prisma.setting.findUnique({ where: { key: "siteTitle" } });
    if (row?.value) return { title: row.value };
  } catch { }
  return {};
}

export default async function AppLayout({ children }: { children: React.ReactNode }) {
  let motdBody  = "";
  let motdTitle = "";
  let siteTitle = "";
  let discordInviteUrl = "";
  let userDiscordId: string | null = null;
  let maintenanceEnabled = false;
  let maintenanceMessage = "";
  let isAdmin = false;
  let featureFlags: FeatureFlags | undefined;
  try {
    const [rows, session, flags] = await Promise.all([
      prisma.setting.findMany({ where: { key: { in: ["motdEnabled", "motdTitle", "motdBody", "siteTitle", "discordInviteUrl", "maintenanceEnabled", "maintenanceMessage"] } } }),
      auth(),
      getFeatureFlags(),
    ]);
    const cfg = Object.fromEntries(rows.map((r) => [r.key, r.value]));
    motdBody            = cfg.motdEnabled === "true" ? (cfg.motdBody ?? "") : "";
    motdTitle           = cfg.motdTitle            ?? "";
    siteTitle           = cfg.siteTitle           ?? "";
    discordInviteUrl    = cfg.discordInviteUrl    ?? "";
    maintenanceEnabled  = cfg.maintenanceEnabled === "true";
    maintenanceMessage  = cfg.maintenanceMessage  ?? "";
    isAdmin             = session?.user?.role === "ADMIN";
    featureFlags        = flags;
    if (discordInviteUrl && session?.user?.id) {
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
        <main className="flex-1 min-h-0 overflow-y-auto px-4 py-4 pb-24 pb-safe-bottom-20 lg:px-7 lg:py-6 lg:pb-10">
          {children}
        </main>
      </div>
      {motdBody && <MotdModal title={motdTitle} body={motdBody} />}
    </div>
  );
}
