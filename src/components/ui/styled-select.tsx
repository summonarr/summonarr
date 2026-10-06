import { cn } from "@/lib/utils";
import { forwardRef } from "react";

// Shares the Input recipe (border-input edge, rounded-lg, the focus ring the
// Button/Input/Badge trio use, disabled treatment) so a select beside an Input
// reads as one family. Default height is min-h-11 (44px) — Apple's recommended
// minimum tap target; `compact` matches Input's h-8 for dense admin forms where
// the select sits in a row of 32px controls. text-base below md: iOS Safari
// zooms the viewport when a control under 16px takes focus (same reason Input
// uses `text-base md:text-sm`) — never pass a smaller base size.
type StyledSelectProps = React.SelectHTMLAttributes<HTMLSelectElement> & {
  /** 32px tall, Input-aligned. Default is the 44px touch-friendly height. */
  compact?: boolean;
};

export const StyledSelect = forwardRef<HTMLSelectElement, StyledSelectProps>(
  function StyledSelect({ className, children, compact = false, ...props }, ref) {
    return (
      <select
        ref={ref}
        {...props}
        className={cn(
          "w-full rounded-lg border border-input bg-[var(--ds-bg-2)] text-base md:text-sm text-zinc-100 outline-none transition-colors",
          "focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50",
          "disabled:cursor-not-allowed disabled:opacity-50",
          "aria-invalid:border-destructive aria-invalid:ring-3 aria-invalid:ring-destructive/20",
          compact ? "h-8 min-h-0 px-2.5 py-1" : "px-3 py-2.5 min-h-11",
          className,
        )}
      >
        {children}
      </select>
    );
  },
);
