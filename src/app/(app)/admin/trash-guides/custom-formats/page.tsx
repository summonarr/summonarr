import { loadTrashPageContext, type TrashPageSearchParams } from "../_shared";
import { SpecSectionsPage } from "../_spec-sections-page";

export const dynamic = "force-dynamic";

export default async function CustomFormatsPage({
  searchParams,
}: {
  searchParams: TrashPageSearchParams;
}) {
  const context = await loadTrashPageContext(searchParams);
  return (
    <SpecSectionsPage
      context={context}
      keyPrefix="cfg"
      sections={[
        {
          kind: "CUSTOM_FORMAT_GROUP",
          titleKey: "trash.section.customFormatGroups.title",
          descriptionKey: "trash.section.customFormatGroups.description",
        },
        {
          kind: "CUSTOM_FORMAT",
          titleKey: "trash.section.customFormats.title",
          descriptionKey: "trash.section.customFormats.description",
        },
      ]}
    />
  );
}
