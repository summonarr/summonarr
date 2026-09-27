"use client";

import Link from "next/link";

const TABS = [
  { id: "site",          label: "Site" },
  { id: "media",         label: "Media" },
  { id: "notifications", label: "Notifications" },
  { id: "integrations",  label: "Integrations" },
  { id: "features",      label: "Features" },
  { id: "system",        label: "System" },
] as const;

export type TabId = typeof TABS[number]["id"];

// Top-level settings tab bar; each tab links to /settings?tab=<id>.
export function SettingsTabNav({ activeTab }: { activeTab: TabId }) {
  return (
    // Wraps onto a second line on narrow screens. A sideways-scrolling row
    // hid the last tab ("System") with no hint that it could scroll.
    <nav
      aria-label="Settings sections"
      className="flex flex-wrap gap-1 max-w-full"
      style={{
        padding: 2,
        background: "var(--ds-bg-1)",
        border: "1px solid var(--ds-border)",
        borderRadius: 8,
      }}
    >
      {TABS.map(({ id, label }) => {
        const active = activeTab === id;
        return (
          <Link
            key={id}
            href={`/settings?tab=${id}`}
            aria-current={active ? "page" : undefined}
            // min-h-9 (36px) keeps each tab a comfortable tap target on
            // phones, where the bar wraps into two tightly packed rows.
            className="inline-flex items-center min-h-9 whitespace-nowrap font-medium transition-colors"
            style={{
              padding: "5px 14px",
              borderRadius: 6,
              fontSize: 12,
              background: active ? "var(--ds-bg-3)" : "transparent",
              color: active ? "var(--ds-fg)" : "var(--ds-fg-muted)",
            }}
          >
            {label}
          </Link>
        );
      })}
    </nav>
  );
}
