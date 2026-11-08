"use client";

import type { ChangeEvent } from "react";
import { StyledSelect } from "@/components/ui/styled-select";

// One option list read live from Radarr/Sonarr (a root folder, a quality or
// language profile), shared by the default/4K forms (forms/arr-form.tsx) and
// the named-instance manager (arr-instances-manager.tsx).
//
// If the saved value is no longer on the server, the select would silently
// show the first option ("default") while still holding the old value — so it
// is listed, marked "not found", instead of hidden.
export function ArrProfileSelect({
  id,
  value,
  onChange,
  defaultLabel,
  options,
  staleLabel,
  compact = true,
  className,
}: {
  id: string;
  value: string;
  onChange: (value: string) => void;
  /** The empty option: "use Radarr's/Sonarr's own default". */
  defaultLabel: string;
  options: readonly { value: string; label: string }[];
  /** The text for a saved value the server no longer lists. */
  staleLabel: (value: string) => string;
  compact?: boolean;
  className?: string;
}) {
  return (
    <StyledSelect
      compact={compact}
      id={id}
      value={value}
      onChange={(e: ChangeEvent<HTMLSelectElement>) => onChange(e.target.value)}
      className={className}
    >
      <option value="">{defaultLabel}</option>
      {value && !options.some((o) => o.value === value) && (
        <option value={value}>{staleLabel(value)}</option>
      )}
      {options.map((o) => (
        <option key={o.value} value={o.value}>{o.label}</option>
      ))}
    </StyledSelect>
  );
}
