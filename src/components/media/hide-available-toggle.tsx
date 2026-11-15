"use client";

import { useT } from "@/components/i18n/i18n-provider";
import { FilterToggleButton } from "./filter-toggle-button";
import { usePendingSearchParam } from "./use-pending-search-param";

interface HideAvailableToggleProps {
  active: boolean;
}

export function HideAvailableToggle({ active }: HideAvailableToggleProps) {
  const t = useT();
  // The pages behind this toggle (home, /upcoming) re-enrich their whole set on
  // every change, so the push can take a moment: show the new state straight
  // away and mark the control busy until the render lands (usePendingSearchParam).
  // The next state comes from what is SHOWN, not from `active`.
  const { shown, set, isPending } = usePendingSearchParam<"1">("hideAvailable", active ? "1" : undefined);
  const pressed = shown === "1";

  function toggle() {
    set(pressed ? undefined : "1");
  }

  return (
    <FilterToggleButton
      pressed={pressed}
      onClick={toggle}
      aria-busy={isPending || undefined}
      className="transition-opacity"
      style={{ whiteSpace: "nowrap", opacity: isPending ? 0.7 : 1 }}
    >
      {t("media.hideAvailable")}
    </FilterToggleButton>
  );
}
