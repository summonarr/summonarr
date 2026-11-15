"use client";

import { X } from "@/components/icons";
import { useT } from "@/components/i18n/i18n-provider";

// Pieces both browse filter bars share (/movies + /tv in filter-bar.tsx, /top
// in top-filter-bar.tsx), so a fix to the chip's hit area or labelling lands
// once.

// An active-filter chip with its remove button.
export function RemovableChip({ label, onRemove }: { label: string; onRemove: () => void }) {
  const t = useT();
  return (
    <span className="ds-chip ds-chip-accent">
      {label}
      <button
        type="button"
        onClick={onRemove}
        aria-label={t("media.filter.remove", { label })}
        title={t("media.filter.remove", { label })}
        className="ds-hover-tint inline-flex items-center justify-center shrink-0"
        style={{
          // A 24px box is easy to tap. The negative margins shrink the space it
          // takes in the layout back to 12px (a 2px gap + the 10px icon), so
          // the chip stays the same size and the icon doesn't move.
          width: 24,
          height: 24,
          margin: "-6px -7px -6px -5px",
          borderRadius: 999,
          background: "transparent",
          border: 0,
          padding: 0,
          color: "inherit",
        }}
      >
        <X style={{ width: 10, height: 10 }} />
      </button>
    </span>
  );
}

// The year options, newest first, back to 1900. `maxYear` is a prop from the
// server, never a module-level `new Date()`: Node freezes that at module load
// and the client re-evaluates it at page load, so once the year rolls over (or
// the bundler bakes the build-time year) the SSR and CSR `<option>` lists
// drift — React #418.
const FIRST_YEAR = 1900;

export function buildYears(maxYear: number): string[] {
  return Array.from({ length: Math.max(0, maxYear - (FIRST_YEAR - 1)) }, (_, i) => String(maxYear - i));
}
