"use client";

import { useState, useCallback } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { useSession } from "next-auth/react";
import {
  LayoutDashboard,
  Film,
  ClipboardList,
  UserCircle,
  ShieldCheck,
  AlertTriangle,
  Menu,
  Search,
  X,
  type LucideIcon,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { filterNavByFeatures, userNavItems } from "@/lib/nav-items";
import type { FeatureFlags } from "@/lib/features";
import { MobileNavDrawer } from "@/components/layout/mobile-nav-drawer";
import { PushNotifications } from "@/components/layout/push-notifications";
import { breadcrumbFor } from "@/components/layout/breadcrumb-label";
import { SearchBar } from "@/components/layout/header";

type Tab = {
  href: string;
  label: string;
  icon: LucideIcon;
  match: (pathname: string) => boolean;
};

export function MobileNav({ featureFlags }: { featureFlags?: FeatureFlags }) {
  const pathname = usePathname();
  const { data: session } = useSession();
  const role = session?.user?.role;
  const provider = session?.user?.provider;
  const showPlex =
    role === "ADMIN" || role === "ISSUE_ADMIN" || provider === "plex";
  const showJellyfin =
    role === "ADMIN" ||
    role === "ISSUE_ADMIN" ||
    provider === "jellyfin" ||
    provider === "jellyfin-quickconnect";

  const [drawerOpen, setDrawerOpen] = useState(false);
  const [searchOpen, setSearchOpen] = useState(false);
  const onDrawerOpenChange = useCallback(
    (open: boolean) => setDrawerOpen(open),
    [],
  );

  const tabs = buildTabs(
    role,
    filterNavByFeatures(userNavItems, featureFlags),
  );
  const someTabActive = tabs.some((t) => t.match(pathname));

  const crumbs = breadcrumbFor(pathname);
  const breadcrumbLabel = crumbs.map((c) => c.label).join(" · ");

  return (
    <>
      {/* Top bar (mobile / tablet) */}
      <div
        className="lg:hidden flex items-center sticky top-0 z-30"
        style={{
          height: 52,
          padding: "0 10px",
          gap: 8,
          background: "color-mix(in oklab, var(--ds-bg) 90%, transparent)",
          backdropFilter: "blur(14px)",
          borderBottom: "1px solid var(--ds-border)",
        }}
      >
        {searchOpen ? (
          <>
            <button
              type="button"
              onClick={() => setSearchOpen(false)}
              className="ds-tap inline-flex items-center justify-center shrink-0"
              aria-label="Close search"
              style={{
                width: 32,
                height: 32,
                borderRadius: 6,
                background: "transparent",
                color: "var(--ds-fg-muted)",
                border: "0",
              }}
            >
              <X style={{ width: 16, height: 16 }} />
            </button>
            <SearchBar
              showPlex={showPlex}
              showJellyfin={showJellyfin}
              variant="full"
              autoFocus
              onAfterSelect={() => setSearchOpen(false)}
            />
          </>
        ) : (
          <>
            <button
              type="button"
              onClick={() => setDrawerOpen(true)}
              aria-label="Open menu"
              className="ds-tap inline-flex items-center justify-center shrink-0"
              style={{
                width: 32,
                height: 32,
                borderRadius: 6,
                background: "transparent",
                color: "var(--ds-fg-muted)",
                border: 0,
              }}
            >
              <Menu style={{ width: 18, height: 18 }} />
            </button>
            <Link
              href="/"
              className="flex-1 min-w-0 flex items-center"
              style={{ gap: 8 }}
            >
              <div
                className="ds-mono font-bold shrink-0"
                style={{
                  width: 22,
                  height: 22,
                  borderRadius: 5,
                  background: "var(--ds-accent)",
                  color: "var(--ds-accent-fg)",
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "center",
                  fontSize: 11,
                }}
              >
                S
              </div>
              <span
                className="font-semibold truncate"
                style={{
                  fontSize: 14,
                  letterSpacing: "-0.01em",
                  color: "var(--ds-fg)",
                }}
              >
                {breadcrumbLabel}
              </span>
            </Link>
            <button
              type="button"
              onClick={() => setSearchOpen(true)}
              aria-label="Search"
              className="ds-tap inline-flex items-center justify-center shrink-0"
              style={{
                width: 32,
                height: 32,
                borderRadius: 6,
                background: "transparent",
                color: "var(--ds-fg-muted)",
                border: 0,
              }}
            >
              <Search style={{ width: 16, height: 16 }} />
            </button>
            {session && <PushNotifications />}
          </>
        )}
      </div>

      {/* Bottom tab bar */}
      <nav
        className="lg:hidden flex fixed inset-x-0 bottom-0 z-40"
        style={{
          padding: "6px 8px calc(6px + env(safe-area-inset-bottom, 0px))",
          background: "color-mix(in oklab, var(--ds-bg-1) 92%, transparent)",
          backdropFilter: "blur(16px)",
          borderTop: "1px solid var(--ds-border)",
          height: 64,
        }}
      >
        <div
          className="grid w-full mx-auto"
          style={{
            gridTemplateColumns: `repeat(${tabs.length + 1}, 1fr)`,
            gap: 4,
            maxWidth: 520,
          }}
        >
          {tabs.map((t) => {
            const active = t.match(pathname);
            return (
              <Link
                key={t.href}
                href={t.href}
                onClick={() => setSearchOpen(false)}
                className="ds-tap flex flex-col items-center justify-center"
                style={{
                  gap: 3,
                  padding: "6px 4px",
                  borderRadius: 8,
                  minHeight: 48,
                  color: active ? "var(--ds-accent)" : "var(--ds-fg-subtle)",
                  transition:
                    "color 140ms var(--ds-ease), background 140ms var(--ds-ease)",
                }}
                aria-label={t.label}
              >
                <t.icon style={{ width: 18, height: 18 }} />
                <span
                  className="font-medium"
                  style={{ fontSize: 10.5, letterSpacing: "-0.005em" }}
                >
                  {t.label}
                </span>
              </Link>
            );
          })}
          <button
            type="button"
            onClick={() => setDrawerOpen(true)}
            aria-label="More"
            aria-haspopup="dialog"
            aria-expanded={drawerOpen}
            className={cn(
              "ds-tap flex flex-col items-center justify-center",
            )}
            style={{
              gap: 3,
              padding: "6px 4px",
              border: 0,
              background: "transparent",
              borderRadius: 8,
              minHeight: 48,
              color:
                drawerOpen || !someTabActive
                  ? "var(--ds-accent)"
                  : "var(--ds-fg-subtle)",
              transition:
                "color 140ms var(--ds-ease), background 140ms var(--ds-ease)",
            }}
          >
            <Menu style={{ width: 18, height: 18 }} />
            <span
              className="font-medium"
              style={{ fontSize: 10.5, letterSpacing: "-0.005em" }}
            >
              More
            </span>
          </button>
        </div>
      </nav>

      <MobileNavDrawer
        open={drawerOpen}
        onOpenChange={onDrawerOpenChange}
        featureFlags={featureFlags}
      />
    </>
  );
}

function buildTabs(role: string | undefined, userItems: readonly { href: string }[]): Tab[] {
  const has = (href: string) => userItems.some((i) => i.href === href);

  const browseHref = has("/movies")
    ? "/movies"
    : has("/tv")
      ? "/tv"
      : "/popular";

  const discover: Tab = {
    href: "/",
    label: "Discover",
    icon: LayoutDashboard,
    match: (p) => p === "/",
  };
  const browse: Tab = {
    href: browseHref,
    label: "Browse",
    icon: Film,
    match: (p) =>
      p === "/movies" ||
      p === "/tv" ||
      p === "/top" ||
      p === "/popular" ||
      p === "/upcoming" ||
      p.startsWith("/movie/") ||
      p.startsWith("/tv/"),
  };
  const requests: Tab = {
    href: "/requests",
    label: "Requests",
    icon: ClipboardList,
    match: (p) =>
      p === "/requests" || p === "/issues" || p === "/votes",
  };

  if (role === "ADMIN") {
    const admin: Tab = {
      href: "/admin",
      label: "Admin",
      icon: ShieldCheck,
      match: (p) => p.startsWith("/admin") || p === "/settings",
    };
    return [discover, browse, requests, admin];
  }

  if (role === "ISSUE_ADMIN") {
    const issues: Tab = {
      href: "/admin/issues",
      label: "Issues",
      icon: AlertTriangle,
      match: (p) => p.startsWith("/admin/issues"),
    };
    return [discover, browse, requests, issues];
  }

  const profile: Tab = {
    href: "/profile",
    label: "Profile",
    icon: UserCircle,
    match: (p) => p === "/profile" || p === "/donate",
  };
  return [discover, browse, requests, profile];
}
