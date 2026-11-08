import { loadTrashPageContext, type TrashPageSearchParams } from "../_shared";
import { SpecSectionsPage } from "../_spec-sections-page";

export const dynamic = "force-dynamic";

export default async function NamingSizesPage({
  searchParams,
}: {
  searchParams: TrashPageSearchParams;
}) {
  const context = await loadTrashPageContext(searchParams);
  return (
    <SpecSectionsPage
      context={context}
      keyPrefix="nm"
      sections={[
        {
          kind: "NAMING",
          titleKey: "trash.section.naming.title",
          descriptionKey: "trash.section.naming.description",
        },
        {
          kind: "QUALITY_SIZE",
          titleKey: "trash.section.qualitySizes.title",
          descriptionKey: "trash.section.qualitySizes.description",
        },
      ]}
    />
  );
}
