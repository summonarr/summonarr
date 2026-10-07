import { SpecSections } from "@/components/admin/trash-guides/spec-sections";
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
      {/* Both sections share one /status fetch + reload (see SpecSections); the
          variant-keyed `key` still remounts them when the toggle flips. */}
      <SpecSections
        key={`nm-${service}-${variant || "default"}`}
        service={service}
        variant={variant}
        disabled={!serviceConfigured}
        sections={[
          {
            kind: "NAMING",
            title: t("trash.section.naming.title"),
            description: t("trash.section.naming.description"),
          },
          {
            kind: "QUALITY_SIZE",
            title: t("trash.section.qualitySizes.title"),
            description: t("trash.section.qualitySizes.description"),
          },
        ]}
      />
    </div>
  );
}
