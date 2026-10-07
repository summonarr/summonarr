"use client";

import { useTransition } from "react";
import { useRouter, usePathname, useSearchParams } from "next/navigation";
import { useT } from "@/components/i18n/i18n-provider";

interface HideAvailableToggleProps {
  active: boolean;
}

export function HideAvailableToggle({ active }: HideAvailableToggleProps) {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const t = useT();
  // The pages behind this toggle (home, /upcoming) re-enrich their whole set on
  // every change, so the push can take a moment. Like PillFilter: show the new
  // state straight away and mark the control busy until the render lands —
  // otherwise the click reads as ignored.
  const [isPending, startTransition] = useTransition();
  const shown = isPending ? !active : active;

  function toggle() {
    const params = new URLSearchParams(searchParams.toString());
    if (active) {
      params.delete("hideAvailable");
    } else {
      params.set("hideAvailable", "1");
    }
    // Toggling changes the result set, so the page number it indexed into is
    // meaningless — same reasoning as the filter bars. /upcoming clamps an
    // out-of-range page anyway, but landing on page 1 is what the user means.
    params.delete("page");
    const qs = params.toString();
    startTransition(() => {
      router.push(qs ? `${pathname}?${qs}` : pathname);
    });
  }

  return (
    <button
      type="button"
      onClick={toggle}
      aria-pressed={shown}
      aria-busy={isPending || undefined}
      className="ds-tap ds-hover-tint inline-flex items-center gap-1.5 font-medium transition-opacity"
      style={{
        padding: "5px 12px",
        minHeight: 32,
        borderRadius: 8,
        fontSize: 12,
        background: shown ? "var(--ds-accent-soft)" : "var(--ds-bg-2)",
        color: shown ? "var(--ds-accent-text)" : "var(--ds-fg-muted)",
        border: `1px solid ${shown ? "var(--ds-accent-ring)" : "var(--ds-border)"}`,
        whiteSpace: "nowrap",
        opacity: isPending ? 0.7 : 1,
      }}
    >
      {t("media.hideAvailable")}
    </button>
  );
}
