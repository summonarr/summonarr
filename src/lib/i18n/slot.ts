// A translated sentence with one element inside it (an emphasized title, a
// source name): the caller translates with `SLOT` as the variable's value and
// renders the element between the two halves, so the element sits wherever the
// locale's word order puts it.
//
//   const parts = splitAtSlot(t("request.confirmPrompt", { title: SLOT }));
//
// Zero imports, so client components and the unit suite load it directly
// (tests/i18n-slot.test.mts).

export const SLOT = "\u0000";

/**
 * The text before and after the slot, or null when the translation has no
 * slot (it words the sentence without the element). A repeated slot keeps the
 * first one and drops the rest, so a stray copy never reaches the page.
 */
export function splitAtSlot(text: string): { before: string; after: string } | null {
  const at = text.indexOf(SLOT);
  if (at < 0) return null;
  return { before: text.slice(0, at), after: text.slice(at + SLOT.length).split(SLOT).join("") };
}
