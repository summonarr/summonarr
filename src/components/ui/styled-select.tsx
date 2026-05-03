import { cn } from "@/lib/utils";
import { forwardRef } from "react";

// Mobile audit F-2.3: bumped vertical padding from py-1.5 (~32 px tall) to
// py-2.5 + an explicit min-h-11 (44 px) so the filter selects clear Apple HIG.
// py-2.5 alone with text-sm landed at 42 px (line-height 20 + padding 20 +
// border 2 = 42) so the explicit min-height is what guarantees 44.
export const StyledSelect = forwardRef<HTMLSelectElement, React.SelectHTMLAttributes<HTMLSelectElement>>(
  function StyledSelect({ className, children, ...props }, ref) {
    return (
      <select
        ref={ref}
        {...props}
        className={cn(
          "rounded-lg border border-zinc-700 bg-zinc-800 px-3 py-2.5 min-h-11 text-sm text-white focus:outline-none focus:ring-2 focus:ring-indigo-500",
          className,
        )}
      >
        {children}
      </select>
    );
  },
);
