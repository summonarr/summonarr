"use client";

import { useEffect, useRef, type CSSProperties, type ReactNode } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { useSummonarrSession } from "@/components/auth/summonarr-session-provider";
import { LogOut, Bell, GitFork } from "@/components/icons";
import { signOutAndRedirect } from "@/components/auth/sign-out";
import {
  userNavItems,
  filterNavByFeatures,
  navItemLabel,
  navItemHref,
  isNavItemActive,
  type NavItem,
} from "@/lib/nav-items";
import { useT } from "@/components/i18n/i18n-provider";
import type { FeatureFlags } from "@/lib/features";
import { PushNotifications } from "@/components/layout/push-notifications";
import { AppearanceMenu } from "@/components/theme/appearance-menu";
import { withBasePath } from "@/lib/base-path";
import { AdminNavGroupList, NavCountBadge, type NavBadges } from "@/components/layout/admin-nav-groups";
import { visibleAdminNavItems } from "@/components/layout/nav-visibility";
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
  navBadges?: NavBadges;
}

export function MobileNavDrawer({
  open,
  onOpenChange,
  featureFlags,
  navBadges,
}: MobileNavDrawerProps) {
  const t = useT();
  const pathname = usePathname();
  const { session } = useSummonarrSession();
  const adminItems = visibleAdminNavItems(session?.user, featureFlags);

  const browseItems = filterNavByFeatures(
    userNavItems.filter((i) => i.section === "browse"),
    featureFlags,
  );
  const personalItems = filterNavByFeatures(
    userNavItems.filter((i) => i.section === "personal"),
    featureFlags,
  );

  // A navigation closes the drawer. Keyed on the pathname ALONE: the
  // callback rides a ref, so a caller passing an inline arrow can't close the
  // drawer on every re-render (the one that opens it included).
  const onOpenChangeRef = useRef(onOpenChange);
  useEffect(() => {
    onOpenChangeRef.current = onOpenChange;
  });
  const shownPath = useRef(pathname);
  useEffect(() => {
    if (shownPath.current === pathname) return;
    shownPath.current = pathname;
    onOpenChangeRef.current(false);
  }, [pathname]);

  // One matcher for every nav surface (nav-items.ts) — this drawer used to
  // carry its own copy that knew about the singular /movie/ detail route while
  // the sidebar's did not.
  const isActive = (item: NavItem) => isNavItemActive(pathname, item);

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
          <DrawerTitle>{t("nav.menu")}</DrawerTitle>
          <DrawerContent>
            <SectionHeader>{t("nav.section.browse")}</SectionHeader>
            {browseItems.map((item) => (
              <NavLink
                key={item.href}
                item={item}
                active={isActive(item)}
                onClick={() => onOpenChange(false)}
              />
            ))}

            {personalItems.length > 0 && (
              <>
                <SectionHeader>{t("nav.section.you")}</SectionHeader>
                {personalItems.map((item) => (
                  <NavLink
                    key={item.href}
                    item={item}
                    active={isActive(item)}
                    onClick={() => onOpenChange(false)}
                  />
                ))}
              </>
            )}

            {adminItems.length > 0 && (
              <>
                <SectionHeader>{t("nav.section.admin")}</SectionHeader>
                <AdminNavGroupList
                  variant="drawer"
                  items={adminItems}
                  isActive={isActive}
                  badges={navBadges}
                  renderItem={(item) => (
                    <NavLink
                      key={item.href}
                      item={item}
                      active={isActive(item)}
                      badge={navBadges?.[item.href]}
                      onClick={() => onOpenChange(false)}
                    />
                  )}
                />
              </>
            )}

            <DrawerAccountActions />
            <DrawerCredits />
            {/* No trailing spacer: DrawerContent already pads its bottom by
                max(1.5rem, safe-area-inset-bottom), and the drawer (z-50)
                overlays the bottom tab bar (z-40) rather than sitting above it. */}
          </DrawerContent>
        </DrawerPopup>
      </DrawerPortal>
    </Drawer>
  );
}

// The drawer's fixed styles, built once.
const ACCOUNT_STYLE: CSSProperties = {
  marginTop: 16,
  paddingTop: 16,
  borderTop: "1px solid var(--ds-border)",
  display: "flex",
  flexDirection: "column",
  gap: 4,
};
const CREDITS_STYLE: CSSProperties = {
  marginTop: 16,
  paddingTop: 14,
  borderTop: "1px solid var(--ds-border)",
  display: "flex",
  flexDirection: "column",
  alignItems: "center",
  gap: 10,
};
const CREDIT_TEXT_STYLE: CSSProperties = { fontSize: 10 };

// Push notifications, the appearance picker and Sign out.
function DrawerAccountActions() {
  const t = useT();
  return (
    <div style={ACCOUNT_STYLE}>
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
          {t("nav.pushNotifications")}
        </span>
        <PushNotifications />
      </div>
      {/* standalone: the drawer is a Drawer, not a base-ui Menu — the
          menuitemradio form throws "MenuRootContext is missing". */}
      <AppearanceMenu standalone />
      <button
        type="button"
        onClick={() => signOutAndRedirect("/login")}
        className="ds-hover-tint flex items-center gap-3 w-full font-medium transition-colors"
        style={{
          padding: "10px 12px",
          borderRadius: 6,
          background: "transparent",
          border: 0,
          fontSize: 13,
          color: "var(--ds-danger)",
        }}
      >
        <LogOut style={{ width: 16, height: 16 }} />
        {t("nav.signOut")}
      </button>
    </div>
  );
}

function CreditLink({ href, title, icon, children }: { href: string; title: string; icon: ReactNode; children: ReactNode }) {
  return (
    <a
      href={href}
      target="_blank"
      rel="noopener noreferrer"
      title={title}
      className="flex items-center gap-2 text-[var(--ds-fg-subtle)] hover:text-[var(--ds-fg-muted)] transition-colors"
    >
      {icon}
      <span className="ds-mono" style={CREDIT_TEXT_STYLE}>
        {children}
      </span>
    </a>
  );
}

// The source and TMDB credits.
function DrawerCredits() {
  const t = useT();
  return (
    <div style={CREDITS_STYLE}>
      <CreditLink
        href="https://github.com/Summonarr/Summonarr"
        title={t("nav.footer.sourceTitle")}
        icon={<GitFork className="h-3 w-3 shrink-0" />}
      >
        {t("nav.footer.fork")}
      </CreditLink>
      <CreditLink
        href="https://www.themoviedb.org"
        title={t("nav.footer.tmdbTitle")}
        // eslint-disable-next-line @next/next/no-img-element
        icon={<img src={withBasePath("/tmdb-logo.svg")} alt="TMDB" className="h-3 w-auto" />}
      >
        {t("nav.footer.tmdb")}
      </CreditLink>
    </div>
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
  badge,
  onClick,
}: {
  item: NavItem;
  active: boolean;
  badge?: number;
  onClick: () => void;
}) {
  const Icon = item.icon;
  const t = useT();
  return (
    <Link
      href={navItemHref(item, badge)}
      onClick={onClick}
      aria-current={active ? "page" : undefined}
      className="ds-hover-tint flex items-center gap-3 font-medium transition-colors relative"
      style={{
        padding: "10px 12px",
        borderRadius: 6,
        background: active ? "var(--ds-accent-soft)" : "transparent",
        // Inactive text is fg-muted, matching the sidebar and bottom tabs.
        color: active ? "var(--ds-accent-text)" : "var(--ds-fg-muted)",
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
          width: 16,
          height: 16,
          color: active ? "var(--ds-accent-text)" : "var(--ds-fg-muted)",
        }}
      />
      {navItemLabel(item, t)}
      <NavCountBadge count={badge} href={item.href} />
    </Link>
  );
}
