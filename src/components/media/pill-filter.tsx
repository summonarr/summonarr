"use client";

import { useRouter, usePathname, useSearchParams } from "next/navigation";

// Labelled group of pill buttons backed by one URL search param. Generalized out
// of the old availability-only filter so /for-you can carry three of these
// (show / type / sort) without three near-identical components.
//
// House style: URL search params are the state (no client store). Selecting the
// group's default clears the param instead of writing it, so a plain /for-you
// link and "everything selected" are the same URL. Every change resets `page` —
// otherwise narrowing the set can strand the reader past the new last page.
export interface PillOption<V extends string> {
  /** undefined is the group's default and is represented by the param's absence. */
  value: V | undefined;
  label: string;
}

export function PillFilter<V extends string>({
  label,
  param,
  options,
  active,
}: {
  label: string;
  param: string;
  options: readonly PillOption<V>[];
  active: V | undefined;
}) {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();

  function select(value: V | undefined) {
    const params = new URLSearchParams(searchParams.toString());
    if (value === undefined) params.delete(param);
    else params.set(param, value);
    params.delete("page");
    const qs = params.toString();
    router.push(qs ? `${pathname}?${qs}` : pathname);
  }

  return (
    <div className="inline-flex items-center gap-2">
      <span
        className="ds-mono shrink-0"
        style={{ fontSize: 10.5, color: "var(--ds-fg-subtle)", textTransform: "uppercase", letterSpacing: "0.06em" }}
      >
        {label}
      </span>
      <div className="inline-flex items-center gap-1.5 flex-wrap">
        {options.map((opt) => {
          const isActive = active === opt.value;
          return (
            <button
              key={opt.label}
              type="button"
              onClick={() => select(opt.value)}
              aria-pressed={isActive}
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
    </div>
  );
}
