import { cn } from "@/lib/utils";

export function StatCard({
  label,
  value,
  delta,
  hint,
  mono,
  className,
}: {
  label: React.ReactNode;
  value: React.ReactNode;
  delta?: string;
  hint?: React.ReactNode;
  mono?: boolean;
  className?: string;
}) {
  const deltaColor = delta?.startsWith("+")
    ? "var(--ds-success)"
    : delta?.startsWith("-")
      ? "var(--ds-danger)"
      : "var(--ds-fg-subtle)";

  return (
    <div
      className={cn(className)}
      style={{
        background: "var(--ds-bg-2)",
        border: "1px solid var(--ds-border)",
        borderRadius: 8,
        padding: "14px 16px",
      }}
    >
      <div
        className="ds-mono"
        style={{
          fontSize: 10.5,
          color: "var(--ds-fg-subtle)",
          textTransform: "uppercase",
          letterSpacing: "0.08em",
          marginBottom: 6,
        }}
      >
        {label}
      </div>
      <div className="flex items-baseline gap-2">
        <span
          className="font-semibold"
          style={{
            fontSize: 26,
            letterSpacing: "-0.02em",
            color: "var(--ds-fg)",
            fontFamily: mono
              ? "var(--font-geist-mono, ui-monospace, monospace)"
              : "inherit",
          }}
        >
          {value}
        </span>
        {delta && (
          <span
            className="ds-mono"
            style={{ fontSize: 11, color: deltaColor }}
          >
            {delta}
          </span>
        )}
      </div>
      {hint && (
        <div
          className="ds-mono"
          style={{
            fontSize: 10.5,
            color: "var(--ds-fg-subtle)",
            marginTop: 6,
          }}
        >
          {hint}
        </div>
      )}
    </div>
  );
}
