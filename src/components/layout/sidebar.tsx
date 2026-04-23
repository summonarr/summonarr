"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useSession } from "next-auth/react";
import { cn } from "@/lib/utils";
import {
  userNavItems,
  getVisibleAdminItems,
  filterNavByFeatures,
  type NavItem,
} from "@/lib/nav-items";
import type { FeatureFlags } from "@/lib/features";

export function Sidebar({
  siteTitle,
  featureFlags,
}: {
  siteTitle?: string;
  featureFlags?: FeatureFlags;
}) {
  const pathname = usePathname();
  const { data: session } = useSession();
  const role = session?.user?.role;

  const visibleUserItems = filterNavByFeatures(userNavItems, featureFlags);
  const visibleAdminItems = filterNavByFeatures(
    getVisibleAdminItems(role),
    featureFlags,
  );

  const browseItems = visibleUserItems.filter((i) => i.section === "browse");
  const personalItems = visibleUserItems.filter(
    (i) => i.section === "personal",
  );

  const isActive = (item: NavItem) =>
    item.exact ? pathname === item.href : pathname.startsWith(item.href);

  return (
    <aside
      className="hidden lg:flex h-screen sticky top-0 flex-col flex-shrink-0"
      style={{
        width: 232,
        background: "var(--ds-bg-1)",
        borderRight: "1px solid var(--ds-border)",
      }}
    >
      {/* Brand */}
      <div
        className="flex items-center gap-2.5"
        style={{
          padding: "16px 16px 14px",
          borderBottom: "1px solid var(--ds-border)",
        }}
      >
        <div
          className="ds-mono font-bold"
          style={{
            width: 26,
            height: 26,
            borderRadius: 6,
            background: "var(--ds-accent)",
            color: "var(--ds-accent-fg)",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            fontSize: 13,
            boxShadow:
              "0 0 0 1px color-mix(in oklab, var(--ds-accent) 40%, transparent), inset 0 -1px 0 rgba(0,0,0,.15)",
          }}
        >
          S
        </div>
        <span
          className="font-semibold truncate"
          style={{
            letterSpacing: "-0.01em",
            fontSize: 14,
            color: "var(--ds-fg)",
          }}
        >
          {siteTitle || "Summonarr"}
        </span>
      </div>

      {/* Nav */}
      <nav
        className="flex-1 overflow-y-auto"
        style={{ padding: "10px 8px" }}
      >
        <NavSection label="Browse">
          {browseItems.map((item) => (
            <NavLink key={item.href} item={item} active={isActive(item)} />
          ))}
        </NavSection>

        {personalItems.length > 0 && (
          <NavSection label="You">
            {personalItems.map((item) => (
              <NavLink key={item.href} item={item} active={isActive(item)} />
            ))}
          </NavSection>
        )}

        {visibleAdminItems.length > 0 && (
          <NavSection label="Admin">
            {visibleAdminItems.map((item) => (
              <NavLink key={item.href} item={item} active={isActive(item)} />
            ))}
          </NavSection>
        )}
      </nav>

      {/* Footer — TMDB attribution */}
      <div
        style={{
          padding: "10px 14px 12px",
          borderTop: "1px solid var(--ds-border)",
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
    </aside>
  );
}

function NavSection({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}) {
  return (
    <div style={{ marginBottom: 14 }}>
      <div
        className="ds-mono uppercase"
        style={{
          padding: "4px 10px 6px",
          fontSize: 10,
          color: "var(--ds-fg-subtle)",
          letterSpacing: "0.08em",
        }}
      >
        {label}
      </div>
      <div className="flex flex-col" style={{ gap: 1 }}>
        {children}
      </div>
    </div>
  );
}

function NavLink({ item, active }: { item: NavItem; active: boolean }) {
  const Icon = item.icon;
  return (
    <Link
      href={item.href}
      className={cn(
        "flex items-center gap-2.5 relative text-left w-full font-medium transition-colors",
        !active && "hover:text-[var(--ds-fg)]",
      )}
      style={{
        padding: "6px 10px",
        borderRadius: 6,
        background: active ? "var(--ds-accent-soft)" : "transparent",
        color: active ? "var(--ds-accent)" : "var(--ds-fg-muted)",
        fontSize: 13,
      }}
      onMouseEnter={(e) => {
        if (!active) {
          e.currentTarget.style.background = "var(--ds-bg-3)";
        }
      }}
      onMouseLeave={(e) => {
        if (!active) {
          e.currentTarget.style.background = "transparent";
        }
      }}
    >
      {active && (
        <span
          aria-hidden
          style={{
            position: "absolute",
            left: 0,
            top: 6,
            bottom: 6,
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
          color: active ? "var(--ds-accent)" : "inherit",
        }}
      />
      <span>{item.label}</span>
    </Link>
  );
}
