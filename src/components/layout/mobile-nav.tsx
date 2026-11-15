"use client";

import { useState, useCallback, useEffect, useRef, type CSSProperties, type ReactNode, type Ref } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { useSummonarrSession } from "@/components/auth/summonarr-session-provider";
import { Bell, Menu, Search, X } from "@/components/icons";
import { getClientBadgeVisibility } from "@/lib/badge-visibility";
import type { FeatureFlags } from "@/lib/features";
import { MobileNavDrawer } from "@/components/layout/mobile-nav-drawer";
import { useNavBadges } from "@/components/layout/admin-nav-groups";
import { PushNotifications } from "@/components/layout/push-notifications";
import { breadcrumbFor } from "@/components/layout/breadcrumb-label";
import { useT } from "@/components/i18n/i18n-provider";
import { useDetailTitle } from "@/components/layout/detail-title";
import { useNotifications } from "@/components/notifications/notification-store";
import { SearchBar } from "@/components/layout/search-bar";
import { useFocusReturn } from "@/hooks/use-focus-return";
import { buildMobileTabs, type MobileTab } from "@/components/layout/mobile-tabs";
import { visibleAdminNavItems } from "@/components/layout/nav-visibility";
import { UnreadCountBadge } from "@/components/layout/unread-badge";

// The 36×36 transparent icon control of the top bar (menu, search, close,
// inbox): one style, so the four never drift apart.
const TOP_BAR_ICON_STYLE: CSSProperties = {
  width: 36,
  height: 36,
  borderRadius: 6,
  background: "transparent",
  color: "var(--ds-fg-muted)",
  border: 0,
};
const TOP_BAR_ICON_CLASS = "ds-tap inline-flex items-center justify-center shrink-0";

// Where focus goes when the search sheet closes on Escape or its X.
const SEARCH_TRIGGER = "search-trigger";

export function MobileNav({ featureFlags }: { featureFlags?: FeatureFlags }) {
  const tr = useT();
  // The same badges as the sidebar — one NavBadgesProvider feeds both.
  const navBadges = useNavBadges();
  const pathname = usePathname();
  const { session } = useSummonarrSession();

  const [drawerOpen, setDrawerOpen] = useState(false);
  const [searchOpen, setSearchOpen] = useState(false);
  const topBarRef = useRef<HTMLDivElement>(null);
  const { returnTo, refFor } = useFocusReturn();

  const closeSearch = useCallback(() => {
    returnTo(SEARCH_TRIGGER);
    setSearchOpen(false);
  }, [returnTo]);

  // Cmd/Ctrl+K below lg: the header's SearchBar is mounted but hidden there
  // and ignores the key, so this bar opens its own search sheet instead. Once
  // the sheet is open, its SearchBar owns the shortcut. Escape closes the
  // sheet when it came from the bar itself (or from nowhere): a dialog open
  // elsewhere on the page handles its own Escape.
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      const bar = topBarRef.current;
      if (!bar || bar.offsetParent === null) return;
      if (e.key === "Escape") {
        const target = e.target instanceof Node ? e.target : null;
        if (searchOpen && (target === null || target === document.body || bar.contains(target))) closeSearch();
        return;
      }
      if (!(e.key === "k" || e.key === "K") || !(e.metaKey || e.ctrlKey)) return;
      if (searchOpen) return;
      e.preventDefault();
      setSearchOpen(true);
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [searchOpen, closeSearch]);
  const onDrawerOpenChange = useCallback(
    (open: boolean) => setDrawerOpen(open),
    [],
  );
  // The drawer covers the bar, and a page picked from it must not land with
  // the search sheet still open.
  const openDrawer = useCallback(() => {
    setSearchOpen(false);
    setDrawerOpen(true);
  }, []);

  const tabs = buildMobileTabs(visibleAdminNavItems(session?.user, featureFlags), tr);

  const detailTitle = useDetailTitle();
  const crumbs = breadcrumbFor(pathname, detailTitle, tr);
  const breadcrumbLabel = crumbs.map((c) => c.label).join(" · ");

  return (
    <>
      {/* Top bar (mobile / tablet) */}
      <div
        ref={topBarRef}
        className="lg:hidden flex items-center sticky top-0 z-30"
        style={{
          minHeight: 52,
          paddingTop: "env(safe-area-inset-top, 0px)",
          paddingLeft: 10,
          paddingRight: 10,
          gap: 8,
          background: "color-mix(in oklab, var(--ds-bg) 90%, transparent)",
          backdropFilter: "blur(14px)",
          borderBottom: "1px solid var(--ds-border)",
        }}
      >
        {searchOpen ? (
          <SearchSheet onClose={closeSearch} onAfterSelect={() => setSearchOpen(false)} />
        ) : (
          <>
            <TopBarIconButton onClick={openDrawer} label={tr("nav.openMenu")}>
              <Menu style={{ width: 18, height: 18 }} />
            </TopBarIconButton>
            <HomeCrumb label={breadcrumbLabel} />
            <TopBarIconButton
              ref={refFor(SEARCH_TRIGGER)}
              onClick={() => setSearchOpen(true)}
              label={tr("nav.search")}
            >
              <Search style={{ width: 16, height: 16 }} />
            </TopBarIconButton>
            {session && <NotificationsLink />}
            {session && <PushNotifications />}
          </>
        )}
      </div>

      <MobileTabBar
        tabs={tabs}
        pathname={pathname}
        drawerOpen={drawerOpen}
        onTab={() => setSearchOpen(false)}
        onMore={openDrawer}
      />

      <MobileNavDrawer
        open={drawerOpen}
        onOpenChange={onDrawerOpenChange}
        featureFlags={featureFlags}
        navBadges={navBadges}
      />
    </>
  );
}

function TopBarIconButton({
  label,
  onClick,
  children,
  ref,
}: {
  label: string;
  onClick: () => void;
  children: ReactNode;
  ref?: Ref<HTMLButtonElement>;
}) {
  return (
    <button
      ref={ref}
      type="button"
      onClick={onClick}
      aria-label={label}
      className={TOP_BAR_ICON_CLASS}
      style={TOP_BAR_ICON_STYLE}
    >
      {children}
    </button>
  );
}

// The search mode of the top bar: a close control and the full-width search.
function SearchSheet({ onClose, onAfterSelect }: { onClose: () => void; onAfterSelect: () => void }) {
  const tr = useT();
  const { session } = useSummonarrSession();
  // The same Plex/Jellyfin badge rule the Header and server pages use, so every
  // surface agrees on which badges this user sees.
  const { showPlex, showJellyfin } = getClientBadgeVisibility(session?.user);
  return (
    <>
      <TopBarIconButton onClick={onClose} label={tr("nav.closeSearch")}>
        <X style={{ width: 16, height: 16 }} />
      </TopBarIconButton>
      <SearchBar
        showPlex={showPlex}
        showJellyfin={showJellyfin}
        variant="full"
        autoFocus
        onAfterSelect={onAfterSelect}
      />
    </>
  );
}

// The brand glyph and the current page's breadcrumb, linking home. The link is
// named for where it goes: its visible text is the CURRENT page, and reading
// "Movies · Dune" for a link to Discover told a screen-reader user the wrong
// destination.
function HomeCrumb({ label }: { label: string }) {
  const tr = useT();
  return (
    <Link
      href="/"
      aria-label={tr("nav.discover")}
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
        {label}
      </span>
    </Link>
  );
}

const TAB_STYLE: CSSProperties = {
  gap: 3,
  padding: "6px 4px",
  borderRadius: 8,
  minHeight: 48,
};
const TAB_TRANSITION = "color 140ms var(--ds-ease), background 140ms var(--ds-ease)";
const TAB_LABEL_STYLE: CSSProperties = { fontSize: 10.5, letterSpacing: "-0.005em" };

// The bottom tab bar: the four tabs, then "More" (the drawer), which takes the
// accent while the drawer is open or no tab claims the current page.
function MobileTabBar({
  tabs,
  pathname,
  drawerOpen,
  onTab,
  onMore,
}: {
  tabs: MobileTab[];
  pathname: string;
  drawerOpen: boolean;
  onTab: () => void;
  onMore: () => void;
}) {
  const tr = useT();
  const someTabActive = tabs.some((t) => t.match(pathname));
  return (
    <nav
      className="lg:hidden flex fixed inset-x-0 bottom-0 z-40"
      style={{
        padding: "6px 8px calc(6px + env(safe-area-inset-bottom, 0px))",
        background: "color-mix(in oklab, var(--ds-bg-1) 92%, transparent)",
        backdropFilter: "blur(16px)",
        borderTop: "1px solid var(--ds-border)",
        minHeight: 64,
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
              onClick={onTab}
              aria-current={active ? "page" : undefined}
              className="ds-tap flex flex-col items-center justify-center"
              style={{
                ...TAB_STYLE,
                color: active ? "var(--ds-accent-text)" : "var(--ds-fg-muted)",
                transition: TAB_TRANSITION,
              }}
            >
              <t.icon style={{ width: 18, height: 18 }} />
              <span className="font-medium" style={TAB_LABEL_STYLE}>
                {t.label}
              </span>
            </Link>
          );
        })}
        <button
          type="button"
          onClick={onMore}
          aria-label={tr("nav.more")}
          aria-haspopup="dialog"
          aria-expanded={drawerOpen}
          className="ds-tap flex flex-col items-center justify-center"
          style={{
            gap: TAB_STYLE.gap,
            padding: TAB_STYLE.padding,
            border: 0,
            background: "transparent",
            borderRadius: TAB_STYLE.borderRadius,
            minHeight: TAB_STYLE.minHeight,
            color:
              drawerOpen || !someTabActive
                ? "var(--ds-accent-text)"
                : "var(--ds-fg-muted)",
            transition: TAB_TRANSITION,
          }}
        >
          <Menu style={{ width: 18, height: 18 }} />
          <span className="font-medium" style={TAB_LABEL_STYLE}>
            {tr("nav.more")}
          </span>
        </button>
      </div>
    </nav>
  );
}

// Top-bar link to the notification inbox for mobile/tablet, where the desktop
// header bell is hidden. The unread count comes from the shared
// NotificationStoreProvider instead of its own fetch: this link and the
// desktop bell are both mounted at every screen size (CSS hides one), so
// separate fetches would request /api/notifications twice per page.
function NotificationsLink() {
  const { unread } = useNotifications();
  const t = useT();

  return (
    <Link
      href="/notifications"
      aria-label={unread > 0 ? t("nav.notificationsUnread", { count: unread }) : t("nav.crumb.notifications")}
      className={`${TOP_BAR_ICON_CLASS} relative`}
      style={TOP_BAR_ICON_STYLE}
    >
      <Bell style={{ width: 16, height: 16 }} />
      <UnreadCountBadge count={unread} size="sm" />
    </Link>
  );
}
