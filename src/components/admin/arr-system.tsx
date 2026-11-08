"use client";

// Admin → Arr System. The parts of Radarr's and Sonarr's own System and
// Settings screens an admin opens them for, across every configured instance:
//   Tasks               — the scheduled tasks (last/next run, Run now), the
//                         commands running or just run (cancel a queued one),
//                         and the two library-wide searches (every monitored
//                         missing title, every title below cutoff).
//                         arr-system-tasks.tsx.
//   Indexers & clients  — which indexers and download clients exist, which
//                         are on (failing ones are in the health panel above);
//                         switch them, test them. Their settings (API keys,
//                         passwords) never leave the server.
//                         arr-system-providers.tsx.
//   Storage             — root folders (free space, reachable, folders the arr
//                         has no title for) and disks. arr-system-storage.tsx.
// Live reads (GET /api/admin/arr/{tasks,providers,storage}, useReport in
// arr-system-parts.tsx); the Tasks tab re-reads while visible so a command's
// status moves on its own — a tick is skipped while a read is still out, never
// stacked on it. Opening a tab paints the last answer the server kept for its
// read at once (useArrSnapshot, marked with when it was read) while that live
// read is out; the live answer then replaces it. Display only: every action
// still re-checks live on the server (guardrail 5e).

import { useState } from "react";
import { EmptyState, FilterBar } from "@/components/ui/design";
import { ArrHealthPanel } from "@/components/admin/arr-health-panel";
import { Server } from "@/components/icons";
import { useT } from "@/components/i18n/i18n-provider";
import { withQuery } from "@/lib/client/url-query";
import { TasksTab } from "./arr-system-tasks";
import { ProvidersTab } from "./arr-system-providers";
import { StorageTab } from "./arr-system-storage";

type Tab = "tasks" | "providers" | "storage";

export function ArrSystem({ configured, initialTab }: { configured: boolean; initialTab: Tab }) {
  const t = useT();
  const [tab, setTab] = useState<Tab>(initialTab);
  if (!configured) {
    return <EmptyState icon={Server} title={t("adminArr.common.noneConfigured")} description={t("adminArr.common.noneConfiguredHint")} cta={{ href: "/settings?tab=media#radarr", label: t("adminArr.common.openSettings") }} />;
  }
  function switchTab(next: Tab) {
    setTab(next);
    // The tab is this page's own key; any other param and the #fragment stay.
    window.history.replaceState(null, "", withQuery(window.location, { tab: next }));
  }
  return (
    <div className="grid gap-4">
      <ArrHealthPanel variant="full" />
      <FilterBar
        segments={[
          { value: "tasks" as const, label: t("adminArr.system.tab.tasks") },
          { value: "providers" as const, label: t("adminArr.system.tab.providers") },
          { value: "storage" as const, label: t("adminArr.system.tab.storage") },
        ]}
        active={tab}
        onChange={switchTab}
        className="mb-0"
      />
      {tab === "tasks" && <TasksTab />}
      {tab === "providers" && <ProvidersTab />}
      {tab === "storage" && <StorageTab />}
    </div>
  );
}
