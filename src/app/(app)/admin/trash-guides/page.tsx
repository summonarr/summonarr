import { auth } from "@/lib/auth";
import { redirect } from "next/navigation";
import { prisma } from "@/lib/prisma";
import { TrashGuidesClient, type TrashSettings } from "@/components/admin/trash-guides-client";
import { PageHeader } from "@/components/ui/design";

export const dynamic = "force-dynamic";

const SETTING_KEYS = [
  "trashGuidesEnabled",
  "trashSyncCustomFormats",
  "trashSyncCustomFormatGroups",
  "trashSyncQualityProfiles",
  "trashSyncNaming",
  "trashSyncQualitySizes",
  "radarrUrl",
  "radarrApiKey",
  "sonarrUrl",
  "sonarrApiKey",
  "trashLastRefreshTruncatedAt",
] as const;

const TRUNCATION_STALE_MS = 7 * 24 * 60 * 60 * 1000;

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
    syncCustomFormatGroups: map.trashSyncCustomFormatGroups !== "false",
    syncQualityProfiles: map.trashSyncQualityProfiles !== "false",
    syncNaming: map.trashSyncNaming !== "false",
    syncQualitySizes: map.trashSyncQualitySizes !== "false",
  };

  const radarrConfigured = !!(map.radarrUrl && map.radarrApiKey);
  const sonarrConfigured = !!(map.sonarrUrl && map.sonarrApiKey);

  // Compute truncation staleness server-side — guardrail 16 forbids Date.now() in client render path.
  // The banner only fires if the last truncation was within the last 7 days; older markers are stale signal.
  const truncatedAtRaw = map.trashLastRefreshTruncatedAt ?? null;
  let recentTruncation: { at: string } | null = null;
  if (truncatedAtRaw) {
    const t = Date.parse(truncatedAtRaw);
    // eslint-disable-next-line react-hooks/purity -- server component; Date.now() runs once per request
    if (!Number.isNaN(t) && Date.now() - t < TRUNCATION_STALE_MS) {
      recentTruncation = { at: truncatedAtRaw };
    }
  }

  return (
    <div className="ds-page-enter">
      <PageHeader
        title="TRaSH Guides"
        subtitle={
          <>
            Sync recommended custom formats, quality profiles, naming schemes,
            and quality sizes from{" "}
            <a
              href="https://trash-guides.info"
              target="_blank"
              rel="noopener noreferrer"
              className="hover:underline"
              style={{ color: "var(--ds-accent)" }}
            >
              trash-guides.info
            </a>
            .
          </>
        }
      />
      <TrashGuidesClient
        initialSettings={settings}
        radarrConfigured={radarrConfigured}
        sonarrConfigured={sonarrConfigured}
        recentTruncation={recentTruncation}
      />
    </div>
  );
}
