import { cn } from "@/lib/utils";

export type StatusKind = "ok" | "warn" | "err" | "muted";

const kindVar: Record<StatusKind, string> = {
  ok: "var(--ds-success)",
  warn: "var(--ds-warning)",
  err: "var(--ds-danger)",
  muted: "var(--ds-fg-subtle)",
};

export function StatusDot({
  kind = "ok",
  className,
  ...props
}: React.HTMLAttributes<HTMLSpanElement> & { kind?: StatusKind }) {
  const color = kindVar[kind];
  return (
    <span
      aria-hidden
      className={cn("inline-block rounded-full", className)}
      style={{
        width: 6,
        height: 6,
        background: color,
        boxShadow: `0 0 6px color-mix(in oklab, ${color} 60%, transparent)`,
      }}
      {...props}
    />
  );
}
