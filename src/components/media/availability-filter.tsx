"use client";

import { useRouter, usePathname, useSearchParams } from "next/navigation";

export type AvailabilityFilterValue = "available" | "missing" | undefined;

// Three-way availability filter for grid pages: everything, only titles already
// on the user's media server(s), or only titles not yet on any of them. Rides
// the `filter` search param (house style — URL state, no client store) and
// resets `page` so a filter change never strands the user past the new last page.
const OPTIONS: { value: AvailabilityFilterValue; label: string }[] = [
  { value: undefined, label: "All" },
  { value: "available", label: "On your server" },
  { value: "missing", label: "Not on server" },
];

export function AvailabilityFilter({ active }: { active: AvailabilityFilterValue }) {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();

  function select(value: AvailabilityFilterValue) {
    const params = new URLSearchParams(searchParams.toString());
    if (value === undefined) {
      params.delete("filter");
    } else {
      params.set("filter", value);
    }
    params.delete("page");
    const qs = params.toString();
    router.push(qs ? `${pathname}?${qs}` : pathname);
  }

  return (
    <div className="inline-flex items-center gap-1.5">
      {OPTIONS.map((opt) => {
        const isActive = active === opt.value;
        return (
          <button
            key={opt.label}
            type="button"
            onClick={() => select(opt.value)}
            className="ds-tap inline-flex items-center font-medium transition-colors"
            style={{
              padding: "5px 12px",
              borderRadius: 6,
              fontSize: 12,
              background: isActive ? "var(--ds-accent-soft)" : "var(--ds-bg-2)",
              color: isActive ? "var(--ds-accent)" : "var(--ds-fg-muted)",
              border: `1px solid ${isActive ? "var(--ds-accent-ring)" : "var(--ds-border)"}`,
              whiteSpace: "nowrap",
            }}
          >
            {opt.label}
          </button>
        );
      })}
    </div>
  );
}
