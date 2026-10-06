import { SpecSections } from "@/components/admin/trash-guides/spec-sections";
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
      {/* Both sections share one /status fetch + reload (see SpecSections); the
          variant-keyed `key` still remounts them when the toggle flips. */}
      <SpecSections
        key={`cfg-${service}-${variant || "default"}`}
        service={service}
        variant={variant}
        disabled={!serviceConfigured}
        sections={[
          {
            kind: "CUSTOM_FORMAT_GROUP",
            title: t("trash.section.customFormatGroups.title"),
            description: t("trash.section.customFormatGroups.description"),
          },
          {
            kind: "CUSTOM_FORMAT",
            title: t("trash.section.customFormats.title"),
            description: t("trash.section.customFormats.description"),
          },
        ]}
      />
    </div>
  );
}
