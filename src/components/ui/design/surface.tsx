import { cn } from "@/lib/utils";

export function Surface({
  tone = "card",
  className,
  children,
  ...props
}: React.HTMLAttributes<HTMLDivElement> & { tone?: "card" | "inset" }) {
  return (
    <div
      className={cn(tone === "inset" ? "ds-surface-1" : "ds-surface", className)}
      {...props}
    >
      {children}
    </div>
  );
}
