import { SpecSection } from "@/components/admin/trash-guides/spec-section";
import { NotConfiguredBanner } from "@/components/admin/trash-guides/not-configured-banner";
import { loadTrashPageContext, type TrashPageSearchParams } from "../_shared";

export const dynamic = "force-dynamic";

export default async function QualityProfilesPage({
  searchParams,
}: {
  searchParams: TrashPageSearchParams;
}) {
  const { service, is4k, serviceConfigured } = await loadTrashPageContext(searchParams);

  return (
    <div className="space-y-6 max-w-6xl">
      {!serviceConfigured && <NotConfiguredBanner service={service} />}
      <SpecSection
        key={`qp-${service}-${is4k ? "4k" : "hd"}`}
        service={service}
        is4k={is4k}
        kind="QUALITY_PROFILE"
        title="Quality Profiles"
        description="TRaSH quality profile templates. Applying a profile also applies any custom formats it references."
        disabled={!serviceConfigured}
      />
    </div>
  );
}
