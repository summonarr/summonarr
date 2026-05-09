import { OverviewTab } from "@/components/admin/trash-guides/overview-tab";
import { loadTrashPageContext, type TrashPageSearchParams } from "./_shared";

export const dynamic = "force-dynamic";

export default async function TrashGuidesOverviewPage({
  searchParams,
}: {
  searchParams: TrashPageSearchParams;
}) {
  const { service, radarrConfigured, sonarrConfigured } = await loadTrashPageContext(searchParams);

  return (
    <OverviewTab
      service={service}
      radarrConfigured={radarrConfigured}
      sonarrConfigured={sonarrConfigured}
    />
  );
}
