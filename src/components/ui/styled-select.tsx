import { cn } from "@/lib/utils";
import { forwardRef } from "react";

export const StyledSelect = forwardRef<HTMLSelectElement, React.SelectHTMLAttributes<HTMLSelectElement>>(
  function StyledSelect({ className, children, ...props }, ref) {
    return (
      <select
        ref={ref}
        {...props}
        className={cn(
          "rounded-lg border border-zinc-700 bg-zinc-800 px-3 py-1.5 text-sm text-white focus:outline-none focus:ring-2 focus:ring-indigo-500",
          className,
        )}
      >
        {children}
      </select>
    );
  },
);
