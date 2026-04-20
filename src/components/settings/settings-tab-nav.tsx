"use client";

import Link from "next/link";

const TABS = [
  { id: "site",          label: "Site" },
  { id: "media",         label: "Media" },
  { id: "notifications", label: "Notifications" },
  { id: "integrations",  label: "Integrations" },
  { id: "system",        label: "System" },
] as const;

export type TabId = typeof TABS[number]["id"];

export function SettingsTabNav({ activeTab }: { activeTab: TabId }) {
  return (
    <nav className="flex gap-0.5 border-b border-zinc-800">
      {TABS.map(({ id, label }) => (
        <Link
          key={id}
          href={`/settings?tab=${id}`}
          className={`px-4 py-2.5 text-sm font-medium rounded-t-md transition-colors border-b-2 -mb-px ${
            activeTab === id
              ? "border-indigo-500 text-white bg-zinc-900/50"
              : "border-transparent text-zinc-500 hover:text-zinc-300"
          }`}
        >
          {label}
        </Link>
      ))}
    </nav>
  );
}
