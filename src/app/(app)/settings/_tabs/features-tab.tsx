import { FeaturesForm } from "@/components/settings/features-form";
import { getFeatureFlags, groupFeaturesByCategory } from "@/lib/features";
import type { Translator } from "@/lib/i18n/translate";

export async function FeaturesTab({ t }: { t: Translator }) {
  const flags = await getFeatureFlags();
  const g = groupFeaturesByCategory();
  const groups = [
    { category: "pages" as const,        title: t("settings.features.group.pages.title"), description: t("settings.features.group.pages.description"), features: g.pages },
    { category: "behaviors" as const,    title: t("settings.features.group.behaviors.title"), description: t("settings.features.group.behaviors.description"), features: g.behaviors },
    { category: "integrations" as const, title: t("settings.features.group.integrations.title"), description: t("settings.features.group.integrations.description"), features: g.integrations },
    { category: "admin" as const,        title: t("settings.features.group.admin.title"), description: t("settings.features.group.admin.description"), features: g.admin },
  ];
  return <FeaturesForm initialFlags={flags} groups={groups} />;
}
