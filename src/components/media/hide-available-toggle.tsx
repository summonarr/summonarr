"use client";

import { useRouter, usePathname, useSearchParams } from "next/navigation";

interface HideAvailableToggleProps {
  active: boolean;
}

export function HideAvailableToggle({ active }: HideAvailableToggleProps) {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();

  function toggle() {
    const params = new URLSearchParams(searchParams.toString());
    if (active) {
      params.delete("hideAvailable");
    } else {
      params.set("hideAvailable", "1");
    }
    const qs = params.toString();
    router.push(qs ? `${pathname}?${qs}` : pathname);
  }

  return (
    <button
      type="button"
      onClick={toggle}
      className="ds-tap inline-flex items-center gap-1.5 font-medium transition-colors"
      style={{
        padding: "5px 12px",
        borderRadius: 6,
        fontSize: 12,
        background: active ? "var(--ds-accent-soft)" : "var(--ds-bg-2)",
        color: active ? "var(--ds-accent)" : "var(--ds-fg-muted)",
        border: `1px solid ${active ? "var(--ds-accent-ring)" : "var(--ds-border)"}`,
        whiteSpace: "nowrap",
      }}
    >
      Hide Available
    </button>
  );
}
