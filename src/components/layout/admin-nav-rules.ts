// The admin nav groups' badge-label rule. Pure, so the unit suite reads them (tests/nav-groups.test.mts).
import { NAV_BADGE_LABEL_KEYS } from "@/lib/nav-items";

// A collapsed group's header sums the badges of the items it hides.
export const GROUP_BADGE_LABEL_KEY = "nav.badge.groupAttention";

/**
 * The label for a collapsed group's badge: the item's own wording when ONE
 * hidden item carries a badge, the generic "N items need attention" when
 * several do (their counts are summed, so one item's wording would misname the
 * total); undefined when the one item has no wording of its own.
 */
export function groupBadgeLabelKey(hiddenBadgedHrefs: readonly string[]): string | undefined {
  if (hiddenBadgedHrefs.length > 1) return GROUP_BADGE_LABEL_KEY;
  return hiddenBadgedHrefs.length === 1 ? NAV_BADGE_LABEL_KEYS[hiddenBadgedHrefs[0]] : undefined;
}
