import { SpecSection } from "@/components/admin/trash-guides/spec-section";
import { NotConfiguredBanner } from "@/components/admin/trash-guides/not-configured-banner";
import { loadTrashPageContext, type TrashPageSearchParams } from "../_shared";

export const dynamic = "force-dynamic";

export default async function NamingSizesPage({
  searchParams,
}: {
  searchParams: TrashPageSearchParams;
}) {
  const { service, is4k, serviceConfigured } = await loadTrashPageContext(searchParams);

  return (
    <div className="space-y-6 max-w-6xl">
      {!serviceConfigured && <NotConfiguredBanner service={service} />}
      <SpecSection
        key={`nm-${service}-${is4k ? "4k" : "hd"}`}
        service={service}
        is4k={is4k}
        kind="NAMING"
        title="Naming"
        description="Naming schemes. Applying merges selected templates into Radarr/Sonarr's media-management config."
        disabled={!serviceConfigured}
      />
      <SpecSection
        key={`qs-${service}-${is4k ? "4k" : "hd"}`}
        service={service}
        is4k={is4k}
        kind="QUALITY_SIZE"
        title="Quality Sizes"
        description="TRaSH's recommended min/preferred/max size per quality. Applying overlays these onto Radarr/Sonarr's quality definitions — untouched qualities keep their current values."
        disabled={!serviceConfigured}
      />
    </div>
  );
}
