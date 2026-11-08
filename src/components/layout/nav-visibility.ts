// Which admin destinations the nav draws for a viewer: the items their
// permissions open (getVisibleAdminItems, which mirrors each page's own gate),
// minus those whose feature flag is off — a switched-off page renders a 404 or
// an empty state, so no surface may link to it. The sidebar and the mobile tab
// bar read it here so the two can't drift. Pure, client-safe.
import { filterNavByFeatures, getVisibleAdminItems, type NavItem } from "@/lib/nav-items";

export type NavViewer = { role?: string; permissions?: string } | null | undefined;

export function visibleAdminNavItems(
  viewer: NavViewer,
  featureFlags?: Record<string, boolean>,
): NavItem[] {
  const role = viewer?.role;
  const permissions = viewer?.permissions;
  return filterNavByFeatures(
    getVisibleAdminItems(permissions ? { role, permissions } : role),
    featureFlags,
  );
}
