"use client";

import { createContext, useContext, useEffect, useState, type ReactNode } from "react";
import { ChevronDown } from "@/components/icons";
import {
  ADMIN_NAV_GROUPS,
  NAV_BADGE_LABEL_KEYS,
  groupAdminNavItems,
  type AdminNavGroup,
  type NavItem,
} from "@/lib/nav-items";
import { withBasePath } from "@/lib/base-path";
import { NAV_BADGE_MIN_REFETCH_MS, NAV_BADGE_POLL_MS, parseNavBadges } from "@/lib/nav-badges";
import { useT } from "@/components/i18n/i18n-provider";

// The admin nav's groups (Requests, Downloads, Library, Insights, System) for
// both the desktop sidebar and the mobile drawer: a collapsible header per
// group, and the count badge a nav item can carry (the Download Queue's
// downloads needing attention). Collapsed groups are remembered per browser.
// The badges come from ONE NavBadgesProvider in the (app) layout.

const STORAGE_KEY = "summonarr:nav:collapsedAdminGroups";
// Same-document sync: the sidebar is always mounted (CSS-hidden below lg) and
// the drawer mounts on open, so two instances share STORAGE_KEY. The `storage`
// event only reaches OTHER documents, so a write here announces itself with
// this event and every mounted instance re-reads — otherwise the sidebar's
// stale set overwrote the drawer's choice on its next toggle.
const SYNC_EVENT = "summonarr:nav:collapsedAdminGroups";
const GROUP_IDS: ReadonlySet<string> = new Set(ADMIN_NAV_GROUPS.map((g) => g.id));

export type NavBadges = Readonly<Record<string, number>>;

const NavBadgesContext = createContext<NavBadges | undefined>(undefined);

/** The admin nav's badges (href → count). Undefined ⇒ none. */
export function useNavBadges(): NavBadges | undefined {
  return useContext(NavBadgesContext);
}

/**
 * ONE badge poll for both nav surfaces — the sidebar and the mobile nav are
 * both mounted at every viewport (CSS hides one), so a poll in each would read
 * twice (the NotificationStoreProvider's lesson). The layout renders `initial`,
 * but layouts do not re-render on client navigation: without this the badge
 * froze at the last full load, and a stopped monitor's count never aged out.
 * While `enabled` (an admin) it re-reads GET /api/admin/arr-watch every
 * NAV_BADGE_POLL_MS, skipped in a hidden tab, and when the tab comes back. A
 * failed read keeps what is shown (fails open). Nothing is read during render
 * (guardrail 16) and the first render is the server's value.
 */
export function NavBadgesProvider({
  initial,
  enabled,
  children,
}: {
  initial: NavBadges | undefined;
  enabled: boolean;
  children: ReactNode;
}) {
  const [badges, setBadges] = useState<NavBadges | undefined>(initial);
  // A fresh server render (router.refresh, a hard load) is the newer value.
  const [renderedInitial, setRenderedInitial] = useState(initial);
  if (renderedInitial !== initial) {
    setRenderedInitial(initial);
    setBadges(initial);
  }

  useEffect(() => {
    if (!enabled) return;
    let cancelled = false;
    let lastRead = Date.now();
    async function reload() {
      lastRead = Date.now();
      try {
        const res = await fetch(withBasePath("/api/admin/arr-watch"), { credentials: "include" });
        if (!res.ok) return;
        const next = parseNavBadges(((await res.json()) as { navBadges?: unknown } | null)?.navBadges);
        if (!cancelled && next !== null) setBadges(Object.keys(next).length > 0 ? next : undefined);
      } catch {
        // best-effort — the badge already shown stays
      }
    }
    const timer = setInterval(() => {
      if (document.visibilityState === "hidden") return;
      void reload();
    }, NAV_BADGE_POLL_MS);
    function onVisibility() {
      if (document.visibilityState === "visible" && Date.now() - lastRead >= NAV_BADGE_MIN_REFETCH_MS) void reload();
    }
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      cancelled = true;
      clearInterval(timer);
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, [enabled]);

  return <NavBadgesContext.Provider value={badges}>{children}</NavBadgesContext.Provider>;
}

/** The stored collapsed set, or null when there is none or storage can't be read. */
function readStoredCollapsed(): Set<AdminNavGroup> | null {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    const ids: unknown = raw ? JSON.parse(raw) : null;
    return Array.isArray(ids) ? new Set(ids.filter((x): x is AdminNavGroup => typeof x === "string" && GROUP_IDS.has(x))) : null;
  } catch {
    return null;
  }
}

function useCollapsedAdminGroups(): { collapsed: ReadonlySet<AdminNavGroup>; toggle: (id: AdminNavGroup) => void } {
  const [collapsed, setCollapsed] = useState<ReadonlySet<AdminNavGroup>>(() => new Set());
  // Read after mount so the first render matches the server's (every group
  // open), and again whenever another instance (or tab) writes. Storage can
  // throw (blocked site data, some private windows) — then every group simply
  // stays open.
  useEffect(() => {
    const apply = () => {
      const stored = readStoredCollapsed();
      if (stored) setCollapsed(stored);
    };
    apply();
    window.addEventListener(SYNC_EVENT, apply);
    window.addEventListener("storage", apply);
    return () => {
      window.removeEventListener(SYNC_EVENT, apply);
      window.removeEventListener("storage", apply);
    };
  }, []);
  function toggle(id: AdminNavGroup) {
    // From what is STORED, not this instance's copy, which another may have outdated.
    const next = new Set(readStoredCollapsed() ?? collapsed);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    setCollapsed(next);
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify([...next]));
      window.dispatchEvent(new Event(SYNC_EVENT));
    } catch {}
  }
  return { collapsed, toggle };
}

/** A count pill beside a nav item (or a collapsed group's header). Nothing for zero. */
export function NavCountBadge({ count, href }: { count: number | undefined; href?: string }) {
  const t = useT();
  if (!count || count <= 0) return null;
  const labelKey = href ? NAV_BADGE_LABEL_KEYS[href] : undefined;
  const label = labelKey ? t(labelKey, { count }) : String(count);
  return (
    <span
      title={label}
      // A tinted warning chip (guardrail 42): the 500 tint under the remapped
      // 400 text, which is tuned to read on it in both themes.
      className="ds-mono ml-auto shrink-0 rounded-full bg-amber-500/20 text-amber-400 text-center"
      style={{ fontSize: 10, fontWeight: 600, lineHeight: "16px", minWidth: 18, padding: "0 5px" }}
    >
      <span aria-hidden>{count > 99 ? "99+" : count}</span>
      <span className="sr-only">{label}</span>
    </span>
  );
}

/**
 * The admin items (already filtered for this viewer) under their group
 * headers. A collapsed group still lists the page you are on, and its header
 * carries the badges of the items it hides, so collapsing never hides where
 * you are or what needs you.
 */
export function AdminNavGroupList({
  items,
  isActive,
  renderItem,
  badges,
  variant,
}: {
  items: readonly NavItem[];
  isActive: (item: NavItem) => boolean;
  renderItem: (item: NavItem) => React.ReactNode;
  badges?: NavBadges;
  variant: "sidebar" | "drawer";
}) {
  const t = useT();
  const { collapsed, toggle } = useCollapsedAdminGroups();
  const drawer = variant === "drawer";
  return (
    <>
      {groupAdminNavItems(items).map((g, i) => {
        const isCollapsed = collapsed.has(g.id);
        const shown = isCollapsed ? g.items.filter(isActive) : g.items;
        const hiddenBadged = isCollapsed ? g.items.filter((item) => !shown.includes(item) && (badges?.[item.href] ?? 0) > 0) : [];
        const hiddenBadges = hiddenBadged.reduce((n, item) => n + (badges?.[item.href] ?? 0), 0);
        const listId = `admin-nav-${variant}-${g.id}`;
        return (
          <div key={g.id} className="flex flex-col" style={{ gap: drawer ? 0 : 1, marginTop: i === 0 ? 0 : drawer ? 4 : 6 }}>
            <button
              type="button"
              aria-expanded={!isCollapsed}
              aria-controls={listId}
              onClick={() => toggle(g.id)}
              className="ds-hover-tint flex items-center gap-1.5 w-full text-left font-medium transition-colors text-[var(--ds-fg-subtle)] hover:text-[var(--ds-fg-muted)]"
              style={{
                // The drawer is touched: the same height as its links.
                padding: drawer ? "10px 12px" : "4px 10px",
                borderRadius: 6,
                background: "transparent",
                border: 0,
                fontSize: drawer ? 12 : 11,
              }}
            >
              <ChevronDown
                aria-hidden
                className="shrink-0 transition-transform"
                style={{ width: 12, height: 12, transform: isCollapsed ? "rotate(-90deg)" : undefined }}
              />
              <span>{t(g.i18nKey)}</span>
              {hiddenBadges > 0 && <NavCountBadge count={hiddenBadges} href={hiddenBadged[0].href} />}
            </button>
            <div id={listId} className="flex flex-col" style={{ gap: drawer ? 0 : 1 }}>
              {shown.map((item) => renderItem(item))}
            </div>
          </div>
        );
      })}
    </>
  );
}
