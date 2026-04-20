import { auth } from "@/lib/auth";
import { redirect } from "next/navigation";
import { prisma } from "@/lib/prisma";
import { TrashGuidesClient, type TrashSettings } from "@/components/admin/trash-guides-client";

export const dynamic = "force-dynamic";

const SETTING_KEYS = [
  "trashGuidesEnabled",
  "trashSyncCustomFormats",
  "trashSyncQualityProfiles",
  "trashSyncNaming",
  "trashSyncQualitySizes",
  "radarrUrl",
  "radarrApiKey",
  "sonarrUrl",
  "sonarrApiKey",
] as const;

export default async function TrashGuidesPage() {
  const session = await auth();
  if (!session || session.user.role !== "ADMIN") redirect("/");

  const rows = await prisma.setting.findMany({
    where: { key: { in: [...SETTING_KEYS] } },
  });
  const map = Object.fromEntries(rows.map((r) => [r.key, r.value]));

  const settings: TrashSettings = {
    enabled: map.trashGuidesEnabled === "true",
    syncCustomFormats: map.trashSyncCustomFormats !== "false",
    syncQualityProfiles: map.trashSyncQualityProfiles !== "false",
    syncNaming: map.trashSyncNaming !== "false",
    syncQualitySizes: map.trashSyncQualitySizes !== "false",
  };

  const radarrConfigured = !!(map.radarrUrl && map.radarrApiKey);
  const sonarrConfigured = !!(map.sonarrUrl && map.sonarrApiKey);

  return (
    <div>
      <div className="mb-8">
        <h1 className="text-2xl font-bold mb-1">TRaSH Guides</h1>
        <p className="text-zinc-400 text-sm">
          Sync recommended custom formats, quality profiles, naming schemes, and quality sizes from{" "}
          <a href="https://trash-guides.info" target="_blank" rel="noopener noreferrer" className="text-indigo-400 hover:underline">trash-guides.info</a>.
        </p>
      </div>
      <TrashGuidesClient
        initialSettings={settings}
        radarrConfigured={radarrConfigured}
        sonarrConfigured={sonarrConfigured}
      />
    </div>
  );
}
