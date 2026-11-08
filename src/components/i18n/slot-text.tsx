import type { ReactNode } from "react";
import { splitAtSlot } from "@/lib/i18n/slot";

// Renders a sentence translated with `SLOT` (src/lib/i18n/slot.ts) with
// `children` in the slot's place. A translation without the slot renders as
// it is, without the element, rather than tacking the element on at the end.
// No hooks and no "use client": server and client components both use it.
export function SlotText({ text, children }: { text: string; children: ReactNode }) {
  const parts = splitAtSlot(text);
  if (!parts) return <>{text}</>;
  return (
    <>
      {parts.before}
      {children}
      {parts.after}
    </>
  );
}
