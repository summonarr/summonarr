import { cn } from "@/lib/utils";
import { deltaToneOf, type DeltaTone } from "./delta-tone";

export type { DeltaTone } from "./delta-tone";

const TONE_COLOR: Record<DeltaTone, string> = {
  up: "var(--ds-success)",
  down: "var(--ds-danger)",
  neutral: "var(--ds-fg-subtle)",
};

// Metric tile: label + value, with an optional delta tinted green/red (by
// `deltaTone`, else by its leading sign) and an optional hint line.
export function StatCard({
  label,
  value,
  delta,
  deltaTone,
  hint,
  mono,
  className,
}: {
  label: React.ReactNode;
  value: React.ReactNode;
  delta?: string;
  deltaTone?: DeltaTone;
  hint?: React.ReactNode;
  mono?: boolean;
  className?: string;
}) {
  const deltaColor = TONE_COLOR[deltaTone ?? (delta ? deltaToneOf(delta) : "neutral")];

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
