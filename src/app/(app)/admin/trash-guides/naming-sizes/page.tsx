import { SpecSection } from "@/components/admin/trash-guides/spec-section";
import { NotConfiguredBanner } from "@/components/admin/trash-guides/not-configured-banner";
import { getTranslator } from "@/lib/i18n/server";
import { loadTrashPageContext, type TrashPageSearchParams } from "../_shared";

export const dynamic = "force-dynamic";

export default async function NamingSizesPage({
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
        key={`nm-${service}-${variant || "default"}`}
        service={service}
        variant={variant}
        kind="NAMING"
        title={t("trash.section.naming.title")}
        description={t("trash.section.naming.description")}
        disabled={!serviceConfigured}
      />
      <SpecSection
        key={`qs-${service}-${variant || "default"}`}
        service={service}
        variant={variant}
        kind="QUALITY_SIZE"
        title={t("trash.section.qualitySizes.title")}
        description={t("trash.section.qualitySizes.description")}
        disabled={!serviceConfigured}
      />
    </div>
  );
}
