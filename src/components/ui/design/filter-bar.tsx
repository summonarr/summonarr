"use client";

import { cn } from "@/lib/utils";

export type FilterSegment<V extends string = string> = {
  value: V;
  label: React.ReactNode;
  count?: number;
};

export function FilterBar<V extends string = string>({
  segments,
  active,
  onChange,
  right,
  className,
}: {
  segments: readonly FilterSegment<V>[];
  active: V;
  onChange: (value: V) => void;
  right?: React.ReactNode;
  className?: string;
}) {
  return (
    <div
      className={cn(
        "flex items-center gap-2 mb-4 flex-wrap",
        className,
      )}
    >
      <div
        className="ds-no-scrollbar flex overflow-x-auto max-w-full"
        style={{
          padding: 2,
          background: "var(--ds-bg-1)",
          border: "1px solid var(--ds-border)",
          borderRadius: 8,
        }}
      >
        {segments.map((s) => {
          const isActive = s.value === active;
          return (
            <button
              key={s.value}
              type="button"
              onClick={() => onChange(s.value)}
              className="inline-flex items-center gap-1.5 whitespace-nowrap shrink-0 font-medium cursor-pointer border-0"
              style={{
                padding: "5px 12px",
                borderRadius: 6,
                background: isActive ? "var(--ds-bg-3)" : "transparent",
                color: isActive ? "var(--ds-fg)" : "var(--ds-fg-muted)",
                fontSize: 12,
                transition: "all 120ms var(--ds-ease)",
              }}
            >
              {s.label}
              {typeof s.count === "number" && (
                <span
                  className="ds-mono"
                  style={{
                    fontSize: 10,
                    padding: "0 5px",
                    borderRadius: 3,
                    background: isActive
                      ? "var(--ds-accent-soft)"
                      : "var(--ds-bg-3)",
                    color: isActive
                      ? "var(--ds-accent)"
                      : "var(--ds-fg-subtle)",
                  }}
                >
                  {s.count}
                </span>
              )}
            </button>
          );
        })}
      </div>
      <div className="flex-1" />
      {right}
    </div>
  );
}
