import { cn } from "@/lib/utils";
import { forwardRef } from "react";

// py-2.5 + explicit min-h-11 (44 px) so filter selects clear Apple HIG. py-2.5
// alone with text-sm lands at 42 px, so the explicit min-height guarantees 44.
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
