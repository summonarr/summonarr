import { SpecSection } from "@/components/admin/trash-guides/spec-section";
import { NotConfiguredBanner } from "@/components/admin/trash-guides/not-configured-banner";
import { loadTrashPageContext, type TrashPageSearchParams } from "../_shared";

export const dynamic = "force-dynamic";

export default async function CustomFormatsPage({
  searchParams,
}: {
  searchParams: TrashPageSearchParams;
}) {
  const { service, serviceConfigured } = await loadTrashPageContext(searchParams);

  return (
    <div className="space-y-6 max-w-6xl">
      {!serviceConfigured && <NotConfiguredBanner service={service} />}
      <SpecSection
        key={`cfg-${service}`}
        service={service}
        kind="CUSTOM_FORMAT_GROUP"
        title="Custom Format Groups"
        description="TRaSH-curated bundles (HDR Formats, Release Groups HQ, Streaming Services, etc.). Applying a group applies every member custom format in one shot."
        disabled={!serviceConfigured}
      />
      <SpecSection
        key={`cf-${service}`}
        service={service}
        kind="CUSTOM_FORMAT"
        title="Custom Formats"
        description="CFs that will be POSTed/PUT to Radarr/Sonarr. Unmanage to stop overwriting upstream changes."
        disabled={!serviceConfigured}
      />
    </div>
  );
}
