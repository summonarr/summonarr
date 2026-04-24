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

export function SettingsTabNav({ activeTab }: { activeTab: TabId }) {
  return (
    <nav
      className="ds-no-scrollbar flex overflow-x-auto max-w-full"
      style={{
        padding: 2,
        background: "var(--ds-bg-1)",
        border: "1px solid var(--ds-border)",
        borderRadius: 8,
        width: "fit-content",
      }}
    >
      {TABS.map(({ id, label }) => {
        const active = activeTab === id;
        return (
          <Link
            key={id}
            href={`/settings?tab=${id}`}
            className="inline-flex items-center whitespace-nowrap font-medium transition-colors"
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
