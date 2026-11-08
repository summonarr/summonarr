import { SpecSections } from "@/components/admin/trash-guides/spec-sections";
import { NotConfiguredBanner } from "@/components/admin/trash-guides/not-configured-banner";
import type { TrashSpecKind } from "@/components/admin/trash-guides/types";
import { getTranslator } from "@/lib/i18n/server";
import type { TrashPageContext } from "./_shared";

// The body of a TRaSH sub-page that is a pair of spec sections (Custom formats,
// Naming & sizes): the not-configured banner, then both sections. Each page
// still loads its own context (the guardrail 29 session read happens there).
export async function SpecSectionsPage({
  context,
  keyPrefix,
  sections,
}: {
  context: Pick<TrashPageContext, "service" | "variant" | "serviceConfigured">;
  // Distinguishes the pages' section keys: the variant-keyed `key` remounts
  // the sections when the toggle flips.
  keyPrefix: string;
  sections: readonly { kind: TrashSpecKind; titleKey: string; descriptionKey: string }[];
}) {
  const { service, variant, serviceConfigured } = context;
  const t = await getTranslator();
  return (
    <div className="space-y-6 max-w-6xl">
      {!serviceConfigured && <NotConfiguredBanner service={service} />}
      {/* Both sections share one /status fetch + reload (see SpecSections). */}
      <SpecSections
        key={`${keyPrefix}-${service}-${variant || "default"}`}
        service={service}
        variant={variant}
        disabled={!serviceConfigured}
        sections={sections.map((s) => ({ kind: s.kind, title: t(s.titleKey), description: t(s.descriptionKey) }))}
      />
    </div>
  );
}
