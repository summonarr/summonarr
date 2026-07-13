import { SpecSection } from "@/components/admin/trash-guides/spec-section";
import { NotConfiguredBanner } from "@/components/admin/trash-guides/not-configured-banner";
import { loadTrashPageContext, type TrashPageSearchParams } from "../_shared";

export const dynamic = "force-dynamic";

export default async function CustomFormatsPage({
  searchParams,
}: {
  searchParams: TrashPageSearchParams;
}) {
  const { service, variant, serviceConfigured } = await loadTrashPageContext(searchParams);

  return (
    <div className="space-y-6 max-w-6xl">
      {!serviceConfigured && <NotConfiguredBanner service={service} />}
      <SpecSection
        key={`cfg-${service}-${variant || "default"}`}
        service={service}
        variant={variant}
        kind="CUSTOM_FORMAT_GROUP"
        title="Custom Format Groups"
        description="TRaSH-curated bundles (HDR Formats, Release Groups HQ, Streaming Services, etc.). Applying a group applies every member custom format in one shot."
        disabled={!serviceConfigured}
      />
      <SpecSection
        key={`cf-${service}-${variant || "default"}`}
        service={service}
        variant={variant}
        kind="CUSTOM_FORMAT"
        title="Custom Formats"
        description="CFs that will be POSTed/PUT to Radarr/Sonarr. Unmanage to stop overwriting upstream changes."
        disabled={!serviceConfigured}
      />
    </div>
  );
}
