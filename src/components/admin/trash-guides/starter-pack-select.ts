// Which Profile Library rows an Apply can take (starter-pack-card.tsx). Pure
// and directive-free (tests/trash-card-shapes.test.mts).
import type { StarterPackItem, TrashService } from "./types";

/** A row whose spec is in the local catalog. */
export type ResolvedStarterItem = StarterPackItem & { spec: NonNullable<StarterPackItem["spec"]> };

/**
 * The rows an Apply can send: in the local catalog, and on a service with a
 * configured connection. A row of an unconfigured service is neither
 * pre-selected nor selectable, so the default Apply never sends a spec to an
 * instance that isn't there (and fails it on first use).
 */
export function appliableStarterItems(
  items: readonly StarterPackItem[],
  serviceConfigured: (service: TrashService) => boolean,
): ResolvedStarterItem[] {
  return items.filter((i): i is ResolvedStarterItem => i.spec !== null && serviceConfigured(i.item.service));
}
