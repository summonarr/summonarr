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

/**
 * The ticks after the appliable set changed. An admin's own picks that are
 * still appliable stay as they are; only a spec that was not in the set before
 * (`seen`) arrives pre-ticked when it is recommended. A reload that returns the
 * same set therefore changes nothing, and neither does losing a spec.
 */
export function mergeStarterSelection(
  previous: ReadonlySet<string>,
  seen: ReadonlySet<string>,
  appliableIds: readonly string[],
  recommendedIds: readonly string[],
): Set<string> {
  const appliable = new Set(appliableIds);
  const next = new Set<string>();
  for (const id of previous) if (appliable.has(id)) next.add(id);
  for (const id of recommendedIds) if (appliable.has(id) && !seen.has(id)) next.add(id);
  return next;
}
