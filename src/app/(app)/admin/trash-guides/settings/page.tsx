import { authActive } from "@/lib/auth";
import { redirect } from "next/navigation";
import { hasPermission, Permission } from "@/lib/permissions";
import { prisma } from "@/lib/prisma";
import { SyncSettingsCard } from "@/components/admin/trash-guides/sync-settings-card";
import { GithubTokenCard } from "@/components/admin/trash-guides/github-token-card";
import type { TrashSettings } from "@/components/admin/trash-guides/types";

export const dynamic = "force-dynamic";

const SETTING_KEYS = [
  "trashGuidesEnabled",
  "trashSyncCustomFormats",
  "trashSyncCustomFormatGroups",
  "trashSyncQualityProfiles",
  "trashSyncNaming",
  "trashSyncQualitySizes",
] as const;

export default async function TrashGuidesSettingsPage() {
  const session = await authActive();
  if (!session || !hasPermission(session.user.permissions, Permission.ADMIN)) redirect("/");

  const rows = await prisma.setting.findMany({
    where: { key: { in: [...SETTING_KEYS] } },
  });
  const map = Object.fromEntries(rows.map((r) => [r.key, r.value]));

  const settings: TrashSettings = {
    enabled: map.trashGuidesEnabled === "true",
    syncCustomFormats: map.trashSyncCustomFormats !== "false",
    syncCustomFormatGroups: map.trashSyncCustomFormatGroups !== "false",
    syncQualityProfiles: map.trashSyncQualityProfiles !== "false",
    syncNaming: map.trashSyncNaming !== "false",
    syncQualitySizes: map.trashSyncQualitySizes !== "false",
  };

  return (
    <div className="space-y-6 max-w-6xl">
      <SyncSettingsCard initialSettings={settings} />
      <GithubTokenCard />
    </div>
  );
}
