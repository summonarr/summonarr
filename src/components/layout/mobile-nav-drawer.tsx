"use client";

import { useEffect } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { useSession, signOut } from "next-auth/react";
import { LogOut, Bell, type LucideIcon } from "lucide-react";
import {
  userNavItems,
  getVisibleAdminItems,
  filterNavByFeatures,
  type NavItem,
} from "@/lib/nav-items";
import type { FeatureFlags } from "@/lib/features";
import { PushNotifications } from "@/components/layout/push-notifications";
import {
  Drawer,
  DrawerPortal,
  DrawerBackdrop,
  DrawerPopup,
  DrawerContent,
  DrawerTitle,
} from "@/components/ui/drawer";

interface MobileNavDrawerProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  featureFlags?: FeatureFlags;
}

export function MobileNavDrawer({
  open,
  onOpenChange,
  featureFlags,
}: MobileNavDrawerProps) {
  const pathname = usePathname();
  const { data: session } = useSession();
  const role = session?.user?.role;
  const adminItems = filterNavByFeatures(
    getVisibleAdminItems(role),
    featureFlags,
  );

  const browseItems = filterNavByFeatures(
    userNavItems.filter((i) => i.section === "browse"),
    featureFlags,
  );
  const personalItems = filterNavByFeatures(
    userNavItems.filter((i) => i.section === "personal"),
    featureFlags,
  );

  useEffect(() => {
    onOpenChange(false);
  }, [pathname, onOpenChange]);

  function isActive(href: string, exact?: boolean) {
    return exact ? pathname === href : pathname.startsWith(href);
  }

  return (
    <Drawer open={open} onOpenChange={onOpenChange}>
      <DrawerPortal>
        <DrawerBackdrop />
        <DrawerPopup
          style={{
            background: "var(--ds-bg-1)",
            borderTop: "1px solid var(--ds-border)",
          }}
        >
          <DrawerTitle>Navigation menu</DrawerTitle>
          <DrawerContent>
            <SectionHeader>Browse</SectionHeader>
            {browseItems.map((item) => (
              <NavLink
                key={item.href}
                item={item}
                active={isActive(item.href, item.exact)}
                onClick={() => onOpenChange(false)}
              />
            ))}

            {personalItems.length > 0 && (
              <>
                <SectionHeader>You</SectionHeader>
                {personalItems.map((item) => (
                  <NavLink
                    key={item.href}
                    item={item}
                    active={isActive(item.href, item.exact)}
                    onClick={() => onOpenChange(false)}
                  />
                ))}
              </>
            )}

            {adminItems.length > 0 && (
              <>
                <SectionHeader>Admin</SectionHeader>
                {adminItems.map((item) => (
                  <NavLink
                    key={item.href}
                    item={item}
                    active={isActive(item.href, item.exact)}
                    onClick={() => onOpenChange(false)}
                  />
                ))}
              </>
            )}

            <div
              style={{
                marginTop: 16,
                paddingTop: 16,
                borderTop: "1px solid var(--ds-border)",
                display: "flex",
                flexDirection: "column",
                gap: 4,
              }}
            >
              <div
                className="flex items-center gap-3"
                style={{
                  padding: "10px 12px",
                }}
              >
                <Bell
                  className="shrink-0"
                  style={{
                    width: 18,
                    height: 18,
                    color: "var(--ds-fg-muted)",
                  }}
                />
                <span
                  className="font-medium flex-1"
                  style={{ fontSize: 13, color: "var(--ds-fg)" }}
                >
                  Push notifications
                </span>
                <PushNotifications />
              </div>
              <button
                type="button"
                onClick={() => signOut({ callbackUrl: "/login" })}
                className="flex items-center gap-3 w-full font-medium transition-colors"
                style={{
                  padding: "10px 12px",
                  borderRadius: 6,
                  background: "transparent",
                  border: 0,
                  fontSize: 13,
                  color: "var(--ds-danger)",
                }}
                onMouseEnter={(e) => {
                  e.currentTarget.style.background =
                    "color-mix(in oklab, var(--ds-danger) 10%, transparent)";
                }}
                onMouseLeave={(e) => {
                  e.currentTarget.style.background = "transparent";
                }}
              >
                <LogOut style={{ width: 18, height: 18 }} />
                Sign out
              </button>
            </div>

            <div
              style={{
                marginTop: 16,
                paddingTop: 14,
                borderTop: "1px solid var(--ds-border)",
                display: "flex",
                justifyContent: "center",
              }}
            >
              <a
                href="https://www.themoviedb.org"
                target="_blank"
                rel="noopener noreferrer"
                title="This product uses the TMDB API but is not endorsed or certified by TMDB."
                className="flex items-center gap-2 opacity-50 hover:opacity-80 transition-opacity"
              >
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img src="/tmdb-logo.svg" alt="TMDB" className="h-3 w-auto" />
                <span
                  className="ds-mono"
                  style={{ fontSize: 10, color: "var(--ds-fg-subtle)" }}
                >
                  Data via TMDB
                </span>
              </a>
            </div>

            <div style={{ height: 80 }} aria-hidden />
          </DrawerContent>
        </DrawerPopup>
      </DrawerPortal>
    </Drawer>
  );
}

function SectionHeader({ children }: { children: React.ReactNode }) {
  return (
    <p
      className="ds-mono uppercase"
      style={{
        padding: "14px 12px 6px",
        fontSize: 10,
        fontWeight: 600,
        color: "var(--ds-fg-subtle)",
        letterSpacing: "0.08em",
      }}
    >
      {children}
    </p>
  );
}

function NavLink({
  item,
  active,
  onClick,
}: {
  item: NavItem;
  active: boolean;
  onClick: () => void;
}) {
  const Icon = item.icon as LucideIcon;
  return (
    <Link
      href={item.href}
      onClick={onClick}
      className="flex items-center gap-3 font-medium transition-colors relative"
      style={{
        padding: "10px 12px",
        borderRadius: 6,
        background: active ? "var(--ds-accent-soft)" : "transparent",
        color: active ? "var(--ds-accent)" : "var(--ds-fg)",
        fontSize: 13,
      }}
    >
      {active && (
        <span
          aria-hidden
          style={{
            position: "absolute",
            left: 0,
            top: 8,
            bottom: 8,
            width: 2,
            background: "var(--ds-accent)",
            borderRadius: 2,
          }}
        />
      )}
      <Icon
        className="shrink-0"
        style={{
          width: 18,
          height: 18,
          color: active ? "var(--ds-accent)" : "var(--ds-fg-muted)",
        }}
      />
      {item.label}
    </Link>
  );
}
