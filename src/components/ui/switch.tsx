import * as React from "react"

import { Loader2 } from "@/components/icons"
import { cn } from "@/lib/utils"

// The one toggle switch. Every colour here is a DS token so it survives both
// themes and all six accents (guardrail 42). Contrast, computed oklch → sRGB →
// WCAG, worst case over every theme × accent:
//   - OFF: a white knob on the --ds-bg-3 track is 16.2:1 in dark but 1.14:1 in
//     light, so the knob carries a --ds-fg-subtle outline (5.74:1 against the
//     light track). --ds-border-strong, the obvious choice, is only 1.26:1.
//   - ON (accent): the knob is --ds-accent-fg, never white — white was 1.09:1
//     on the mono accent in dark and 2.0–2.7:1 on amber/emerald/cyan. accent-fg
//     is 3.35:1 (rose) or better.
//   - ON (success/warning): the knob is --ds-on-status (6.4:1 or better); white
//     on the dark success track was 2.31:1.
const TRACK_ON = {
  accent: "bg-[var(--ds-accent)]",
  success: "bg-[var(--ds-success)]",
  warning: "bg-[var(--ds-warning)]",
} as const

const KNOB_ON = {
  accent: "bg-[var(--ds-accent-fg)]",
  success: "bg-[var(--ds-on-status)]",
  warning: "bg-[var(--ds-on-status)]",
} as const

const SPINNER_ON = {
  accent: "text-[var(--ds-accent-fg)]",
  success: "text-[var(--ds-on-status)]",
  warning: "text-[var(--ds-on-status)]",
} as const

// The ON offset leaves the same inset as OFF on the other side: track width −
// knob − off-inset (sm 32−12−2, md 36−16−2 = 18px; lg 44−16−4 = 24px).
const SIZES = {
  sm: { track: "h-4 w-8", knob: "h-3 w-3", spinner: "h-3 w-3", on: "translate-x-[18px]", off: "translate-x-0.5" },
  md: { track: "h-5 w-9", knob: "h-4 w-4", spinner: "h-3.5 w-3.5", on: "translate-x-[18px]", off: "translate-x-0.5" },
  lg: { track: "h-6 w-11", knob: "h-4 w-4", spinner: "h-4 w-4", on: "translate-x-6", off: "translate-x-1" },
} as const

type SwitchProps = Omit<React.ComponentProps<"button">, "type" | "role" | "onClick" | "onChange" | "children"> & {
  checked: boolean
  /** Called with the next value; the switch holds no state of its own. */
  onCheckedChange: (next: boolean) => void
  /** Swaps the knob for a spinner (and sets aria-busy). Does not disable. */
  loading?: boolean
  /** Track colour when on. */
  variant?: keyof typeof TRACK_ON
  size?: keyof typeof SIZES
}

function Switch({
  checked,
  onCheckedChange,
  loading = false,
  variant = "accent",
  size = "md",
  className,
  ...props
}: SwitchProps) {
  const s = SIZES[size]
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-busy={loading || undefined}
      data-slot="switch"
      data-state={checked ? "on" : "off"}
      onClick={() => onCheckedChange(!checked)}
      className={cn(
        "relative inline-flex shrink-0 items-center rounded-full transition-colors outline-none focus-visible:ring-2 focus-visible:ring-[var(--ds-accent-hover)] focus-visible:ring-offset-2 focus-visible:ring-offset-[var(--ds-bg-1)] disabled:cursor-not-allowed disabled:opacity-50",
        s.track,
        checked ? TRACK_ON[variant] : "bg-[var(--ds-bg-3)]",
        className
      )}
      {...props}
    >
      {loading ? (
        <Loader2
          aria-hidden
          className={cn(
            "animate-spin transition-transform",
            s.spinner,
            checked ? cn(s.on, SPINNER_ON[variant]) : cn(s.off, "text-[var(--ds-fg)]")
          )}
        />
      ) : (
        <span
          aria-hidden
          className={cn(
            "pointer-events-none inline-block rounded-full shadow transition-transform",
            s.knob,
            checked ? cn(s.on, KNOB_ON[variant]) : cn(s.off, "bg-white")
          )}
          // Only the OFF knob needs an edge: in light mode it is white on a
          // near-white track. The ON knob already contrasts with its track.
          style={checked ? undefined : { outline: "1px solid var(--ds-fg-subtle)", outlineOffset: -1 }}
        />
      )}
    </button>
  )
}

export { Switch }
export type { SwitchProps }
