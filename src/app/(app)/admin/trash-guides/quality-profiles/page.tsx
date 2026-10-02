import { SpecSection } from "@/components/admin/trash-guides/spec-section";
import { NotConfiguredBanner } from "@/components/admin/trash-guides/not-configured-banner";
import { getTranslator } from "@/lib/i18n/server";
import { loadTrashPageContext, type TrashPageSearchParams } from "../_shared";

export const dynamic = "force-dynamic";

export default async function QualityProfilesPage({
  searchParams,
}: {
  searchParams: TrashPageSearchParams;
}) {
  const { service, variant, serviceConfigured } = await loadTrashPageContext(searchParams);
  const t = await getTranslator();

  return (
    <div className="space-y-6 max-w-6xl">
      {!serviceConfigured && <NotConfiguredBanner service={service} />}
      <SpecSection
        key={`qp-${service}-${variant || "default"}`}
        service={service}
        variant={variant}
        kind="QUALITY_PROFILE"
        title={t("trash.section.qualityProfiles.title")}
        description={t("trash.section.qualityProfiles.description")}
        disabled={!serviceConfigured}
      />
    </div>
  );
}
