import * as React from "react"

import { cn } from "@/lib/utils"

// Multi-line twin of Input: same edge, radius, focus ring, disabled and
// invalid treatment, and the same text-base-below-md rule (iOS Safari zooms
// the viewport when a control under 16px takes focus). Ten hand-rolled
// <textarea className="…"> recipes across the settings and issue forms each
// drifted from Input on one of those; this is the one place to keep them equal.
function Textarea({ className, ...props }: React.ComponentProps<"textarea">) {
  return (
    <textarea
      data-slot="textarea"
      className={cn(
        "w-full min-w-0 rounded-lg border border-input bg-transparent px-2.5 py-1.5 text-base transition-colors outline-none placeholder:text-muted-foreground focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 disabled:pointer-events-none disabled:cursor-not-allowed disabled:bg-input/50 disabled:opacity-50 aria-invalid:border-destructive aria-invalid:ring-3 aria-invalid:ring-destructive/20 md:text-sm dark:bg-input/30 dark:disabled:bg-input/80 dark:aria-invalid:border-destructive/50 dark:aria-invalid:ring-destructive/40",
        className
      )}
      {...props}
    />
  )
}

export { Textarea }
