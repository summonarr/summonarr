import type { Metadata } from "next";
import { cache } from "react";
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
import { getTranslator } from "@/lib/i18n/server";
import { LocaleSync } from "@/components/i18n/locale-sync";
import { hasPermission, Permission } from "@/lib/permissions";
import { getFeatureFlags } from "@/lib/features";
import { readArrWatchNavBadges } from "@/lib/arr-watch-data";
import { DONATION_SETTING_KEYS } from "@/lib/donations";
import { appLayoutStateFrom } from "@/lib/app-layout-state";
import { forgetWarnOnChange, warnOnChange } from "@/lib/log-dedup";
import { sanitizeForLog } from "@/lib/sanitize";
import { RatingsVisibilityProvider } from "@/components/media/ratings-visibility";
import { DetailTitleProvider } from "@/components/layout/detail-title";
import { NotificationStoreProvider } from "@/components/notifications/notification-store";
import { NavBadgesProvider } from "@/components/layout/admin-nav-groups";
import { cookies } from "next/headers";
import { ADMIN_NAV_COLLAPSED_COOKIE, parseCollapsedGroupsCookie } from "@/lib/admin-nav-collapsed";

// One settings read per request, shared by generateMetadata and the layout
// body. Next only de-duplicates `fetch()` calls between those two, not Prisma
// reads, so React's `cache` does it here. The cache lives for one request only,
// so a settings change still shows up on the next page load.
const LAYOUT_SETTING_KEYS = [
  "motdEnabled", "motdTitle", "motdBody", "siteTitle", "discordInviteUrl",
  "maintenanceEnabled", "maintenanceMessage", "ratingsHiddenSources",
  ...DONATION_SETTING_KEYS,
];
const readLayoutSettings = cache(async () =>
  prisma.setting.findMany({ where: { key: { in: LAYOUT_SETTING_KEYS } } }),
);

type ReadFailure = { name: string; detail: string };

// One layout read's value, or undefined with its failure noted under `name`.
function readValue<T>(name: string, r: PromiseSettledResult<T>, failures: ReadFailure[]): T | undefined {
  if (r.status === "fulfilled") return r.value;
  failures.push({ name, detail: sanitizeForLog(r.reason instanceof Error ? r.reason.message : r.reason) });
  return undefined;
}

// Every (app) page render reaches the layout, so a failing read would repeat
// once per page view for the whole outage: log it on change only (guardrail 7b).
const LAYOUT_READS_WARN_KEY = "layout:reads";
function warnLayoutReads(failed: string, detail: string): void {
  warnOnChange(LAYOUT_READS_WARN_KEY, failed, `[layout] read failed, rendering with defaults: ${detail}`);
}

export async function generateMetadata(): Promise<Metadata> {
  try {
    const title = (await readLayoutSettings()).find((r) => r.key === "siteTitle")?.value;
    // The root layout's template names the app "Summonarr"; an instance with a
    // configured site title must carry it into every tab title too.
    if (title) return { title: { default: title, template: `%s · ${title}` } };
  } catch { }
  return {};
}

export default async function AppLayout({ children }: { children: React.ReactNode }) {
  // DB-checked login gate (guardrail 29). The proxy (src/proxy.ts) skips
  // prefetch requests, so it can't be the only check. Each page also calls
  // requireAppSession(), because Next can skip this layout's render on some
  // client navigations. authActive() checks the database, so a revoked session
  // or a demoted role is honored, not just the JWT's signature and expiry.
  // Keep this redirect outside any try/catch: redirect() works by throwing,
  // and a catch around it would swallow the redirect.
  const session = await authActive();
  if (!session) redirect("/login");
  const isAdmin = hasPermission(session.user.permissions, Permission.ADMIN);

  // The discordId lookup runs in parallel with the settings/flags reads
  // instead of after them, saving a full DB round-trip per page. The cost:
  // sites with no Discord invite do one small extra lookup they don't need.
  // Settled one by one: a failed user or flags read must not discard the
  // settings that WERE read (maintenance mode among them). A failed read keeps
  // its defaults, so a DB hiccup here never takes down every page in the app.
  const [rowsRes, flagsRes, userRes, badgesRes] = await Promise.allSettled([
    readLayoutSettings(),
    getFeatureFlags(),
    prisma.user.findUnique({ where: { id: session.user.id }, select: { discordId: true, locale: true } }),
    // The Download Queue's "needs attention" count (the Radarr/Sonarr
    // monitor's last run) — one row read, admins only; never throws.
    isAdmin ? readArrWatchNavBadges() : Promise.resolve(undefined),
  ]);
  const failures: ReadFailure[] = [];
  const rows = readValue("settings", rowsRes, failures) ?? [];
  const flags = readValue("feature flags", flagsRes, failures);
  const user = readValue("user", userRes, failures);
  const navBadges = readValue("nav badges", badgesRes, failures);
  if (failures.length) {
    warnLayoutReads(
      failures.map((f) => f.name).join(","),
      failures.map((f) => `${f.name}: ${f.detail}`).join("; "),
    );
  } else {
    forgetWarnOnChange(LAYOUT_READS_WARN_KEY);
  }
  const {
    motdBody, motdTitle, siteTitle, discordInviteUrl, userDiscordId, storedLocale, localeKnown,
    maintenanceEnabled, maintenanceMessage, featureFlags, hiddenRatingSources,
  } = appLayoutStateFrom({ rows, flags, user, userReadOk: userRes.status === "fulfilled" });

  // Admins bypass maintenance mode so they can still manage settings during downtime.
  if (maintenanceEnabled && !isAdmin) {
    return <MaintenancePage message={maintenanceMessage} />;
  }

  const t = await getTranslator();
  // Which admin nav groups this browser keeps collapsed, so they render closed.
  const collapsedNavGroups = parseCollapsedGroupsCookie((await cookies()).get(ADMIN_NAV_COLLAPSED_COOKIE)?.value);
  return (
    <RatingsVisibilityProvider hidden={hiddenRatingSources}>
    {/* Wraps Header/MobileNav as well as {children}: the detail pages
        publish their title here and the breadcrumb in that chrome reads it. */}
    <DetailTitleProvider>
    {/* One notifications poll for the whole app — the desktop bell and the
        mobile badge are both mounted at every viewport and used to fetch
        independently. Must wrap Header and MobileNav, not just {children}. */}
    <NotificationStoreProvider>
    {/* One badge poll for both nav surfaces: this layout renders the first
        value, but it does not re-render on client navigation, so the provider
        re-reads the admin badge (GET /api/admin/arr-watch) while the app is open. */}
    <NavBadgesProvider initial={navBadges} enabled={isAdmin} collapsedGroups={collapsedNavGroups}>
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
        {t("shared.skipToContent")}
      </a>
      {/* Only after a successful user read: a failed one must not look like
          "never stored" and overwrite a real choice. */}
      {localeKnown && <LocaleSync stored={storedLocale} />}
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
        <main id="main-content" tabIndex={-1} className="flex-1 min-h-0 overflow-y-auto px-4 py-4 pb-safe-bottom-20 lg:px-7 lg:py-6 lg:pb-10">
          {children}
        </main>
      </div>
      {motdBody && <MotdModal title={motdTitle} body={motdBody} />}
    </div>
    </NavBadgesProvider>
    </NotificationStoreProvider>
    </DetailTitleProvider>
    </RatingsVisibilityProvider>
  );
}
