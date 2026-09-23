import { cn } from "@/lib/utils";
import { forwardRef } from "react";

// min-h-11 (44px) meets Apple's recommended minimum tap-target size. The
// padding alone (py-2.5 with text-sm) only reaches 42px, hence the min-height.
export const StyledSelect = forwardRef<HTMLSelectElement, React.SelectHTMLAttributes<HTMLSelectElement>>(
  function StyledSelect({ className, children, ...props }, ref) {
    return (
      <select
        ref={ref}
        {...props}
        className={cn(
          "rounded-lg border border-[var(--ds-border)] bg-[var(--ds-bg-2)] px-3 py-2.5 min-h-11 text-sm text-zinc-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500",
          className,
        )}
      >
        {children}
      </select>
    );
  },
);
