import { SpecSection } from "@/components/admin/trash-guides/spec-section";
import { NotConfiguredBanner } from "@/components/admin/trash-guides/not-configured-banner";
import { getTranslator } from "@/lib/i18n/server";
import { loadTrashPageContext, type TrashPageSearchParams } from "../_shared";

export const dynamic = "force-dynamic";

export default async function CustomFormatsPage({
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
        key={`cfg-${service}-${variant || "default"}`}
        service={service}
        variant={variant}
        kind="CUSTOM_FORMAT_GROUP"
        title={t("trash.section.customFormatGroups.title")}
        description={t("trash.section.customFormatGroups.description")}
        disabled={!serviceConfigured}
      />
      <SpecSection
        key={`cf-${service}-${variant || "default"}`}
        service={service}
        variant={variant}
        kind="CUSTOM_FORMAT"
        title={t("trash.section.customFormats.title")}
        description={t("trash.section.customFormats.description")}
        disabled={!serviceConfigured}
      />
    </div>
  );
}
