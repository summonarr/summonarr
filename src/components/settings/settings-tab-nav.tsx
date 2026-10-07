"use client";

import Link from "next/link";
import { useT } from "@/components/i18n/i18n-provider";

const TABS = [
  { id: "site",          i18nKey: "settings.tab.site" },
  { id: "media",         i18nKey: "settings.tab.media" },
  { id: "notifications", i18nKey: "settings.tab.notifications" },
  { id: "integrations",  i18nKey: "settings.tab.integrations" },
  { id: "features",      i18nKey: "settings.tab.features" },
  { id: "system",        i18nKey: "settings.tab.system" },
] as const;

export type TabId = typeof TABS[number]["id"];

// Top-level settings tab bar; each tab links to /settings?tab=<id>.
export function SettingsTabNav({ activeTab }: { activeTab: TabId }) {
  const t = useT();
  return (
    // Wraps onto a second line on narrow screens. A sideways-scrolling row
    // hid the last tab ("System") with no hint that it could scroll.
    <nav
      aria-label={t("settings.tab.ariaLabel")}
      className="flex flex-wrap gap-1 max-w-full"
      style={{
        padding: 2,
        background: "var(--ds-bg-1)",
        border: "1px solid var(--ds-border)",
        borderRadius: 8,
      }}
    >
      {TABS.map(({ id, i18nKey }) => {
        const active = activeTab === id;
        return (
          <Link
            key={id}
            href={`/settings?tab=${id}`}
            aria-current={active ? "page" : undefined}
            // min-h-9 (36px) keeps each tab a comfortable tap target on
            // phones, where the bar wraps into two tightly packed rows.
            className="ds-hover-tint inline-flex items-center min-h-9 whitespace-nowrap font-medium transition-colors"
            style={{
              padding: "5px 14px",
              borderRadius: 6,
              fontSize: 12,
              background: active ? "var(--ds-bg-3)" : "transparent",
              color: active ? "var(--ds-fg)" : "var(--ds-fg-muted)",
            }}
          >
            {t(i18nKey)}
          </Link>
        );
      })}
    </nav>
  );
}
