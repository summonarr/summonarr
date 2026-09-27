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
              aria-pressed={isActive}
              // min-h-9 (36px) on phones, 32px from sm: these are the main
              // filter controls on list pages, packed into a scrolling track.
              className="inline-flex items-center gap-1.5 whitespace-nowrap shrink-0 font-medium border-0 min-h-9 sm:min-h-8"
              style={{
                padding: "5px 12px",
                borderRadius: 6,
                // Raised segmented-control look. A bg-3 fill alone was ~1.07:1
                // against the bg-1 track in light mode — the selected filter
                // was nearly invisible — so the active segment also carries a
                // border-strong edge and a small shadow, visible in both themes.
                background: isActive ? "var(--ds-bg-2)" : "transparent",
                boxShadow: isActive
                  ? "var(--ds-shadow-sm), inset 0 0 0 1px var(--ds-border-strong)"
                  : "none",
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
                      ? "var(--ds-accent-text)"
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
